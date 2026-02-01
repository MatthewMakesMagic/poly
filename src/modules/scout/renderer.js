/**
 * Scout Terminal Renderer
 *
 * ANSI-based terminal output for Scout.
 * Works in Claude Code terminal and standard terminals.
 */

import { Colors, Icons } from './types.js';
import { getTimeAgo } from './translator.js';
import * as reviewQueue from './review-queue.js';

// Terminal width (default, will attempt to detect)
let termWidth = 70;

// Event history for display
let eventHistory = [];
const MAX_HISTORY = 20;

// Resize handler reference for cleanup
let resizeHandler = null;

/**
 * Initialize renderer
 */
export function init() {
  // Try to detect terminal width
  if (process.stdout.columns) {
    termWidth = Math.min(process.stdout.columns, 100);
  }

  // Handle terminal resize (store reference for cleanup)
  resizeHandler = () => {
    if (process.stdout.columns) {
      termWidth = Math.min(process.stdout.columns, 100);
    }
  };
  process.stdout.on('resize', resizeHandler);
}

/**
 * Add event to history
 */
export function addEvent(event) {
  eventHistory.push({
    ...event,
    timestamp: new Date().toISOString(),
  });

  // Trim history
  if (eventHistory.length > MAX_HISTORY) {
    eventHistory = eventHistory.slice(-MAX_HISTORY);
  }
}

/**
 * Clear the terminal screen
 */
export function clear() {
  process.stdout.write('\x1b[2J\x1b[H');
}

/**
 * Render the full Scout display
 */
export function render(state) {
  const lines = [];

  // Status bar
  lines.push(...renderStatusBar(state));

  // Separator
  lines.push(renderSeparator());

  // Event stream
  lines.push(...renderEventStream());

  // Review queue (if items exist)
  const queueCount = reviewQueue.getCount();
  if (queueCount > 0) {
    lines.push(renderSeparator());
    lines.push(...renderReviewQueue());
  }

  // Output
  console.log(lines.join('\n'));
}

/**
 * Render just a new event (append mode)
 */
export function renderEvent(event) {
  const { type, translation, data } = event;
  const time = formatTime(new Date());

  const icon = getIcon(translation?.icon, translation?.level);
  const summary = translation?.summary || type;
  const explanation = translation?.explanation || '';

  // First line: timestamp + icon + summary
  console.log(
    `${Colors.DIM}${time}${Colors.RESET}  ${icon} ${Colors.BOLD}${summary}${Colors.RESET}`
  );

  // Second line: Scout's explanation (indented)
  if (explanation) {
    console.log(
      `${Colors.DIM}          Scout:${Colors.RESET} ${Colors.CYAN}"${explanation}"${Colors.RESET}`
    );
  }

  console.log(''); // Blank line between events
}

/**
 * Render status bar
 */
function renderStatusBar(state) {
  const lines = [];

  const queueCount = reviewQueue.getCount();
  const queueText = queueCount > 0
    ? `${Colors.YELLOW}${Icons.ARROW_UP} ${queueCount} need review${Colors.RESET}`
    : `${Colors.GREEN}${Icons.CHECK} all clear${Colors.RESET}`;

  // Story E.3: Add mode badge to header
  const modeBadge = formatModeBadge(state.tradingMode);
  const header = `${Colors.BOLD}${Colors.CYAN} SCOUT${Colors.RESET} ${modeBadge}`;
  const headerRight = queueText;
  const headerPadding = termWidth - stripAnsi(header).length - stripAnsi(headerRight).length - 2;

  lines.push(header + ' '.repeat(Math.max(1, headerPadding)) + headerRight);

  // Story E.3: Status line with paper/live counts
  const paperCount = state.paperSignalCount || 0;
  const liveCount = state.liveOrderCount || 0;
  const lastUpdate = state.lastEventTime ? getTimeAgo(state.lastEventTime) : 'waiting';

  const statusLine = `${Colors.DIM} Paper signals: ${paperCount} | Live orders: ${liveCount} ${Icons.DOT} Last check: ${lastUpdate}${Colors.RESET}`;

  lines.push(statusLine);

  return lines;
}

/**
 * Render separator line
 */
function renderSeparator() {
  return Colors.DIM + '\u2500'.repeat(termWidth) + Colors.RESET;
}

/**
 * Render event stream
 */
function renderEventStream() {
  const lines = [];

  if (eventHistory.length === 0) {
    lines.push('');
    lines.push(`${Colors.DIM} Waiting for events...${Colors.RESET}`);
    lines.push('');
  } else {
    lines.push('');
    for (const event of eventHistory.slice(-10)) {
      const time = formatTime(new Date(event.timestamp));
      const icon = getIcon(event.icon, event.level);
      const summary = event.summary || event.type;

      lines.push(
        ` ${Colors.DIM}${time}${Colors.RESET}  ${icon} ${summary}`
      );

      if (event.explanation) {
        lines.push(
          `${Colors.DIM}           Scout:${Colors.RESET} ${Colors.CYAN}"${event.explanation}"${Colors.RESET}`
        );
      }
      lines.push('');
    }
  }

  return lines;
}

/**
 * Render review queue
 */
function renderReviewQueue() {
  const lines = [];
  const items = reviewQueue.getItems().slice(-5); // Show last 5

  lines.push(`${Colors.BOLD} REVIEW QUEUE${Colors.RESET} ${Colors.DIM}(oldest first)${Colors.RESET}`);

  for (const item of items) {
    const time = formatTime(new Date(item.addedAt));
    const levelColor = item.level === 'error' ? Colors.RED : Colors.YELLOW;
    const icon = item.level === 'error' ? Icons.CROSS : Icons.WARNING;

    lines.push(
      ` ${Colors.DIM}[${item.id}]${Colors.RESET} ${time} ${levelColor}${icon}${Colors.RESET} ${item.summary} ${Colors.DIM}${Icons.DOT} ${item.windowId || 'no window'}${Colors.RESET}`
    );
  }

  return lines;
}

/**
 * Format time for display (HH:MM:SS)
 */
export function formatTime(date) {
  return date.toTimeString().slice(0, 8);
}

/**
 * Get colored icon based on level
 */
export function getIcon(icon, level) {
  const displayIcon = icon || Icons.CIRCLE;

  switch (level) {
    case 'error':
      return `${Colors.RED}${displayIcon}${Colors.RESET}`;
    case 'warn':
      return `${Colors.YELLOW}${displayIcon}${Colors.RESET}`;
    default:
      return `${Colors.GREEN}${displayIcon}${Colors.RESET}`;
  }
}

/**
 * Story E.3: Format trading mode badge for status bar
 *
 * @param {string|null} mode - 'PAPER', 'LIVE', or null
 * @returns {string} Formatted badge string
 */
export function formatModeBadge(mode) {
  if (!mode) {
    return `${Colors.DIM}[Mode unknown]${Colors.RESET}`;
  }

  if (mode === 'PAPER') {
    return `${Colors.YELLOW}[PAPER]${Colors.RESET}`;
  }

  if (mode === 'LIVE') {
    // Use red with warning indicator for LIVE
    return `${Colors.RED}[\u{1F534} LIVE]${Colors.RESET}`;
  }

  return `${Colors.DIM}[${mode}]${Colors.RESET}`;
}

/**
 * Strip ANSI codes for length calculation
 */
export function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Render Scout startup message
 */
export function renderStartup(mode) {
  console.log('');
  console.log(`${Colors.BOLD}${Colors.CYAN}  SCOUT${Colors.RESET} ${Colors.DIM}v1.0${Colors.RESET}`);
  console.log(`${Colors.DIM}  Real-time trading monitor${Colors.RESET}`);
  console.log('');
  console.log(`${Colors.DIM}  Mode: ${mode}${Colors.RESET}`);
  console.log(`${Colors.DIM}  Press Ctrl+C to stop${Colors.RESET}`);
  console.log('');
  console.log(renderSeparator());
  console.log('');
}

/**
 * Render Scout shutdown message
 */
export function renderShutdown(stats) {
  console.log('');
  console.log(renderSeparator());
  console.log('');
  console.log(`${Colors.BOLD}  Scout signing off${Colors.RESET}`);
  console.log('');
  console.log(`${Colors.DIM}  Events received: ${stats.eventsReceived}${Colors.RESET}`);
  console.log(`${Colors.DIM}  Signals: ${stats.signalCount} | Entries: ${stats.entryCount} | Exits: ${stats.exitCount}${Colors.RESET}`);
  // Story E.3: Add paper/live counts to shutdown summary
  const paperCount = stats.paperSignalCount || 0;
  const liveCount = stats.liveOrderCount || 0;
  console.log(`${Colors.DIM}  Paper signals: ${paperCount} | Live orders: ${liveCount}${Colors.RESET}`);
  console.log(`${Colors.DIM}  Alerts: ${stats.alertCount}${Colors.RESET}`);
  console.log('');
}

/**
 * Reset renderer state
 */
export function reset() {
  eventHistory = [];

  // Clean up resize handler to prevent memory leaks
  if (resizeHandler) {
    process.stdout.off('resize', resizeHandler);
    resizeHandler = null;
  }
}
