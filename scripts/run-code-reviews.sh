#!/bin/bash
#
# run-code-reviews.sh - Run adversarial code reviews on safeguard stories
#

set -e

SPRINT_STATUS="_bmad-output/implementation-artifacts/sprint-status.yaml"

STORIES=(
    "8-8-live-trading-gate"
    "8-9-one-trade-per-window-safeguard"
    "7-20-per-crypto-oracle-price-fix"
    "7-19-cross-module-integration-tests"
    "E-3-scout-paper-mode-clarity"
)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Adversarial Code Reviews - Auto-Fix Enabled${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

get_story_status() {
    local story=$1
    grep "  ${story}:" "$SPRINT_STATUS" | sed 's/.*: //' | tr -d ' ' | cut -d'#' -f1
}

run_claude_fresh() {
    local prompt="$1"
    echo -e "${YELLOW}[Fresh Context] Running: $prompt${NC}"
    claude --print --permission-mode bypassPermissions "$prompt"
}

REVIEWED=0
SKIPPED=0

for STORY in "${STORIES[@]}"; do
    echo -e "\n${BLUE}───────────────────────────────────────────────────────────${NC}"
    echo -e "${BLUE}  Reviewing: $STORY${NC}"
    echo -e "${BLUE}───────────────────────────────────────────────────────────${NC}"

    STATUS=$(get_story_status "$STORY")

    if [[ "$STATUS" == "done" ]]; then
        echo -e "${GREEN}Already done, skipping${NC}"
        ((SKIPPED++))
        continue
    fi

    if [[ "$STATUS" != "review" ]]; then
        echo -e "${YELLOW}Status is '$STATUS', not 'review' - skipping${NC}"
        ((SKIPPED++))
        continue
    fi

    echo -e "${GREEN}Running adversarial code review with auto-fix...${NC}"
    if run_claude_fresh "/bmad-bmm-code-review $STORY --auto-fix"; then
        echo -e "${GREEN}Code review completed${NC}"
        ((REVIEWED++))
        sed -i '' "s/  ${STORY}: review/  ${STORY}: done/" "$SPRINT_STATUS"
        echo -e "${GREEN}Marked as done${NC}"
        git add -A
        git commit -m "Code review: $STORY (auto-fixed)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>" 2>/dev/null || echo "Nothing to commit"
    else
        echo -e "${RED}Code review had issues${NC}"
    fi
done

echo -e "\n${BLUE}───────────────────────────────────────────────────────────${NC}"
echo -e "${BLUE}  Final Test Suite${NC}"
echo -e "${BLUE}───────────────────────────────────────────────────────────${NC}"
npm test

echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Code Reviews Complete${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "  Reviewed: ${GREEN}$REVIEWED${NC}"
echo -e "  Skipped:  ${YELLOW}$SKIPPED${NC}"
