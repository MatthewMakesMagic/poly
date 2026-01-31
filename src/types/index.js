/**
 * Shared type definitions for poly trading system
 *
 * This module exports all shared types used across the system.
 */

// Error types
export {
  PolyError,
  PositionError,
  OrderError,
  ConfigError,
  StateError,
  ApiError,
  SafetyError,
  PersistenceError,
  IntentError,
  ErrorCodes,
} from './errors.js';

// Position types
export {
  PositionStatus,
  PositionSide,
  createPosition,
  calculateUnrealizedPnl,
  validatePosition,
} from './position.js';

// Order types
export {
  OrderStatus,
  OrderType,
  OrderSide,
  createOrder,
  isOrderTerminal,
  isOrderCancellable,
  getRemainingSize,
  validateOrder,
} from './order.js';

// Trade log types
export {
  LogLevel,
  EventType,
  createLogEntry,
  createTradeEvent,
  validateLogEntry,
} from './trade-log.js';
