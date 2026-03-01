/**
 * Alerter Module
 *
 * Sends alerts to Discord via webhook. Supports rate limiting,
 * severity levels, and daily summary messages.
 *
 * Public API:
 * - init(config) - Initialize with webhook URL from env
 * - send(type, context) - Send an alert (rate-limited per type)
 * - sendDailySummary(stats) - Send end-of-day summary
 * - getState() - Return current state snapshot
 * - shutdown() - Clean up timers
 *
 * Alert types:
 * - circuit_breaker_trip: CB tripped (CRITICAL)
 * - assertion_failure: Assertion check failed (WARNING)
 * - large_drawdown: Drawdown threshold breached (CRITICAL)
 * - position_unknown_state: Position stuck unknown >60s (WARNING)
 * - health_endpoint_failure: Health check failed (WARNING)
 * - system_start: System started (INFO)
 * - system_stop: System stopped (INFO)
 *
 * @module modules/alerter
 */

import { child } from '../logger/index.js';

let log = null;
let initialized = false;
let webhookUrl = null;
let rateLimitMs = 60000; // 1 alert per type per 60s
let dailySummaryTimer = null;

// Rate limiting: track last send time per alert type
const lastSentAt = {};

// Stats for getState()
let stats = {
  alertsSent: 0,
  alertsRateLimited: 0,
  lastAlertAt: null,
  lastAlertType: null,
  errors: 0,
};

/**
 * Severity configuration per alert type
 */
const ALERT_CONFIG = {
  circuit_breaker_trip: { severity: 'CRITICAL', color: 0xED4245, emoji: '!!' },
  assertion_failure:    { severity: 'WARNING',  color: 0xFEE75C, emoji: '/!\\' },
  large_drawdown:       { severity: 'CRITICAL', color: 0xED4245, emoji: '!!' },
  position_unknown_state: { severity: 'WARNING', color: 0xFEE75C, emoji: '/!\\' },
  health_endpoint_failure: { severity: 'WARNING', color: 0xFEE75C, emoji: '/!\\' },
  system_start:         { severity: 'INFO',     color: 0x57F287, emoji: '>>' },
  system_stop:          { severity: 'INFO',     color: 0x5865F2, emoji: '[]' },
};

/**
 * Initialize the alerter module
 *
 * @param {Object} config - Full application configuration
 */
export async function init(config) {
  if (initialized) return;

  log = child({ module: 'alerter' });
  log.info('module_init_start');

  webhookUrl = process.env.DISCORD_WEBHOOK_URL || null;
  rateLimitMs = config?.alerter?.rateLimitMs || 60000;
  const dailySummaryHour = config?.alerter?.dailySummaryHour ?? 23; // 11 PM

  if (!webhookUrl) {
    log.warn('alerter_no_webhook', {
      message: 'DISCORD_WEBHOOK_URL not set - alerts will be logged only',
    });
  }

  // Schedule daily summary
  scheduleDailySummary(dailySummaryHour);

  initialized = true;
  log.info('module_initialized', {
    webhookConfigured: !!webhookUrl,
    rateLimitMs,
    dailySummaryHour,
  });

  // Send startup alert
  await send('system_start', {
    tradingMode: config?.tradingMode || 'PAPER',
    pid: process.pid,
  });
}

/**
 * Send an alert (rate-limited per type).
 *
 * @param {string} type - Alert type (e.g. 'circuit_breaker_trip')
 * @param {Object} [context={}] - Context data to include
 * @returns {Promise<boolean>} True if sent, false if rate-limited or failed
 */
export async function send(type, context = {}) {
  if (!initialized) {
    // Allow pre-init calls to be silently dropped
    return false;
  }

  const config = ALERT_CONFIG[type] || { severity: 'INFO', color: 0x5865F2, emoji: '(i)' };

  // Rate limiting: skip if we sent this type recently
  const now = Date.now();
  const lastSent = lastSentAt[type] || 0;
  if (now - lastSent < rateLimitMs) {
    stats.alertsRateLimited++;
    log.debug('alert_rate_limited', { type, lastSentAgo: now - lastSent });
    return false;
  }

  lastSentAt[type] = now;
  const timestamp = new Date().toISOString();

  // Build Discord embed
  const embed = {
    title: `${config.emoji} [${config.severity}] ${formatAlertType(type)}`,
    color: config.color,
    timestamp,
    fields: buildFields(context),
    footer: { text: `Poly Trading | ${type}` },
  };

  // Log the alert regardless of webhook
  log.info('alert_sent', { type, severity: config.severity, context });

  // Send to Discord if configured
  if (webhookUrl) {
    try {
      await postToDiscord({ embeds: [embed] });
      stats.alertsSent++;
      stats.lastAlertAt = timestamp;
      stats.lastAlertType = type;
      return true;
    } catch (err) {
      stats.errors++;
      log.warn('alert_send_failed', { type, error: err.message });
      return false;
    }
  }

  stats.alertsSent++;
  stats.lastAlertAt = timestamp;
  stats.lastAlertType = type;
  return true;
}

/**
 * Send a daily summary message.
 *
 * @param {Object} [summaryData] - Optional summary data override.
 *   If not provided, fetches from orchestrator state.
 */
export async function sendDailySummary(summaryData) {
  if (!initialized || !webhookUrl) return;

  const data = summaryData || {};

  const embed = {
    title: 'Daily Trading Summary',
    color: 0x5865F2,
    timestamp: new Date().toISOString(),
    fields: [
      { name: 'Trades', value: `${data.tradeCount ?? '--'}`, inline: true },
      { name: 'W/L', value: `${data.wins ?? '--'} / ${data.losses ?? '--'}`, inline: true },
      { name: 'Net P&L', value: data.netPnl != null ? `$${Number(data.netPnl).toFixed(2)}` : '--', inline: true },
      { name: 'Win Rate', value: data.winRate != null ? `${(data.winRate * 100).toFixed(1)}%` : '--', inline: true },
      { name: 'Uptime', value: data.uptimeHours != null ? `${data.uptimeHours.toFixed(1)}h` : '--', inline: true },
      { name: 'Alerts Sent', value: `${stats.alertsSent}`, inline: true },
      { name: 'Assertions', value: data.assertionPassRate != null ? `${(data.assertionPassRate * 100).toFixed(0)}% pass` : '--', inline: true },
      { name: 'Feed Health', value: data.feedHealth || '--', inline: true },
    ],
    footer: { text: 'Poly Trading | Daily Summary' },
  };

  try {
    await postToDiscord({ embeds: [embed] });
    log.info('daily_summary_sent');
  } catch (err) {
    log.warn('daily_summary_failed', { error: err.message });
  }
}

/**
 * Get module state.
 *
 * @returns {Object} State snapshot
 */
export function getState() {
  return {
    initialized,
    webhookConfigured: !!webhookUrl,
    stats: { ...stats },
    rateLimitMs,
  };
}

/**
 * Shutdown the alerter module.
 */
export async function shutdown() {
  if (log) log.info('module_shutdown_start');

  // Send shutdown alert
  await send('system_stop', { reason: 'graceful_shutdown' });

  if (dailySummaryTimer) {
    clearTimeout(dailySummaryTimer);
    dailySummaryTimer = null;
  }

  initialized = false;
  webhookUrl = null;
  stats = {
    alertsSent: 0,
    alertsRateLimited: 0,
    lastAlertAt: null,
    lastAlertType: null,
    errors: 0,
  };

  if (log) {
    log.info('module_shutdown_complete');
    log = null;
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Post a payload to the Discord webhook URL.
 *
 * @param {Object} payload - Discord webhook payload
 * @returns {Promise<void>}
 */
async function postToDiscord(payload) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord webhook returned ${res.status}: ${text.slice(0, 200)}`);
  }
}

/**
 * Format alert type to human-readable title.
 */
function formatAlertType(type) {
  return type
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Build Discord embed fields from a context object.
 * Limits to 10 fields max.
 */
function buildFields(context) {
  const fields = [];
  const entries = Object.entries(context);

  for (let i = 0; i < Math.min(entries.length, 10); i++) {
    const [key, value] = entries[i];
    fields.push({
      name: key,
      value: String(value ?? '--').slice(0, 1024),
      inline: true,
    });
  }

  return fields;
}

/**
 * Schedule the daily summary message.
 * Fires once per day at the configured hour.
 */
function scheduleDailySummary(hour) {
  if (dailySummaryTimer) {
    clearTimeout(dailySummaryTimer);
  }

  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);

  // If target is in the past today, schedule for tomorrow
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  const delayMs = target.getTime() - now.getTime();

  dailySummaryTimer = setTimeout(() => {
    sendDailySummary();
    // Reschedule for next day
    scheduleDailySummary(hour);
  }, delayMs);

  if (log) {
    log.debug('daily_summary_scheduled', {
      targetTime: target.toISOString(),
      delayMs,
    });
  }
}
