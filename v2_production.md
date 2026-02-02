# V2 Production Infrastructure

Document tracking production infrastructure improvements needed for full PRD compliance.

---

## 1. Persistent Storage (Critical)

### Current State
- SQLite database at `/app/data/poly.db`
- Code correctly implements write-ahead logging and persistence
- **Gap:** Railway deployment has NO persistent volume
- **Impact:** All data lost on container restart/redeploy (trade history, positions, orders, calibration)

### PRD Requirements (Not Met in Deployment)
- **FR16:** System can persist state to durable storage
- **FR17:** System can reconcile in-memory state with persistent state on restart
- **NFR8:** State persisted to disk before acknowledging any position change

### Solution: Railway Volume

**Prerequisites:**
- Railway Pro plan ($5/month + usage)

**Steps:**
1. Upgrade Railway plan to Pro
2. Go to Railway Dashboard → poly service → Settings → Volumes
3. Add volume:
   - Mount Path: `/app/data`
   - Size: 1 GB (expandable)
4. Redeploy

**Verification:**
```bash
# SSH into Railway container or check logs for:
# - Database file persists across deploys
# - Trade history accessible after restart
```

### Alternative: Turso (If Staying Free Tier)

[Turso](https://turso.tech) is SQLite-compatible edge database with free tier.

**Changes Required:**
1. Replace `better-sqlite3` with `@libsql/client`
2. Update `src/persistence/database.js` connection logic
3. Add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` env vars

**Pros:** Free, SQLite-compatible
**Cons:** Code changes, external dependency, slight latency

---

## 2. Production Checklist

### Before Going Live with Real Money

- [ ] **Persistent storage configured** (Railway volume or Turso)
- [ ] **Backup strategy** (even with volume, periodic backups recommended)
- [ ] **Monitoring/alerting** (beyond structured logs)
- [ ] **Kill switch tested** against production
- [ ] **Drawdown limits** configured appropriately
- [ ] **API rate limits** understood and respected

### Environment Variables Required

```
# Core
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_PASSPHRASE=

# Railway (for kill switch)
RAILWAY_API_TOKEN=
RAILWAY_SERVICE_ID=

# Optional: Turso (if using)
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
```

---

## 3. Cost Estimate (Railway Pro)

| Item | Estimated Cost |
|------|----------------|
| Pro Plan Base | $5/month |
| Compute (always-on) | ~$5-10/month |
| Volume (1GB) | ~$0.25/month |
| **Total** | **~$10-15/month** |

---

## 4. Data Recovery (Current Risk)

Until persistent storage is configured:

- **Every deploy = fresh database**
- **Paper trading data:** Lost on restart (acceptable for testing)
- **Live trading data:** Would be lost (unacceptable)

**Mitigation for now:**
- Stay in PAPER mode until volume configured
- Export important data manually if needed:
  ```bash
  railway run sqlite3 /app/data/poly.db ".dump" > backup.sql
  ```

---

## 5. Migration Path

When ready to enable persistent storage:

1. Export any valuable data from current deployment
2. Upgrade Railway plan
3. Add volume at `/app/data`
4. Redeploy
5. Verify database persists across restart:
   ```bash
   railway logs  # Check for "module_initialized" with existing data
   ```
6. Switch to LIVE mode when confident

---

*Last updated: 2026-02-02*
