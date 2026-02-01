import asyncio
import importlib.util
import os
import subprocess
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

    class _DummyProvider:
        def __init__(self) -> None:
            self.deleted: list[str] = []

        def delete_file_completely(self, file_path: str) -> bool:
            self.deleted.append(file_path)
            return True

    class _ServicesWithProvider:
        def __init__(self, provider: _DummyProvider) -> None:
            self.provider = provider

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

    class _FakeIndexingWithGitIgnore(_FakeIndexing):
        def resolve_ignore_sources(self) -> list[str]:
            return ["gitignore"]

    class _FakeConfigWithGitIgnore(_FakeConfig):
        def __init__(self, target_dir: Path) -> None:
            self.target_dir = Path(target_dir)
            self.indexing = _FakeIndexingWithGitIgnore()

    class _TrackingRealtimeIndexingService(RealtimeIndexingService):
        def __init__(self, config: _FakeConfig) -> None:
            super().__init__(services=_DummyServices(), config=config)
            self.added: list[tuple[Path, str]] = []
            self.removed: list[Path] = []
            self.sweeps = 0

        async def add_file(self, file_path: Path, priority: str = "change") -> None:
            self.added.append((Path(file_path), priority))
            await super().add_file(file_path, priority=priority)

        async def remove_file(self, file_path: Path) -> None:
            self.removed.append(Path(file_path))

        async def _scan_for_changes(self, watch_path: Path) -> None:
            self.sweeps += 1
            await super()._scan_for_changes(watch_path)

    class _PurgeTrackingRealtimeIndexingService(RealtimeIndexingService):
        def __init__(self, services: _ServicesWithProvider, config: _FakeConfig) -> None:
            super().__init__(services=services, config=config)
            self.added: list[tuple[Path, str]] = []

        async def add_file(self, file_path: Path, priority: str = "change") -> None:
            self.added.append((Path(file_path), priority))


class RealtimeIndexingPollingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        if _MISSING_MODULES:
            missing = ", ".join(_MISSING_MODULES)
            self.skipTest(
                f"Missing python deps ({missing}); install chunkhound requirements to run this test."
            )
        self._original_env = os.environ.copy()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.config = _FakeConfig(self.root)
        self.service = _TrackingRealtimeIndexingService(self.config)
        self.service.watch_path = self.root

    async def asyncTearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._original_env)
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

    async def test_polling_purges_newly_ignored_files(self) -> None:
        provider = _DummyProvider()
        config = _FakeConfigWithGitIgnore(self.root)
        service = _PurgeTrackingRealtimeIndexingService(
            services=_ServicesWithProvider(provider), config=config
        )
        service.watch_path = self.root

        # Make this directory a Git repo so repo-aware gitignore logic is active.
        subprocess.run(
            ["git", "init"],
            cwd=self.root,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        file_path = self.root / "ignored.py"
        file_path.write_text("print('ignore me')\n")

        # Baseline scan sees the file and would enqueue it.
        await service._scan_for_changes(self.root)

        # Introduce a new ignore rule; future snapshots should exclude the file.
        (self.root / ".gitignore").write_text("ignored.py\n")
        # Force ignore caches to rebuild for the next snapshot.
        service._polling_handler = None
        service.event_handler = None

        await service._scan_for_changes(self.root)

        self.assertTrue(any(path.endswith("ignored.py") for path in provider.deleted))

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

    async def test_embed_dedupe_does_not_pin_when_pending_change(self) -> None:
        file_path = self.root / "embed.py"
        file_path.write_text("print('embed')\n")

        # Simulate pending change in-flight
        self.service.pending_files.add(file_path)

        # Embed request should be skipped without pinning
        await self.service.add_file(file_path, priority="embed")

        self.assertNotIn(str(file_path), self.service._pending_embed_files)
        # Ensure no embed task was queued
        self.assertTrue(self.service.file_queue.empty())

    async def test_overflow_pending_drains_to_queue(self) -> None:
        os.environ["CHUNKHOUND_FILE_QUEUE_MAXSIZE"] = "1"
        service = _TrackingRealtimeIndexingService(self.config)
        file_a = self.root / "a.py"
        file_b = self.root / "b.py"
        file_a.write_text("print('a')\n")
        file_b.write_text("print('b')\n")

        await service.add_file(file_a, priority="scan")
        await service.add_file(file_b, priority="scan")

        self.assertIn(str(file_b), service._overflow_pending_files)

        # Simulate processing the first item
        service.file_queue.get_nowait()
        service.pending_files.discard(file_a)

        drained = await service._drain_overflow_pending_once()
        self.assertGreaterEqual(drained, 1)
        self.assertNotIn(str(file_b), service._overflow_pending_files)
        queued_priority, queued_path = service.file_queue.get_nowait()
        self.assertEqual(queued_priority, "scan")
        self.assertEqual(queued_path, file_b)

    async def test_overflow_without_drain_clears_pending(self) -> None:
        os.environ["CHUNKHOUND_FILE_QUEUE_MAXSIZE"] = "1"
        os.environ["CHUNKHOUND_FILE_QUEUE_DRAIN_SECONDS"] = "0"
        service = _TrackingRealtimeIndexingService(self.config)
        file_a = self.root / "c.py"
        file_b = self.root / "d.py"
        file_a.write_text("print('c')\n")
        file_b.write_text("print('d')\n")

        await service.add_file(file_a, priority="scan")
        await service.add_file(file_b, priority="scan")

        self.assertNotIn(file_b, service.pending_files)
        self.assertNotIn(str(file_b), service._overflow_pending_files)
