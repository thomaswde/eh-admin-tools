#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage:
  scripts/publish_github_release.sh --sync-only
  scripts/publish_github_release.sh [--notes-file PATH]

Publishes the authoritative GitLab main branch to GitHub. Release mode also
runs all release gates, builds the distribution, creates v<VERSION>, pushes
that tag to both remotes, and creates the GitHub release.

Options:
  --sync-only         Mirror main to GitHub without creating a release.
  --notes-file PATH   Use Markdown release notes instead of generated notes.
  -h, --help          Show this help.

Environment overrides:
  GITLAB_REMOTE       Authoritative remote name (default: gitlab)
  GITHUB_REMOTE       Public mirror remote name (default: github)
  GITHUB_REPOSITORY   GitHub owner/repository (default: thomaswde/eh-admin-tools)
EOF
}

mode=release
notes_file=
while (($#)); do
    case "$1" in
        --sync-only)
            mode=sync
            shift
            ;;
        --notes-file)
            [[ $# -ge 2 ]] || { echo "error: --notes-file requires a path" >&2; exit 2; }
            notes_file=$2
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [[ $mode == sync && -n $notes_file ]]; then
    echo "error: --notes-file cannot be used with --sync-only" >&2
    exit 2
fi

GITLAB_REMOTE=${GITLAB_REMOTE:-gitlab}
GITHUB_REMOTE=${GITHUB_REMOTE:-github}
GITHUB_REPOSITORY=${GITHUB_REPOSITORY:-thomaswde/eh-admin-tools}

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "error: run this script from the eh-admin-tools repository" >&2
    exit 1
}
cd "$repo_root"

for command in git; do
    command -v "$command" >/dev/null || { echo "error: required command not found: $command" >&2; exit 1; }
done
for remote in "$GITLAB_REMOTE" "$GITHUB_REMOTE"; do
    git remote get-url "$remote" >/dev/null 2>&1 || {
        echo "error: Git remote '$remote' is not configured" >&2
        exit 1
    }
done

if [[ -n $(git status --porcelain) ]]; then
    echo "error: the working tree must be clean" >&2
    git status --short >&2
    exit 1
fi
if [[ $(git branch --show-current) != main ]]; then
    echo "error: releases must be published from main" >&2
    exit 1
fi

printf 'Fetching %s and %s...\n' "$GITLAB_REMOTE" "$GITHUB_REMOTE"
git fetch --prune --tags "$GITLAB_REMOTE"
git fetch --prune --tags "$GITHUB_REMOTE"

head_commit=$(git rev-parse HEAD)
gitlab_main=$(git rev-parse "$GITLAB_REMOTE/main")
if [[ $head_commit != "$gitlab_main" ]]; then
    echo "error: HEAD must exactly match authoritative $GITLAB_REMOTE/main" >&2
    echo "       HEAD:                 $head_commit" >&2
    echo "       $GITLAB_REMOTE/main: $gitlab_main" >&2
    exit 1
fi
if ! git merge-base --is-ancestor "$GITHUB_REMOTE/main" HEAD; then
    echo "error: $GITHUB_REMOTE/main contains commits not present in authoritative main" >&2
    echo "       reconcile those commits in GitLab before publishing" >&2
    exit 1
fi

if [[ $mode == sync ]]; then
    git push "$GITHUB_REMOTE" HEAD:refs/heads/main
    echo "GitHub main now matches GitLab main at $(git rev-parse --short HEAD)."
    exit 0
fi

for command in gh npm node python3; do
    command -v "$command" >/dev/null || { echo "error: required command not found: $command" >&2; exit 1; }
done
gh auth status --hostname github.com >/dev/null

if [[ -n $notes_file && ! -f $notes_file ]]; then
    echo "error: release notes file not found: $notes_file" >&2
    exit 1
fi

version=$(tr -d '[:space:]' < VERSION)
package_version=$(python3 - "$version" <<'PY'
from datetime import date
import re
import sys

value = sys.argv[1]
if not re.fullmatch(r"\d{4}\.\d{2}\.\d{2}", value):
    raise SystemExit("error: VERSION must use YYYY.MM.DD")
year, month, day = map(int, value.split("."))
date(year, month, day)
print(f"{year}.{month}.{day}")
PY
)

python3 - "$package_version" <<'PY'
import json
from pathlib import Path
import sys

expected = sys.argv[1]
for name in ("package.json", "package-lock.json"):
    value = json.loads(Path(name).read_text(encoding="utf-8")).get("version")
    if value != expected:
        raise SystemExit(f"error: {name} version is {value!r}; expected {expected!r} from VERSION")
PY

tag="v$version"
if git show-ref --verify --quiet "refs/tags/$tag"; then
    tag_commit=$(git rev-parse "refs/tags/$tag^{}")
    if [[ $tag_commit != "$head_commit" ]]; then
        echo "error: $tag already points to $tag_commit, not HEAD $head_commit" >&2
        exit 1
    fi
fi
if gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
    echo "error: GitHub release $tag already exists" >&2
    exit 1
fi

release_venv=$(mktemp -d "${TMPDIR:-/tmp}/eh-admin-tools-release.XXXXXX")
trap 'rm -rf "$release_venv"' EXIT

printf '%s\n' 'Running JavaScript release gates...'
npm ci
npm run check

printf '%s\n' 'Running Python release gates...'
python3 -m venv "$release_venv"
"$release_venv/bin/python" -m pip install --disable-pip-version-check -r requirements-dev.txt
"$release_venv/bin/python" -m pytest -q
"$release_venv/bin/python" -m ruff check main.py backend tests

printf '%s\n' 'Building distribution...'
"$release_venv/bin/python" scripts/build_dist.py
git diff --check

zip_path="dist/eh-admin-tools-$version.zip"
checksum_path="$zip_path.sha256"
[[ -f $zip_path && -f $checksum_path ]] || {
    echo "error: expected release artifacts were not created" >&2
    exit 1
}
python3 - "$zip_path" "$checksum_path" <<'PY'
import hashlib
from pathlib import Path
import sys

archive = Path(sys.argv[1])
manifest = Path(sys.argv[2]).read_text(encoding="utf-8").strip().split()
if len(manifest) != 2 or manifest[1] != archive.name:
    raise SystemExit("error: malformed distribution checksum manifest")
actual = hashlib.sha256(archive.read_bytes()).hexdigest()
if actual != manifest[0]:
    raise SystemExit("error: distribution checksum verification failed")
print(f"{archive}: OK")
PY

# Catch an authoritative update that landed while the release gates were running.
git fetch --prune "$GITLAB_REMOTE" main
if [[ $(git rev-parse "$GITLAB_REMOTE/main") != "$head_commit" ]]; then
    echo "error: $GITLAB_REMOTE/main changed during the release; restart from its new head" >&2
    exit 1
fi

if ! git show-ref --verify --quiet "refs/tags/$tag"; then
    git tag -a "$tag" -m "ExtraHop Admin Tools $version"
fi

# Keep release identity authoritative in GitLab before publishing the mirror.
git push "$GITLAB_REMOTE" "refs/tags/$tag"
git push "$GITHUB_REMOTE" HEAD:refs/heads/main "refs/tags/$tag"

release_args=(
    release create "$tag"
    "$zip_path"
    "$checksum_path"
    --repo "$GITHUB_REPOSITORY"
    --verify-tag
    --title "ExtraHop Admin Tools $version"
)
if [[ -n $notes_file ]]; then
    release_args+=(--notes-file "$notes_file")
else
    release_args+=(--generate-notes)
fi

gh "${release_args[@]}"
echo "Published $tag from GitLab commit $(git rev-parse --short HEAD)."
