"""Real-time indexing service for MCP servers.

This service provides continuous filesystem monitoring and incremental updates
while maintaining search responsiveness. It leverages the existing indexing
infrastructure and respects the single-threaded database constraint.

Architecture:
- Single event queue for filesystem changes
- Background scan iterator for initial indexing
- No cancellation - operations complete naturally
- SerialDatabaseProvider handles all concurrency
"""

import asyncio
import os
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Callable, TYPE_CHECKING

from loguru import logger
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer
from chunkhound.utils.windows_constants import IS_WINDOWS
from chunkhound.utils.hashing import compute_file_hash

from chunkhound.core.config.config import Config
from chunkhound.core.utils.path_utils import normalize_path_for_lookup
if TYPE_CHECKING:
    from chunkhound.database_factory import DatabaseServices


def normalize_file_path(path: Path | str) -> str:
    """Single source of truth for path normalization across ChunkHound."""
    return str(Path(path).resolve())


class SimpleEventHandler(FileSystemEventHandler):
    """Simple sync event handler - no async complexity."""

    def __init__(
        self,
        event_queue: asyncio.Queue | None,
        config: Config | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
        on_overflow: Callable[[str, Path], None] | None = None,
        on_invalidate: Callable[[str, Path], None] | None = None,
    ):
        self.event_queue = event_queue
        self.config = config
        self.loop = loop
        self._on_overflow = on_overflow
        self._on_invalidate = on_invalidate
        self._engine = None
        self._include_patterns: list[str] | None = None
        self._pattern_cache: dict[str, Any] = {}
        self._ignore_names: set[str] = {".gitignore", ".chunkhound.json"}
        try:
            if config and getattr(config, "indexing", None):
                chf = getattr(config.indexing, "chignore_file", None)
                if chf:
                    self._ignore_names.add(chf)
        except Exception:
            pass
        try:
            self._root = (config.target_dir if config and config.target_dir else Path.cwd()).resolve()
        except Exception:
            self._root = Path.cwd().resolve()

    def invalidate_filters(self) -> None:
        """Reset ignore/include caches so changes are picked up."""
        self._engine = None
        self._include_patterns = None
        self._pattern_cache.clear()

    def _is_ignore_or_config(self, file_path: Path) -> bool:
        try:
            if file_path.name in self._ignore_names:
                return True
            path_str = file_path.as_posix()
            if path_str.endswith("/.git/info/exclude"):
                return True
        except Exception:
            return False
        return False

    def _notify_overflow(self, event_type: str, file_path: Path) -> None:
        if not self._on_overflow or not self.loop or self.loop.is_closed():
            return
        try:
            self.loop.call_soon_threadsafe(self._on_overflow, event_type, file_path)
        except Exception:
            pass

    def _notify_invalidate(self, file_path: Path) -> None:
        if not self._on_invalidate or not self.loop or self.loop.is_closed():
            return
        try:
            self.loop.call_soon_threadsafe(self._on_invalidate, "config_changed", file_path)
        except Exception:
            pass

    def on_any_event(self, event: Any) -> None:
        """Handle filesystem events - simple queue operation."""
        # Handle directory creation
        if event.event_type == "created" and event.is_directory:
            # Queue directory creation for processing
            self._queue_event("dir_created", Path(normalize_file_path(event.src_path)))
            return

        # Handle directory deletion
        if event.event_type == "deleted" and event.is_directory:
            # Queue directory deletion for cleanup
            self._queue_event("dir_deleted", Path(normalize_file_path(event.src_path)))
            return

        # Skip other directory events (modified, moved)
        if event.is_directory:
            return

        # Handle move events for atomic writes
        if event.event_type == "moved" and hasattr(event, "dest_path"):
            self._handle_move_event(event.src_path, event.dest_path)
            return

        # Resolve path to canonical form to avoid /var vs /private/var issues
        file_path = Path(normalize_file_path(event.src_path))

        # Invalidate ignore/include caches when ignore/config files change
        if self._is_ignore_or_config(file_path):
            self.invalidate_filters()
            self._notify_invalidate(file_path)
            return

        # Simple filtering for supported file types
        if not self._should_index(file_path):
            return

        # Put event in async queue from watchdog thread
        self._queue_event(event.event_type, file_path)

    def _should_index(self, file_path: Path) -> bool:
        """Check if file should be indexed based on config patterns.

        Uses config-based filtering if available, otherwise falls back to
        Language enum which derives all patterns from parser_factory.
        This ensures realtime indexing supports all languages without
        requiring manual updates.
        """
        if not self.config:
            # Fallback: derive from Language enum (which derives from parser_factory)
            # Uses lazy import to avoid heavyweight startup cost
            from chunkhound.core.types.common import Language

            # Check extension-based patterns
            if file_path.suffix.lower() in Language.get_all_extensions():
                return True

            # Check filename-based patterns (Makefile, Dockerfile, etc.)
            if file_path.name.lower() in Language.get_all_filename_patterns():
                return True

            return False

        # Repo-aware ignore engine (lazy init)
        try:
            if self._engine is None:
                from chunkhound.utils.ignore_engine import build_repo_aware_ignore_engine
                sources = self.config.indexing.resolve_ignore_sources()
                cfg_ex = self.config.indexing.get_effective_config_excludes()
                chf = self.config.indexing.chignore_file
                overlay = bool(getattr(self.config.indexing, "workspace_gitignore_nonrepo", False))
                self._engine = build_repo_aware_ignore_engine(self._root, sources, chf, cfg_ex, workspace_root_only_gitignore=overlay)
        except Exception:
            self._engine = None

        # Exclude via engine
        try:
            if self._engine is not None and self._engine.matches(file_path, is_dir=False):
                return False
        except Exception:
            pass

        # Include via normalized patterns (fallback to Language defaults)
        try:
            if self._include_patterns is None:
                from chunkhound.utils.file_patterns import normalize_include_patterns
                inc = list(self.config.indexing.include)
                self._include_patterns = normalize_include_patterns(inc)

            from chunkhound.utils.file_patterns import should_include_file
            return should_include_file(file_path, self._root, self._include_patterns, self._pattern_cache)
        except Exception:
            # Fallback to Language-based detection if include matching fails
            from chunkhound.core.types.common import Language
            if file_path.suffix.lower() in Language.get_all_extensions():
                return True
            if file_path.name.lower() in Language.get_all_filename_patterns():
                return True
            return False

    def _handle_move_event(self, src_path: str, dest_path: str) -> None:
        """Handle atomic file moves (temp -> final file)."""
        src_file = Path(normalize_file_path(src_path))
        dest_file = Path(normalize_file_path(dest_path))

        if self._is_ignore_or_config(src_file) or self._is_ignore_or_config(dest_file):
            self.invalidate_filters()
            self._notify_invalidate(dest_file)
            return

        # If moving FROM temp file TO supported file -> index destination
        if not self._should_index(src_file) and self._should_index(dest_file):
            logger.debug(f"Atomic write detected: {src_path} -> {dest_path}")
            self._queue_event("created", dest_file)

        # If moving FROM supported file -> handle as deletion + creation
        elif self._should_index(src_file) and self._should_index(dest_file):
            logger.debug(f"File rename: {src_path} -> {dest_path}")
            self._queue_event("deleted", src_file)
            self._queue_event("created", dest_file)

        # If moving FROM supported file TO temp/unsupported -> deletion
        elif self._should_index(src_file) and not self._should_index(dest_file):
            logger.debug(f"File moved to temp/unsupported: {src_path}")
            self._queue_event("deleted", src_file)

    def _queue_event(self, event_type: str, file_path: Path) -> None:
        """Queue an event for async processing."""
        if self.event_queue is None or not self.loop or self.loop.is_closed():
            return

        def _enqueue() -> None:
            try:
                self.event_queue.put_nowait((event_type, file_path))
            except asyncio.QueueFull:
                logger.warning(f"Event queue full; dropping {event_type} for {file_path}")
                self._notify_overflow(event_type, file_path)
            except Exception as e:
                logger.warning(f"Failed to queue {event_type} event for {file_path}: {e}")
                self._notify_overflow(event_type, file_path)

        try:
            self.loop.call_soon_threadsafe(_enqueue)
        except Exception as e:
            logger.warning(f"Failed to schedule queue insert for {file_path}: {e}")
            self._notify_overflow(event_type, file_path)


class RealtimeIndexingService:
    """Simple real-time indexing service with search responsiveness."""

    # Event deduplication window - suppress duplicate events within this period
    _EVENT_DEDUP_WINDOW_SECONDS = 2.0
    # Retention period for event history - entries older than this are cleaned up
    _EVENT_HISTORY_RETENTION_SECONDS = 10.0

    def __init__(
        self,
        services: "DatabaseServices",
        config: Config,
        debug_sink: Callable[[str], None] | None = None,
    ):
        self.services = services
        self.config = config
        # Optional sink that writes to MCPServerBase.debug_log so events land in
        # /tmp/chunkhound_mcp_debug.log when CHUNKHOUND_DEBUG is enabled.
        self._debug_sink = debug_sink

        # NEW: Async queue for events from watchdog (thread-safe via asyncio)
        self.event_queue: asyncio.Queue = asyncio.Queue(maxsize=1000)

        # Deduplication and error tracking
        self.pending_files: set[Path] = set()
        self.failed_files: set[str] = set()
        self.dirty_files: set[Path] = set()
        self._pending_embed_files: set[str] = set()

        # Simple debouncing for rapid file changes
        self._pending_debounce: dict[str, float] = {}  # file_path -> timestamp
        self._debounce_delay = 0.5  # 500ms delay from research
        self._debounce_tasks: set[asyncio.Task] = set()  # Track active debounce tasks

        self._recent_file_events: dict[str, tuple[str, float]] = {}  # Layer 3: event dedup

        # Background scan state
        self.scan_iterator: Iterator | None = None
        self.scan_complete = False

        # Polling/health state
        self._using_polling = False
        self._last_event_time = 0.0
        self._stop_event = threading.Event()

        # Watchdog startup can be slow on large repos or slow filesystems.
        # If it takes too long we may temporarily fall back to polling, but we
        # should never block the asyncio loop during that decision.
        self._watchdog_setup_timeout_s = 30.0
        try:
            self._watchdog_setup_timeout_s = float(
                os.getenv("CHUNKHOUND_WATCHDOG_SETUP_TIMEOUT_SEC", "30")
            )
        except Exception:
            self._watchdog_setup_timeout_s = 30.0
        if self._watchdog_setup_timeout_s <= 0:
            self._watchdog_setup_timeout_s = 30.0

        def _parse_bool(value: str | None, default: bool = False) -> bool:
            if value is None:
                return default
            return value.strip().lower() in {"1", "true", "yes", "on"}

        self._periodic_sweep_interval_s = 0.0
        try:
            self._periodic_sweep_interval_s = float(
                os.getenv("CHUNKHOUND_REALTIME_SWEEP_SECONDS", "60")
            )
        except Exception:
            self._periodic_sweep_interval_s = 60.0
        if self._periodic_sweep_interval_s < 0:
            self._periodic_sweep_interval_s = 0.0
        self._periodic_sweep_enabled = self._periodic_sweep_interval_s > 0

        self._file_queue_maxsize = 0
        try:
            self._file_queue_maxsize = int(
                os.getenv("CHUNKHOUND_FILE_QUEUE_MAXSIZE", "2000")
            )
        except Exception:
            self._file_queue_maxsize = 2000
        if self._file_queue_maxsize < 0:
            self._file_queue_maxsize = 0

        # Existing asyncio queue for priority processing (bounded if configured)
        if self._file_queue_maxsize > 0:
            self.file_queue: asyncio.Queue[tuple[str, Path]] = asyncio.Queue(
                maxsize=self._file_queue_maxsize
            )
        else:
            self.file_queue = asyncio.Queue()

        self._embed_sweep_interval_s = 0.0
        try:
            self._embed_sweep_interval_s = float(
                os.getenv("CHUNKHOUND_EMBED_SWEEP_SECONDS", "300")
            )
        except Exception:
            self._embed_sweep_interval_s = 300.0
        if self._embed_sweep_interval_s < 0:
            self._embed_sweep_interval_s = 0.0
        self._embed_sweep_enabled = self._embed_sweep_interval_s > 0
        self._embed_sweep_backoff_s = 0.0
        try:
            self._embed_sweep_backoff_s = float(
                os.getenv("CHUNKHOUND_EMBED_SWEEP_BACKOFF_SECONDS", "30")
            )
        except Exception:
            self._embed_sweep_backoff_s = 30.0
        if self._embed_sweep_backoff_s < 0:
            self._embed_sweep_backoff_s = 0.0
        self._last_embed_activity_time = 0.0
        self._last_embed_sweep_time = 0.0

        self._overflow_drain_interval_s = 0.0
        try:
            self._overflow_drain_interval_s = float(
                os.getenv("CHUNKHOUND_FILE_QUEUE_DRAIN_SECONDS", "1.0")
            )
        except Exception:
            self._overflow_drain_interval_s = 1.0
        if self._overflow_drain_interval_s < 0:
            self._overflow_drain_interval_s = 0.0

        self._poll_verify_hash = _parse_bool(
            os.getenv("CHUNKHOUND_POLL_VERIFY_HASH"),
            default=True,
        )
        try:
            self._poll_hash_interval_s = float(
                os.getenv("CHUNKHOUND_POLL_HASH_INTERVAL_SECONDS", "300")
            )
        except Exception:
            self._poll_hash_interval_s = 300.0
        try:
            self._poll_hash_budget_ms = int(
                os.getenv("CHUNKHOUND_POLL_HASH_BUDGET_MS", "200")
            )
        except Exception:
            self._poll_hash_budget_ms = 200
        try:
            self._poll_hash_max_size_kb = int(
                os.getenv("CHUNKHOUND_POLL_HASH_MAX_SIZE_KB", "256")
            )
        except Exception:
            self._poll_hash_max_size_kb = 256
        self._poll_hash_checked: dict[str, float] = {}

        self._realtime_embed_immediate = _parse_bool(
            os.getenv("CHUNKHOUND_REALTIME_EMBED_IMMEDIATE"),
            default=True,
        )
        try:
            self._realtime_embed_backlog = int(
                os.getenv("CHUNKHOUND_REALTIME_EMBED_BACKLOG", "0")
            )
        except Exception:
            self._realtime_embed_backlog = 0

        # Filesystem monitoring
        self.observer: Any | None = None
        self.event_handler: SimpleEventHandler | None = None
        self.watch_path: Path | None = None

        # Processing tasks
        self.process_task: asyncio.Task | None = None
        self.event_consumer_task: asyncio.Task | None = None
        self._polling_task: asyncio.Task | None = None
        self._polling_lock = asyncio.Lock()
        self._health_task: asyncio.Task | None = None
        self._periodic_sweep_task: asyncio.Task | None = None
        self._embed_sweep_task: asyncio.Task | None = None
        self._overflow_drain_task: asyncio.Task | None = None

        # Directory watch management for progressive monitoring
        self.watched_directories: set[str] = set()  # Track watched dirs
        self.watch_lock = asyncio.Lock()  # Protect concurrent access

        # Monitoring readiness coordination
        self.monitoring_ready = asyncio.Event()  # Signals when monitoring is ready
        self._monitoring_ready_time: float | None = (
            None  # Track when monitoring became ready
        )
        # Polling state cache (used in polling mode and overflow sweeps)
        self._poll_state: dict[str, tuple[int, ...]] = {}
        self._polling_handler: SimpleEventHandler | None = None
        # Queue overflow handling
        self._overflow_task: asyncio.Task | None = None
        self._last_overflow_time = 0.0
        self._overflow_debounce_seconds = 2.0
        self._overflow_pending_files: dict[str, tuple[Path, str]] = {}

    # Internal helper to forward realtime events into the MCP debug log file
    def _debug(self, message: str) -> None:
        try:
            if self._debug_sink:
                # Prefix with RT to make it easy to filter
                self._debug_sink(f"RT: {message}")
        except Exception:
            # Never let debug plumbing affect runtime
            pass

    async def start(self, watch_path: Path) -> None:
        """Start real-time indexing service."""
        logger.debug(f"Starting real-time indexing for {watch_path}")
        self._debug(f"start watch on {watch_path}")

        self._stop_event.clear()

        # Store the watch path
        self.watch_path = watch_path

        # Always start with watchdog but with reasonable timeout
        # If it takes too long, we'll fall back to polling
        loop = asyncio.get_event_loop()

        # Start all necessary tasks
        self.event_consumer_task = asyncio.create_task(self._consume_events())
        self.process_task = asyncio.create_task(self._process_loop())
        self._health_task = asyncio.create_task(self._monitor_health())
        if self._periodic_sweep_enabled:
            self._periodic_sweep_task = asyncio.create_task(self._periodic_sweep())
        if self._embed_sweep_enabled:
            self._embed_sweep_task = asyncio.create_task(self._periodic_embedding_sweep())
        if self._overflow_drain_interval_s > 0:
            self._overflow_drain_task = asyncio.create_task(self._drain_overflow_loop())

        # Setup watchdog with timeout
        self._watchdog_setup_task = asyncio.create_task(
            self._setup_watchdog_with_timeout(watch_path, loop)
        )

        # Wait for monitoring to be confirmed ready
        monitoring_ok = await self.wait_for_monitoring_ready(timeout=10.0)
        if monitoring_ok:
            self._debug("monitoring ready")
        else:
            self._debug("monitoring timeout; continuing")

    async def stop(self) -> None:
        """Stop the service gracefully."""
        logger.debug("Stopping real-time indexing service")
        self._debug("stopping service")
        self._stop_event.set()

        # Cancel watchdog setup if still running
        if hasattr(self, "_watchdog_setup_task") and self._watchdog_setup_task:
            self._watchdog_setup_task.cancel()
            try:
                await self._watchdog_setup_task
            except asyncio.CancelledError:
                pass

        # Stop filesystem observer
        if self.observer:
            self.observer.stop()
            # Join with timeout to prevent hanging
            try:
                loop = asyncio.get_event_loop()
                await asyncio.wait_for(
                    loop.run_in_executor(None, self.observer.join), timeout=1.0
                )
            except asyncio.TimeoutError:
                logger.warning("Observer thread did not exit within timeout")

        # Cancel event consumer task
        if self.event_consumer_task:
            self.event_consumer_task.cancel()
            try:
                await self.event_consumer_task
            except asyncio.CancelledError:
                pass

        # Cancel processing task
        if self.process_task:
            self.process_task.cancel()
            try:
                await self.process_task
            except asyncio.CancelledError:
                pass

        # Cancel polling task if running
        if self._polling_task:
            self._polling_task.cancel()
            try:
                await self._polling_task
            except asyncio.CancelledError:
                pass

        if self._health_task:
            self._health_task.cancel()
            try:
                await self._health_task
            except asyncio.CancelledError:
                pass

        if self._periodic_sweep_task:
            self._periodic_sweep_task.cancel()
            try:
                await self._periodic_sweep_task
            except asyncio.CancelledError:
                pass

        if self._embed_sweep_task:
            self._embed_sweep_task.cancel()
            try:
                await self._embed_sweep_task
            except asyncio.CancelledError:
                pass

        if self._overflow_drain_task:
            self._overflow_drain_task.cancel()
            try:
                await self._overflow_drain_task
            except asyncio.CancelledError:
                pass

        # Cancel all active debounce tasks
        for task in self._debounce_tasks.copy():
            task.cancel()

        # Wait for debounce tasks to finish cancelling
        if self._debounce_tasks:
            await asyncio.gather(*self._debounce_tasks, return_exceptions=True)
            self._debounce_tasks.clear()

    async def _setup_watchdog_async(
        self, watch_path: Path, loop: asyncio.AbstractEventLoop
    ) -> None:
        """Setup watchdog in background thread without blocking initialization."""
        try:
            await loop.run_in_executor(None, self._start_fs_monitor, watch_path, loop)
            logger.debug("Watchdog setup completed successfully")
        except Exception as e:
            logger.error(f"Failed to setup watchdog monitoring: {e}")
            # Server continues to work even if watchdog setup fails

    async def _setup_watchdog_with_timeout(
        self, watch_path: Path, loop: asyncio.AbstractEventLoop
    ) -> None:
        """Setup watchdog with timeout - fall back to polling if it takes too long."""
        if self._stop_event.is_set():
            return

        # run_in_executor returns an awaitable Future
        watchdog_future = loop.run_in_executor(None, self._start_fs_monitor, watch_path, loop)

        async def _stop_polling_if_running() -> None:
            if self._polling_task and not self._polling_task.done():
                self._polling_task.cancel()
                try:
                    await self._polling_task
                except asyncio.CancelledError:
                    pass
            self._polling_task = None

        def _on_watchdog_done(fut: asyncio.Future) -> None:
            # This callback runs on the event loop thread.
            if self._stop_event.is_set():
                return
            try:
                fut.result()
            except Exception:
                # Failure is handled by the await below (or we are already in polling mode).
                return

            # If we temporarily fell back to polling, stop it once watchdog is live.
            if self._using_polling:
                self._debug("watchdog ready; stopping polling fallback")
                asyncio.create_task(_stop_polling_if_running())
                self._using_polling = False

            if not self.monitoring_ready.is_set():
                self._monitoring_ready_time = time.time()
                self.monitoring_ready.set()

        watchdog_future.add_done_callback(_on_watchdog_done)

        try:
            # Shield to avoid cancelling the underlying executor work on timeout.
            await asyncio.wait_for(
                asyncio.shield(watchdog_future),
                timeout=self._watchdog_setup_timeout_s,
            )
            logger.debug("Watchdog setup completed successfully (recursive mode)")
            self._debug("watchdog setup complete (recursive)")
            self._monitoring_ready_time = time.time()
            self.monitoring_ready.set()

        except asyncio.TimeoutError:
            logger.info(
                f"Watchdog setup still in progress after {self._watchdog_setup_timeout_s:.1f}s for {watch_path} - "
                "enabling polling fallback until watchdog is ready"
            )
            self._using_polling = True
            if not self._polling_task or self._polling_task.done():
                self._polling_task = asyncio.create_task(self._polling_monitor(watch_path))
            # Wait a moment for polling to start
            await asyncio.sleep(0.5)
            self._monitoring_ready_time = time.time()
            self.monitoring_ready.set()
            self._debug("watchdog delayed; switched to polling fallback")

        except Exception as e:
            logger.warning(f"Watchdog setup failed: {e} - falling back to polling")
            self._using_polling = True
            if not self._polling_task or self._polling_task.done():
                self._polling_task = asyncio.create_task(self._polling_monitor(watch_path))
            # Wait a moment for polling to start
            await asyncio.sleep(0.5)
            self._monitoring_ready_time = time.time()
            self.monitoring_ready.set()
            self._debug("watchdog failed; switched to polling fallback")

    def _start_fs_monitor(
        self, watch_path: Path, loop: asyncio.AbstractEventLoop
    ) -> None:
        """Start filesystem monitoring with recursive watching for complete coverage."""
        if self._stop_event.is_set():
            return
        self.event_handler = SimpleEventHandler(
            self.event_queue,
            self.config,
            loop,
            on_overflow=self._handle_queue_overflow,
            on_invalidate=self._handle_filter_invalidation,
        )
        self.observer = Observer()

        # Use recursive=True to ensure all directory events are captured
        # This is necessary for proper real-time monitoring of new directories
        self.observer.schedule(
            self.event_handler,
            str(watch_path),
            recursive=True,  # Use recursive for complete event coverage
        )
        self.watched_directories.add(str(watch_path))
        self.observer.start()
        if self._stop_event.is_set():
            try:
                self.observer.stop()
            except Exception:
                pass
            return

        # Wait for observer thread to be fully running
        # On Windows, observer thread startup can be noticeably slower.
        # Give it more time to become alive to avoid falling back to polling unnecessarily.
        max_wait = 5.0 if IS_WINDOWS else 1.0
        start = time.time()
        while not self.observer.is_alive() and (time.time() - start) < max_wait:
            time.sleep(0.01)

        if self.observer.is_alive():
            logger.debug(f"Started recursive filesystem monitoring for {watch_path}")
        else:
            raise RuntimeError("Observer failed to start within timeout")

    async def _add_subdirectories_progressively(self, root_path: Path) -> None:
        """No longer needed - using recursive monitoring."""
        logger.debug(
            "Progressive directory addition skipped (using recursive monitoring)"
        )

    async def _monitor_health(self) -> None:
        """Monitor filesystem watcher health and fall back to polling if needed."""
        while True:
            try:
                await asyncio.sleep(2.0)
                if not self.observer or not self.watch_path:
                    continue
                if self.observer.is_alive():
                    continue
                if not self._using_polling:
                    logger.warning("Watchdog observer not alive; switching to polling")
                    self._debug("watchdog observer not alive; switching to polling")
                    await self._ensure_polling_started()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Health monitor error: {e}")

    async def _ensure_polling_started(self) -> None:
        if not self.watch_path:
            return
        if self._using_polling and self._polling_task and not self._polling_task.done():
            return
        self._using_polling = True
        if not self._polling_task or self._polling_task.done():
            self._polling_task = asyncio.create_task(self._polling_monitor(self.watch_path))
            # Give it a moment to spin up
            await asyncio.sleep(0.1)

    async def _periodic_sweep(self) -> None:
        """Periodically scan to recover from dropped filesystem events."""
        while True:
            try:
                await asyncio.sleep(self._periodic_sweep_interval_s)
                if not self.watch_path:
                    continue
                # Avoid reindexing everything on first sweep if we only want a baseline
                if not self._using_polling and not self._poll_state:
                    await self._scan_for_changes(self.watch_path, emit_changes=False)
                    continue
                await self._scan_for_changes(self.watch_path, emit_changes=True)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Periodic sweep error: {e}")

    async def _periodic_embedding_sweep(self) -> None:
        """Periodically generate missing embeddings as a safety net."""
        while True:
            try:
                await asyncio.sleep(self._embed_sweep_interval_s)
                if not self.services or not hasattr(
                    self.services, "indexing_coordinator"
                ):
                    continue
                if self._pending_embed_files:
                    continue
                now = time.time()
                if self._embed_sweep_backoff_s > 0 and (
                    now - self._last_embed_activity_time
                ) < self._embed_sweep_backoff_s:
                    continue
                if (
                    self._last_embed_sweep_time
                    and (now - self._last_embed_sweep_time)
                    < self._embed_sweep_interval_s
                ):
                    continue
                await self.services.indexing_coordinator.generate_missing_embeddings()
                self._last_embed_sweep_time = time.time()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Periodic embedding sweep error: {e}")

    async def _polling_monitor(self, watch_path: Path) -> None:
        """Simple polling monitor for large directories."""
        logger.debug(f"Starting polling monitor for {watch_path}")
        self._debug(f"polling monitor active for {watch_path}")

        # Use a shorter interval during the first few seconds to ensure
        # freshly created files are detected quickly after startup/fallback.
        polling_start = time.time()

        while True:
            try:
                await self._scan_for_changes(watch_path)

                # Adaptive poll interval: 1s for the first 10s, then 5s
                elapsed = time.time() - polling_start
                interval = 1.0 if elapsed < 10.0 else 5.0
                await asyncio.sleep(interval)

            except Exception as e:
                logger.error(f"Polling monitor error: {e}")
                await asyncio.sleep(5)

    async def add_file(self, file_path: Path, priority: str = "change") -> None:
        """Add file to processing queue with deduplication and debouncing."""
        if priority == "embed":
            file_key = str(file_path)
            if file_key in self._pending_embed_files:
                self._debug(f"skipping duplicate embed for {file_path}")
                return
            if file_path in self.pending_files:
                # Avoid pinning embed requests while a change is pending.
                self._debug(f"skipping embed while pending change for {file_path}")
                return
            self._pending_embed_files.add(file_key)
            self.pending_files.add(file_path)
            if not self._queue_file(priority, file_path):
                self._pending_embed_files.discard(file_key)
                self.pending_files.discard(file_path)
            return
        if file_path in self.pending_files:
            if priority == "change":
                # Mark dirty so we reprocess after the current pass
                self.dirty_files.add(file_path)
                file_str = str(file_path)
                # If a debounce is in-flight, extend its window to the latest change
                if file_str in self._pending_debounce:
                    self._pending_debounce[file_str] = time.time()
                self._debug(f"marked dirty {file_path} priority={priority}")
            return
        if file_path not in self.pending_files:
            self.pending_files.add(file_path)

            # Simple debouncing for change events
            if priority == "change":
                file_str = str(file_path)
                current_time = time.time()

                if file_str in self._pending_debounce:
                    # Update timestamp for existing pending file
                    self._pending_debounce[file_str] = current_time
                    return
                else:
                    # Schedule debounced processing
                    self._pending_debounce[file_str] = current_time
                    task = asyncio.create_task(
                        self._debounced_add_file(file_path, priority)
                    )
                    self._debounce_tasks.add(task)
                    task.add_done_callback(self._debounce_tasks.discard)
                    self._debug(f"queued (debounced) {file_path} priority={priority}")
            else:
                # Priority scan events bypass debouncing
                self._queue_file(priority, file_path)

    async def _debounced_add_file(self, file_path: Path, priority: str) -> None:
        """Process file after debounce delay."""
        await asyncio.sleep(self._debounce_delay)

        file_str = str(file_path)
        if file_str in self._pending_debounce:
            last_update = self._pending_debounce[file_str]

            # Check if no recent updates during delay
            if time.time() - last_update >= self._debounce_delay:
                del self._pending_debounce[file_str]
                if self._queue_file(priority, file_path):
                    logger.debug(f"Processing debounced file: {file_path}")
                    self._debug(f"processing debounced file: {file_path}")

    async def _consume_events(self) -> None:
        """Simple event consumer - pure asyncio queue."""
        while True:
            try:
                # Get event from async queue with timeout
                try:
                    event_type, file_path = await asyncio.wait_for(
                        self.event_queue.get(), timeout=1.0
                    )
                except asyncio.TimeoutError:
                    # Normal timeout, continue to check if task should stop
                    continue
                self._last_event_time = time.time()

                # Layer 3: Event deduplication to prevent redundant processing
                # Suppress duplicate events within 2-second window (e.g., created + modified from same editor save)
                file_key = str(file_path)
                current_time = time.time()

                if file_key in self._recent_file_events:
                    last_event_type, last_event_time = self._recent_file_events[file_key]
                    if last_event_type == event_type and (current_time - last_event_time) < self._EVENT_DEDUP_WINDOW_SECONDS:
                        logger.debug(
                            f"Suppressing duplicate {event_type} event for {file_path} "
                            f"(within {self._EVENT_DEDUP_WINDOW_SECONDS}s window)"
                        )
                        self._debug(f"suppressed duplicate {event_type}: {file_path}")
                        if event_type in ("created", "modified"):
                            await self.add_file(file_path, priority="change")
                        self.event_queue.task_done()
                        continue

                # Record this event
                self._recent_file_events[file_key] = (event_type, current_time)

                # Cleanup old entries to keep dict bounded (max 1000 files)
                if len(self._recent_file_events) > 1000:
                    cutoff = current_time - self._EVENT_HISTORY_RETENTION_SECONDS
                    self._recent_file_events = {
                        k: v for k, v in self._recent_file_events.items()
                        if v[1] > cutoff
                    }

                if event_type in ("created", "modified"):
                    # Use existing add_file method for deduplication and priority
                    await self.add_file(file_path, priority="change")
                    self._debug(f"event {event_type}: {file_path}")
                elif event_type == "deleted":
                    # Handle deletion immediately
                    await self.remove_file(file_path)
                    self._debug(f"event deleted: {file_path}")
                elif event_type == "dir_created":
                    # Handle new directory creation - with recursive monitoring,
                    # we don't need to add individual watches
                    # Index files in new directory
                    await self._index_directory(file_path)
                    self._debug(f"event dir_created: {file_path}")
                elif event_type == "dir_deleted":
                    # Handle directory deletion - cleanup database
                    await self._cleanup_deleted_directory(str(file_path))
                    self._debug(f"event dir_deleted: {file_path}")

                self.event_queue.task_done()

            except Exception as e:
                logger.error(f"Error consuming event: {e}")
                await asyncio.sleep(0.1)  # Brief pause on error

    async def remove_file(self, file_path: Path) -> None:
        """Remove file from database."""
        try:
            logger.debug(f"Removing file from database: {file_path}")
            if file_path.exists():
                # The file might still exist but no longer be eligible for indexing
                # (e.g., ignore/include rules changed). In that case, treat this as
                # an index deletion rather than re-queueing work.
                should_index = True
                try:
                    handler = self._polling_handler or self.event_handler
                    if handler is not None and hasattr(handler, "_should_index"):
                        should_index = bool(handler._should_index(file_path))
                except Exception:
                    should_index = True

                if should_index:
                    logger.debug(f"File still exists; re-queueing change: {file_path}")
                    await self.add_file(file_path, priority="change")
                    return
            self.services.provider.delete_file_completely(str(file_path))
            self._debug(f"removed file from database: {file_path}")
        except Exception as e:
            logger.error(f"Error removing file {file_path}: {e}")

    async def _add_directory_watch(self, dir_path: str) -> None:
        """Add a new directory to monitoring with recursive watching for real-time events."""
        async with self.watch_lock:
            if dir_path not in self.watched_directories:
                if self.observer and self.event_handler:
                    self.observer.schedule(
                        self.event_handler,
                        dir_path,
                        recursive=True,  # Use recursive for dynamically created directories
                    )
                    self.watched_directories.add(dir_path)
                    logger.debug(f"Added recursive watch for new directory: {dir_path}")

    async def _remove_directory_watch(self, dir_path: str) -> None:
        """Remove directory from monitoring and clean up database."""
        async with self.watch_lock:
            if dir_path in self.watched_directories:
                # Note: Watchdog auto-removes watches for deleted dirs
                self.watched_directories.discard(dir_path)

                # Clean up database entries for files in deleted directory
                await self._cleanup_deleted_directory(dir_path)
                logger.debug(f"Removed watch for deleted directory: {dir_path}")

    async def _cleanup_deleted_directory(self, dir_path: str) -> None:
        """Clean up database entries for files in a deleted directory."""
        try:
            # Normalize directory path to DB-relative scope prefix
            base_dir = None
            if hasattr(self.services.provider, "get_base_directory"):
                base_dir = self.services.provider.get_base_directory()

            try:
                scope_prefix = normalize_path_for_lookup(dir_path, base_dir)
            except Exception:
                # Fallback: best-effort normalization
                scope_prefix = str(dir_path).replace("\\", "/").lstrip("/")

            if not scope_prefix or scope_prefix in (".", "/"):
                logger.debug(
                    f"Skipping cleanup for invalid scope prefix: {scope_prefix!r}"
                )
                return

            if not scope_prefix.endswith("/"):
                scope_prefix += "/"

            # Use file-path scoped query (fast) instead of regex over code content
            if not hasattr(self.services.provider, "get_scope_file_paths"):
                logger.warning(
                    "Provider missing get_scope_file_paths; skipping deleted directory cleanup"
                )
                return

            file_paths = self.services.provider.get_scope_file_paths(scope_prefix)

            # Delete each file found in the directory
            for file_path in file_paths:
                logger.debug(f"Cleaning up deleted file: {file_path}")
                self.services.provider.delete_file_completely(file_path)

            logger.info(
                f"Cleaned up {len(file_paths)} files from deleted directory: {dir_path}"
            )

        except Exception as e:
            logger.error(f"Error cleaning up deleted directory {dir_path}: {e}")

    async def _index_directory(self, dir_path: Path) -> None:
        """Index files in a newly created directory."""
        try:
            # Get all supported files in the new directory
            supported_files = []
            for file_path in dir_path.rglob("*"):
                if (
                    file_path.is_file()
                    and self.event_handler
                    and self.event_handler._should_index(file_path)
                ):
                    supported_files.append(file_path)

            # Add files to processing queue
            for file_path in supported_files:
                await self.add_file(file_path, priority="change")

            logger.debug(
                f"Queued {len(supported_files)} files from new directory: {dir_path}"
            )
            self._debug(
                f"queued {len(supported_files)} files from new directory: {dir_path}"
            )

        except Exception as e:
            logger.error(f"Error indexing new directory {dir_path}: {e}")

    async def _embed_missing_for_file(self, file_path: Path) -> None:
        """Generate missing embeddings for a single file."""
        try:
            self._last_embed_activity_time = time.time()
            if not self.services or not hasattr(self.services, "embedding_service"):
                return
            base_dir = None
            if hasattr(self.services.provider, "get_base_directory"):
                base_dir = self.services.provider.get_base_directory()
            try:
                rel_path = normalize_path_for_lookup(file_path, base_dir)
            except Exception:
                rel_path = file_path.as_posix().lstrip("/")

            await self.services.embedding_service.generate_missing_embeddings_for_file(
                rel_path
            )
        except Exception as e:
            logger.warning(f"Embedding generation failed for {file_path}: {e}")

    def _priority_rank(self, priority: str) -> int:
        return 2 if priority == "change" else 1 if priority == "scan" else 0

    def _record_overflow_pending(self, priority: str, file_path: Path) -> None:
        if self._overflow_drain_interval_s <= 0:
            return
        if priority == "embed":
            return
        key = str(file_path)
        existing = self._overflow_pending_files.get(key)
        if existing:
            _, existing_priority = existing
            if self._priority_rank(priority) <= self._priority_rank(existing_priority):
                return
        self._overflow_pending_files[key] = (file_path, priority)

    async def _drain_overflow_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._overflow_drain_interval_s)
                await self._drain_overflow_pending_once()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Overflow drain error: {e}")

    async def _drain_overflow_pending_once(self) -> int:
        if not self._overflow_pending_files:
            return 0
        if self.file_queue.full():
            return 0
        drained = 0
        for key, (path, priority) in list(self._overflow_pending_files.items()):
            if self.file_queue.full():
                break
            if path not in self.pending_files:
                self.pending_files.add(path)
            try:
                self.file_queue.put_nowait((priority, path))
                self._debug(f"drained overflow {path} priority={priority}")
                self._overflow_pending_files.pop(key, None)
                drained += 1
            except asyncio.QueueFull:
                break
        return drained

    def _queue_file(self, priority: str, file_path: Path) -> bool:
        """Queue a file for processing; schedule sweep if queue is full."""
        try:
            self.file_queue.put_nowait((priority, file_path))
            self._debug(f"queued {file_path} priority={priority}")
            return True
        except asyncio.QueueFull:
            logger.warning(f"File queue full; dropping {priority} for {file_path}")
            self._debug(f"file queue full; dropping {priority} for {file_path}")
            if self._overflow_drain_interval_s > 0:
                self._record_overflow_pending(priority, file_path)
            else:
                self.pending_files.discard(file_path)
            self._handle_queue_overflow(priority, file_path)
            return False

    async def _process_loop(self) -> None:
        """Main processing loop - simple and robust."""
        logger.debug("Starting processing loop")

        while True:
            try:
                # Wait for next file (blocks if queue is empty)
                priority, file_path = await self.file_queue.get()

                # Remove from pending set
                self.pending_files.discard(file_path)

                # Check if file still exists (prevent race condition with deletion)
                if not file_path.exists():
                    logger.debug(f"Skipping {file_path} - file no longer exists")
                    self.dirty_files.discard(file_path)
                    continue
                # Avoid indexing mid-write; if unstable, requeue and continue.
                if priority == "change":
                    stable = await self._wait_for_file_stability(file_path)
                    if not stable:
                        if file_path.exists():
                            await self.add_file(file_path, priority="change")
                        else:
                            self.dirty_files.discard(file_path)
                        continue

                # Process the file
                logger.debug(f"Processing {file_path} (priority: {priority})")

                # Fast path for embedding pass: generate missing embeddings for all chunks
                # without re-parsing the file. Keeps the loop snappy and avoids diffing.
                if priority == "embed":
                    try:
                        await self._embed_missing_for_file(file_path)
                    except Exception as e:
                        logger.warning(
                            f"Embedding generation failed in realtime (embed pass): {e}"
                        )
                    finally:
                        self._pending_embed_files.discard(str(file_path))
                    continue

                embed_now = self._realtime_embed_immediate
                if embed_now and self._realtime_embed_backlog > 0:
                    if self.file_queue.qsize() > self._realtime_embed_backlog:
                        embed_now = False

                # Skip embeddings for initial and change events unless configured
                # to embed immediately.
                skip_embeddings = not embed_now

                # Use existing indexing coordinator
                result = await self.services.indexing_coordinator.process_file(
                    file_path, skip_embeddings=skip_embeddings
                )

                # Ensure database transaction is flushed for immediate visibility
                if hasattr(self.services.provider, "flush"):
                    await self.services.provider.flush()

                # If we skipped embeddings (or embedding failed), queue for embedding generation
                if skip_embeddings:
                    await self.add_file(file_path, priority="embed")
                else:
                    try:
                        if isinstance(result, dict) and result.get("embedding_error"):
                            await self.add_file(file_path, priority="embed")
                    except Exception:
                        pass

                # Record processing summary into MCP debug log
                try:
                    chunks = (
                        result.get("chunks", None) if isinstance(result, dict) else None
                    )
                    embeds = (
                        result.get("embeddings", None)
                        if isinstance(result, dict)
                        else None
                    )
                    self._debug(
                        f"processed {file_path} priority={priority} "
                        f"skip_embeddings={skip_embeddings} chunks={chunks} embeddings={embeds}"
                    )
                except Exception:
                    pass
                # If file changed again while processing, requeue it
                if file_path in self.dirty_files:
                    self.dirty_files.discard(file_path)
                    await self.add_file(file_path, priority="change")

            except asyncio.CancelledError:
                logger.debug("Processing loop cancelled")
                raise
            except Exception as e:
                logger.error(f"Error processing {file_path}: {e}")
                # Track failed files for debugging and monitoring
                self.failed_files.add(str(file_path))
                # Continue processing other files

    async def get_stats(self) -> dict:
        """Get current service statistics."""
        # Check if observer is running OR we're using polling mode
        monitoring_active = False
        if self.observer and self.observer.is_alive():
            monitoring_active = True
        elif self._using_polling:
            # If we're using polling mode, consider it "alive"
            monitoring_active = True

        return {
            "queue_size": self.file_queue.qsize(),
            "pending_files": len(self.pending_files),
            "failed_files": len(self.failed_files),
            "scan_complete": self.scan_complete,
            "observer_alive": monitoring_active,
            "watching_directory": str(self.watch_path) if self.watch_path else None,
            "watched_directories_count": len(self.watched_directories),  # Added
        }

    def _handle_queue_overflow(self, event_type: str, file_path: Path) -> None:
        """Schedule a polling sweep to recover from dropped watchdog events."""
        now = time.time()
        if (now - self._last_overflow_time) < self._overflow_debounce_seconds:
            return
        self._last_overflow_time = now
        if not self.watch_path:
            return
        if self._overflow_task and not self._overflow_task.done():
            return
        self._debug(f"queue overflow; scheduling sweep ({event_type}: {file_path})")
        self._overflow_task = asyncio.create_task(self._overflow_sweep())

    def _handle_filter_invalidation(self, event_type: str, file_path: Path) -> None:
        """Invalidate ignore/include caches and trigger a sweep."""
        try:
            if self.event_handler:
                self.event_handler.invalidate_filters()
            if self._polling_handler:
                self._polling_handler.invalidate_filters()
        except Exception:
            pass
        self._debug(f"filters invalidated by {file_path}")
        self._handle_queue_overflow(event_type, file_path)

    async def _overflow_sweep(self) -> None:
        """Run a one-off polling sweep to catch missed changes."""
        if not self.watch_path:
            return
        try:
            await self._scan_for_changes(self.watch_path)
        except Exception as e:
            logger.error(f"Overflow sweep failed: {e}")

    def _build_poll_state(self, stat: os.stat_result) -> tuple[int, int] | tuple[int, int, int]:
        if IS_WINDOWS:
            return (stat.st_mtime_ns, stat.st_size)
        return (stat.st_mtime_ns, stat.st_size, stat.st_ctime_ns)

    def _should_verify_hash(self, file_key: str, stat: os.stat_result, now: float) -> bool:
        if not self._poll_verify_hash:
            return False
        if self._poll_hash_max_size_kb > 0 and stat.st_size > (self._poll_hash_max_size_kb * 1024):
            return False
        last = self._poll_hash_checked.get(file_key)
        if last is None:
            return True
        return (now - last) >= self._poll_hash_interval_s

    def _snapshot_poll_state(self, watch_path: Path) -> dict[str, tuple[int, ...]]:
        """Build a filesystem snapshot for polling/sweeps (runs off the event loop)."""
        if self._polling_handler is None:
            self._polling_handler = SimpleEventHandler(None, self.config, None)

        current_state: dict[str, tuple[int, ...]] = {}
        for file_path in watch_path.rglob("*"):
            try:
                if not file_path.is_file():
                    continue
                if not self._polling_handler._should_index(file_path):
                    continue
                file_key = normalize_file_path(file_path)
                stat = file_path.stat()
                current_state[file_key] = self._build_poll_state(stat)
            except (OSError, PermissionError, FileNotFoundError):
                continue
        return current_state

    async def _scan_for_changes(self, watch_path: Path, emit_changes: bool = True) -> None:
        """Scan filesystem and enqueue new/modified files; remove deleted files."""
        async with self._polling_lock:
            now = time.time()
            hash_budget_deadline: float | None = None
            if emit_changes and self._poll_verify_hash and self._poll_hash_budget_ms > 0:
                hash_budget_deadline = now + (self._poll_hash_budget_ms / 1000.0)

            current_state = await asyncio.to_thread(self._snapshot_poll_state, watch_path)

            if not emit_changes:
                self._poll_state = current_state
                if self._poll_hash_checked:
                    self._poll_hash_checked = {
                        k: v for k, v in self._poll_hash_checked.items() if k in current_state
                    }
                return

            prev_state = self._poll_state
            new_paths: list[Path] = []
            modified_paths: list[Path] = []
            unchanged_keys: list[str] = []

            for file_key, state in current_state.items():
                prev = prev_state.get(file_key)
                if prev is None:
                    new_paths.append(Path(file_key))
                elif prev != state:
                    modified_paths.append(Path(file_key))
                else:
                    unchanged_keys.append(file_key)

            # Update snapshot early to avoid thrashing if downstream actions trigger sweeps.
            self._poll_state = current_state

            for idx, file_path in enumerate(new_paths, 1):
                logger.debug(f"Polling detected new file: {file_path}")
                self._debug(f"polling detected new file: {file_path}")
                await self.add_file(file_path, priority="change")
                if idx % 200 == 0:
                    await asyncio.sleep(0)

            for idx, file_path in enumerate(modified_paths, 1):
                logger.debug(f"Polling detected modified file: {file_path}")
                self._debug(f"polling detected modified file: {file_path}")
                await self.add_file(file_path, priority="change")
                if idx % 200 == 0:
                    await asyncio.sleep(0)

            # Opportunistic checksum verification for a small time budget.
            if hash_budget_deadline:
                for idx, file_key in enumerate(unchanged_keys, 1):
                    if time.time() > hash_budget_deadline:
                        break
                    file_path = Path(file_key)
                    try:
                        stat = file_path.stat()
                    except (OSError, PermissionError, FileNotFoundError):
                        continue
                    if not self._should_verify_hash(file_key, stat, now):
                        continue

                    changed = False
                    try:
                        record = self.services.provider.get_file_by_path(
                            str(file_path), as_model=False
                        )
                        db_hash = (
                            record.get("content_hash") if isinstance(record, dict) else None
                        )
                        if db_hash:
                            cur_hash = await asyncio.to_thread(compute_file_hash, file_path)
                            if cur_hash and cur_hash != db_hash:
                                changed = True
                    except Exception:
                        changed = False

                    self._poll_hash_checked[file_key] = time.time()
                    if changed:
                        logger.debug(f"Polling detected content change: {file_path}")
                        self._debug(f"polling detected content change: {file_path}")
                        await self.add_file(file_path, priority="change")

                    if idx % 200 == 0:
                        await asyncio.sleep(0)

            # Check for deleted files
            deleted_keys = set(prev_state.keys()) - set(current_state.keys())
            for idx, file_key in enumerate(deleted_keys, 1):
                file_path = Path(file_key)
                logger.debug(f"Polling detected deleted file: {file_path}")
                await self.remove_file(file_path)
                self._debug(f"polling detected deleted file: {file_path}")
                self._poll_hash_checked.pop(file_key, None)
                if idx % 200 == 0:
                    await asyncio.sleep(0)
            if self._poll_hash_checked:
                self._poll_hash_checked = {
                    k: v for k, v in self._poll_hash_checked.items() if k in current_state
                }

    async def _wait_for_file_stability(
        self, file_path: Path, max_wait_ms: int = 2000, interval_ms: int = 200
    ) -> bool:
        """Wait briefly for file mtime/size to stabilize; return True if stable."""
        deadline = time.time() + (max_wait_ms / 1000.0)
        last_state: tuple[int, int] | None = None

        while time.time() < deadline:
            try:
                stat = file_path.stat()
            except FileNotFoundError:
                return False

            state = (stat.st_mtime_ns, stat.st_size)
            if last_state is not None and state == last_state:
                return True
            last_state = state
            await asyncio.sleep(interval_ms / 1000.0)

        # If still changing, treat as unstable
        return False

    async def wait_for_monitoring_ready(self, timeout: float = 10.0) -> bool:
        """Wait for filesystem monitoring to be ready."""
        try:
            await asyncio.wait_for(self.monitoring_ready.wait(), timeout=timeout)
            logger.debug("Monitoring became ready after setup")
            return True
        except asyncio.TimeoutError:
            logger.warning(f"Monitoring not ready after {timeout}s")
            return False
