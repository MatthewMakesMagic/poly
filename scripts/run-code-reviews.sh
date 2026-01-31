#!/bin/bash
#
# run-code-reviews.sh - Run adversarial code reviews on completed stories
#
# Usage: ./scripts/run-code-reviews.sh [epic_number]
# Example: ./scripts/run-code-reviews.sh 1  # Review Epic 1 stories only
#          ./scripts/run-code-reviews.sh    # Review all completed stories
#

set -e

EPIC="${1:-}"
SPRINT_STATUS="_bmad-output/implementation-artifacts/sprint-status.yaml"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  BMAD Code Review Runner${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

# Get stories to review
if [[ -n "$EPIC" ]]; then
    STORIES=$(grep "^  ${EPIC}-.*: done" "$SPRINT_STATUS" | sed 's/:.*//' | sed 's/^ *//')
    echo -e "${YELLOW}Reviewing Epic $EPIC stories...${NC}"
else
    STORIES=$(grep -E "^  [0-9]+-.*: done" "$SPRINT_STATUS" | sed 's/:.*//' | sed 's/^ *//')
    echo -e "${YELLOW}Reviewing all completed stories...${NC}"
fi

if [[ -z "$STORIES" ]]; then
    echo -e "${GREEN}No stories to review${NC}"
    exit 0
fi

echo -e "\n${YELLOW}Stories to review:${NC}"
for story in $STORIES; do
    echo "  - $story"
done
echo ""

REVIEWED=0
ISSUES_FOUND=0

for STORY in $STORIES; do
    [[ -z "$STORY" ]] && continue

    echo -e "\n${BLUE}───────────────────────────────────────────────────────────${NC}"
    echo -e "${BLUE}  Reviewing: $STORY${NC}"
    echo -e "${BLUE}───────────────────────────────────────────────────────────${NC}"

    # Run code review
    REVIEW_OUTPUT=$(claude --print --permission-mode bypassPermissions "/bmad-bmm-code-review $STORY" 2>&1)

    echo "$REVIEW_OUTPUT"

    # Check if issues were found
    if echo "$REVIEW_OUTPUT" | grep -q "HIGH\|MEDIUM"; then
        echo -e "\n${YELLOW}Issues found - running auto-fix...${NC}"
        ((ISSUES_FOUND++))

        # Extract and fix issues
        claude --print --permission-mode bypassPermissions "Based on the code review just performed for $STORY, fix all HIGH and MEDIUM issues. After fixing, run tests to verify nothing is broken. Commit the fixes with a descriptive message."

        echo -e "${GREEN}Fixes applied${NC}"
    else
        echo -e "${GREEN}No critical issues found${NC}"
    fi

    ((REVIEWED++))
done

echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Code Review Complete${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "  Stories reviewed: ${GREEN}$REVIEWED${NC}"
echo -e "  Stories with issues: ${YELLOW}$ISSUES_FOUND${NC}"

# Final test run
echo -e "\n${YELLOW}Running final test suite...${NC}"
npm test
