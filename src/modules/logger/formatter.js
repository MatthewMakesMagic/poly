/**
 * Logger Formatter - JSON log formatting with snake_case fields
 *
 * Formats log entries according to the architecture specification:
 * - Required fields: timestamp, level, module, event
 * - Optional fields: data, context, error
 * - All field names use snake_case
 */

/**
 * Format a log entry as JSON
 *
 * @param {string} level - Log level (info, warn, error)
 * @param {string|null} moduleName - Module name
 * @param {string} event - Event name
 * @param {Object} [data={}] - Event data
 * @param {Object} [context={}] - Additional context
 * @param {Error|null} [err=null] - Error object
 * @returns {string} JSON formatted log entry
 */
export function formatLogEntry(level, moduleName, event, data = {}, context = {}, err = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    module: moduleName || 'root',
    event,
  };

  // Add optional data if not empty
  if (data && Object.keys(data).length > 0) {
    entry.data = serializeValue(data);
  }

  // Add optional context if not empty
  if (context && Object.keys(context).length > 0) {
    entry.context = serializeValue(context);
  }

  // Add error info if provided
  if (err) {
    entry.error = formatError(err);
  }

  return JSON.stringify(entry);
}

/**
 * Serialize a value, handling special types
 *
 * @param {any} value - Value to serialize
 * @param {WeakSet} [seen=new WeakSet()] - Tracks circular references
 * @returns {any} Serialized value
 */
function serializeValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value;
  }

  // Handle Date objects
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Handle BigInt
  if (typeof value === 'bigint') {
    return value.toString();
  }

  // Handle Error objects
  if (value instanceof Error) {
    return formatError(value);
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item, seen));
  }

  // Handle objects
  if (typeof value === 'object') {
    // Check for circular reference
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const result = {};
    for (const [key, val] of Object.entries(value)) {
      // Convert camelCase to snake_case for top-level keys
      result[key] = serializeValue(val, seen);
    }
    return result;
  }

  // Primitive values pass through
  return value;
}

/**
 * Format an Error object for logging
 *
 * @param {Error} err - Error object
 * @returns {Object} Formatted error object
 */
function formatError(err) {
  const errorObj = {
    message: err.message,
    name: err.name,
  };

  // Include error code if present (PolyError)
  if (err.code) {
    errorObj.code = err.code;
  }

  // Include context if present (PolyError)
  if (err.context) {
    errorObj.context = err.context;
  }

  // Include stack trace
  if (err.stack) {
    errorObj.stack = err.stack;
  }

  return errorObj;
}
