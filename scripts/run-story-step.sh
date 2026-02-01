#!/bin/bash

#############################################################################
# Run Story Step - Simple single-step executor
#
# Runs a single step for a story in a fresh Claude context.
# Each invocation clears context naturally.
#
# Usage:
#   ./run-story-step.sh <story-id> <step>
#
# Steps:
#   create   - Create story file (/bmad-bmm-create-story)
#   dev      - Implement story (/bmad-bmm-dev-story)
#   review   - Code review (/bmad-bmm-code-review)
#   review2  - Secondary review (custom prompt)
#############################################################################

set -e

STORY_ID="$1"
STEP="$2"

if [[ -z "$STORY_ID" ]] || [[ -z "$STEP" ]]; then
    echo "Usage: $0 <story-id> <step>"
    echo ""
    echo "Steps:"
    echo "  create   - Create story file"
    echo "  dev      - Implement story"
    echo "  review   - Primary code review"
    echo "  review2  - Secondary code review"
    echo ""
    echo "Epic 7 Stories (Oracle Edge):"
    echo "  7-1-rtds-websocket-client"
    echo "  7-2-feed-tick-logger"
    echo "  7-3-feed-divergence-tracker"
    echo "  7-4-oracle-update-pattern-tracker"
    echo "  7-5-oracle-update-predictor"
    echo "  7-6-oracle-staleness-detector"
    echo "  7-7-oracle-edge-signal-generator"
    echo "  7-8-signal-outcome-logger"
    echo "  7-9-strategy-quality-gate"
    echo "  7-10-window-timing-model"
    echo "  7-11-lag-tracker"
    echo "  7-12-strategy-composition-integration"
    echo ""
    echo "Epic 8 Stories (Launch Control):"
    echo "  8-1-launch-manifest"
    echo "  8-2-pre-flight-checks"
    echo "  8-3-health-endpoint-enhancement"
    echo "  8-4-deploy-command"
    echo "  8-5-post-deploy-verification"
    echo ""
    echo "Examples:"
    echo "  $0 7-1-rtds-websocket-client dev"
    echo "  $0 8-1-launch-manifest create"
    echo "  $0 8-1-launch-manifest dev"
    exit 1
fi

PROJECT_ROOT="/Users/matthewkirkham/poly"
LOG_DIR="${PROJECT_ROOT}/logs/steps"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="${LOG_DIR}/${STORY_ID}-${STEP}-${TIMESTAMP}.log"

mkdir -p "${LOG_DIR}"

echo "═══════════════════════════════════════════════════"
echo "Story: ${STORY_ID}"
echo "Step:  ${STEP}"
echo "Log:   ${LOG_FILE}"
echo "═══════════════════════════════════════════════════"
echo ""

case "${STEP}" in
    create)
        PROMPT="/bmad-bmm-create-story ${STORY_ID}"
        ;;
    dev)
        PROMPT="/bmad-bmm-dev-story ${STORY_ID}"
        ;;
    review)
        PROMPT="/bmad-bmm-code-review ${STORY_ID}

AUTONOMOUS MODE: Do NOT ask for user input or confirmation. Automatically fix all issues found. After fixing, update the story status to done and report what was fixed."
        ;;
    review2)
        PROMPT="Perform a thorough secondary code review for story ${STORY_ID}.

Read the story file at: _bmad-output/implementation-artifacts/${STORY_ID}.md
Review all files listed in the 'File List' section.

Focus areas:
1. SECURITY - Vulnerabilities, injection risks, credential exposure
2. PERFORMANCE - Inefficient operations, memory issues
3. EDGE CASES - Null checks, boundaries, error scenarios
4. TEST COVERAGE - Missing tests, untested paths
5. ARCHITECTURE - Compliance with architecture.md
6. ERROR HANDLING - Proper propagation and logging

Find and fix all issues. Be adversarial - find problems, don't approve."
        ;;
    *)
        echo "Unknown step: ${STEP}"
        echo "Valid steps: create, dev, review, review2"
        exit 1
        ;;
esac

echo "Running Claude with fresh context..."
echo ""

# Run claude - each invocation is a fresh context
claude --dangerously-skip-permissions \
       --max-turns 100 \
       -p "${PROMPT}" 2>&1 | tee "${LOG_FILE}"

EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo "═══════════════════════════════════════════════════"
if [[ ${EXIT_CODE} -eq 0 ]]; then
    echo "✓ Step completed successfully"
else
    echo "✗ Step failed (exit code: ${EXIT_CODE})"
fi
echo "Log saved to: ${LOG_FILE}"
echo "═══════════════════════════════════════════════════"

exit ${EXIT_CODE}
