from unittest.mock import Mock, patch

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
