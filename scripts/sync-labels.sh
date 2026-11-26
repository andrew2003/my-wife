#!/usr/bin/env bash
# Creates or updates the repository labels listed in .github/labels.yml.
# Requires an authenticated gh CLI. Usage: scripts/sync-labels.sh [owner/repo]
set -euo pipefail

cd "$(dirname "$0")/.."
repo_args=()
if [ "${1:-}" != "" ]; then repo_args=(--repo "$1"); fi

node --input-type=module -e '
import { readFileSync } from "node:fs";
for (const line of readFileSync(".github/labels.yml", "utf8").split("\n")) {
  const m = line.match(/^- \{ name: "?([^",]+)"?, color: "([0-9a-f]{6})", description: "(.*)" \}$/);
  if (m) console.log(m.slice(1).join("\t"));
}
' | while IFS=$'\t' read -r name color description; do
  gh label create "$name" --color "$color" --description "$description" --force "${repo_args[@]}"
done
