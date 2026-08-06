import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.build_identity import (
    BuildIdentity,
    fallback_version,
    git_build_identity,
    normalize_version,
    resolve_runtime_version,
    version_from_commit_date,
)


class BuildIdentityTests(unittest.TestCase):
    def test_normalizes_real_calendar_dates_only(self):
        self.assertEqual(normalize_version(" 2026.07.30\n"), "2026.07.30")
        self.assertEqual(normalize_version("2026.07.30.1"), "2026.07.30.1")
        for value in ("2026.7.30", "2026.02.30", "2026.07.30.0", "2026.07.30.01", "release-2026.07.30"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_version(value)

    def test_converts_git_commit_date_to_distribution_version(self):
        self.assertEqual(version_from_commit_date("2026-07-30"), "2026.07.30")

    def test_rejects_revision_options_before_invoking_git(self):
        with self.assertRaisesRegex(ValueError, "Invalid Git build revision"):
            git_build_identity(Path("/repo"), "--show-signature")

    @patch("backend.build_identity.git_build_identity")
    def test_source_checkout_uses_the_requested_commit_date(self, identity):
        identity.return_value = BuildIdentity(version="2026.07.30", commit="eb46c97")

        version = resolve_runtime_version(Path("/repo"), Path("/repo/VERSION"), "eb46c97")

        self.assertEqual(version, "2026.07.30")
        identity.assert_called_once_with(Path("/repo"), "eb46c97")

    @patch("backend.build_identity.git_build_identity")
    def test_distribution_marker_uses_version_without_searching_parent_git(self, identity):
        with tempfile.TemporaryDirectory() as temp:
            version_path = Path(temp) / "VERSION"
            version_path.write_text("2026.07.30\n", encoding="utf-8")

            self.assertEqual(
                resolve_runtime_version(Path(temp) / "app", version_path, None),
                "2026.07.30",
            )
        identity.assert_not_called()

    @patch("backend.build_identity.git_build_identity")
    def test_distribution_marker_accepts_a_same_day_release_sequence(self, identity):
        with tempfile.TemporaryDirectory() as temp:
            version_path = Path(temp) / "VERSION"
            version_path.write_text("2026.07.30.2\n", encoding="utf-8")

            self.assertEqual(
                resolve_runtime_version(Path(temp) / "app", version_path, None),
                "2026.07.30.2",
            )
        identity.assert_not_called()

    @patch("backend.build_identity.git_build_identity")
    def test_source_without_git_falls_back_to_validated_version_file(self, identity):
        identity.side_effect = subprocess.CalledProcessError(128, ["git"])
        with tempfile.TemporaryDirectory() as temp:
            version_path = Path(temp) / "VERSION"
            version_path.write_text("2026.07.30\n", encoding="utf-8")

            self.assertEqual(
                resolve_runtime_version(Path(temp) / "app", version_path),
                "2026.07.30",
            )

    def test_missing_version_metadata_is_explicitly_development(self):
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(fallback_version(Path(temp) / "VERSION"), "development")


if __name__ == "__main__":
    unittest.main()
