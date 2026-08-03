"""Resolve reproducible application versions from Git commit metadata."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
import re
import subprocess


VERSION_PATTERN = re.compile(r"^\d{4}\.\d{2}\.\d{2}$")
GIT_REVISION_PATTERN = re.compile(r"^(?:HEAD|[0-9a-fA-F]{7,40})$")


@dataclass(frozen=True)
class BuildIdentity:
    version: str
    commit: str


def normalize_version(value: str) -> str:
    candidate = value.strip()
    if not VERSION_PATTERN.fullmatch(candidate):
        raise ValueError(f"Application version must use YYYY.MM.DD: {candidate!r}")
    date.fromisoformat(candidate.replace(".", "-"))
    return candidate


def version_from_commit_date(value: str) -> str:
    return date.fromisoformat(value.strip()).strftime("%Y.%m.%d")


def git_output(repo_root: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", *arguments],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def git_build_identity(repo_root: Path, revision: str = "HEAD") -> BuildIdentity:
    if not GIT_REVISION_PATTERN.fullmatch(revision):
        raise ValueError(f"Invalid Git build revision: {revision!r}")
    metadata = git_output(repo_root, "show", "-s", "--format=%h%n%cs", revision).splitlines()
    if len(metadata) != 2:
        raise ValueError("Git returned incomplete build identity metadata.")
    commit, commit_date = metadata
    return BuildIdentity(version=version_from_commit_date(commit_date), commit=commit)


def fallback_version(version_path: Path) -> str:
    if not version_path.is_file():
        return "development"
    return normalize_version(version_path.read_text(encoding="utf-8"))


def resolve_runtime_version(
    repo_root: Path,
    version_path: Path,
    revision: str | None = "HEAD",
) -> str:
    if revision is None:
        return fallback_version(version_path)
    try:
        return git_build_identity(repo_root, revision).version
    except (FileNotFoundError, subprocess.CalledProcessError, ValueError):
        return fallback_version(version_path)
