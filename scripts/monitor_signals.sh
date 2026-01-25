#!/bin/bash
# Signal Monitor - Logs all enabled signals and executions
# Run for 4 cycles (60 minutes)

LOG_FILE="/Users/matthewkirkham/poly/logs/signals_$(date +%Y%m%d_%H%M).log"

echo "=== LIVE TRADING SIGNAL LOG ===" > "$LOG_FILE"
echo "Started: $(date -u '+%Y-%m-%d %H:%M:%S UTC')" >> "$LOG_FILE"
echo "Monitoring 4 cycles (60 minutes)..." >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

for i in {1..60}; do
    TIMESTAMP=$(date -u '+%H:%M:%S UTC')
    
    # Get latest signals and executions from Railway
    SIGNALS=$(railway logs --lines 100 2>&1 | grep -E "enabled.*true|EXECUTING|FILLED|Order not|Window changed" | tail -10)
    
    # Get current prices
    PRICES=$(railway logs --lines 50 2>&1 | grep "Binance" | tail -4)
    
    # Log if there are any signals
    if [ -n "$SIGNALS" ]; then
        echo "[$TIMESTAMP] === SIGNALS ===" >> "$LOG_FILE"
        echo "$SIGNALS" >> "$LOG_FILE"
        echo "" >> "$LOG_FILE"
    fi
    
    # Log prices every 5 minutes
    if [ $((i % 5)) -eq 0 ]; then
        echo "[$TIMESTAMP] --- PRICES ---" >> "$LOG_FILE"
        echo "$PRICES" >> "$LOG_FILE"
        echo "" >> "$LOG_FILE"
    fi
    
    # Print to terminal
    echo "[$TIMESTAMP] Check $i/60"
    if [ -n "$SIGNALS" ]; then
        echo "$SIGNALS"
    fi
    
    sleep 60
done

echo "" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"
echo "Monitoring complete: $(date -u '+%Y-%m-%d %H:%M:%S UTC')" >> "$LOG_FILE"
