#!/bin/bash
#
# run-epic.sh - Automated story execution with fresh context per story
#
# Usage: ./scripts/run-epic.sh [epic_number] [--yes]
# Example: ./scripts/run-epic.sh 1
#
# Each story runs in a fresh Claude session (new process = clean context)
# Pauses at epic end for review

set -e

EPIC="${1:-1}"
AUTO_YES="${2:-}"
SPRINT_STATUS="_bmad-output/implementation-artifacts/sprint-status.yaml"
STORIES_DIR="_bmad-output/implementation-artifacts"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  BMAD Epic Runner - Epic $EPIC${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

# Extract backlog stories for the epic from sprint-status.yaml
get_backlog_stories() {
    local epic=$1
    grep "^  ${epic}-" "$SPRINT_STATUS" 2>/dev/null | grep ": backlog" | sed 's/:.*//' | sed 's/^ *//' || true
}

# Check if story file exists (ready-for-dev)
story_file_exists() {
    local story=$1
    [[ -f "${STORIES_DIR}/${story}.md" ]]
}

# Get story status from sprint-status.yaml
get_story_status() {
    local story=$1
    grep "^  ${story}:" "$SPRINT_STATUS" | sed 's/.*: //'
}

# Run claude with fresh context
run_claude_fresh() {
    local prompt="$1"
    echo -e "${YELLOW}[Fresh Context] Running: $prompt${NC}"

    # Key flags:
    # --print (-p): non-interactive mode, exits when done
    # --permission-mode bypassPermissions: reduces approval friction
    # Each invocation is a new process = fresh context
    claude \
        --print \
        --permission-mode bypassPermissions \
        "$prompt"
}

# Main execution
STORIES=$(get_backlog_stories "$EPIC")

if [[ -z "$STORIES" ]]; then
    echo -e "${GREEN}No backlog stories remaining in Epic $EPIC${NC}"
    echo -e "${YELLOW}Epic may be complete - run retrospective?${NC}"
    exit 0
fi

echo -e "\n${YELLOW}Stories to process:${NC}"
for story in $STORIES; do
    [[ -n "$story" ]] && echo "  - $story"
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

# Process each story
COMPLETED=0
FAILED=0

# Use for loop instead of pipe to avoid subshell issues
for STORY in $STORIES; do
    [[ -z "$STORY" ]] && continue

    echo -e "\n${BLUE}───────────────────────────────────────────────────────────${NC}"
    echo -e "${BLUE}  Starting: $STORY${NC}"
    echo -e "${BLUE}───────────────────────────────────────────────────────────${NC}"

    # Check if story file needs to be created first
    if ! story_file_exists "$STORY"; then
        echo -e "${YELLOW}Story file doesn't exist - creating first...${NC}"

        # Fresh context: create story
        run_claude_fresh "/bmad-bmm-create-story $STORY"

        # Small delay to let file system sync
        sleep 1

        if ! story_file_exists "$STORY"; then
            echo -e "${RED}Failed to create story file for $STORY${NC}"
            continue
        fi
        echo -e "${GREEN}Story file created${NC}"
    fi

    # Fresh context: run dev-story workflow
    echo -e "${GREEN}Running dev-story workflow...${NC}"

    # The key: each claude invocation is a fresh process with fresh context
    if run_claude_fresh "/bmad-bmm-dev-story $STORY"; then
        echo -e "${GREEN}Claude process completed${NC}"
    else
        echo -e "${RED}Claude process exited with error${NC}"

        if [[ "$AUTO_YES" != "--yes" ]]; then
            read -p "Continue to next story anyway? (y/N) " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                echo "Paused. Resume with: ./scripts/run-epic.sh $EPIC"
                exit 0
            fi
        fi
        continue
    fi

    # Check result
    sleep 1  # Let file system sync
    NEW_STATUS=$(get_story_status "$STORY")

    # Accept "done" or "review" as success (review is the natural end state of dev-story)
    if [[ "$NEW_STATUS" == "done" || "$NEW_STATUS" == "review" ]]; then
        echo -e "${GREEN}✓ Story $STORY completed (status: $NEW_STATUS)${NC}"
        ((COMPLETED++))

        # Auto-mark as done if in review (skip code review for automation)
        if [[ "$NEW_STATUS" == "review" ]]; then
            echo -e "${YELLOW}Auto-marking as done (skipping code review)...${NC}"
            sed -i '' "s/  ${STORY}: review/  ${STORY}: done/" "$SPRINT_STATUS"
        fi

        # Commit changes
        echo -e "${YELLOW}Committing changes...${NC}"
        git add -A
        git commit -m "Implement story $STORY

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>" 2>/dev/null || echo "Nothing to commit"

        # Push to GitHub
        echo -e "${YELLOW}Pushing to GitHub...${NC}"
        if git push 2>/dev/null; then
            echo -e "${GREEN}Pushed successfully${NC}"
        else
            echo -e "${YELLOW}Push failed or nothing to push${NC}"
        fi
    else
        echo -e "${YELLOW}Story $STORY status: $NEW_STATUS (expected: done or review)${NC}"
        echo -e "${YELLOW}May need manual intervention${NC}"
        ((FAILED++))

        if [[ "$AUTO_YES" != "--yes" ]]; then
            # Pause for review
            read -p "Continue to next story? (y/N) " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                echo "Paused. Resume with: ./scripts/run-epic.sh $EPIC"
                exit 0
            fi
        fi
    fi

done

echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Epic $EPIC Processing Complete${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

# Check if epic is complete (check for backlog OR ready-for-dev)
get_incomplete_stories() {
    local epic=$1
    grep "^  ${epic}-" "$SPRINT_STATUS" 2>/dev/null | grep -E ": (backlog|ready-for-dev|in-progress|review)" | sed 's/:.*//' | sed 's/^ *//' || true
}

REMAINING=$(get_incomplete_stories "$EPIC")
if [[ -z "$REMAINING" ]]; then
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  All stories in Epic $EPIC are done!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${YELLOW}Review time - check the implementation before proceeding.${NC}"
    echo ""
    echo "Suggested next steps:"
    echo "  1. Review git log for Epic $EPIC commits"
    echo "  2. Run tests: npm test"
    echo "  3. Optional retrospective: /bmad-bmm-retrospective"
    echo "  4. Start next epic: ./scripts/run-epic.sh $((EPIC + 1))"
else
    echo -e "${YELLOW}Remaining incomplete stories:${NC}"
    for story in $REMAINING; do
        [[ -n "$story" ]] && echo "  - $story"
    done
fi
