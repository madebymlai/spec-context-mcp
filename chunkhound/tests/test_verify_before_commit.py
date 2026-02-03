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
    """Minimal DB stub (we should never write on stale)."""

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


class _StaleProcessFileCoordinator(IndexingCoordinator):
    def __init__(
        self,
        target_dir: Path,
        file_path: Path,
        parsed_size: int,
        parsed_mtime: float,
    ) -> None:
        super().__init__(
            database_provider=_DummyDB(),
            base_directory=target_dir,
            embedding_provider=None,
            language_parsers={},
            config=_FakeConfig(target_dir),
        )
        self._file_path = Path(file_path)
        self._parsed_size = int(parsed_size)
        self._parsed_mtime = float(parsed_mtime)
        self.store_called = False

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
            chunks=[
                {
                    "symbol": "",
                    "start_line": 1,
                    "end_line": 1,
                    "code": "print('old')\n",
                    "chunk_type": "code",
                    "language": Language.PYTHON.value,
                }
            ],
            language=Language.PYTHON,
            file_size=self._parsed_size,
            file_mtime=self._parsed_mtime,
            status="success",
        )
        return [result]

    async def _store_parsed_results(  # type: ignore[override]
        self, results, file_task=None, cumulative_counters=None
    ):
        self.store_called = True
        return {"total_files": 1, "total_chunks": 1, "errors": []}, 1


class VerifyBeforeCommitTests(unittest.IsolatedAsyncioTestCase):
    async def test_process_file_returns_stale_when_file_changed_after_parse(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            file_path = root / "example.py"

            file_path.write_text("print('old')\n")
            old_stat = file_path.stat()

            # Ensure mtime changes on coarse filesystems.
            await asyncio.sleep(0.02)

            file_path.write_text("print('new')\n")
            os.utime(file_path, None)

            coord = _StaleProcessFileCoordinator(
                target_dir=root,
                file_path=file_path,
                parsed_size=old_stat.st_size,
                parsed_mtime=old_stat.st_mtime,
            )

            result = await coord.process_file(file_path, skip_embeddings=True)

            self.assertEqual(result.get("status"), "stale")
            self.assertFalse(coord.store_called)

    async def test_process_file_honors_zero_mtime_epsilon(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            file_path = root / "example.py"

            file_path.write_text("print('old')\n")
            old_stat = file_path.stat()

            coord = _StaleProcessFileCoordinator(
                target_dir=root,
                file_path=file_path,
                parsed_size=old_stat.st_size,
                parsed_mtime=old_stat.st_mtime,
            )

            # Simulate a small-but-nonzero mtime change with same size.
            # With mtime_epsilon_seconds=0.0, this must be treated as stale.
            fake_stat = type(
                "_Stat",
                (),
                {"st_size": old_stat.st_size, "st_mtime": old_stat.st_mtime + 0.005},
            )()
            with mock.patch.object(Path, "stat", return_value=fake_stat):
                result = await coord.process_file(file_path, skip_embeddings=True)

            self.assertEqual(result.get("status"), "stale")
            self.assertFalse(coord.store_called)
