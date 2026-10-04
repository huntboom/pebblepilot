#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${PEBBLEPILOT_CONFIG:-$ROOT/config.json}"
BASE="${PEBBLEPILOT_URL:-http://127.0.0.1:8787}"

if [[ ! -f "$CONFIG" ]]; then
  echo "Missing $CONFIG — copy config.example.json first" >&2
  exit 1
fi

TOKEN="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).token)" "$CONFIG")"
AUTH="Authorization: Bearer $TOKEN"

echo "== health =="
curl -fsS "$BASE/health"
echo

echo "== unauthorized error shape =="
curl -sS "$BASE/projects" | node -e "
const j = JSON.parse(require('fs').readFileSync(0,'utf8'));
if (j.code !== 'unauthorized') { console.error('expected code unauthorized, got', j); process.exit(1); }
console.log(JSON.stringify(j));
"
echo

echo "== projects =="
curl -fsS -H "$AUTH" "$BASE/projects"
echo

echo "== agents =="
curl -fsS -H "$AUTH" "$BASE/pebble/agents"
echo

if [[ "${1:-}" == "start" ]]; then
  PROJECT_ID="${2:-pebblepilot}"
  PROMPT="${3:-Summarize this repository in three short bullets.}"
  echo "== start $PROJECT_ID =="
  curl -fsS -X POST "$BASE/agents" \
    -H "$AUTH" \
    -H "Content-Type: application/json" \
    -d "$(node -e "console.log(JSON.stringify({projectId:process.argv[1],prompt:process.argv[2]}))" "$PROJECT_ID" "$PROMPT")"
  echo
fi
