#!/usr/bin/env bash
# Creates a per-branch database inside the shared stack. Usage: infra/create-branch-db.sh <db_name>
set -euo pipefail
db="${1:?database name required}"
[[ "$db" =~ ^[a-z][a-z0-9_]*$ ]] || { echo "invalid database name" >&2; exit 1; }
dir="$(cd "$(dirname "$0")" && pwd)"
docker compose -f "$dir/docker-compose.yml" exec -T postgres \
  psql -U "${POSTGRES_USER:-mywife}" -d postgres -c "CREATE DATABASE \"$db\"" || true
docker compose -f "$dir/docker-compose.yml" exec -T postgres \
  psql -U "${POSTGRES_USER:-mywife}" -d "$db" < "$dir/postgres/init.sql"
