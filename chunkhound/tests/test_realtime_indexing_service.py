import asyncio
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

_REQUIRED_MODULES = ("loguru", "watchdog", "pathspec")
_MISSING_MODULES = [
    name for name in _REQUIRED_MODULES if importlib.util.find_spec(name) is None
]

if not _MISSING_MODULES:
    _MODULE_PATH = (
        Path(__file__).resolve().parents[1]
        / "services"
        / "realtime_indexing_service.py"
    )
    _spec = importlib.util.spec_from_file_location(
        "chunkhound_realtime_indexing_service", _MODULE_PATH
    )
    if _spec is None or _spec.loader is None:
        raise RuntimeError("Failed to load realtime_indexing_service module for tests")
    _module = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_module)
    RealtimeIndexingService = _module.RealtimeIndexingService

    class _DummyServices:
        pass

    class _FakeIndexing:
        def __init__(self) -> None:
            self.include = ["**/*.py"]
            self.exclude = []
            self.chignore_file = ".chignore"
            self.workspace_gitignore_nonrepo = False

        def resolve_ignore_sources(self) -> list[str]:
            return []

        def get_effective_config_excludes(self) -> list[str]:
            return []

    class _FakeConfig:
        def __init__(self, target_dir: Path) -> None:
            self.target_dir = Path(target_dir)
            self.indexing = _FakeIndexing()

    class _TrackingRealtimeIndexingService(RealtimeIndexingService):
        def __init__(self, config: _FakeConfig) -> None:
            super().__init__(services=_DummyServices(), config=config)
            self.added: list[tuple[Path, str]] = []
            self.removed: list[Path] = []
            self.sweeps = 0

        async def add_file(self, file_path: Path, priority: str = "change") -> None:
            self.added.append((Path(file_path), priority))

        async def remove_file(self, file_path: Path) -> None:
            self.removed.append(Path(file_path))

        async def _scan_for_changes(self, watch_path: Path) -> None:
            self.sweeps += 1
            await super()._scan_for_changes(watch_path)


class RealtimeIndexingPollingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        if _MISSING_MODULES:
            missing = ", ".join(_MISSING_MODULES)
            self.skipTest(
                f"Missing python deps ({missing}); install chunkhound requirements to run this test."
            )
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.config = _FakeConfig(self.root)
        self.service = _TrackingRealtimeIndexingService(self.config)
        self.service.watch_path = self.root

    async def asyncTearDown(self) -> None:
        self.temp_dir.cleanup()

    async def test_polling_detects_modified_files(self) -> None:
        file_path = self.root / "example.py"
        file_path.write_text("print('a')\n")
        await self.service._scan_for_changes(self.root)
        self.service.added.clear()

        file_path.write_text("print('changed')\n")
        os.utime(file_path, None)

        await self.service._scan_for_changes(self.root)

        self.assertEqual(len(self.service.added), 1)
        self.assertEqual(self.service.added[0][0], file_path)

    async def test_polling_detects_deleted_files(self) -> None:
        file_path = self.root / "gone.py"
        file_path.write_text("print('bye')\n")
        await self.service._scan_for_changes(self.root)
        self.service.removed.clear()

        file_path.unlink()
        await self.service._scan_for_changes(self.root)

        self.assertEqual(self.service.removed, [file_path])

    async def test_queue_overflow_triggers_sweep(self) -> None:
        file_path = self.root / "overflow.py"
        file_path.write_text("print('x')\n")

        self.service._handle_queue_overflow("modified", file_path)
        if self.service._overflow_task:
            await self.service._overflow_task

        self.assertGreaterEqual(self.service.sweeps, 1)
        self.assertTrue(any(path == file_path for path, _ in self.service.added))

    async def test_wait_for_file_stability(self) -> None:
        file_path = self.root / "stable.py"
        file_path.write_text("print('stable')\n")

        stable = await self.service._wait_for_file_stability(
            file_path, max_wait_ms=500, interval_ms=50
        )
        self.assertTrue(stable)

    async def test_wait_for_file_stability_returns_false_when_changing(self) -> None:
        file_path = self.root / "flapping.py"
        file_path.write_text("0")

        async def writer() -> None:
            for i in range(10):
                file_path.write_text("x" * (i + 1))
                await asyncio.sleep(0.05)

        writer_task = asyncio.create_task(writer())
        stable = await self.service._wait_for_file_stability(
            file_path, max_wait_ms=200, interval_ms=50
        )
        await writer_task

        self.assertFalse(stable)
