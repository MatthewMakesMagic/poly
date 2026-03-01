import { useState, useEffect, useRef, useCallback } from 'react';

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30000;

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
          setState(msg.data);
        }

        if (msg.type === 'event') {
          setEvents((prev) => {
            const next = [{ ...msg.data, _event: msg.event, _ts: msg.ts }, ...prev];
            return next.slice(0, 200); // Keep last 200 events
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
