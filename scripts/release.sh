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

# Keep Claude marketplace/package versions in sync with npm package version.
node -e "for (const file of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) { const fs = require('fs'); const data = JSON.parse(fs.readFileSync(file, 'utf8')); if (file.endsWith('plugin.json')) data.version = process.argv[1]; else data.plugins[0].version = process.argv[1]; fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); }" "$NEW"

# Commit, tag, push
git add package.json package-lock.json "$CHANGELOG" README.md .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: release v${NEW}"
git tag "v${NEW}"
git push origin main
git push origin "v${NEW}"

echo ""
echo "Released v${NEW} — GitHub Actions will publish to npm."
