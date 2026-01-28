# Future Monitoring Systems

This document outlines the recommended monitoring infrastructure to prevent position exit failures.

## Background

On January 2026, we experienced significant losses when positions entered but failed to exit with take profit or stop loss. Root causes included:
- Silent error catching in monitoring code
- No alerting when monitoring failed
- No independent verification of position health

## Recommended Implementation

### Option A: Independent Watchdog Process

A separate process that monitors positions independently of the main trading engine.

```javascript
// watchdog.js - Run as separate Railway service
import { createClient } from '@supabase/supabase-js';

const WATCHDOG_CONFIG = {
    CHECK_INTERVAL: 10000,        // Check every 10 seconds
    MAX_POSITION_AGE: 600,        // Alert if position > 10 minutes old
    MAX_DRAWDOWN_ALERT: 0.20,     // Alert if position down 20%
    STALE_UPDATE_THRESHOLD: 30000 // Alert if position not updated in 30s
};

class PositionWatchdog {
    constructor() {
        this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
        this.lastAlertTime = new Map();
    }

    async checkPositions() {
        // Query all open positions
        const { data: positions } = await this.supabase
            .from('live_trades')
            .select('*')
            .is('exit_time', null);

        for (const pos of positions || []) {
            await this.validatePosition(pos);
        }
    }

    async validatePosition(position) {
        const now = Date.now();
        const entryTime = new Date(position.entry_time).getTime();
        const lastUpdate = new Date(position.updated_at).getTime();
        const age = (now - entryTime) / 1000;

        // Check 1: Position age
        if (age > WATCHDOG_CONFIG.MAX_POSITION_AGE) {
            await this.sendAlert('STALE_POSITION', {
                positionId: position.id,
                crypto: position.crypto,
                age: Math.round(age),
                message: `Position open for ${Math.round(age)}s - may be stuck`
            });
        }

        // Check 2: Last update time
        if (now - lastUpdate > WATCHDOG_CONFIG.STALE_UPDATE_THRESHOLD) {
            await this.sendAlert('NO_UPDATES', {
                positionId: position.id,
                crypto: position.crypto,
                lastUpdate: Math.round((now - lastUpdate) / 1000),
                message: 'Position not being monitored'
            });
        }

        // Check 3: Drawdown
        if (position.current_pnl_pct < -WATCHDOG_CONFIG.MAX_DRAWDOWN_ALERT) {
            await this.sendAlert('HIGH_DRAWDOWN', {
                positionId: position.id,
                crypto: position.crypto,
                pnl: position.current_pnl_pct,
                message: `Position down ${(position.current_pnl_pct * 100).toFixed(1)}%`
            });
        }
    }

    async sendAlert(type, data) {
        const key = `${type}-${data.positionId}`;
        const lastAlert = this.lastAlertTime.get(key) || 0;

        // Throttle alerts to 1 per minute per issue
        if (Date.now() - lastAlert < 60000) return;

        this.lastAlertTime.set(key, Date.now());

        console.error(`[WATCHDOG ALERT] ${type}:`, data);

        // Send to external alerting (Slack, PagerDuty, etc.)
        await this.sendSlackAlert(type, data);
    }

    async sendSlackAlert(type, data) {
        if (!process.env.SLACK_WEBHOOK_URL) return;

        await fetch(process.env.SLACK_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: `🚨 *${type}*: ${data.message}`,
                attachments: [{
                    color: 'danger',
                    fields: Object.entries(data).map(([k, v]) => ({
                        title: k,
                        value: String(v),
                        short: true
                    }))
                }]
            })
        });
    }

    start() {
        console.log('[Watchdog] Starting position watchdog...');
        setInterval(() => this.checkPositions(), WATCHDOG_CONFIG.CHECK_INTERVAL);
    }
}

// Start watchdog
const watchdog = new PositionWatchdog();
watchdog.start();
```

**Deployment:**
- Run as separate Railway service
- Requires only read access to database
- Environment variables: `SUPABASE_URL`, `SUPABASE_KEY`, `SLACK_WEBHOOK_URL`

---

### Option B: Heartbeat + Alert System

Integrated into the main trading engine with external heartbeat monitoring.

```javascript
// Add to live_trader.js

class HeartbeatMonitor {
    constructor() {
        this.lastHeartbeat = Date.now();
        this.heartbeatInterval = 5000;  // 5 seconds
        this.positionStats = new Map();
    }

    recordHeartbeat(stats) {
        this.lastHeartbeat = Date.now();

        // Log position health
        console.log(`[HEARTBEAT] ${new Date().toISOString()} | ` +
            `positions=${stats.openPositions} | ` +
            `monitoring=${stats.monitoringActive} | ` +
            `errors=${stats.recentErrors}`);

        // Send to external monitoring service
        this.sendToMonitoringService(stats);
    }

    async sendToMonitoringService(stats) {
        // Option 1: Betterstack/Uptime Robot heartbeat
        if (process.env.HEARTBEAT_URL) {
            await fetch(process.env.HEARTBEAT_URL, { method: 'GET' });
        }

        // Option 2: Datadog/New Relic custom metrics
        if (process.env.DD_API_KEY) {
            await this.sendDatadogMetrics(stats);
        }
    }

    async sendDatadogMetrics(stats) {
        const metrics = [
            { metric: 'trading.positions.open', points: [[Date.now()/1000, stats.openPositions]] },
            { metric: 'trading.monitoring.errors', points: [[Date.now()/1000, stats.recentErrors]] },
            { metric: 'trading.pnl.total', points: [[Date.now()/1000, stats.totalPnL]] }
        ];

        await fetch('https://api.datadoghq.com/api/v1/series', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'DD-API-KEY': process.env.DD_API_KEY
            },
            body: JSON.stringify({ series: metrics })
        });
    }
}

// Usage in monitorPositions():
async monitorPositions(tick, market) {
    // ... existing monitoring code ...

    // Send heartbeat after each monitoring cycle
    this.heartbeat.recordHeartbeat({
        openPositions: this.livePositions.size,
        monitoringActive: true,
        recentErrors: this.monitoringFailures.size,
        totalPnL: this.calculateTotalPnL()
    });
}
```

**External Heartbeat Monitoring Setup:**

1. **Betterstack (recommended)**
   - Create heartbeat monitor at betterstack.com
   - Set expected interval: 30 seconds
   - Set grace period: 60 seconds
   - Add HEARTBEAT_URL to Railway environment

2. **Custom Dead Man's Switch**
   ```javascript
   // deadmans_switch.js - Separate process
   let lastHeartbeat = Date.now();
   const TIMEOUT = 60000; // 1 minute

   app.post('/heartbeat', (req, res) => {
       lastHeartbeat = Date.now();
       res.send('ok');
   });

   setInterval(() => {
       if (Date.now() - lastHeartbeat > TIMEOUT) {
           sendEmergencyAlert('Trading engine stopped sending heartbeats!');
       }
   }, 10000);
   ```

---

## Recommended Combined Approach

Deploy BOTH systems for defense in depth:

1. **Option A (Watchdog)** - Catches issues where positions exist but aren't being monitored
2. **Option B (Heartbeat)** - Catches issues where the entire trading engine stops

### Priority Implementation Order

| Priority | System | Effort | Protection |
|----------|--------|--------|------------|
| 1 | Kill switch (already implemented) | Done | Stops trading on repeated failures |
| 2 | Heartbeat to Betterstack | 1 hour | Alerts if engine stops |
| 3 | Position watchdog service | 4 hours | Catches stuck positions |
| 4 | Datadog/metrics integration | 2 hours | Historical analysis |

### Environment Variables Needed

```bash
# Alerting
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# Heartbeat monitoring
HEARTBEAT_URL=https://uptime.betterstack.com/api/v1/heartbeat/...

# Metrics (optional)
DD_API_KEY=your_datadog_api_key
```

---

## Current Protections (Implemented)

As of January 2026, the following protections are active:

1. **Kill Switch** - Activates after 10 consecutive monitoring failures for any crypto
2. **Abandoned Position Tracking** - Positions that fail 3 exit attempts are logged to database
3. **Monitoring Failure Counter** - Tracks per-crypto monitoring failures
4. **Fixed Stop Loss** - Always checked first, catches price gaps
5. **Profit Floor Ratchet** - Locks in gains at +10%, +20%, +30% thresholds

---

## Incident Response Checklist

If positions are not exiting:

1. [ ] Check Railway logs for monitoring errors
2. [ ] Check `monitoringFailures` map for per-crypto failure counts
3. [ ] Query `live_trades` for positions without recent `updated_at`
4. [ ] Check if kill switch activated (look for "KILL SWITCH ACTIVATED" in logs)
5. [ ] Manually set `LIVE_TRADING_ENABLED=false` if needed
6. [ ] Query `abandoned_positions` table for failed exits
7. [ ] Review tick data to confirm monitoring was receiving ticks
