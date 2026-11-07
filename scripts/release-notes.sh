#!/bin/sh
# Print the CHANGELOG section for one version, without its heading. Used by the
# CI release job to turn a tagged version's notes into a GitLab release
# description (the release title already shows the version).
# Usage: release-notes.sh <version> [changelog-file]
# Exit 1 when the CHANGELOG has no section for <version>.
set -eu

version="$1"
file="${2:-CHANGELOG.md}"

section="$(awk -v v="$version" '
  index($0, "## " v " ") == 1 || $0 == "## " v { insec = 1; print; next }
  insec && index($0, "## ") == 1 { exit }
  insec { print }
' "$file")"

if [ -z "$section" ]; then
  echo "No CHANGELOG section for $version in $file" >&2
  echo "Add a '## $version — date' heading before tagging." >&2
  exit 1
fi

# Drop the heading line and any blank lines right after it.
printf '%s\n' "$section" | sed '1d' | sed '/./,$!d'
