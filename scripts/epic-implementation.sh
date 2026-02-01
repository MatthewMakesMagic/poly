#!/bin/bash

#############################################################################
# Epic Implementation Script
#
# Processes an entire epic through the full BMAD pipeline:
# 1. Create story file (create-story)
# 2. Implement story (dev-story)
# 3. First code review
# 4. Second code review (different perspective)
#
# Features:
# - Multi-epic support (Epic 7, 8, etc.)
# - Wave-based processing with dependencies
# - Context window clearing between stories
# - Progress tracking and logging
# - Resume capability
#
# Compatible with macOS bash 3.2
#############################################################################

set -e

# Configuration
EPIC_NUM="${1:-8}"
PROJECT_ROOT="/Users/matthewkirkham/poly"
LOG_DIR="${PROJECT_ROOT}/logs/epic-${EPIC_NUM}-implementation"
PROGRESS_FILE="${LOG_DIR}/progress.json"
PARALLEL_JOBS="${2:-1}"  # Default to sequential

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Create log directory
mkdir -p "${LOG_DIR}"

#############################################################################
# Epic Configuration Functions
# Each epic defines its stories and waves
#############################################################################

get_story_order() {
    local epic="$1"
    case "${epic}" in
        7)
            echo "7-1-rtds-websocket-client"
            echo "7-2-feed-tick-logger"
            echo "7-3-feed-divergence-tracker"
            echo "7-4-oracle-update-pattern-tracker"
            echo "7-10-window-timing-model"
            echo "7-11-lag-tracker"
            echo "7-5-oracle-update-predictor"
            echo "7-6-oracle-staleness-detector"
            echo "7-7-oracle-edge-signal-generator"
            echo "7-8-signal-outcome-logger"
            echo "7-9-strategy-quality-gate"
            echo "7-12-strategy-composition-integration"
            ;;
        8)
            echo "8-1-launch-manifest"
            echo "8-2-pre-flight-checks"
            echo "8-3-health-endpoint-enhancement"
            echo "8-5-post-deploy-verification"
            echo "8-4-deploy-command"
            ;;
        *)
            log_error "Unknown epic: ${epic}"
            exit 1
            ;;
    esac
}

get_waves() {
    local epic="$1"
    case "${epic}" in
        7)
            echo "Wave 1 (Foundation)|7-1-rtds-websocket-client"
            echo "Wave 2 (Parallel)|7-2-feed-tick-logger,7-3-feed-divergence-tracker,7-4-oracle-update-pattern-tracker,7-10-window-timing-model,7-11-lag-tracker"
            echo "Wave 3 (Predictors)|7-5-oracle-update-predictor,7-6-oracle-staleness-detector"
            echo "Wave 4 (Signal)|7-7-oracle-edge-signal-generator"
            echo "Wave 5 (Logging)|7-8-signal-outcome-logger"
            echo "Wave 6 (Quality)|7-9-strategy-quality-gate"
            echo "Wave 7 (Integration)|7-12-strategy-composition-integration"
            ;;
        8)
            echo "Wave 1 (Foundation)|8-1-launch-manifest"
            echo "Wave 2 (Preflight + Health)|8-2-pre-flight-checks,8-3-health-endpoint-enhancement"
            echo "Wave 3 (Verification)|8-5-post-deploy-verification"
            echo "Wave 4 (Deploy)|8-4-deploy-command"
            ;;
        *)
            log_error "Unknown epic: ${epic}"
            exit 1
            ;;
    esac
}

get_story_count() {
    local epic="$1"
    case "${epic}" in
        7) echo "12" ;;
        8) echo "5" ;;
        *) echo "0" ;;
    esac
}

#############################################################################
# Utility Functions
#############################################################################

log_info() {
    echo -e "${BLUE}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

# Initialize or load progress
init_progress() {
    if [[ -f "${PROGRESS_FILE}" ]]; then
        log_info "Found existing progress file, resuming..."
    else
        log_info "Starting fresh implementation run"
        echo '{}' > "${PROGRESS_FILE}"
    fi
}

# Get story status from progress file
get_story_status() {
    local story_id="$1"
    if command -v jq &> /dev/null; then
        jq -r ".\"${story_id}\".status // \"not_started\"" "${PROGRESS_FILE}" 2>/dev/null || echo "not_started"
    else
        grep -o "\"${story_id}\":{[^}]*\"status\":\"[^\"]*\"" "${PROGRESS_FILE}" 2>/dev/null | \
            sed 's/.*"status":"\([^"]*\)".*/\1/' || echo "not_started"
    fi
}

# Update story status in progress file
update_story_status() {
    local story_id="$1"
    local status="$2"
    local step="$3"
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    if command -v jq &> /dev/null; then
        local tmp_file=$(mktemp)
        jq ".\"${story_id}\" = {\"status\": \"${status}\", \"step\": \"${step}\", \"updated_at\": \"${timestamp}\"}" \
            "${PROGRESS_FILE}" > "${tmp_file}" && mv "${tmp_file}" "${PROGRESS_FILE}"
    else
        # Fallback: simple JSON update
        log_warn "jq not found, using simple progress tracking"
        echo "{\"${story_id}\": {\"status\": \"${status}\", \"step\": \"${step}\"}}" > "${PROGRESS_FILE}"
    fi
}

#############################################################################
# Claude CLI Wrapper Functions
#############################################################################

# Run claude interactively with auto-accept
run_claude_interactive() {
    local command="$1"
    local story_id="$2"
    local step="$3"
    local log_file="${LOG_DIR}/${story_id}-${step}.log"

    log_info "Running: ${step} for ${story_id}"

    # Use claude with dangerously-skip-permissions for automation
    claude --dangerously-skip-permissions \
           --print \
           --max-turns 100 \
           -p "${command}" 2>&1 | tee "${log_file}"

    return ${PIPESTATUS[0]}
}

#############################################################################
# Story Processing Functions
#############################################################################

# Create story file
create_story() {
    local story_id="$1"
    log_info "Creating story: ${story_id}"

    run_claude_interactive \
        "/bmad-bmm-create-story ${story_id}" \
        "${story_id}" \
        "01-create-story"
}

# Implement story
implement_story() {
    local story_id="$1"
    log_info "Implementing story: ${story_id}"

    run_claude_interactive \
        "/bmad-bmm-dev-story ${story_id}" \
        "${story_id}" \
        "02-dev-story"
}

# First code review
code_review_1() {
    local story_id="$1"
    log_info "Running first code review: ${story_id}"

    run_claude_interactive \
        "/bmad-bmm-code-review ${story_id}" \
        "${story_id}" \
        "03-code-review-1"
}

# Second code review (fresh perspective)
code_review_2() {
    local story_id="$1"
    log_info "Running second code review: ${story_id}"

    run_claude_interactive \
        "Please perform a thorough code review of story ${story_id}. Focus on:
1. Security vulnerabilities
2. Performance issues
3. Edge cases not handled
4. Test coverage gaps
5. Architecture compliance with architecture.md
6. Error handling completeness

Read the story file at _bmad-output/implementation-artifacts/${story_id}.md and review all files listed in the File List section." \
        "${story_id}" \
        "04-code-review-2"
}

# Full pipeline for a single story
process_story() {
    local story_id="$1"
    local current_status=$(get_story_status "${story_id}")

    log_info "Processing story: ${story_id} (current status: ${current_status})"

    # Step 1: Create story (if not already done)
    if [[ "$current_status" == "not_started" ]]; then
        update_story_status "${story_id}" "in_progress" "create_story"
        if create_story "${story_id}"; then
            update_story_status "${story_id}" "story_created" "create_story"
        else
            update_story_status "${story_id}" "failed" "create_story"
            return 1
        fi
        current_status="story_created"
    fi

    # Step 2: Implement story
    if [[ "$current_status" == "story_created" ]]; then
        update_story_status "${story_id}" "in_progress" "implement"
        if implement_story "${story_id}"; then
            update_story_status "${story_id}" "implemented" "implement"
        else
            update_story_status "${story_id}" "failed" "implement"
            return 1
        fi
        current_status="implemented"
    fi

    # Step 3: First code review
    if [[ "$current_status" == "implemented" ]]; then
        update_story_status "${story_id}" "in_progress" "review_1"
        if code_review_1 "${story_id}"; then
            update_story_status "${story_id}" "review_1_complete" "review_1"
        else
            update_story_status "${story_id}" "failed" "review_1"
            return 1
        fi
        current_status="review_1_complete"
    fi

    # Step 4: Second code review
    if [[ "$current_status" == "review_1_complete" ]]; then
        update_story_status "${story_id}" "in_progress" "review_2"
        if code_review_2 "${story_id}"; then
            update_story_status "${story_id}" "complete" "review_2"
        else
            update_story_status "${story_id}" "failed" "review_2"
            return 1
        fi
    fi

    log_success "Story ${story_id} fully complete!"
    return 0
}

# Process a wave of stories
process_wave() {
    local wave_name="$1"
    shift
    local stories=("$@")

    log_info "=========================================="
    log_info "Processing ${wave_name} with ${#stories[@]} stories"
    log_info "=========================================="

    if [[ ${PARALLEL_JOBS} -gt 1 ]]; then
        # Parallel processing
        local pids=()
        for story_id in "${stories[@]}"; do
            (
                process_story "${story_id}"
            ) &
            pids+=($!)

            # Limit parallel jobs
            if [[ ${#pids[@]} -ge ${PARALLEL_JOBS} ]]; then
                wait "${pids[0]}"
                pids=("${pids[@]:1}")
            fi
        done

        # Wait for remaining jobs
        for pid in "${pids[@]}"; do
            wait "$pid"
        done
    else
        # Sequential processing
        for story_id in "${stories[@]}"; do
            process_story "${story_id}"
        done
    fi
}

# Process all waves for the epic
process_all_waves() {
    local epic="$1"

    while IFS= read -r wave_def; do
        # Parse wave definition: "Wave Name|story1,story2,story3"
        local wave_name="${wave_def%%|*}"
        local stories_str="${wave_def#*|}"

        # Convert comma-separated stories to array
        IFS=',' read -ra wave_stories <<< "$stories_str"

        process_wave "${wave_name}" "${wave_stories[@]}"
    done < <(get_waves "${epic}")
}

#############################################################################
# Main Execution
#############################################################################

main() {
    local story_count=$(get_story_count "${EPIC_NUM}")

    if [[ "${story_count}" == "0" ]]; then
        log_error "Unknown epic: ${EPIC_NUM}"
        log_error "Supported epics: 7, 8"
        exit 1
    fi

    log_info "=========================================="
    log_info "Epic ${EPIC_NUM} Implementation Pipeline"
    log_info "=========================================="
    log_info "Project root: ${PROJECT_ROOT}"
    log_info "Log directory: ${LOG_DIR}"
    log_info "Parallel jobs: ${PARALLEL_JOBS}"
    log_info "Stories: ${story_count}"
    log_info ""

    # Initialize progress tracking
    init_progress

    # Process all waves for this epic
    process_all_waves "${EPIC_NUM}"

    log_info "=========================================="
    log_success "Epic ${EPIC_NUM} Implementation Complete!"
    log_info "=========================================="

    # Print summary
    echo ""
    echo "Summary:"
    echo "--------"
    while IFS= read -r story_id; do
        local status=$(get_story_status "${story_id}")
        if [[ "$status" == "complete" ]]; then
            echo -e "  ${GREEN}✓${NC} ${story_id}"
        elif [[ "$status" == "failed" ]]; then
            echo -e "  ${RED}✗${NC} ${story_id}"
        else
            echo -e "  ${YELLOW}○${NC} ${story_id} (${status})"
        fi
    done < <(get_story_order "${EPIC_NUM}")

    echo ""
    echo "Logs available at: ${LOG_DIR}"
}

# Parse command line arguments
SINGLE_STORY=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --epic|-e)
            EPIC_NUM="$2"
            LOG_DIR="${PROJECT_ROOT}/logs/epic-${EPIC_NUM}-implementation"
            PROGRESS_FILE="${LOG_DIR}/progress.json"
            mkdir -p "${LOG_DIR}"
            shift 2
            ;;
        --parallel|-p)
            PARALLEL_JOBS="$2"
            shift 2
            ;;
        --story|-s)
            SINGLE_STORY="$2"
            shift 2
            ;;
        --resume|-r)
            shift
            ;;
        --fresh|-f)
            rm -f "${PROGRESS_FILE}"
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -e, --epic NUM       Epic number to process (default: 8)"
            echo "  -p, --parallel NUM   Number of parallel jobs (default: 1)"
            echo "  -s, --story ID       Process single story only"
            echo "  -r, --resume         Resume from progress file (default)"
            echo "  -f, --fresh          Start fresh, clear progress"
            echo "  -h, --help           Show this help"
            echo ""
            echo "Supported Epics:"
            echo "  7 - Oracle Edge Infrastructure (12 stories)"
            echo "  8 - Launch Control & Deployment Pipeline (5 stories)"
            echo ""
            echo "Examples:"
            echo "  $0 -e 8                      # Process Epic 8 sequentially"
            echo "  $0 -e 8 -f                   # Process Epic 8, start fresh"
            echo "  $0 -e 7 -p 3                 # Process Epic 7 with 3 parallel jobs"
            echo "  $0 -e 8 -s 8-1-launch-manifest  # Process single story"
            exit 0
            ;;
        *)
            # Handle positional arguments for backward compatibility
            if [[ "$1" =~ ^[0-9]+$ ]]; then
                EPIC_NUM="$1"
                LOG_DIR="${PROJECT_ROOT}/logs/epic-${EPIC_NUM}-implementation"
                PROGRESS_FILE="${LOG_DIR}/progress.json"
                mkdir -p "${LOG_DIR}"
            fi
            shift
            ;;
    esac
done

# Single story mode
if [[ -n "${SINGLE_STORY}" ]]; then
    init_progress
    process_story "${SINGLE_STORY}"
    exit $?
fi

# Full epic mode
main
