/**
 * Logger Redactor - Credential sanitization
 *
 * Automatically detects and redacts sensitive data from log entries
 * following NFR12 requirement that credentials are never logged.
 */

// Maximum recursion depth to prevent stack overflow on deeply nested objects
const MAX_DEPTH = 50;

// Patterns that indicate sensitive field names
const SENSITIVE_PATTERNS = [
  /key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
  /auth/i,
  /private/i,
  /api.?key/i,
];

const REDACTED_VALUE = '[REDACTED]';

/**
 * Check if a field name matches sensitive patterns
 *
 * @param {string} fieldName - Field name to check
 * @returns {boolean} True if field should be redacted
 */
function isSensitiveField(fieldName) {
  if (typeof fieldName !== 'string') {
    return false;
  }

  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(fieldName));
}

/**
 * Recursively redact sensitive values from an object
 *
 * @param {any} obj - Object to redact
 * @param {WeakSet} [seen=new WeakSet()] - Tracks circular references
 * @param {number} [depth=0] - Current recursion depth
 * @returns {any} Object with sensitive values redacted
 */
export function redactSensitive(obj, seen = new WeakSet(), depth = 0) {
  // Prevent stack overflow on deeply nested objects
  if (depth > MAX_DEPTH) {
    return '[Max Depth Exceeded]';
  }

  // Handle null/undefined
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle primitives
  if (typeof obj !== 'object') {
    return obj;
  }

  // Handle circular references
  if (seen.has(obj)) {
    return '[Circular]';
  }
  seen.add(obj);

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitive(item, seen, depth + 1));
  }

  // Handle objects
  const redacted = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveField(key)) {
      redacted[key] = REDACTED_VALUE;
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitive(value, seen, depth + 1);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}
