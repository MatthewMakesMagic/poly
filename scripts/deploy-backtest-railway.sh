#!/usr/bin/env bash
#
# Deploy & run the backtest as a one-shot Railway service.
#
# Usage:
#   ./scripts/deploy-backtest-railway.sh              # Create service + deploy + run
#   ./scripts/deploy-backtest-railway.sh --redeploy   # Re-run existing service
#   ./scripts/deploy-backtest-railway.sh --logs       # Tail logs from latest run
#
# Prerequisites:
#   - railway CLI installed and logged in
#   - Linked to the calm-exploration project (railway link)
#
# The backtest service runs in the same Railway project as the main poly service,
# sharing the same Postgres database via internal networking (sub-ms latency).
# This bypasses the Railway proxy entirely — no more 30-60 min data loads.
#

set -euo pipefail

SERVICE_NAME="backtest-runner"
PROJECT_NAME="calm-exploration"

# ─── Parse args ───
ACTION="deploy"
if [[ "${1:-}" == "--redeploy" ]]; then
  ACTION="redeploy"
elif [[ "${1:-}" == "--logs" ]]; then
  ACTION="logs"
fi

# ─── Check prerequisites ───
if ! command -v railway &>/dev/null; then
  echo "Error: railway CLI not found. Install: npm i -g @railway/cli"
  exit 1
fi

echo "=== Backtest Railway Service ==="
echo "Project: $PROJECT_NAME"
echo "Service: $SERVICE_NAME"
echo ""

# ─── Tail logs ───
if [[ "$ACTION" == "logs" ]]; then
  echo "Tailing logs from $SERVICE_NAME..."
  railway logs --service "$SERVICE_NAME"
  exit 0
fi

# ─── Redeploy (re-run) existing service ───
if [[ "$ACTION" == "redeploy" ]]; then
  echo "Re-deploying $SERVICE_NAME to trigger a new backtest run..."
  railway redeploy --service "$SERVICE_NAME"
  echo ""
  echo "Backtest triggered. View logs:"
  echo "  railway logs --service $SERVICE_NAME"
  echo "  railway logs --service $SERVICE_NAME --json  # structured output"
  exit 0
fi

# ─── Full deploy: create service if needed, then upload ───
echo "Step 1: Creating service '$SERVICE_NAME' (if it doesn't exist)..."
railway add --service "$SERVICE_NAME" 2>/dev/null || echo "  Service may already exist, continuing..."

echo ""
echo "Step 2: Setting environment variables..."
# Copy DATABASE_URL from the postgres service (Railway reference variable)
# The internal URL gives direct DB access without proxy overhead.
railway variable set "DATABASE_URL=\${{Postgres.DATABASE_URL}}" \
  --service "$SERVICE_NAME" \
  --skip-deploys 2>/dev/null || echo "  DATABASE_URL may already be set"

railway variable set "NODE_ENV=production" \
  --service "$SERVICE_NAME" \
  --skip-deploys 2>/dev/null || true

echo ""
echo "Step 3: Deploying backtest service..."
# Upload and deploy the project to the backtest-runner service
# Uses Dockerfile.backtest via the service's settings
railway up --service "$SERVICE_NAME" --detach

echo ""
echo "=== Deployment initiated ==="
echo ""
echo "The backtest will run with direct DB access (internal network)."
echo "Expected runtime: 1-5 minutes for full 9-strategy × 4-symbol backtest."
echo ""
echo "Monitor progress:"
echo "  railway logs --service $SERVICE_NAME"
echo ""
echo "Re-run later:"
echo "  ./scripts/deploy-backtest-railway.sh --redeploy"
echo ""
echo "Results will be in backtest_runs + backtest_trades tables."
