# Deployment Checklist

## Before Deploying

1. **Sync worktree with main**
   ```bash
   git merge main  # if on a worktree branch
   ```

2. **Verify strategy sync** - strategies enabled in DB must exist in code
   ```bash
   node -e "import('./src/quant/strategies/index.js').then(m => console.log(m.createAllQuantStrategies(100).map(s => s.getName())))"
   ```

3. **Check for uncommitted changes**
   ```bash
   git status
   ```

## Deploy

```bash
git push origin main
```

Railway auto-deploys on push to main.

## After Deploying

Verify health check ran:
```bash
railway logs | grep -E "(Verifying|CRITICAL|enabled strategies)"
```

If you see `❌ CRITICAL: Strategies enabled in DB but NOT in code` - fix immediately.

## Common Mistakes

| Mistake | Result | Fix |
|---------|--------|-----|
| Strategy in DB but not in code | Silent failure, no trades | Add to `createAllQuantStrategies()` |
| Working on worktree, forgot to merge | Code mismatch | `git merge main` |
| Typo in strategy name | DB/code mismatch | Check `getName()` matches exactly |
