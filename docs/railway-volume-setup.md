# Railway Volume Configuration

## Overview

Railway volumes provide persistent storage for the SQLite database across container restarts and deployments.

## Setup Instructions

### 1. Create Volume in Railway Dashboard

1. Go to your Railway project dashboard
2. Click on your service
3. Navigate to **Settings** → **Volumes**
4. Click **+ Add Volume**
5. Configure:
   - **Name**: `poly-data`
   - **Mount Path**: `/app/data`
   - **Size**: 5GB minimum (Hobby tier)

### 2. Verify Environment Variable

The application uses `DATABASE_PATH` to locate the database. For Railway with a volume mounted at `/app/data`:

```bash
DATABASE_PATH=/app/data/poly.db
```

This is already the default path when running in the `/app` directory.

### 3. Deploy and Verify

```bash
# Deploy the application
railway up

# Check logs to verify database path
railway logs

# Look for: "db_connection path=/app/data/poly.db"
```

### 4. Test Persistence

```bash
# Trigger a redeploy (container restart)
railway up

# Verify data survives restart by checking logs
railway logs
```

## Storage Estimates

| Data Type | Retention | Est. Daily Growth | Est. 7-day Storage |
|-----------|-----------|-------------------|-------------------|
| rtds_ticks | 7 days | ~2M rows/day | ~14M rows (~1.5GB) |
| oracle_updates | 30 days | ~50K rows/day | ~350K rows (~50MB) |
| lag_signals | 30 days | ~10K rows/day | ~70K rows (~10MB) |
| trade_events | 90 days | ~500 rows/day | ~3.5K rows (~5MB) |

**Total estimate: 2-3GB with retention policies applied**

## Limitations

1. **Single process only** - SQLite with WAL mode supports single writer
2. **Brief downtime during deploys** - Volume unmounts during container swap
3. **No automatic backups** - Consider periodic backup to S3/R2 for safety

## Troubleshooting

### Database Not Persisting

1. Verify volume is mounted: Check Railway dashboard → Service → Volumes
2. Verify mount path matches: Should be `/app/data`
3. Check `DATABASE_PATH` env var: Should be `/app/data/poly.db`

### Database Locked Errors

1. Ensure only one instance is running
2. Check for zombie processes
3. Restart the service: `railway restart`

## Future: PostgreSQL Migration

When storage or concurrency limits are reached, migrate to Supabase PostgreSQL:

- Track as Epic 9 or future backlog
- Estimated effort: 40-50 hours
- Triggers: >10GB data, multi-process needs, longer retention requirements
