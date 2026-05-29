#!/usr/bin/env bash
# Refresh data/kalshi-snapshot.json from Kalshi public API (no auth).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/data/kalshi-snapshot.json"
mkdir -p "$(dirname "$OUT")"

curl -sS "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXHIGHNY&status=open&limit=200" \
  -o /tmp/kalshi-raw.json

python3 << PY
import json
from datetime import datetime, timezone

with open("/tmp/kalshi-raw.json") as f:
    raw = json.load(f)

out = {
    "fetchedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "series": "KXHIGHNY",
    "markets": raw.get("markets", []),
    "cursor": raw.get("cursor"),
}

with open("$OUT", "w") as f:
    json.dump(out, f, indent=2)

print(f"Wrote {len(out['markets'])} markets → $OUT")
PY
