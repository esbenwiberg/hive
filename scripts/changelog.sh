#!/usr/bin/env bash
# Regenerate CHANGELOG.md from git history, grouped by date.
# Usage: bash scripts/changelog.sh

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

{
  echo "# Changelog"
  echo ""

  git log --format="%ad|%s" --date=short |
  while IFS='|' read -r date msg; do
    if [ "$date" != "${prev_date:-}" ]; then
      [ -n "${prev_date:-}" ] && echo ""
      echo "## $date"
      prev_date="$date"
    fi
    echo "- $msg"
  done
} > CHANGELOG.md

echo "==> CHANGELOG.md updated ($(grep -c '^- ' CHANGELOG.md) entries)"
