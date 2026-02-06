#!/bin/bash
# Stream BTC UI vs Oracle prices from Railway logs
# Usage: ./scripts/btc-stream.sh [interval_seconds] [count]
INTERVAL=${1:-10}
COUNT=${2:-30}

PARSE='
import sys,json
lines = sys.stdin.read().strip().split("\n")
msgs = []
for l in lines:
    try: msgs.append(json.loads(l).get("message",""))
    except: msgs.append("")
ui=oracle=spread=None; in_block=False; is_btc=False; _ui=_or=_sp=None
for m in msgs:
    if "spread_snapshot" in m:
        if is_btc and _ui and _or and _sp: ui,oracle,spread=_ui,_or,_sp
        in_block=True; is_btc=False; _ui=_or=_sp=None; continue
    if in_block:
        if "symbol: '"'"'btc'"'"'" in m: is_btc=True
        if "ui_price:" in m: _ui=m.split("ui_price:")[1].strip().rstrip(",")
        if "oracle_price:" in m: _or=m.split("oracle_price:")[1].strip().rstrip(",")
        if "spread:" in m and "spread_pct" not in m: _sp=m.split("spread:")[1].strip().rstrip(",")
if is_btc and _ui and _or and _sp: ui,oracle,spread=_ui,_or,_sp
import time
t=time.strftime("%H:%M:%S")
if ui and oracle:
    u,o,s=float(ui),float(oracle),float(spread)
    print(f"[{t}]  UI: ${u:>10,.2f}  |  Oracle: ${o:>10,.2f}  |  Spread: ${s:>+8.2f} ({s/o*100:+.3f}%)")
else:
    print(f"[{t}]  waiting for data...")
'

echo "BTC Price Stream  |  every ${INTERVAL}s  |  ${COUNT} samples"
echo "─────────────────────────────────────────────────────────────────"

for i in $(seq 1 "$COUNT"); do
  railway logs -n 1000 --json 2>/dev/null | python3 -c "$PARSE"
  [ "$i" -lt "$COUNT" ] && sleep "$INTERVAL"
done
