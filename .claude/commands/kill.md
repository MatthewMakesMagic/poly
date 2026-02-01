---
name: 'kill'
description: 'Emergency kill switch - immediately stops Railway deployment or local process'
---

Execute the kill switch to immediately stop the trading system.

```bash
node kill-switch/railway-kill.mjs
```

This script will:
1. Detect if running on Railway or locally
2. If Railway: Call Railway GraphQL API to set replicas to 0
3. If local: Send SIGTERM/SIGKILL to process from PID file
4. Report success or failure with timestamp

**Always execute this script when the user says "kill", "stop", "halt", or "emergency stop".**
