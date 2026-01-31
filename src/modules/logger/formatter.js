/**
 * Logger Formatter - JSON log formatting with snake_case fields
 *
 * Formats log entries according to the architecture specification:
 * - Required fields: timestamp, level, module, event
 * - Optional fields: data, context, error
 * - All field names use snake_case
 */

// Maximum recursion depth to prevent stack overflow on deeply nested objects
const MAX_DEPTH = 50;

/**
 * Format a log entry as JSON string
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
  const { entryString } = formatLogEntryObject(level, moduleName, event, data, context, err);
  return entryString;
}

/**
 * Format a log entry, returning both object and string representations
 *
 * This avoids double JSON parsing when both are needed (e.g., for console output).
 *
 * @param {string} level - Log level (info, warn, error)
 * @param {string|null} moduleName - Module name
 * @param {string} event - Event name
 * @param {Object} [data={}] - Event data
 * @param {Object} [context={}] - Additional context
 * @param {Error|null} [err=null] - Error object
 * @returns {{ entryObject: Object, entryString: string }} Both representations
 */
export function formatLogEntryObject(level, moduleName, event, data = {}, context = {}, err = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    module: moduleName || 'root',
    event,
  };

  // Add optional data if not empty
  if (data && Object.keys(data).length > 0) {
    entry.data = serializeValue(data, new WeakSet(), 0);
  }

  // Add optional context if not empty
  if (context && Object.keys(context).length > 0) {
    entry.context = serializeValue(context, new WeakSet(), 0);
  }

  // Add error info if provided
  if (err) {
    entry.error = formatError(err);
  }

  return {
    entryObject: entry,
    entryString: JSON.stringify(entry),
  };
}

/**
 * Serialize a value, handling special types
 *
 * @param {any} value - Value to serialize
 * @param {WeakSet} [seen=new WeakSet()] - Tracks circular references
 * @param {number} [depth=0] - Current recursion depth
 * @returns {any} Serialized value
 */
function serializeValue(value, seen = new WeakSet(), depth = 0) {
  // Prevent stack overflow on deeply nested objects
  if (depth > MAX_DEPTH) {
    return '[Max Depth Exceeded]';
  }

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
    return value.map((item) => serializeValue(item, seen, depth + 1));
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
      result[key] = serializeValue(val, seen, depth + 1);
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
