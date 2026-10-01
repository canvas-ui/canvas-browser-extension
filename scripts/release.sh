#!/usr/bin/env bash
# release.sh — cut an extension release: bump, commit, push main.
#
#   pnpm run release patch|minor|major      bump, commit, push
#   pnpm run release patch --dry-run        print the plan, change nothing
#
# The version lives in package.json and both manifests (the stores read the
# manifests); this keeps all three in step. Pushing is the whole release:
# release.yml builds both zips and creates the v<version> GitHub Release.
set -euo pipefail

say() { echo "[release $(date '+%H:%M:%S')] $1"; }
die() { echo "[release] ERROR: $1" >&2; exit 1; }

BUMP="${1:-}"; DRY_RUN=false
[[ "$BUMP" =~ ^(patch|minor|major)$ ]] || die "usage: release.sh patch|minor|major [--dry-run]"
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=true

cd "$(git rev-parse --show-toplevel)"
[[ "$(git branch --show-current)" == "main" ]] || die "releases publish from main only"
git update-index -q --refresh >/dev/null 2>&1 || true
git diff-index --quiet HEAD -- || die "working tree has uncommitted changes"
git fetch origin main --quiet || die "git fetch failed"
git merge-base --is-ancestor origin/main main || die "main is behind/diverged from origin/main — pull first"

cur=$(node -p "require('./package.json').version")
if $DRY_RUN; then say "--dry-run: would bump $BUMP from $cur, commit and push main"; exit 0; fi
npm version "$BUMP" --no-git-tag-version >/dev/null
ver=$(node -p "require('./package.json').version")
# Rewrite the manifests' version strings in place — a JSON round-trip would reformat.
for f in manifest-chromium.json manifest-firefox.json; do
    FILE=$f VER=$ver node -e '
const fs = require("fs"), p = process.env.FILE, v = process.env.VER;
const src = fs.readFileSync(p, "utf8"), out = src.replace(/("version"\s*:\s*")[^"]+(")/, `$1${v}$2`);
if (JSON.parse(out).version !== v) { console.error("version rewrite failed in " + p); process.exit(1); }
fs.writeFileSync(p, out);'
done
git commit --quiet -am "canvas-browser-extension $ver"
git push --quiet origin main
say "Pushed canvas-browser-extension $ver — release.yml builds both zips. Watch: gh run list --workflow=release.yml --limit 1"
