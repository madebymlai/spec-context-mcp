"""Thread-safe serial executor for database operations requiring single-threaded execution."""

import asyncio
import concurrent.futures
import contextvars
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from loguru import logger

from chunkhound.utils.windows_constants import IS_WINDOWS, WINDOWS_FILE_HANDLE_DELAY

# Task-local transaction state to ensure proper isolation in async contexts
_transaction_context = contextvars.ContextVar("transaction_active", default=False)

# Thread-local storage for executor thread state
_executor_local = threading.local()


def get_thread_local_connection(provider: Any, executor: Any | None = None) -> Any:
    """Get thread-local database connection for executor thread.

    This function should ONLY be called from within the executor thread.

    Args:
        provider: Database provider instance that has _create_connection method

    Returns:
        Thread-local database connection

    Raises:
        RuntimeError: If connection creation fails
    """
    if not hasattr(_executor_local, "connection"):
        # Create new connection for this thread
        _executor_local.connection = provider._create_connection()
        if _executor_local.connection is None:
            raise RuntimeError("Failed to create database connection")
        if executor is not None:
            executor._record_connection(_executor_local.connection)
        logger.debug(
            f"Created new connection in executor thread {threading.get_ident()}"
        )
    return _executor_local.connection


def get_thread_local_state() -> dict[str, Any]:
    """Get thread-local state for executor thread.

    This function should ONLY be called from within the executor thread.

    Returns:
        Thread-local state dictionary
    """
    if not hasattr(_executor_local, "state"):
        _executor_local.state = {
            "transaction_active": False,
            "operations_since_checkpoint": 0,
            "last_checkpoint_time": time.time(),
            "last_activity_time": time.time(),  # Track last database activity
            "deferred_checkpoint": False,
            "checkpoint_threshold": 100,  # Checkpoint every N operations
        }
    return dict(_executor_local.state)  # Return a typed dict copy


def track_operation(state: dict[str, Any]) -> None:
    """Track a database operation for checkpoint management.

    This function should ONLY be called from within the executor thread.

    Args:
        state: Thread-local state dictionary
    """
    state["operations_since_checkpoint"] += 1


class SerialDatabaseExecutor:
    """Thread-safe executor for database operations requiring single-threaded execution.

    This executor ensures all database operations are serialized through a single thread,
    which is required for databases like DuckDB and LanceDB that don't support concurrent
    access from multiple threads.
    """

    def __init__(self) -> None:
        """Initialize serial executor with single-threaded pool."""
        # Create single-threaded executor for all database operations
        # This ensures complete serialization and prevents concurrent access issues
        self._db_executor = ThreadPoolExecutor(
            max_workers=1,  # Hardcoded - not configurable
            thread_name_prefix="serial-db",
        )
        self._state_lock = threading.Lock()
        self._last_connection: Any | None = None
        self._current_operation: str | None = None
        self._current_operation_start: float | None = None
        self._last_activity_time: float | None = None
        self._current_operation_id = 0

    def _record_connection(self, conn: Any) -> None:
        with self._state_lock:
            self._last_connection = conn

    def _mark_operation_start(self, operation_name: str) -> int:
        now = time.time()
        with self._state_lock:
            self._current_operation_id += 1
            op_id = self._current_operation_id
            self._current_operation = operation_name
            self._current_operation_start = now
            self._last_activity_time = now
            return op_id

    def _mark_operation_end(self, op_id: int) -> None:
        with self._state_lock:
            if op_id == self._current_operation_id:
                self._current_operation = None
                self._current_operation_start = None
                self._last_activity_time = time.time()

    def _get_operation_snapshot(self) -> tuple[str | None, float | None, float | None]:
        with self._state_lock:
            return (
                self._current_operation,
                self._current_operation_start,
                self._last_activity_time,
            )

    def _interrupt_connection(self) -> bool:
        with self._state_lock:
            conn = self._last_connection
        if conn is None:
            return False
        if not hasattr(conn, "interrupt"):
            return False
        try:
            conn.interrupt()
            return True
        except Exception as e:
            logger.warning(f"Failed to interrupt DB connection: {e}")
            return False

    def _reset_executor(self) -> None:
        """Best-effort reset to recover from a stuck DB thread."""
        try:
            try:
                self._db_executor.shutdown(wait=False, cancel_futures=True)
            except TypeError:
                # Older Python without cancel_futures
                self._db_executor.shutdown(wait=False)
        except Exception as e:
            logger.warning(f"Failed to shutdown DB executor: {e}")

        self._db_executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="serial-db"
        )
        with self._state_lock:
            self._last_connection = None
            self._current_operation = None
            self._current_operation_start = None
            self._current_operation_id = 0

    def execute_sync(
        self, provider: Any, operation_name: str, *args: Any, **kwargs: Any
    ) -> Any:
        """Execute named operation synchronously in DB thread.

        All database operations MUST go through this method to ensure serialization.
        The connection and all state management happens exclusively in the executor thread.

        Args:
            provider: Database provider instance
            operation_name: Name of the executor method to call (e.g., 'search_semantic')
            *args: Positional arguments for the operation
            **kwargs: Keyword arguments for the operation

        Returns:
            The result of the operation, fully materialized
        """

        def executor_operation() -> Any:
            # Get thread-local connection (created on first access)
            conn = get_thread_local_connection(provider, self)

            # Get thread-local state
            state = get_thread_local_state()

            # Update last activity time for ALL operations
            state["last_activity_time"] = time.time()
            op_id = self._mark_operation_start(operation_name)

            # Include base directory if provider has it
            if hasattr(provider, "get_base_directory"):
                state["base_directory"] = provider.get_base_directory()

            # Execute operation - look for method named _executor_{operation_name}
            op_func = getattr(provider, f"_executor_{operation_name}")
            try:
                return op_func(conn, state, *args, **kwargs)
            finally:
                self._mark_operation_end(op_id)

        # Run in executor synchronously with timeout (env override)
        future = self._db_executor.submit(executor_operation)
        import os
        start = time.perf_counter()
        try:
            base_timeout = float(os.getenv("CHUNKHOUND_DB_EXECUTE_TIMEOUT", "30"))
        except Exception:
            base_timeout = 30.0
        try:
            search_timeout = float(os.getenv("CHUNKHOUND_DB_SEARCH_TIMEOUT", str(base_timeout)))
        except Exception:
            search_timeout = base_timeout
        is_search_op = operation_name.startswith("search_") or operation_name in (
            "find_similar_chunks",
            "search_by_embedding",
        )
        timeout_s = search_timeout if is_search_op else base_timeout
        try:
            result = future.result(timeout=timeout_s)
            elapsed_ms = (time.perf_counter() - start) * 1000.0
            try:
                slow_ms = float(os.getenv("CHUNKHOUND_DB_LOG_SLOW_MS", "5000"))
            except Exception:
                slow_ms = 5000.0
            if elapsed_ms >= slow_ms:
                logger.warning(
                    f"Slow DB op '{operation_name}': {elapsed_ms:.1f}ms (slow >= {slow_ms:.0f}ms)"
                )
            else:
                logger.debug(
                    f"DB op '{operation_name}' completed in {elapsed_ms:.1f}ms"
                )
            return result
        except concurrent.futures.TimeoutError:
            active_op, active_start, last_activity = self._get_operation_snapshot()
            active_age = (
                f"{(time.time() - active_start):.1f}s"
                if active_start is not None
                else "unknown"
            )
            last_activity_age = (
                f"{(time.time() - last_activity):.1f}s"
                if last_activity is not None
                else "unknown"
            )
            logger.error(
                f"Database operation '{operation_name}' timed out after {timeout_s} seconds "
                f"(active_op={active_op or 'unknown'} active_age={active_age} last_activity_age={last_activity_age})"
            )
            interrupted = self._interrupt_connection()
            if interrupted:
                logger.warning("Issued interrupt on DB connection after timeout")
            else:
                logger.warning("No DB connection available to interrupt after timeout")

            import os
            reset_on_timeout = os.getenv("CHUNKHOUND_DB_RESET_ON_TIMEOUT", "0").lower() in (
                "1",
                "true",
                "yes",
            )
            if reset_on_timeout:
                logger.warning("Resetting DB executor after timeout to recover")
                self._reset_executor()
            raise TimeoutError(f"Operation '{operation_name}' timed out")

    async def execute_async(
        self, provider: Any, operation_name: str, *args, **kwargs
    ) -> Any:
        """Execute named operation asynchronously in DB thread.

        All database operations MUST go through this method to ensure serialization.
        The connection and all state management happens exclusively in the executor thread.

        Args:
            provider: Database provider instance
            operation_name: Name of the executor method to call (e.g., 'search_semantic')
            *args: Positional arguments for the operation
            **kwargs: Keyword arguments for the operation

        Returns:
            The result of the operation, fully materialized
        """
        loop = asyncio.get_running_loop()

        def executor_operation():
            # Get thread-local connection (created on first access)
            conn = get_thread_local_connection(provider, self)

            # Get thread-local state
            state = get_thread_local_state()

            # Update last activity time for ALL operations
            state["last_activity_time"] = time.time()
            op_id = self._mark_operation_start(operation_name)

            # Include base directory if provider has it
            if hasattr(provider, "get_base_directory"):
                state["base_directory"] = provider.get_base_directory()

            # Execute operation - look for method named _executor_{operation_name}
            op_func = getattr(provider, f"_executor_{operation_name}")
            try:
                return op_func(conn, state, *args, **kwargs)
            finally:
                self._mark_operation_end(op_id)

        # Capture context for async compatibility
        ctx = contextvars.copy_context()

        # Run in executor with context + timeout (env override)
        start = time.perf_counter()
        future = loop.run_in_executor(self._db_executor, ctx.run, executor_operation)
        import os

        try:
            base_timeout = float(os.getenv("CHUNKHOUND_DB_EXECUTE_TIMEOUT", "30"))
        except Exception:
            base_timeout = 30.0
        try:
            search_timeout = float(os.getenv("CHUNKHOUND_DB_SEARCH_TIMEOUT", str(base_timeout)))
        except Exception:
            search_timeout = base_timeout
        is_search_op = operation_name.startswith("search_") or operation_name in (
            "find_similar_chunks",
            "search_by_embedding",
        )
        timeout_s = search_timeout if is_search_op else base_timeout

        try:
            result = await asyncio.wait_for(future, timeout=timeout_s)
        except asyncio.TimeoutError:
            active_op, active_start, last_activity = self._get_operation_snapshot()
            active_age = (
                f"{(time.time() - active_start):.1f}s"
                if active_start is not None
                else "unknown"
            )
            last_activity_age = (
                f"{(time.time() - last_activity):.1f}s"
                if last_activity is not None
                else "unknown"
            )
            logger.error(
                f"Database operation '{operation_name}' timed out after {timeout_s} seconds "
                f"(active_op={active_op or 'unknown'} active_age={active_age} last_activity_age={last_activity_age})"
            )
            interrupted = self._interrupt_connection()
            if interrupted:
                logger.warning("Issued interrupt on DB connection after timeout")
            else:
                logger.warning("No DB connection available to interrupt after timeout")

            reset_on_timeout = os.getenv("CHUNKHOUND_DB_RESET_ON_TIMEOUT", "0").lower() in (
                "1",
                "true",
                "yes",
            )
            if reset_on_timeout:
                logger.warning("Resetting DB executor after timeout to recover")
                self._reset_executor()
            raise TimeoutError(f"Operation '{operation_name}' timed out")

        elapsed_ms = (time.perf_counter() - start) * 1000.0
        try:
            slow_ms = float(os.getenv("CHUNKHOUND_DB_LOG_SLOW_MS", "5000"))
        except Exception:
            slow_ms = 5000.0
        if elapsed_ms >= slow_ms:
            logger.warning(
                f"Slow DB op '{operation_name}': {elapsed_ms:.1f}ms (slow >= {slow_ms:.0f}ms)"
            )
        else:
            logger.debug(f"DB op '{operation_name}' completed in {elapsed_ms:.1f}ms")
        return result

    def shutdown(self, wait: bool = True) -> None:
        """Shutdown the executor with proper cleanup.

        Args:
            wait: Whether to wait for pending operations to complete
        """
        try:
            # Force close any thread-local connections first
            self._force_close_connections()

            # Shutdown the executor
            self._db_executor.shutdown(wait=wait)

            # Windows-specific: Small delay to allow file handles to be released
            if IS_WINDOWS:
                time.sleep(WINDOWS_FILE_HANDLE_DELAY)

        except Exception as e:
            logger.error(f"Error during executor shutdown: {e}")

    def _force_close_connections(self) -> None:
        """Force close any thread-local database connections."""

        def close_connection():
            try:
                if hasattr(_executor_local, "connection"):
                    conn = _executor_local.connection
                    if conn and hasattr(conn, "close"):
                        conn.close()
                        logger.debug("Forced close of thread-local connection")
            except Exception as e:
                logger.error(f"Error force-closing connection: {e}")

        # Submit the close operation to the executor thread
        try:
            future = self._db_executor.submit(close_connection)
            future.result(timeout=2.0)  # Short timeout for cleanup
        except Exception as e:
            logger.error(f"Error during force connection close: {e}")

    def clear_thread_local(self) -> None:
        """Clear thread-local storage (for cleanup).

        This should be called when disconnecting to ensure clean state.
        """
        if hasattr(_executor_local, "connection"):
            delattr(_executor_local, "connection")
        if hasattr(_executor_local, "state"):
            delattr(_executor_local, "state")

    def get_last_activity_time(self) -> float | None:
        """Get the last activity time from the executor thread.

        Returns:
            Last activity timestamp, or None if no activity yet
        """
        with self._state_lock:
            return self._last_activity_time
