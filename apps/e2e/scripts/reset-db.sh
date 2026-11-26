#!/usr/bin/env bash
# Rebuilds the per-branch e2e database from scratch inside the shared stack. Usage: reset-db.sh <db_name>
set -euo pipefail
db="${1:?database name required}"
[[ "$db" =~ ^[a-z][a-z0-9_]*$ ]] || { echo "invalid database name" >&2; exit 1; }
# Compose interpolates every service; exec needs only a placeholder.
export SESSION_SECRET="${SESSION_SECRET:-e2e-only-secret-e2e-only-secret-0000}"
root="$(cd "$(dirname "$0")/../../.." && pwd)"
docker compose -f "$root/infra/docker-compose.yml" exec -T postgres \
  psql -U "${POSTGRES_USER:-mywife}" -d postgres -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)"
"$root/infra/create-branch-db.sh" "$db"
