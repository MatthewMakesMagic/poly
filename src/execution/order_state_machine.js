/**
 * Order State Machine
 * 
 * Tracks the full lifecycle of every order with complete audit trail.
 * Handles all state transitions and failure recovery.
 * 
 * States:
 *   PENDING    -> Order created, not yet submitted
 *   SUBMITTED  -> Order sent to exchange, awaiting confirmation
 *   OPEN       -> Order confirmed and live on the book
 *   PARTIALLY_FILLED -> Some fills received
 *   FILLED     -> Completely filled
 *   CANCELLED  -> User cancelled
 *   REJECTED   -> Exchange rejected
 *   EXPIRED    -> Order expired (GTD orders)
 *   FAILED     -> System error during processing
 */

import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';

/**
 * Order states
 */
export const OrderState = {
    PENDING: 'PENDING',
    SUBMITTED: 'SUBMITTED',
    OPEN: 'OPEN',
    PARTIALLY_FILLED: 'PARTIALLY_FILLED',
    FILLED: 'FILLED',
    CANCELLED: 'CANCELLED',
    REJECTED: 'REJECTED',
    EXPIRED: 'EXPIRED',
    FAILED: 'FAILED'
};

/**
 * Valid state transitions
 */
const VALID_TRANSITIONS = {
    [OrderState.PENDING]: [OrderState.SUBMITTED, OrderState.FAILED, OrderState.CANCELLED],
    [OrderState.SUBMITTED]: [OrderState.OPEN, OrderState.FILLED, OrderState.REJECTED, OrderState.FAILED],
    [OrderState.OPEN]: [OrderState.PARTIALLY_FILLED, OrderState.FILLED, OrderState.CANCELLED, OrderState.EXPIRED, OrderState.FAILED],
    [OrderState.PARTIALLY_FILLED]: [OrderState.FILLED, OrderState.CANCELLED, OrderState.EXPIRED, OrderState.FAILED],
    [OrderState.FILLED]: [],
    [OrderState.CANCELLED]: [],
    [OrderState.REJECTED]: [],
    [OrderState.EXPIRED]: [],
    [OrderState.FAILED]: [OrderState.PENDING] // Can retry failed orders
};

/**
 * Terminal states (order is complete)
 */
export const TERMINAL_STATES = [
    OrderState.FILLED,
    OrderState.CANCELLED,
    OrderState.REJECTED,
    OrderState.EXPIRED,
    OrderState.FAILED
];

/**
 * Single Order instance with full state tracking
 */
export class Order {
    constructor(params) {
        // Identification
        this.id = params.id || uuidv4();
        this.clientOrderId = params.clientOrderId || `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.exchangeOrderId = null;  // Set when exchange confirms
        
        // Market info
        this.tokenId = params.tokenId;
        this.market = params.market;
        this.crypto = params.crypto;
        this.windowEpoch = params.windowEpoch;
        
        // Order parameters
        this.side = params.side;           // 'BUY' or 'SELL'
        this.tokenSide = params.tokenSide; // 'UP' or 'DOWN'
        this.price = params.price;
        this.size = params.size;           // Size in USD
        this.orderType = params.orderType || 'GTC';
        
        // State
        this.state = OrderState.PENDING;
        this.previousState = null;
        
        // Fill tracking
        this.filledSize = 0;
        this.filledPrice = 0;    // Average fill price
        this.remainingSize = params.size;
        this.fills = [];         // Array of fill events
        
        // Timestamps (all in ms)
        this.createdAt = Date.now();
        this.submittedAt = null;
        this.confirmedAt = null;
        this.filledAt = null;
        this.completedAt = null;
        
        // Context at creation
        this.context = {
            spotPrice: params.spotPrice,
            upBid: params.upBid,
            upAsk: params.upAsk,
            downBid: params.downBid,
            downAsk: params.downAsk,
            timeRemaining: params.timeRemaining,
            spread: params.spread
        };
        
        // Execution quality
        this.expectedPrice = params.price;
        this.slippage = 0;
        this.fees = 0;
        
        // Error tracking
        this.error = null;
        this.retryCount = 0;
        this.maxRetries = params.maxRetries || 3;
        
        // Audit trail
        this.history = [{
            timestamp: this.createdAt,
            state: OrderState.PENDING,
            event: 'ORDER_CREATED',
            details: { params }
        }];
        
        // Strategy reference
        this.strategy = params.strategy;
        this.signal = params.signal;     // Original signal that triggered this order
        
        // Linked orders (for position management)
        this.parentOrderId = params.parentOrderId;  // If this is a closing order
        this.childOrderIds = [];                     // Child/closing orders
    }
    
    /**
     * Transition to a new state
     */
    transitionTo(newState, event, details = {}) {
        // Validate transition
        const validNextStates = VALID_TRANSITIONS[this.state];
        if (!validNextStates.includes(newState)) {
            const error = new Error(
                `Invalid state transition: ${this.state} -> ${newState}. ` +
                `Valid transitions: ${validNextStates.join(', ')}`
            );
            this.recordHistory('INVALID_TRANSITION_ATTEMPT', { 
                attemptedState: newState, 
                error: error.message 
            });
            throw error;
        }
        
        // Record transition
        this.previousState = this.state;
        this.state = newState;
        
        // Update timestamps
        const now = Date.now();
        switch (newState) {
            case OrderState.SUBMITTED:
                this.submittedAt = now;
                break;
            case OrderState.OPEN:
                this.confirmedAt = now;
                break;
            case OrderState.FILLED:
                this.filledAt = now;
                this.completedAt = now;
                break;
            case OrderState.CANCELLED:
            case OrderState.REJECTED:
            case OrderState.EXPIRED:
            case OrderState.FAILED:
                this.completedAt = now;
                break;
        }
        
        // Record in history
        this.recordHistory(event, { newState, ...details });
        
        return this;
    }
    
    /**
     * Record an event in history
     */
    recordHistory(event, details = {}) {
        this.history.push({
            timestamp: Date.now(),
            state: this.state,
            event,
            details
        });
    }
    
    /**
     * Mark order as submitted
     */
    markSubmitted(exchangeOrderId) {
        this.exchangeOrderId = exchangeOrderId;
        return this.transitionTo(OrderState.SUBMITTED, 'ORDER_SUBMITTED', { exchangeOrderId });
    }
    
    /**
     * Mark order as confirmed/open
     */
    markOpen(response) {
        return this.transitionTo(OrderState.OPEN, 'ORDER_CONFIRMED', { response });
    }
    
    /**
     * Record a fill
     */
    addFill(fill) {
        const fillRecord = {
            id: fill.id || uuidv4(),
            timestamp: fill.timestamp || Date.now(),
            price: fill.price,
            size: fill.size,
            fee: fill.fee || 0
        };
        
        this.fills.push(fillRecord);
        
        // Update totals
        const prevFilledSize = this.filledSize;
        this.filledSize += fill.size;
        this.remainingSize = Math.max(0, this.size - this.filledSize);
        this.fees += fill.fee || 0;
        
        // Calculate weighted average fill price
        if (this.filledSize > 0) {
            this.filledPrice = (
                (prevFilledSize * this.filledPrice) + (fill.size * fill.price)
            ) / this.filledSize;
        }
        
        // Calculate slippage
        this.slippage = this.filledPrice - this.expectedPrice;
        
        // State transition
        const event = 'FILL_RECEIVED';
        const details = { fill: fillRecord, filledSize: this.filledSize, remainingSize: this.remainingSize };
        
        if (this.remainingSize <= 0) {
            this.transitionTo(OrderState.FILLED, event, details);
        } else if (this.state === OrderState.OPEN) {
            this.transitionTo(OrderState.PARTIALLY_FILLED, event, details);
        } else {
            this.recordHistory(event, details);
        }
        
        return this;
    }
    
    /**
     * Mark order as cancelled
     */
    markCancelled(reason) {
        return this.transitionTo(OrderState.CANCELLED, 'ORDER_CANCELLED', { reason });
    }
    
    /**
     * Mark order as rejected
     */
    markRejected(error) {
        this.error = error;
        return this.transitionTo(OrderState.REJECTED, 'ORDER_REJECTED', { error });
    }
    
    /**
     * Mark order as expired
     */
    markExpired() {
        return this.transitionTo(OrderState.EXPIRED, 'ORDER_EXPIRED', {});
    }
    
    /**
     * Mark order as failed
     */
    markFailed(error) {
        this.error = error;
        return this.transitionTo(OrderState.FAILED, 'ORDER_FAILED', { error });
    }
    
    /**
     * Check if order is in a terminal state
     */
    isComplete() {
        return TERMINAL_STATES.includes(this.state);
    }
    
    /**
     * Check if order can be retried
     */
    canRetry() {
        return this.state === OrderState.FAILED && this.retryCount < this.maxRetries;
    }
    
    /**
     * Prepare for retry
     */
    prepareRetry() {
        if (!this.canRetry()) {
            throw new Error('Order cannot be retried');
        }
        
        this.retryCount++;
        this.error = null;
        this.transitionTo(OrderState.PENDING, 'RETRY_PREPARED', { retryCount: this.retryCount });
        
        return this;
    }
    
    /**
     * Calculate realized P&L (only valid for filled orders)
     */
    calculatePnL(exitPrice = null) {
        if (this.filledSize === 0) return null;
        
        // For a buy order, P&L = (exitPrice - entryPrice) * size
        // For a sell order, P&L = (entryPrice - exitPrice) * size
        
        if (!exitPrice) {
            // Use filled price as reference
            return {
                grossPnL: 0,
                fees: this.fees,
                netPnL: -this.fees,
                slippage: this.slippage,
                slippageCost: this.slippage * this.filledSize
            };
        }
        
        let grossPnL;
        if (this.side === 'BUY') {
            grossPnL = (exitPrice - this.filledPrice) * this.filledSize;
        } else {
            grossPnL = (this.filledPrice - exitPrice) * this.filledSize;
        }
        
        return {
            grossPnL,
            fees: this.fees,
            netPnL: grossPnL - this.fees,
            slippage: this.slippage,
            slippageCost: this.slippage * this.filledSize
        };
    }
    
    /**
     * Get order duration in ms
     */
    getDuration() {
        const endTime = this.completedAt || Date.now();
        return endTime - this.createdAt;
    }
    
    /**
     * Get time to fill in ms
     */
    getTimeToFill() {
        if (!this.filledAt) return null;
        return this.filledAt - this.submittedAt;
    }
    
    /**
     * Serialize to JSON for persistence
     */
    toJSON() {
        return {
            id: this.id,
            clientOrderId: this.clientOrderId,
            exchangeOrderId: this.exchangeOrderId,
            tokenId: this.tokenId,
            market: this.market,
            crypto: this.crypto,
            windowEpoch: this.windowEpoch,
            side: this.side,
            tokenSide: this.tokenSide,
            price: this.price,
            size: this.size,
            orderType: this.orderType,
            state: this.state,
            previousState: this.previousState,
            filledSize: this.filledSize,
            filledPrice: this.filledPrice,
            remainingSize: this.remainingSize,
            fills: this.fills,
            createdAt: this.createdAt,
            submittedAt: this.submittedAt,
            confirmedAt: this.confirmedAt,
            filledAt: this.filledAt,
            completedAt: this.completedAt,
            context: this.context,
            expectedPrice: this.expectedPrice,
            slippage: this.slippage,
            fees: this.fees,
            error: this.error,
            retryCount: this.retryCount,
            history: this.history,
            strategy: this.strategy,
            signal: this.signal,
            parentOrderId: this.parentOrderId,
            childOrderIds: this.childOrderIds
        };
    }
    
    /**
     * Restore from JSON
     */
    static fromJSON(data) {
        const order = new Order({
            id: data.id,
            clientOrderId: data.clientOrderId,
            tokenId: data.tokenId,
            market: data.market,
            crypto: data.crypto,
            windowEpoch: data.windowEpoch,
            side: data.side,
            tokenSide: data.tokenSide,
            price: data.price,
            size: data.size,
            orderType: data.orderType,
            spotPrice: data.context?.spotPrice,
            upBid: data.context?.upBid,
            upAsk: data.context?.upAsk,
            downBid: data.context?.downBid,
            downAsk: data.context?.downAsk,
            timeRemaining: data.context?.timeRemaining,
            spread: data.context?.spread,
            strategy: data.strategy,
            signal: data.signal,
            parentOrderId: data.parentOrderId
        });
        
        // Restore state
        order.exchangeOrderId = data.exchangeOrderId;
        order.state = data.state;
        order.previousState = data.previousState;
        order.filledSize = data.filledSize;
        order.filledPrice = data.filledPrice;
        order.remainingSize = data.remainingSize;
        order.fills = data.fills || [];
        order.createdAt = data.createdAt;
        order.submittedAt = data.submittedAt;
        order.confirmedAt = data.confirmedAt;
        order.filledAt = data.filledAt;
        order.completedAt = data.completedAt;
        order.expectedPrice = data.expectedPrice;
        order.slippage = data.slippage;
        order.fees = data.fees;
        order.error = data.error;
        order.retryCount = data.retryCount;
        order.history = data.history || [];
        order.childOrderIds = data.childOrderIds || [];
        
        return order;
    }
}

/**
 * Order Manager - tracks all orders with event emission
 */
export class OrderManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.orders = new Map();          // id -> Order
        this.ordersByExchangeId = new Map(); // exchangeOrderId -> Order
        this.openOrders = new Set();      // Set of open order IDs
        this.logger = options.logger || console;
        
        // Stats
        this.stats = {
            created: 0,
            submitted: 0,
            filled: 0,
            cancelled: 0,
            rejected: 0,
            failed: 0
        };
    }
    
    /**
     * Create a new order
     */
    createOrder(params) {
        const order = new Order(params);
        
        this.orders.set(order.id, order);
        this.openOrders.add(order.id);
        this.stats.created++;
        
        this.logger.log(`[OrderManager] Created order ${order.id}: ${order.side} ${order.tokenSide} $${order.size} @ ${order.price}`);
        this.emit('order:created', order);
        
        return order;
    }
    
    /**
     * Get order by ID
     */
    getOrder(id) {
        return this.orders.get(id);
    }
    
    /**
     * Get order by exchange ID
     */
    getOrderByExchangeId(exchangeOrderId) {
        return this.ordersByExchangeId.get(exchangeOrderId);
    }
    
    /**
     * Mark order as submitted
     */
    markSubmitted(id, exchangeOrderId) {
        const order = this.orders.get(id);
        if (!order) {
            throw new Error(`Order not found: ${id}`);
        }
        
        order.markSubmitted(exchangeOrderId);
        this.ordersByExchangeId.set(exchangeOrderId, order);
        this.stats.submitted++;
        
        this.logger.log(`[OrderManager] Order ${id} submitted, exchange ID: ${exchangeOrderId}`);
        this.emit('order:submitted', order);
        
        return order;
    }
    
    /**
     * Mark order as open/confirmed
     */
    markOpen(id, response = {}) {
        const order = this.orders.get(id);
        if (!order) {
            throw new Error(`Order not found: ${id}`);
        }
        
        order.markOpen(response);
        this.logger.log(`[OrderManager] Order ${id} confirmed and open`);
        this.emit('order:open', order);
        
        return order;
    }
    
    /**
     * Add fill to order
     */
    addFill(id, fill) {
        const order = this.orders.get(id);
        if (!order) {
            throw new Error(`Order not found: ${id}`);
        }
        
        const wasComplete = order.isComplete();
        order.addFill(fill);
        
        this.logger.log(`[OrderManager] Fill on order ${id}: ${fill.size} @ ${fill.price}`);
        this.emit('order:fill', order, fill);
        
        if (!wasComplete && order.isComplete()) {
            this.handleOrderComplete(order);
        }
        
        return order;
    }
    
    /**
     * Mark order as cancelled
     */
    markCancelled(id, reason) {
        const order = this.orders.get(id);
        if (!order) {
            throw new Error(`Order not found: ${id}`);
        }
        
        order.markCancelled(reason);
        this.handleOrderComplete(order);
        this.stats.cancelled++;
        
        this.logger.log(`[OrderManager] Order ${id} cancelled: ${reason}`);
        this.emit('order:cancelled', order);
        
        return order;
    }
    
    /**
     * Mark order as rejected
     */
    markRejected(id, error) {
        const order = this.orders.get(id);
        if (!order) {
            throw new Error(`Order not found: ${id}`);
        }
        
        order.markRejected(error);
        this.handleOrderComplete(order);
        this.stats.rejected++;
        
        this.logger.log(`[OrderManager] Order ${id} rejected: ${error}`);
        this.emit('order:rejected', order);
        
        return order;
    }
    
    /**
     * Mark order as failed
     */
    markFailed(id, error) {
        const order = this.orders.get(id);
        if (!order) {
            throw new Error(`Order not found: ${id}`);
        }
        
        order.markFailed(error);
        this.handleOrderComplete(order);
        this.stats.failed++;
        
        this.logger.log(`[OrderManager] Order ${id} failed: ${error}`);
        this.emit('order:failed', order);
        
        return order;
    }
    
    /**
     * Handle order completion
     */
    handleOrderComplete(order) {
        this.openOrders.delete(order.id);
        
        if (order.state === OrderState.FILLED) {
            this.stats.filled++;
        }
        
        this.emit('order:complete', order);
    }
    
    /**
     * Get all open orders
     */
    getOpenOrders() {
        return Array.from(this.openOrders).map(id => this.orders.get(id));
    }
    
    /**
     * Get all orders for a window
     */
    getOrdersForWindow(crypto, windowEpoch) {
        return Array.from(this.orders.values()).filter(
            o => o.crypto === crypto && o.windowEpoch === windowEpoch
        );
    }
    
    /**
     * Cancel all open orders
     */
    async cancelAllOpen(reason = 'manual_cancel') {
        const cancelled = [];
        for (const id of this.openOrders) {
            const order = this.orders.get(id);
            if (order && !order.isComplete()) {
                order.markCancelled(reason);
                cancelled.push(order);
            }
        }
        this.openOrders.clear();
        return cancelled;
    }
    
    /**
     * Get stats
     */
    getStats() {
        return {
            ...this.stats,
            openCount: this.openOrders.size,
            totalCount: this.orders.size
        };
    }
    
    /**
     * Export all orders for persistence
     */
    exportOrders() {
        return Array.from(this.orders.values()).map(o => o.toJSON());
    }
    
    /**
     * Import orders from persistence
     */
    importOrders(ordersData) {
        for (const data of ordersData) {
            const order = Order.fromJSON(data);
            this.orders.set(order.id, order);
            
            if (order.exchangeOrderId) {
                this.ordersByExchangeId.set(order.exchangeOrderId, order);
            }
            
            if (!order.isComplete()) {
                this.openOrders.add(order.id);
            }
        }
        
        this.logger.log(`[OrderManager] Imported ${ordersData.length} orders`);
    }
}

export default OrderManager;
