import { useState, useEffect, useRef, useCallback } from 'react';

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30000;

/**
 * Derive activity events by comparing previous and current state snapshots.
 * Since broadcastEvent() is not called from the orchestrator, we synthesize
 * events from state diffs to populate the activity feed.
 */
function deriveEvents(prev, curr, ts) {
  if (!prev || !curr) return [];
  const events = [];

  // Window count changes
  const prevWindows = prev.activeWindows ?? 0;
  const currWindows = curr.activeWindows ?? 0;
  if (currWindows !== prevWindows) {
    events.push({
      _event: 'window',
      _ts: ts,
      action: currWindows > prevWindows ? 'opened' : 'closed',
      window_id: `${currWindows} active`,
      count: currWindows,
      previous: prevWindows,
    });
  }

  // Position count changes
  const prevPosCount = prev.positionCount ?? (prev.openPositions?.length ?? 0);
  const currPosCount = curr.positionCount ?? (curr.openPositions?.length ?? 0);
  if (currPosCount !== prevPosCount) {
    events.push({
      _event: currPosCount > prevPosCount ? 'fill' : 'order',
      _ts: ts,
      action: currPosCount > prevPosCount ? 'position opened' : 'position closed',
      count: currPosCount,
      previous: prevPosCount,
    });
  }

  // New open positions (detect specific new ones)
  if (curr.openPositions && prev.openPositions) {
    const prevIds = new Set(prev.openPositions.map(p => p.id));
    for (const pos of curr.openPositions) {
      if (!prevIds.has(pos.id)) {
        events.push({
          _event: 'fill',
          _ts: ts,
          side: pos.side,
          symbol: pos.token_id || pos.window_id,
          shares: pos.shares,
          fill_price: pos.entry_price,
          strategy_id: pos.strategy_id,
        });
      }
    }
  }

  // System state changes (running/paused/stopped)
  if (prev.systemState !== curr.systemState && curr.systemState) {
    events.push({
      _event: 'window',
      _ts: ts,
      action: `system ${curr.systemState}`,
      window_id: 'system',
    });
  }

  // Circuit breaker state changes
  if (prev.circuitBreakerState !== curr.circuitBreakerState && curr.circuitBreakerState) {
    events.push({
      _event: curr.circuitBreakerState === 'OPEN' ? 'error' : 'assertion',
      _ts: ts,
      name: 'Circuit Breaker',
      passed: curr.circuitBreakerState === 'CLOSED',
      message: `CB: ${prev.circuitBreakerState} -> ${curr.circuitBreakerState}`,
    });
  }

  // Error count increase
  const prevErrors = prev.errorCount ?? 0;
  const currErrors = curr.errorCount ?? 0;
  if (currErrors > prevErrors) {
    events.push({
      _event: 'error',
      _ts: ts,
      message: curr.lastError || `+${currErrors - prevErrors} error(s)`,
      count: currErrors,
    });
  }

  return events;
}

/**
 * WebSocket hook for connecting to the trading backend.
 * Handles auto-reconnection and state management.
 */
export function useWebSocket() {
  const [state, setState] = useState(null);
  const [events, setEvents] = useState([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectDelayRef = useRef(RECONNECT_DELAY_MS);
  const reconnectTimerRef = useRef(null);
  const mountedRef = useRef(true);
  const prevStateRef = useRef(null);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      reconnectDelayRef.current = RECONNECT_DELAY_MS;
    };

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(evt.data);

        if (msg.type === 'init' || msg.type === 'state') {
          const newState = msg.data;

          // Derive events from state diffs (skip init to avoid false events on connect)
          if (msg.type === 'state' && prevStateRef.current) {
            const derived = deriveEvents(prevStateRef.current, newState, msg.ts);
            if (derived.length > 0) {
              setEvents((prev) => {
                const next = [...derived, ...prev];
                return next.slice(0, 200);
              });
            }
          }

          prevStateRef.current = newState;
          setState(newState);
        }

        if (msg.type === 'event') {
          setEvents((prev) => {
            const next = [{ ...msg.data, _event: msg.event, _ts: msg.ts }, ...prev];
            return next.slice(0, 200);
          });
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      wsRef.current = null;

      // Auto-reconnect with exponential backoff
      const delay = reconnectDelayRef.current;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectDelayRef.current = Math.min(delay * 1.5, MAX_RECONNECT_DELAY_MS);
        connect();
      }, delay);
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { state, events, connected };
}
