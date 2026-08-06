#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib
from datetime import date
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

normalize_version = importlib.import_module("backend.build_identity").normalize_version


DIST_DIR = REPO_ROOT / "dist"
BUILD_VERSION_ENV = "EH_ADMIN_TOOLS_BUILD_VERSION"

ROOT_FILES = {
    ".env.example": ".env.example",
    "start.sh": "start.sh",
    "START-HERE.command": "START-HERE.command",
    "README-DIST.md": "README.md",
    "requirements.lock": "requirements.lock",
    "THIRD_PARTY_NOTICES.md": "THIRD_PARTY_NOTICES.md",
}

APP_FILES = [
    "main.py",
    "index.html",
    "catalog.eh.json",
    "favicon.png",
]

APP_TREES = {
    "backend": {".py"},
    "css": {".css", ".woff2"},
    "js": {".js"},
    "assets": {".svg", ".png"},
}

LICENSE_TREE = ("licenses", {"", ".md", ".txt"})
FONT_TREE = ("fonts", {".ttf"})


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_file(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"Required distribution file is missing: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def copy_tree(source_dir: Path, destination_dir: Path, suffixes: set[str]) -> None:
    if not source_dir.is_dir():
        raise FileNotFoundError(f"Required distribution directory is missing: {source_dir}")
    for source in sorted(source_dir.rglob("*")):
        if source.is_file() and source.suffix in suffixes:
            copy_file(source, destination_dir / source.relative_to(source_dir))


def git_build_identity() -> tuple[str, str]:
    metadata = subprocess.run(
        ["git", "show", "-s", "--format=%h%n%cs", "HEAD"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    if len(metadata) != 2:
        raise RuntimeError("Git returned incomplete build identity metadata")
    commit, commit_date = metadata
    version = date.fromisoformat(commit_date).strftime("%Y.%m.%d")
    return commit, version


def git_worktree_dirty() -> bool:
    return bool(
        subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=no"],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    )


def resolved_build_version(commit_version: str) -> str:
    requested = os.environ.get(BUILD_VERSION_ENV)
    if not requested:
        return commit_version
    version = normalize_version(requested)
    if version[:10] != commit_version:
        raise RuntimeError(
            f"{BUILD_VERSION_ENV} date {version[:10]} does not match HEAD commit date {commit_version}"
        )
    return version


def make_checksum_manifest(package_root: Path) -> None:
    files = [
        path
        for path in sorted(package_root.rglob("*"))
        if path.is_file() and path.name != "SHA256SUMS"
    ]
    manifest = "".join(
        f"{sha256(path)}  {path.relative_to(package_root).as_posix()}\n"
        for path in files
    )
    (package_root / "SHA256SUMS").write_text(manifest, encoding="utf-8")


def validate_package(package_root: Path) -> None:
    required = [
        "START-HERE.command",
        ".env.example",
        "start.sh",
        "README.md",
        "VERSION",
        "COMMIT",
        "requirements.lock",
        "app/main.py",
        "app/index.html",
        "app/backend/build_identity.py",
        "app/backend/extrahop_client.py",
        "app/backend/locality_imports.py",
        "app/backend/pcap_analyzer/analyzer.py",
        "app/backend/pcap_analyzer/jobs.py",
        "app/backend/system_health_pdf.py",
        "app/css/styles.css",
        "app/assets/eh-logo-black.svg",
        "app/assets/eh-logo-color.png",
        "app/assets/eh-logo-white.svg",
        "app/assets/eh-logo-white.png",
        "app/assets/system-health-cover-classichop.png",
        "app/assets/system-health-cover-reveal-x.png",
        "app/js/theme-init.js",
        "app/js/utils/csv.js",
        "app/js/utils/deployment-capabilities.js",
        "app/js/utils/feature-registry.js",
        "app/js/utils/report-cache-validation.js",
        "app/js/modules/chart-theme.js",
        "app/js/modules/pcap-analyzer.js",
        "app/js/modules/system-health-collection.js",
        "app/js/modules/system-health-view-model.js",
        "app/js/vendor/chart.umd.min.js",
        "app/js/vendor/d3.min.js",
        "app/js/vendor/pptxgen.bundle.js",
        "app/catalog.eh.json",
        "fonts/SourceSans3-Regular.ttf",
        "fonts/SourceSans3-Bold.ttf",
        "SHA256SUMS",
    ]
    missing = [name for name in required if not (package_root / name).is_file()]
    if missing:
        raise RuntimeError(f"Distribution is incomplete: {', '.join(missing)}")

    forbidden_parts = {
        ".git",
        ".venv",
        ".runtime",
        "__pycache__",
        "logs",
        "chart-themes",
        "api-response-cache",
        "tests",
        "dist",
        "node_modules",
    }
    for path in package_root.rglob("*"):
        if forbidden_parts.intersection(path.relative_to(package_root).parts):
            raise RuntimeError(f"Forbidden path included in distribution: {path}")


def write_zip(package_root: Path, zip_path: Path) -> None:
    if zip_path.exists():
        zip_path.unlink()

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source in sorted(package_root.rglob("*")):
            if not source.is_file():
                continue
            archive_name = f"{package_root.name}/{source.relative_to(package_root).as_posix()}"
            info = zipfile.ZipInfo.from_file(source, arcname=archive_name)
            mode = source.stat().st_mode
            if source.name in {"start.sh", "START-HERE.command"}:
                mode |= stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH
            info.external_attr = (mode & 0xFFFF) << 16
            with source.open("rb") as handle:
                archive.writestr(
                    info,
                    handle.read(),
                    compress_type=zipfile.ZIP_DEFLATED,
                    compresslevel=9,
                )


def build() -> Path:
    commit, commit_version = git_build_identity()
    version = resolved_build_version(commit_version)
    if git_worktree_dirty():
        commit = f"{commit}-dirty"
    package_name = f"eh-admin-tools-{version}"
    DIST_DIR.mkdir(exist_ok=True)
    zip_path = DIST_DIR / f"{package_name}.zip"

    with tempfile.TemporaryDirectory(prefix="eh-admin-tools-dist-") as temp:
        package_root = Path(temp) / package_name
        app_root = package_root / "app"
        package_root.mkdir()

        for source_name, destination_name in ROOT_FILES.items():
            copy_file(REPO_ROOT / source_name, package_root / destination_name)
        (package_root / "VERSION").write_text(f"{version}\n", encoding="utf-8")
        (package_root / "COMMIT").write_text(f"{commit}\n", encoding="utf-8")

        for source_name in APP_FILES:
            copy_file(REPO_ROOT / source_name, app_root / source_name)

        for tree_name, suffixes in APP_TREES.items():
            copy_tree(REPO_ROOT / tree_name, app_root / tree_name, suffixes)

        license_name, license_suffixes = LICENSE_TREE
        copy_tree(
            REPO_ROOT / license_name,
            package_root / license_name,
            license_suffixes,
        )
        font_name, font_suffixes = FONT_TREE
        copy_tree(
            REPO_ROOT / font_name,
            package_root / font_name,
            font_suffixes,
        )

        for launcher in (package_root / "start.sh", package_root / "START-HERE.command"):
            launcher.chmod(0o755)

        make_checksum_manifest(package_root)
        validate_package(package_root)
        write_zip(package_root, zip_path)

    checksum_path = zip_path.with_suffix(".zip.sha256")
    checksum_path.write_text(f"{sha256(zip_path)}  {zip_path.name}\n", encoding="utf-8")
    return zip_path


if __name__ == "__main__":
    artifact = build()
    print(artifact)
    print(artifact.with_suffix(".zip.sha256"))
