#!/bin/bash
#
# run-safeguard-stories.sh - Execute all production safeguard stories
#
# Stories in priority order:
#   8-8  Live Trading Gate (CRITICAL)
#   8-9  One Trade Per Window Safeguard (CRITICAL)
#   7-20 Per-Crypto Oracle Price Fix (HIGH)
#   7-19 Cross-Module Integration Tests (HIGH)
#   E-3  Scout Paper Mode Clarity (MEDIUM)
#
# Usage: ./scripts/run-safeguard-stories.sh [--yes]
#
# Each story runs in a fresh Claude session (new process = clean context)

set -e

AUTO_YES="${1:-}"
SPRINT_STATUS="_bmad-output/implementation-artifacts/sprint-status.yaml"
STORIES_DIR="_bmad-output/implementation-artifacts"

# Stories in implementation order
STORIES=(
    "8-8-live-trading-gate"
    "8-9-one-trade-per-window-safeguard"
    "7-20-per-crypto-oracle-price-fix"
    "7-19-cross-module-integration-tests"
    "E-3-scout-paper-mode-clarity"
)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Production Safeguard Stories - Batch Execution${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}Stories to process (in order):${NC}"
for story in "${STORIES[@]}"; do
    echo "  - $story"
done
echo ""

# Confirm before starting
if [[ "$AUTO_YES" != "--yes" ]]; then
    read -p "Start automated story execution? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 1
    fi
fi

# Check if story file exists
story_file_exists() {
    local story=$1
    [[ -f "${STORIES_DIR}/${story}.md" ]]
}

# Get story status from sprint-status.yaml
get_story_status() {
    local story=$1
    grep "  ${story}:" "$SPRINT_STATUS" | sed 's/.*: //' | tr -d ' '
}

# Run claude with fresh context
run_claude_fresh() {
    local prompt="$1"
    echo -e "${YELLOW}[Fresh Context] Running: $prompt${NC}"

    # Key flags:
    # --print (-p): non-interactive mode, exits when done
    # --permission-mode bypassPermissions: auto-authorize all actions
    claude \
        --print \
        --permission-mode bypassPermissions \
        "$prompt"
}

# Process each story
COMPLETED=0
FAILED=0

for STORY in "${STORIES[@]}"; do
    echo -e "\n${BLUE}───────────────────────────────────────────────────────────${NC}"
    echo -e "${BLUE}  Starting: $STORY${NC}"
    echo -e "${BLUE}───────────────────────────────────────────────────────────${NC}"

    # Check current status
    CURRENT_STATUS=$(get_story_status "$STORY")

    if [[ "$CURRENT_STATUS" == "done" ]]; then
        echo -e "${GREEN}Story already done, skipping${NC}"
        ((COMPLETED++))
        continue
    fi

    # Check if story file needs to be created first
    if ! story_file_exists "$STORY"; then
        echo -e "${YELLOW}Story file doesn't exist - creating first...${NC}"

        # Fresh context: create story
        run_claude_fresh "/bmad-bmm-create-story $STORY"

        sleep 1

        if ! story_file_exists "$STORY"; then
            echo -e "${RED}Failed to create story file for $STORY${NC}"
            ((FAILED++))
            continue
        fi
        echo -e "${GREEN}Story file created${NC}"
    fi

    # Fresh context: run dev-story workflow
    echo -e "${GREEN}Running dev-story workflow...${NC}"

    if run_claude_fresh "/bmad-bmm-dev-story $STORY"; then
        echo -e "${GREEN}Claude process completed${NC}"
    else
        echo -e "${RED}Claude process exited with error${NC}"
        ((FAILED++))
        continue
    fi

    # Check result
    sleep 1
    NEW_STATUS=$(get_story_status "$STORY")

    if [[ "$NEW_STATUS" == "done" || "$NEW_STATUS" == "review" ]]; then
        echo -e "${GREEN}✓ Story $STORY completed (status: $NEW_STATUS)${NC}"
        ((COMPLETED++))

        # Run code review if in review status
        if [[ "$NEW_STATUS" == "review" ]]; then
            echo -e "${YELLOW}Running adversarial code review...${NC}"
            run_claude_fresh "/bmad-bmm-code-review $STORY"

            # Mark as done after review
            sed -i '' "s/  ${STORY}: review/  ${STORY}: done/" "$SPRINT_STATUS"
        fi

        # Commit changes
        echo -e "${YELLOW}Committing changes...${NC}"
        git add -A
        git commit -m "Implement story $STORY (Production Safeguards)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>" 2>/dev/null || echo "Nothing to commit"

    else
        echo -e "${YELLOW}Story $STORY status: $NEW_STATUS (expected: done or review)${NC}"
        ((FAILED++))
    fi
done

# Run full test suite
echo -e "\n${BLUE}───────────────────────────────────────────────────────────${NC}"
echo -e "${BLUE}  Running Full Test Suite${NC}"
echo -e "${BLUE}───────────────────────────────────────────────────────────${NC}"

if npm test; then
    echo -e "${GREEN}All tests passed!${NC}"
else
    echo -e "${RED}Some tests failed - review output above${NC}"
fi

# Final summary
echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Batch Execution Complete${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Completed: ${GREEN}$COMPLETED${NC}"
echo -e "  Failed:    ${RED}$FAILED${NC}"
echo ""

if [[ $FAILED -eq 0 ]]; then
    echo -e "${GREEN}All stories completed successfully!${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Verify Railway variable name: LIVE_TRADING=enabled/disabled"
    echo "  2. git push (if not already pushed)"
    echo "  3. Deploy to Railway with LIVE_TRADING=disabled"
    echo "  4. Verify paper mode working"
    echo "  5. Enable live trading only after verification"
else
    echo -e "${YELLOW}Some stories need attention - review above output${NC}"
fi
