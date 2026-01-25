/**
 * Execution Engine Module
 * 
 * Production-grade trading execution system for Polymarket.
 * 
 * Components:
 * - PolymarketClient: API client for order management
 * - OrderManager: Order state machine and lifecycle tracking
 * - RiskManager: Kill switches, limits, circuit breakers
 * - ExecutionEngine: Main 24/7 orchestrator
 * - HealthMonitor: Alerting and monitoring
 */

// SDK Client (RECOMMENDED - uses @polymarket/clob-client with fixes)
export { 
    SDKClient, 
    createSDKClient,
    HOST,
    GAMMA_API 
} from './sdk_client.js';

// Legacy client (custom implementation)
export { 
    PolymarketClient, 
    Side, 
    OrderType, 
    createClientFromEnv,
    ENDPOINTS,
    CHAIN_ID 
} from './polymarket_client.js';

// Order management
export { 
    Order, 
    OrderManager, 
    OrderState, 
    TERMINAL_STATES 
} from './order_state_machine.js';

// Risk management
export { 
    RiskManager, 
    RiskViolation 
} from './risk_manager.js';

// Engine
export { 
    ExecutionEngine, 
    EngineState 
} from './execution_engine.js';

// Health monitoring
export { 
    HealthMonitor, 
    AlertLevel, 
    AlertType, 
    attachMonitor 
} from './health_monitor.js';

// Kill switch
export {
    KillSwitch,
    isKillSwitchActive,
    activateKillSwitch,
    deactivateKillSwitch
} from './kill_switch.js';
