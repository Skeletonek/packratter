#!/bin/sh
# Print the CHANGELOG section for one version. Used by the CI release job to
# turn a tagged version's notes into a GitLab release description.
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

printf '%s\n' "$section"
