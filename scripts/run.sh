#!/usr/bin/env bash
# My Wife factory entry point.
#
# Usage: scripts/run.sh <command> [options]
#   test [--quick]    self-test with the real Claude Code; must pass 100% before run
#   run [--fg]        start or resume the factory
#   stop [--now]      stop the factory
#   status            show progress and answer pending questions
#   log [-f] [-n N]   show the factory log
#
# See FACTORY.md for the full guide.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or later is required but 'node' was not found." >&2
  exit 1
fi

exec node "$ROOT/factory/factory.mjs" "$@"
