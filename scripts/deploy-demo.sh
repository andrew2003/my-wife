#!/usr/bin/env bash
# Deploy the demo on this machine behind a Cloudflare Tunnel.
#
# Usage: scripts/deploy-demo.sh [--check]
#   --check   validate the intake and the compose config, then stop (no containers)
#
# Reads DEPLOY_TARGET and the intake values from the environment, falling back to
# the factory intake file (parsed, never sourced, never printed). DEPLOY_TARGET:
# this_server | none. Only variable NAMES are ever printed, never values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTAKE_FILE="${INTAKE_FILE:-$ROOT/factory/INTAKE.env}"
CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then CHECK_ONLY=1; fi

REQUIRED=(DOMAIN CLOUDFLARE_TUNNEL_TOKEN SESSION_SECRET APP_ENCRYPTION_KEY ADMIN_EMAIL)
KNOWN=(DEPLOY_TARGET APP_SUBDOMAIN UI_LANGUAGE LOGIN_METHOD "${REQUIRED[@]}")

# Fill names that are not already set from the intake file.
if [[ -f "$INTAKE_FILE" ]]; then
  for name in "${KNOWN[@]}"; do
    if [[ -z "${!name:-}" ]]; then
      value="$(grep -E "^${name}=" "$INTAKE_FILE" | tail -n1 | cut -d= -f2- || true)"
      if [[ -n "$value" ]]; then export "$name=$value"; fi
    fi
  done
fi

TARGET="${DEPLOY_TARGET:-none}"
case "$TARGET" in
  this_server) ;;
  none)
    echo "DEPLOY_TARGET is 'none': the real deploy is skipped. Verify locally instead." >&2
    exit 0 ;;
  *)
    echo "DEPLOY_TARGET must be 'this_server' or 'none'." >&2
    exit 2 ;;
esac

missing=()
for name in "${REQUIRED[@]}"; do
  if [[ -z "${!name:-}" ]]; then missing+=("$name"); fi
done
if ((${#missing[@]} > 0)); then
  echo "Intake is incomplete. Missing: ${missing[*]}" >&2
  exit 1
fi

export BIND_ADDR=127.0.0.1
export APP_SUBDOMAIN="${APP_SUBDOMAIN:-mywife}"
ADDRESS="https://${APP_SUBDOMAIN}.${DOMAIN}"
COMPOSE=(docker compose -f "$ROOT/infra/docker-compose.yml" -f "$ROOT/infra/docker-compose.cloudflare.yml")

"${COMPOSE[@]}" config --quiet
if ((CHECK_ONLY)); then
  echo "Deploy check passed. Address would be: $ADDRESS"
  exit 0
fi

"${COMPOSE[@]}" up -d --build
echo "Demo deployed. Address: $ADDRESS"
