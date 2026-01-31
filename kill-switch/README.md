# Kill Switch Watchdog

Critical safety infrastructure for the poly trading system. The watchdog is a **separate process** that can forcibly terminate the main trading process within 5 seconds, even if the main process is hung or unresponsive.

## Why Separate Process?

The watchdog must be a separate process because:
- If the main process is hung, internal shutdown code won't execute
- SIGKILL can only be sent from an external process
- Independent process ensures reliability even in worst-case scenarios

## Quick Start

```bash
# Start the watchdog
node kill-switch/watchdog.js start

# Check status
node kill-switch/watchdog.js status

# Trigger kill sequence
node kill-switch/watchdog.js kill

# Stop the watchdog
node kill-switch/watchdog.js stop

# Show help
node kill-switch/watchdog.js help
```

## Commands

### `start`
Start watching the main process. The watchdog will:
- Write its own PID file (`data/watchdog.pid`)
- Monitor the main process health
- Log status changes

### `stop`
Stop the watchdog gracefully. Cleans up PID files and stops monitoring.

### `kill`
Execute the kill sequence on the main process:
1. Read main process PID from `data/main.pid`
2. Send SIGTERM (graceful shutdown)
3. Wait up to 2 seconds for graceful exit
4. If still running, send SIGKILL (force kill)
5. Clean up PID file

**Guaranteed to complete within 5 seconds** (NFR2).

### `status`
Display current status of:
- Watchdog process (running/stopped, PID, uptime)
- Main process (running/stopped/unknown, PID)
- Health check statistics
- Last kill operation details

### `help`
Show usage information.

## Kill Sequence

```
User triggers kill
       │
       ▼
┌─────────────────────┐
│ Read main.pid file  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Check if running    │──► Not running? Done (already_stopped)
└──────────┬──────────┘
           │ Running
           ▼
┌─────────────────────┐
│ Send SIGTERM        │
│ (graceful shutdown) │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Wait 2 seconds      │──► Exited? Done (graceful)
└──────────┬──────────┘
           │ Still running
           ▼
┌─────────────────────┐
│ Send SIGKILL        │
│ (force kill)        │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Verify terminated   │──► Done (force)
└─────────────────────┘

Total time: < 5 seconds
```

## Files

| File | Purpose |
|------|---------|
| `data/main.pid` | Main process writes its PID here on startup |
| `data/watchdog.pid` | Watchdog writes its PID here when started |
| `logs/watchdog.log` | Watchdog event log (JSON format) |
| `data/last-known-state.json` | State snapshot (written by Story 4.2) |

## Configuration

The watchdog reads from `config/default.js`:

```javascript
killSwitch: {
  gracefulTimeoutMs: 2000,     // 2 seconds for graceful shutdown
  stateFilePath: './data/last-known-state.json',
}
```

## Integration with Main Process

The main process must:
1. Write its PID to `data/main.pid` on startup
2. Remove the PID file on graceful shutdown
3. Handle SIGTERM for graceful shutdown

Example:
```javascript
import fs from 'fs';

const PID_FILE = './data/main.pid';

// On startup
fs.writeFileSync(PID_FILE, process.pid.toString());

// On graceful shutdown
process.on('SIGTERM', async () => {
  // ... shutdown logic ...
  fs.unlinkSync(PID_FILE);
  process.exit(0);
});
```

## Log Format

Logs are written in JSON format:

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "info",
  "module": "watchdog",
  "event": "kill_graceful_success",
  "data": {
    "pid": 12345,
    "durationMs": 150
  }
}
```

## Error Codes

| Code | Description |
|------|-------------|
| `PID_FILE_NOT_FOUND` | Main process PID file doesn't exist |
| `PID_FILE_STALE` | PID file exists but process is not running |
| `PID_FILE_INVALID` | PID file contains invalid data |
| `MAIN_PROCESS_NOT_RUNNING` | Main process is not running |
| `KILL_FAILED` | Kill sequence failed |
| `INVALID_COMMAND` | Unknown command provided |
| `WATCHDOG_ALREADY_RUNNING` | Watchdog is already running |

## Testing

Run the tests:

```bash
npm test -- kill-switch
```

## NFR Compliance

- **FR25**: Kill switch halts trading within 5 seconds ✓
- **FR26**: Kill switch works even if main process unresponsive ✓
- **NFR2**: Kill switch halts all activity within 5 seconds ✓

## Future Integration (Story 4.2)

The kill sequence will be extended to:
1. Capture last known state before kill
2. Write state snapshot to `data/last-known-state.json`
3. Enable recovery on next startup
