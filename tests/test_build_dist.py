from unittest.mock import Mock, patch

import pytest

from scripts import build_dist


@patch("scripts.build_dist.subprocess.run")
def test_git_build_identity_uses_head_commit_date(run):
    run.return_value = Mock(stdout="d02bb7a\n2026-08-04\n")

    commit, version = build_dist.git_build_identity()

    assert commit == "d02bb7a"
    assert version == "2026.08.04"
    run.assert_called_once_with(
        ["git", "show", "-s", "--format=%h%n%cs", "HEAD"],
        cwd=build_dist.REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )


@patch("scripts.build_dist.subprocess.run")
def test_git_build_identity_rejects_incomplete_metadata(run):
    run.return_value = Mock(stdout="d02bb7a\n")

    try:
        build_dist.git_build_identity()
    except RuntimeError as error:
        assert str(error) == "Git returned incomplete build identity metadata"
    else:
        raise AssertionError("incomplete Git metadata should fail the build")


@patch("scripts.build_dist.subprocess.run")
def test_git_worktree_dirty_ignores_untracked_distribution_artifacts(run):
    run.return_value = Mock(stdout=" M main.py\n")

    assert build_dist.git_worktree_dirty()
    run.assert_called_once_with(
        ["git", "status", "--porcelain", "--untracked-files=no"],
        cwd=build_dist.REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )


def test_release_build_version_can_add_a_same_day_sequence(monkeypatch):
    monkeypatch.setenv(build_dist.BUILD_VERSION_ENV, "2026.08.06.1")

    assert build_dist.resolved_build_version("2026.08.06") == "2026.08.06.1"


def test_release_build_version_cannot_claim_a_different_calendar_date(monkeypatch):
    monkeypatch.setenv(build_dist.BUILD_VERSION_ENV, "2026.08.07")

    with pytest.raises(RuntimeError, match="does not match HEAD commit date"):
        build_dist.resolved_build_version("2026.08.06")
