import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from chunkhound.core.config.indexing_config import IndexingConfig
from chunkhound.services.indexing_coordinator import IndexingCoordinator
from chunkhound.utils.file_patterns import normalize_include_patterns


class _DummyDB:
    """Minimal DB stub for IndexingCoordinator discovery tests."""

    db_path = None


def _run_git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


class GitBackendGitignoreTrackedFilesTests(unittest.TestCase):
    def setUp(self) -> None:
        if shutil.which("git") is None:
            self.skipTest("git is required for this test")
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)

        _run_git(self.repo, "init")
        _run_git(self.repo, "config", "user.email", "test@example.com")
        _run_git(self.repo, "config", "user.name", "Test User")

        # Ignore all spec context by default, but explicitly allow steering docs.
        (self.repo / ".gitignore").write_text(
            "\n".join(
                [
                    ".spec-context/**",
                    "!.spec-context/steering/",
                    "!.spec-context/steering/**",
                    "",
                ]
            ),
            encoding="utf-8",
        )

        # Create one tracked file that *matches* the ignore pattern (forced add),
        # and one tracked file that is explicitly un-ignored.
        archived = self.repo / ".spec-context" / "archive" / "specs" / "test" / "tasks.md"
        archived.parent.mkdir(parents=True, exist_ok=True)
        archived.write_text("# archived\n", encoding="utf-8")

        steering = self.repo / ".spec-context" / "steering" / "product.md"
        steering.parent.mkdir(parents=True, exist_ok=True)
        steering.write_text("# steering\n", encoding="utf-8")

        _run_git(self.repo, "add", ".gitignore")
        _run_git(self.repo, "add", steering.relative_to(self.repo).as_posix())
        _run_git(self.repo, "add", "-f", archived.relative_to(self.repo).as_posix())
        _run_git(self.repo, "commit", "-m", "fixture")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_git_backend_filters_tracked_files_ignored_by_gitignore(self) -> None:
        idx = IndexingConfig()
        coordinator = IndexingCoordinator(
            database_provider=_DummyDB(),
            base_directory=self.repo,
            embedding_provider=None,
            language_parsers={},
            config=type("Cfg", (), {"indexing": idx, "target_dir": self.repo})(),
        )

        patterns = normalize_include_patterns(["**/*.md"])
        files = coordinator._discover_files_via_git(  # type: ignore[attr-defined]
            directory=self.repo,
            patterns=patterns,
            exclude_patterns=[],
            fallback_to_python=False,
        )

        rels = {p.relative_to(self.repo).as_posix() for p in (files or [])}

        # The steering doc is un-ignored and should still be discovered.
        self.assertIn(".spec-context/steering/product.md", rels)
        # The archive doc is tracked but matches an ignore rule; it should be filtered out.
        self.assertNotIn(".spec-context/archive/specs/test/tasks.md", rels)
