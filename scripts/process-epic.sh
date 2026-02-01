#!/bin/bash

#############################################################################
# Process Epic - Practical Implementation Script
#
# Processes stories through the BMAD pipeline using separate Claude
# invocations (each gets fresh context naturally).
#
# Each step runs in its own claude session:
# 1. create-story - Creates the story file with full context
# 2. dev-story - Implements the story
# 3. code-review - Reviews the implementation
#
# Usage:
#   ./process-epic.sh                    # Interactive mode
#   ./process-epic.sh --auto             # Auto mode (skip confirmations)
#   ./process-epic.sh --story 7-1        # Single story
#############################################################################

set -e

PROJECT_ROOT="/Users/matthewkirkham/poly"
LOG_DIR="${PROJECT_ROOT}/logs/implementation"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

mkdir -p "${LOG_DIR}"

#############################################################################
# Epic 7 Stories in dependency order
#############################################################################

# Wave definitions for parallel-capable grouping
declare -a WAVES=(
    "7-1-rtds-websocket-client"
    "7-2-feed-tick-logger|7-3-feed-divergence-tracker|7-4-oracle-update-pattern-tracker|7-10-window-timing-model|7-11-lag-tracker"
    "7-5-oracle-update-predictor|7-6-oracle-staleness-detector"
    "7-7-oracle-edge-signal-generator"
    "7-8-signal-outcome-logger"
    "7-9-strategy-quality-gate"
    "7-12-strategy-composition-integration"
)

# All stories in order
ALL_STORIES=(
    "7-1-rtds-websocket-client"
    "7-2-feed-tick-logger"
    "7-3-feed-divergence-tracker"
    "7-4-oracle-update-pattern-tracker"
    "7-5-oracle-update-predictor"
    "7-6-oracle-staleness-detector"
    "7-7-oracle-edge-signal-generator"
    "7-8-signal-outcome-logger"
    "7-9-strategy-quality-gate"
    "7-10-window-timing-model"
    "7-11-lag-tracker"
    "7-12-strategy-composition-integration"
)

#############################################################################
# Utility Functions
#############################################################################

print_header() {
    echo ""
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  $1${NC}"
    echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
    echo ""
}

print_step() {
    echo -e "${BLUE}▶ $1${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warn() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

confirm() {
    if [[ "$AUTO_MODE" == "true" ]]; then
        return 0
    fi

    local prompt="$1"
    echo -e "${YELLOW}${prompt}${NC}"
    read -p "Press Enter to continue (or 'q' to quit): " response
    if [[ "$response" == "q" ]]; then
        echo "Aborted."
        exit 0
    fi
}

#############################################################################
# Claude Execution Functions
#############################################################################

# Run claude with a command, fresh context each time
run_claude() {
    local prompt="$1"
    local story_id="$2"
    local step="$3"
    local log_file="${LOG_DIR}/${story_id}-${step}-${TIMESTAMP}.log"

    print_step "Running: ${step}"
    echo "  Logging to: ${log_file}"

    # Run claude with the prompt
    # --dangerously-skip-permissions allows automation
    # Each invocation is a fresh context
    if claude --dangerously-skip-permissions \
              --max-turns 100 \
              -p "${prompt}" 2>&1 | tee "${log_file}"; then
        print_success "Completed: ${step}"
        return 0
    else
        print_error "Failed: ${step}"
        return 1
    fi
}

#############################################################################
# Story Processing
#############################################################################

create_story() {
    local story_id="$1"
    print_header "CREATE STORY: ${story_id}"

    local prompt="/bmad-bmm-create-story ${story_id}

Please create the story file with comprehensive developer context. Follow the create-story workflow exactly.

When done, the story should be at: _bmad-output/implementation-artifacts/${story_id}.md
And sprint-status.yaml should show the story as 'ready-for-dev'."

    run_claude "${prompt}" "${story_id}" "01-create"
}

implement_story() {
    local story_id="$1"
    print_header "IMPLEMENT STORY: ${story_id}"

    local prompt="/bmad-bmm-dev-story ${story_id}

Implement this story following the dev-story workflow. Read the story file at:
_bmad-output/implementation-artifacts/${story_id}.md

Follow all acceptance criteria and tasks. Create all necessary files.
Update the story file with completion notes and file list when done."

    run_claude "${prompt}" "${story_id}" "02-implement"
}

code_review_primary() {
    local story_id="$1"
    print_header "CODE REVIEW (Primary): ${story_id}"

    local prompt="/bmad-bmm-code-review ${story_id}

Perform an adversarial code review of story ${story_id}.
Read the story file and review all implemented files.
Find issues, fix them, and update sprint status when complete."

    run_claude "${prompt}" "${story_id}" "03-review-primary"
}

code_review_secondary() {
    local story_id="$1"
    print_header "CODE REVIEW (Secondary): ${story_id}"

    local prompt="Perform a thorough secondary code review for story ${story_id}.

Read the story file at: _bmad-output/implementation-artifacts/${story_id}.md
Review all files listed in the 'File List' section.

Focus on:
1. SECURITY - Any vulnerabilities, injection risks, credential exposure
2. PERFORMANCE - Inefficient loops, memory leaks, unnecessary operations
3. EDGE CASES - Null checks, boundary conditions, error scenarios
4. TEST COVERAGE - Missing test cases, untested paths
5. ARCHITECTURE - Compliance with architecture.md patterns
6. ERROR HANDLING - Proper error propagation, logging, recovery

For each issue found:
- Describe the issue
- Show the problematic code
- Provide the fix
- Apply the fix

Be thorough and adversarial. The goal is to find problems, not approve code."

    run_claude "${prompt}" "${story_id}" "04-review-secondary"
}

#############################################################################
# Full Pipeline
#############################################################################

process_story_full() {
    local story_id="$1"

    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║  PROCESSING: ${story_id}${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""

    # Check if story file already exists
    local story_file="${PROJECT_ROOT}/_bmad-output/implementation-artifacts/${story_id}.md"

    if [[ -f "${story_file}" ]]; then
        print_warn "Story file already exists: ${story_file}"
        confirm "Skip create-story and proceed to implementation?"
    else
        confirm "Step 1: Create story file?"
        create_story "${story_id}"
    fi

    confirm "Step 2: Implement story?"
    implement_story "${story_id}"

    confirm "Step 3: Primary code review?"
    code_review_primary "${story_id}"

    confirm "Step 4: Secondary code review?"
    code_review_secondary "${story_id}"

    print_success "Story ${story_id} fully processed!"
}

process_wave() {
    local wave_num="$1"
    local wave_stories="$2"

    print_header "WAVE ${wave_num}"

    # Split wave into individual stories
    IFS='|' read -ra stories <<< "${wave_stories}"

    echo "Stories in this wave:"
    for s in "${stories[@]}"; do
        echo "  - ${s}"
    done
    echo ""

    if [[ ${#stories[@]} -gt 1 ]]; then
        print_warn "This wave has ${#stories[@]} stories that CAN run in parallel."
        print_warn "However, for safety, we'll process them sequentially."
        print_warn "To parallelize, run in separate terminals."
    fi

    for story_id in "${stories[@]}"; do
        process_story_full "${story_id}"
    done
}

#############################################################################
# Main
#############################################################################

AUTO_MODE="false"
SINGLE_STORY=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --auto|-a)
            AUTO_MODE="true"
            shift
            ;;
        --story|-s)
            SINGLE_STORY="$2"
            shift 2
            ;;
        --list|-l)
            echo "Epic 7 Stories:"
            echo ""
            for i in "${!ALL_STORIES[@]}"; do
                echo "  $((i+1)). ${ALL_STORIES[$i]}"
            done
            exit 0
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -a, --auto         Auto mode (skip confirmations)"
            echo "  -s, --story ID     Process single story"
            echo "  -l, --list         List all stories"
            echo "  -h, --help         Show this help"
            echo ""
            echo "Examples:"
            echo "  $0                                    # Interactive full epic"
            echo "  $0 --auto                             # Auto mode full epic"
            echo "  $0 --story 7-1-rtds-websocket-client  # Single story"
            echo ""
            echo "Waves (parallel-capable groups):"
            for i in "${!WAVES[@]}"; do
                echo "  Wave $((i+1)): ${WAVES[$i]}"
            done
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Header
print_header "EPIC 7 IMPLEMENTATION PIPELINE"
echo "Project: ${PROJECT_ROOT}"
echo "Log Dir: ${LOG_DIR}"
echo "Mode: $(if [[ "$AUTO_MODE" == "true" ]]; then echo "Automatic"; else echo "Interactive"; fi)"
echo ""

# Single story mode
if [[ -n "${SINGLE_STORY}" ]]; then
    process_story_full "${SINGLE_STORY}"
    exit 0
fi

# Full epic mode - process waves
for i in "${!WAVES[@]}"; do
    process_wave "$((i+1))" "${WAVES[$i]}"
done

print_header "EPIC 7 COMPLETE"
print_success "All stories processed!"
echo ""
echo "Logs available at: ${LOG_DIR}"
