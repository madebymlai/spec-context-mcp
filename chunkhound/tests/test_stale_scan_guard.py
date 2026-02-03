import asyncio
import os
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from chunkhound.core.types.common import Language
from chunkhound.services.batch_processor import ParsedFileResult
from chunkhound.services.indexing_coordinator import IndexingCoordinator


class _DummyDB:
    """Minimal DB stub for IndexingCoordinator.process_directory tests."""

    db_path = ":memory:"


class _FakeIndexing:
    def __init__(self) -> None:
        self.include = ["**/*.py"]
        self.exclude = []
        self.cleanup = False
        self.force_reindex = True
        self.mtime_epsilon_seconds = 0.0
        self.config_file_size_threshold_kb = 0
        self.db_batch_size = 5000


class _FakeConfig:
    def __init__(self, target_dir: Path) -> None:
        self.target_dir = Path(target_dir)
        self.indexing = _FakeIndexing()
        self.database = type("_DBCfg", (), {"max_disk_usage_mb": None})()


class _StaleParseCoordinator(IndexingCoordinator):
    def __init__(self, target_dir: Path, file_path: Path, old_size: int, old_mtime: float) -> None:
        super().__init__(
            database_provider=_DummyDB(),
            base_directory=target_dir,
            embedding_provider=None,
            language_parsers={},
            config=_FakeConfig(target_dir),
        )
        self._file_path = Path(file_path)
        self._old_size = int(old_size)
        self._old_mtime = float(old_mtime)
        self.reindexed: list[Path] = []

    async def _discover_files(  # type: ignore[override]
        self, directory: Path, patterns: list[str] | None = None, exclude_patterns: list[str] | None = None
    ) -> list[Path]:
        return [self._file_path]

    def _cleanup_orphaned_files(  # type: ignore[override]
        self, directory: Path, discovered_files: list[Path], exclude_patterns: list[str] | None
    ) -> int:
        return 0

    async def _process_files_in_batches(  # type: ignore[override]
        self,
        files,
        config_file_size_threshold_kb: int = 20,
        parse_task=None,
        on_batch=None,
    ):
        # Return a "success" parse result with stale stat metadata.
        result = ParsedFileResult(
            file_path=self._file_path,
            chunks=[{"symbol": "", "start_line": 1, "end_line": 1, "code": "print('old')\n", "chunk_type": "code", "language": Language.PYTHON.value}],
            language=Language.PYTHON,
            file_size=self._old_size,
            file_mtime=self._old_mtime,
            status="success",
        )
        if on_batch is not None:
            await on_batch([result])
        return [result]

    async def _store_parsed_results(  # type: ignore[override]
        self, results, file_task=None, cumulative_counters=None
    ):
        # The stale scan guard should have marked results as skipped so they
        # don't overwrite newer on-disk content.
        for r in results:
            if r.file_path == self._file_path:
                assert r.status == "skipped"
                assert r.error == "stale_during_scan"
        return {"total_files": 0, "total_chunks": 0, "errors": [], "chunk_ids_needing_embeddings": []}

    async def process_file(self, file_path: Path, skip_embeddings: bool = False):  # type: ignore[override]
        self.reindexed.append(Path(file_path))
        return {"status": "success", "chunks": 1, "errors": []}


class StaleScanGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_directory_scan_does_not_write_stale_parse_results(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            file_path = root / "example.py"
            file_path.write_text("print('old')\n")
            old_stat = file_path.stat()

            # Ensure filesystem mtime changes for the next write on coarse clocks.
            await asyncio.sleep(0.02)

            file_path.write_text("print('new')\n")
            os.utime(file_path, None)

            coord = _StaleParseCoordinator(
                target_dir=root,
                file_path=file_path,
                old_size=old_stat.st_size,
                old_mtime=old_stat.st_mtime,
            )

            result = await coord.process_directory(root)

            self.assertEqual(result.get("status"), "success")
            self.assertEqual(result.get("stale_during_scan"), 1)
            self.assertEqual(result.get("stale_reindexed"), 1)
            self.assertEqual(result.get("stale_reindex_failed"), 0)
            self.assertEqual(coord.reindexed, [file_path])

    async def test_directory_scan_honors_zero_mtime_epsilon(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            file_path = root / "example.py"
            file_path.write_text("print('old')\n")
            old_stat = file_path.stat()

            coord = _StaleParseCoordinator(
                target_dir=root,
                file_path=file_path,
                old_size=old_stat.st_size,
                old_mtime=old_stat.st_mtime,
            )

            # Simulate a small-but-nonzero mtime change with the same size.
            # With mtime_epsilon_seconds=0.0, the stale scan guard must treat this
            # parse result as stale and reindex it.
            fake_stat = type(
                "_Stat",
                (),
                {"st_size": old_stat.st_size, "st_mtime": old_stat.st_mtime + 0.005},
            )()
            real_stat = Path.stat

            def patched_stat(self):  # type: ignore[no-untyped-def]
                if self == file_path:
                    return fake_stat
                return real_stat(self)

            with mock.patch.object(Path, "stat", new=patched_stat):
                result = await coord.process_directory(root)

            self.assertEqual(result.get("status"), "success")
            self.assertEqual(result.get("stale_during_scan"), 1)
            self.assertEqual(result.get("stale_reindexed"), 1)
            self.assertEqual(result.get("stale_reindex_failed"), 0)
            self.assertEqual(coord.reindexed, [file_path])
