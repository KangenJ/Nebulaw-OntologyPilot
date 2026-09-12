/**
 * Transform functions for datasource mapping (Spec Section 6.5).
 *
 * Transforms are composable functions that convert source field values
 * to ontology property values during record mapping.
 */

/**
 * A transform function takes a source value and the full source record,
 * returning the transformed value.
 */
export type TransformFn = (
  value: unknown,
  record: Record<string, unknown>,
) => unknown;

/** Registry of custom transform functions. */
const customFunctions = new Map<string, TransformFn>();

/**
 * Register a custom transform function by name.
 * Used with `custom('fnName')` in mapping configs.
 */
export function registerCustomTransform(
  name: string,
  fn: TransformFn,
): void {
  customFunctions.set(name, fn);
}

/**
 * Clear all registered custom transforms. Useful for test isolation.
 */
export function clearCustomTransforms(): void {
  customFunctions.clear();
}

// ── Built-in transform functions ──────────────────────────────────────

/** Concatenate field references and literal strings. */
export function concat(...fields: string[]): TransformFn {
  return (_value, record) => {
    return fields
      .map((f) => {
        // Literal strings are quoted with single quotes
        if (f.startsWith("'") && f.endsWith("'")) {
          return f.slice(1, -1);
        }
        const val = record[f];
        return val == null ? "" : String(val);
      })
      .join("");
  };
}

/** Prepend a string to the source value. */
export function prefix(str: string): TransformFn {
  return (value) => {
    if (value == null) return null;
    return `${str}${String(value)}`;
  };
}

/** Append a string to the source value. */
export function suffix(str: string): TransformFn {
  return (value) => {
    if (value == null) return null;
    return `${String(value)}${str}`;
  };
}

/**
 * Parse a date string with the given format and return ISO 8601 date string.
 *
 * Supported format tokens:
 * - dd: day of month (01-31)
 * - MM: month (01-12)
 * - yyyy: four-digit year
 */
export function parseDate(fmt: string): TransformFn {
  return (value) => {
    if (value == null) return null;
    const str = String(value);
    return parseDateString(str, fmt);
  };
}

/**
 * Parse a datetime string with the given format and return ISO 8601 datetime string.
 *
 * Extends parseDate with time tokens:
 * - HH: hours (00-23)
 * - mm: minutes (00-59)
 * - ss: seconds (00-59)
 */
export function parseDateTime(fmt: string): TransformFn {
  return (value) => {
    if (value == null) return null;
    const str = String(value);
    return parseDateTimeString(str, fmt);
  };
}

/** Convert source value to uppercase. */
export function toUpper(): TransformFn {
  return (value) => {
    if (value == null) return null;
    return String(value).toUpperCase();
  };
}

/** Convert source value to lowercase. */
export function toLower(): TransformFn {
  return (value) => {
    if (value == null) return null;
    return String(value).toLowerCase();
  };
}

/** Parse the source value as an integer (radix 10). */
export function parseInt_(): TransformFn {
  return (value) => {
    if (value == null) return null;
    const n = Number.parseInt(String(value), 10);
    return Number.isNaN(n) ? null : n;
  };
}

/** Parse the source value as a floating-point number. */
export function parseFloat_(): TransformFn {
  return (value) => {
    if (value == null) return null;
    const n = Number.parseFloat(String(value));
    return Number.isFinite(n) ? n : null;
  };
}

/** Strip leading and trailing whitespace. */
export function trim(): TransformFn {
  return (value) => {
    if (value == null) return null;
    return String(value).trim();
  };
}

/**
 * If the source field is non-null, return thenVal; otherwise return elseVal.
 */
export function ifPresent(thenVal: string, elseVal: string): TransformFn {
  return (value) => {
    return value != null ? thenVal : elseVal;
  };
}

/** Return the source value if non-null, otherwise return the fallback. */
export function coalesce(fallback: string): TransformFn {
  return (value) => {
    return value != null ? value : fallback;
  };
}

/** Map source values to target values using a lookup table. */
export function map(mapping: Record<string, string>): TransformFn {
  return (value) => {
    if (value == null) return null;
    const key = String(value);
    return key in mapping ? mapping[key] : null;
  };
}

/** Call a registered custom transform function. */
export function custom(fn: string): TransformFn {
  return (value, record) => {
    const customFn = customFunctions.get(fn);
    if (!customFn) {
      throw new Error(`Custom transform function not registered: ${fn}`);
    }
    return customFn(value, record);
  };
}

// ── Transform expression parser ───────────────────────────────────────

/**
 * Parse a transform expression string (e.g., "prefix('patient-')")
 * into a TransformFn.
 */
export function parseTransformExpression(
  expr: string,
): TransformFn {
  const trimmed = expr.trim();

  // Match function call: name(args)
  const match = trimmed.match(/^(\w+)\((.*)?\)$/s);
  if (!match) {
    throw new Error(`Invalid transform expression: ${expr}`);
  }

  const [, fnName, argsStr] = match;
  const args = argsStr ? parseArgs(argsStr) : [];
  // concat needs raw (unstripped) args to distinguish field refs from literals
  const rawArgs = argsStr ? parseArgsRaw(argsStr) : [];

  switch (fnName) {
    case "concat":
      return concat(...rawArgs);
    case "prefix":
      return prefix(args[0] ?? "");
    case "suffix":
      return suffix(args[0] ?? "");
    case "parseDate":
      return parseDate(args[0] ?? "");
    case "parseDateTime":
      return parseDateTime(args[0] ?? "");
    case "parseInt":
      return parseInt_();
    case "parseFloat":
      return parseFloat_();
    case "toUpper":
      return toUpper();
    case "toLower":
      return toLower();
    case "trim":
      return trim();
    case "ifPresent":
      return ifPresent(args[0] ?? "", args[1] ?? "");
    case "coalesce":
      return coalesce(args[0] ?? "");
    case "map":
      return map(parseMapArg(argsStr ?? ""));
    case "custom":
      return custom(args[0] ?? "");
    default:
      throw new Error(`Unknown transform function: ${fnName}`);
  }
}

// ── Internal parsing helpers ──────────────────────────────────────────

/**
 * Parse a comma-separated argument list, handling quoted strings
 * and unquoted field references.
 */
function parseArgs(argsStr: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote = false;
  let depth = 0;

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i]!;

    if (ch === "'" && !inQuote) {
      inQuote = true;
      current += ch;
    } else if (ch === "'" && inQuote) {
      inQuote = false;
      current += ch;
    } else if (ch === "{") {
      depth++;
      current += ch;
    } else if (ch === "}") {
      depth--;
      current += ch;
    } else if (ch === "," && !inQuote && depth === 0) {
      args.push(normalizeArg(current.trim()));
      current = "";
    } else {
      current += ch;
    }
  }

  if (current.trim()) {
    args.push(normalizeArg(current.trim()));
  }

  return args;
}

/**
 * Parse args but preserve surrounding quotes (for concat which needs
 * to distinguish field references from string literals).
 */
function parseArgsRaw(argsStr: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote = false;
  let depth = 0;

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i]!;

    if (ch === "'" && !inQuote) {
      inQuote = true;
      current += ch;
    } else if (ch === "'" && inQuote) {
      inQuote = false;
      current += ch;
    } else if (ch === "{") {
      depth++;
      current += ch;
    } else if (ch === "}") {
      depth--;
      current += ch;
    } else if (ch === "," && !inQuote && depth === 0) {
      args.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

/** Strip surrounding single quotes from a string argument. */
function normalizeArg(arg: string): string {
  if (arg.startsWith("'") && arg.endsWith("'")) {
    return arg.slice(1, -1);
  }
  return arg;
}

/** Parse `{ 'key': 'value', ... }` into a Record. */
function parseMapArg(argsStr: string): Record<string, string> {
  const trimmed = argsStr.trim();
  // Match { ... }
  const braceMatch = trimmed.match(/^\{(.*)\}$/s);
  if (!braceMatch) {
    throw new Error(`Invalid map argument: ${argsStr}`);
  }

  const inner = braceMatch[1]!;
  const result: Record<string, string> = {};

  // Match 'key': 'value' pairs
  const pairRegex = /'([^']*)':\s*'([^']*)'/g;
  let pairMatch: RegExpExecArray | null;

  while ((pairMatch = pairRegex.exec(inner)) !== null) {
    result[pairMatch[1]!] = pairMatch[2]!;
  }

  return result;
}

/**
 * Parse a date string using a simple format string.
 * Returns ISO 8601 date (yyyy-MM-dd).
 */
function parseDateString(value: string, fmt: string): string {
  const parts = extractDateParts(value, fmt);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Parse a datetime string using a format string.
 * Returns ISO 8601 datetime (yyyy-MM-ddTHH:mm:ssZ).
 */
function parseDateTimeString(value: string, fmt: string): string {
  const parts = extractDateParts(value, fmt);
  const hours = parts.hours ?? "00";
  const minutes = parts.minutes ?? "00";
  const seconds = parts.seconds ?? "00";
  return `${parts.year}-${parts.month}-${parts.day}T${hours}:${minutes}:${seconds}Z`;
}

interface DateParts {
  year: string;
  month: string;
  day: string;
  hours?: string;
  minutes?: string;
  seconds?: string;
}

/**
 * Extract date parts from a value string based on a format pattern.
 * Uses positional mapping: the position of tokens like "dd", "MM", "yyyy"
 * in the format string determines where to find the values.
 */
function extractDateParts(value: string, fmt: string): DateParts {
  // Build a regex from the format, capturing each token
  const tokenMap: Array<{ token: string; index: number }> = [];
  let regexStr = "^";
  let fmtIndex = 0;
  let groupIndex = 0;

  while (fmtIndex < fmt.length) {
    const remaining = fmt.slice(fmtIndex);

    if (remaining.startsWith("yyyy")) {
      groupIndex++;
      tokenMap.push({ token: "yyyy", index: groupIndex });
      regexStr += "(\\d{4})";
      fmtIndex += 4;
    } else if (remaining.startsWith("MM")) {
      groupIndex++;
      tokenMap.push({ token: "MM", index: groupIndex });
      regexStr += "(\\d{2})";
      fmtIndex += 2;
    } else if (remaining.startsWith("dd")) {
      groupIndex++;
      tokenMap.push({ token: "dd", index: groupIndex });
      regexStr += "(\\d{2})";
      fmtIndex += 2;
    } else if (remaining.startsWith("HH")) {
      groupIndex++;
      tokenMap.push({ token: "HH", index: groupIndex });
      regexStr += "(\\d{2})";
      fmtIndex += 2;
    } else if (remaining.startsWith("mm")) {
      groupIndex++;
      tokenMap.push({ token: "mm", index: groupIndex });
      regexStr += "(\\d{2})";
      fmtIndex += 2;
    } else if (remaining.startsWith("ss")) {
      groupIndex++;
      tokenMap.push({ token: "ss", index: groupIndex });
      regexStr += "(\\d{2})";
      fmtIndex += 2;
    } else {
      // Literal character — escape for regex
      regexStr += fmt[fmtIndex]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      fmtIndex += 1;
    }
  }

  regexStr += "$";

  const regex = new RegExp(regexStr);
  const match = value.match(regex);
  if (!match) {
    throw new Error(
      `Value "${value}" does not match date format "${fmt}"`,
    );
  }

  const parts: DateParts = { year: "0000", month: "01", day: "01" };

  for (const { token, index } of tokenMap) {
    const captured = match[index]!;
    switch (token) {
      case "yyyy":
        parts.year = captured;
        break;
      case "MM":
        parts.month = captured;
        break;
      case "dd":
        parts.day = captured;
        break;
      case "HH":
        parts.hours = captured;
        break;
      case "mm":
        parts.minutes = captured;
        break;
      case "ss":
        parts.seconds = captured;
        break;
    }
  }

  return parts;
}
