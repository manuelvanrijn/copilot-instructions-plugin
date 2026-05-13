#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh [patch|minor|major]
# Bumps version, updates CHANGELOG.md, commits, tags, and pushes.

BUMP="${1:-patch}"
CHANGELOG="CHANGELOG.md"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]" >&2
  exit 1
fi

# Ensure clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

# Get current version from package.json
CURRENT=$(node -p "require('./package.json').version")

# Bump version
npm version "$BUMP" --no-git-tag-version
NEW=$(node -p "require('./package.json').version")

echo "Bumping $CURRENT → $NEW"

# Update CHANGELOG: replace ## Unreleased with versioned header + add new Unreleased
DATE=$(date +%Y-%m-%d)
VERSIONED_HEADER="## v${NEW} — ${DATE}"

if ! grep -q "^## Unreleased" "$CHANGELOG"; then
  echo "No '## Unreleased' section found in $CHANGELOG" >&2
  exit 1
fi

# Replace first occurrence of ## Unreleased with versioned header
# then prepend a new ## Unreleased block at the top (after # Changelog)
TMP=$(mktemp)

awk -v header="$VERSIONED_HEADER" '
  /^## Unreleased/ && !replaced {
    print header
    replaced=1
    next
  }
  { print }
' "$CHANGELOG" > "$TMP"

# Insert new Unreleased section after the first line (# Changelog)
awk '
  NR==1 { print; print ""; print "## Unreleased"; print ""; next }
  { print }
' "$TMP" > "$CHANGELOG"

rm "$TMP"

# Update version references in README.md
sed -i '' "s/@manuelvanrijn\/copilot-instructions-plugin@${CURRENT}/@manuelvanrijn\/copilot-instructions-plugin@${NEW}/g" README.md

# Commit, tag, push
git add package.json "$CHANGELOG" README.md
git commit -m "chore: release v${NEW}"
git tag "v${NEW}"
git push origin main
git push origin "v${NEW}"

echo ""
echo "Released v${NEW} — GitHub Actions will publish to npm."
