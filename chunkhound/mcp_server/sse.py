"""SSE MCP server implementation for multi-session support.

This module implements an HTTP/SSE transport for MCP, allowing multiple
Claude sessions to share a single ChunkHound server instance.

Usage:
    python -m chunkhound.mcp_server.sse --path /path/to/project --port 31000
"""

from __future__ import annotations

import asyncio
import os
import sys
import logging
from typing import Any, TYPE_CHECKING

from starlette.applications import Starlette
from starlette.responses import Response, JSONResponse
from starlette.routing import Route, Mount
from starlette.requests import Request

if TYPE_CHECKING:
    from mcp.server.sse import SseServerTransport

from chunkhound.core.config.config import Config
from chunkhound.version import __version__

from .base import MCPServerBase
from .common import handle_tool_call, has_reranker_support
from .tools import TOOL_REGISTRY

# Configure logging for SSE mode (can use stderr unlike stdio)
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger(__name__)


class SseMCPServer(MCPServerBase):
    """MCP server implementation for SSE (Server-Sent Events) transport.

    Unlike stdio, SSE allows multiple clients to connect to a single server,
    making it suitable for multiple parallel Claude sessions.
    """

    def __init__(self, config: Config, args: Any = None, port: int = 8080, host: str = "localhost"):
        """Initialize SSE MCP server.

        Args:
            config: Validated configuration object
            args: Original CLI arguments for direct path access
            port: Port to listen on
            host: Host to bind to
        """
        super().__init__(config, args=args)
        self.port = port
        self.host = host

        # Import MCP SDK components
        from mcp.server import Server
        from mcp.server.sse import SseServerTransport

        self.server: Server = Server("ChunkHound Code Search")
        self.sse_transport: SseServerTransport = SseServerTransport("/messages/")

        # Event to signal initialization completion
        self._initialization_complete = asyncio.Event()

        # Register tools
        self._register_tools()

    def _register_tools(self) -> None:
        """Register tool handlers with the SSE server."""
        import mcp.types as types

        @self.server.call_tool()
        async def handle_all_tools(
            tool_name: str, arguments: dict[str, Any]
        ) -> list[types.TextContent]:
            """Universal tool handler that routes to the unified handler."""
            return await handle_tool_call(
                tool_name=tool_name,
                arguments=arguments,
                services=self.ensure_services(),
                embedding_manager=self.embedding_manager,
                initialization_complete=self._initialization_complete,
                debug_mode=self.debug_mode,
                scan_progress=self._scan_progress,
                llm_manager=self.llm_manager,
                config=self.config,
            )

        self._register_list_tools()

    def _register_list_tools(self) -> None:
        """Register list_tools handler."""
        import mcp.types as types
        import copy

        @self.server.list_tools()
        async def list_tools() -> list[types.Tool]:
            """List available tools."""
            try:
                await asyncio.wait_for(
                    self._initialization_complete.wait(), timeout=5.0
                )
            except asyncio.TimeoutError:
                pass

            return self._build_available_tools()

    def _build_available_tools(self) -> list:
        """Build list of tools available based on current configuration."""
        import mcp.types as types
        import copy

        tools = []
        for tool_name, tool in TOOL_REGISTRY.items():
            if tool.requires_embeddings and (
                not self.embedding_manager
                or not self.embedding_manager.list_providers()
            ):
                continue

            if tool.requires_llm and not self.llm_manager:
                continue

            if tool.requires_reranker and not has_reranker_support(
                self.embedding_manager
            ):
                continue

            tool_params = copy.deepcopy(tool.parameters)

            if tool_name == "search" and (
                not self.embedding_manager
                or not self.embedding_manager.list_providers()
            ):
                if "type" in tool_params.get("properties", {}):
                    tool_params["properties"]["type"]["enum"] = ["regex"]

            tools.append(
                types.Tool(
                    name=tool_name,
                    description=tool.description,
                    inputSchema=tool_params,
                )
            )

        return tools

    def _create_starlette_app(self) -> Starlette:
        """Create Starlette ASGI application with SSE routes."""

        async def handle_sse(request: Request) -> Response:
            """Handle SSE connection requests."""
            logger.info(f"New SSE connection from {request.client}")

            async with self.sse_transport.connect_sse(
                request.scope, request.receive, request._send
            ) as streams:
                await self.server.run(
                    streams[0],
                    streams[1],
                    self.server.create_initialization_options()
                )

            return Response()

        async def handle_health(request: Request) -> JSONResponse:
            """Health check endpoint."""
            return JSONResponse({
                "status": "healthy",
                "server": "ChunkHound Code Search",
                "version": __version__,
                "initialized": self._initialization_complete.is_set(),
                "scan_progress": self._scan_progress,
            })

        routes = [
            Route("/health", endpoint=handle_health, methods=["GET"]),
            Route("/sse", endpoint=handle_sse, methods=["GET"]),
            Mount("/messages/", app=self.sse_transport.handle_post_message),
        ]

        return Starlette(routes=routes, on_startup=[self._on_startup])

    async def _on_startup(self) -> None:
        """Initialize services on server startup."""
        logger.info("Initializing ChunkHound services...")
        await self.initialize()
        self._initialization_complete.set()
        logger.info("ChunkHound initialization complete")

    async def run(self) -> None:
        """Run the SSE server."""
        import uvicorn

        app = self._create_starlette_app()

        config = uvicorn.Config(
            app,
            host=self.host,
            port=self.port,
            log_level="info",
            access_log=True,
        )

        server = uvicorn.Server(config)

        logger.info(f"Starting ChunkHound SSE server on {self.host}:{self.port}")
        logger.info(f"SSE endpoint: http://{self.host}:{self.port}/sse")
        logger.info(f"Health check: http://{self.host}:{self.port}/health")

        await server.serve()


async def main(args: Any = None) -> None:
    """Main entry point for the MCP SSE server.

    Args:
        args: Pre-parsed arguments. If None, will parse from sys.argv.
    """
    import argparse
    from chunkhound.api.cli.utils.config_factory import create_validated_config
    from chunkhound.mcp_server.common import add_common_mcp_arguments

    if args is None:
        parser = argparse.ArgumentParser(
            description="ChunkHound MCP SSE server",
            formatter_class=argparse.RawDescriptionHelpFormatter,
        )
        add_common_mcp_arguments(parser)
        parser.add_argument(
            "--port",
            type=int,
            default=int(os.getenv("CHUNKHOUND_MCP__PORT", "8080")),
            help="Port to listen on (default: 8080 or CHUNKHOUND_MCP__PORT)",
        )
        parser.add_argument(
            "--host",
            type=str,
            default=os.getenv("CHUNKHOUND_MCP__HOST", "localhost"),
            help="Host to bind to (default: localhost or CHUNKHOUND_MCP__HOST)",
        )
        args = parser.parse_args()

    # Create and validate configuration
    config, validation_errors = create_validated_config(args, "mcp")

    if validation_errors:
        for error in validation_errors:
            logger.error(f"Configuration error: {error}")
        sys.exit(1)

    # Create and run the SSE server
    try:
        port = getattr(args, 'port', int(os.getenv("CHUNKHOUND_MCP__PORT", "8080")))
        host = getattr(args, 'host', os.getenv("CHUNKHOUND_MCP__HOST", "localhost"))

        server = SseMCPServer(config, args=args, port=port, host=host)
        await server.run()
    except KeyboardInterrupt:
        logger.info("Server interrupted by user")
    except Exception as e:
        logger.error(f"Server error: {e}")
        raise


def main_sync() -> None:
    """Synchronous wrapper for CLI entry point."""
    asyncio.run(main())


if __name__ == "__main__":
    main_sync()
