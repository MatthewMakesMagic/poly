/**
 * Logger Schema - Log entry schema validation
 *
 * Validates log entries conform to the architecture specification.
 * Required fields: timestamp, level, module, event
 * Optional fields: data, context, error
 */

// Valid log levels
const VALID_LEVELS = ['info', 'warn', 'error'];

// ISO 8601 timestamp pattern with milliseconds
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Validate a log entry conforms to the required schema
 *
 * @param {Object} entry - Log entry object
 * @returns {{ valid: boolean, errors: string[] }} Validation result
 */
export function validateLogEntry(entry) {
  const errors = [];

  // Check required fields
  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Entry must be an object'] };
  }

  // timestamp - required, ISO 8601 format
  if (!entry.timestamp) {
    errors.push('Missing required field: timestamp');
  } else if (!ISO_TIMESTAMP_PATTERN.test(entry.timestamp)) {
    errors.push('Invalid timestamp format: must be ISO 8601 with milliseconds');
  }

  // level - required, must be valid level
  if (!entry.level) {
    errors.push('Missing required field: level');
  } else if (!VALID_LEVELS.includes(entry.level)) {
    errors.push(`Invalid level: must be one of ${VALID_LEVELS.join(', ')}`);
  }

  // module - required, must be string
  if (!entry.module) {
    errors.push('Missing required field: module');
  } else if (typeof entry.module !== 'string') {
    errors.push('Invalid module: must be a string');
  }

  // event - required, must be string
  if (!entry.event) {
    errors.push('Missing required field: event');
  } else if (typeof entry.event !== 'string') {
    errors.push('Invalid event: must be a string');
  }

  // data - optional, must be object if present
  if (entry.data !== undefined && (typeof entry.data !== 'object' || entry.data === null)) {
    errors.push('Invalid data: must be an object');
  }

  // context - optional, must be object if present
  if (entry.context !== undefined && (typeof entry.context !== 'object' || entry.context === null)) {
    errors.push('Invalid context: must be an object');
  }

  // error - optional, must be object if present
  if (entry.error !== undefined && (typeof entry.error !== 'object' || entry.error === null)) {
    errors.push('Invalid error: must be an object');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Check if a log level is valid
 *
 * @param {string} level - Log level to validate
 * @returns {boolean} True if valid
 */
export function isValidLevel(level) {
  return VALID_LEVELS.includes(level);
}

/**
 * Get all valid log levels
 *
 * @returns {string[]} Array of valid levels
 */
export function getValidLevels() {
  return [...VALID_LEVELS];
}
