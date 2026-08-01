/**
 * Assertions and value capture.
 *
 * Both walk the response with the same tiny path reader. It is deliberately not a full
 * JSONPath implementation: dotted paths with array indexes cover what a request editor needs,
 * and a real JSONPath dependency would be a much larger surface for the value it adds here.
 */

/**
 * Keys that would step out of the response data and into JavaScript's object machinery.
 * The path comes from user input, so they are refused outright.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** `data.items[0].id` → walk. Returns undefined for anything that does not exist. */
export function readPath(value, path) {
  if (!path) return value;

  let current = value;
  for (const segment of path.split('.')) {
    if (current == null) return undefined;

    // Split at the first bracket rather than matching the whole segment: a pattern like
    // ^([^[\]]*)((\[\d+\])*)$ nests quantifiers, which is a ReDoS shape, and the path comes
    // from user input.
    const bracket = segment.indexOf('[');
    const name = bracket === -1 ? segment : segment.slice(0, bracket);
    const suffix = bracket === -1 ? '' : segment.slice(bracket);

    if (name) {
      // Own properties only: reading through __proto__ or constructor would expose the
      // prototype chain rather than the response the user asked about.
      if (UNSAFE_KEYS.has(name)) return undefined;
      if (typeof current !== 'object' || !Object.hasOwn(current, name)) return undefined;
      // Read-only traversal, never assignment; unsafe keys are refused above and only own
      // properties are followed.
      // nosemgrep: prototype-pollution-loop
      current = current[name];
    }
    if (!suffix) continue;

    // The suffix must be nothing but [digits] groups, checked without backtracking.
    let cursor = 0;
    while (cursor < suffix.length) {
      if (suffix[cursor] !== '[') return undefined;
      const close = suffix.indexOf(']', cursor);
      if (close === -1) return undefined;

      const digits = suffix.slice(cursor + 1, close);
      if (!digits.length || !/^\d+$/.test(digits)) return undefined;

      if (current == null) return undefined;
      // nosemgrep: prototype-pollution-loop -- numeric index into an array, read-only.
      current = current[Number(digits)];
      cursor = close + 1;
    }
  }
  return current;
}

function parsedBody(response) {
  if (response.bodyEncoding !== 'utf8') return undefined;
  try {
    return JSON.parse(response.body);
  } catch {
    return undefined;
  }
}

function actualValue(assertion, run) {
  const { response, timing } = run;

  switch (assertion.type) {
    case 'status':
      return response.status;
    case 'responseTime':
      return timing.totalMs;
    case 'header':
      return response.headers[assertion.target.toLowerCase()];
    case 'bodyContains':
      return response.bodyEncoding === 'utf8' ? response.body : '';
    case 'jsonPath':
      return readPath(parsedBody(response), assertion.target);
    default:
      return undefined;
  }
}

function compare(operator, actual, expected) {
  switch (operator) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'equals':
      return String(actual) === String(expected);
    case 'notEquals':
      return String(actual) !== String(expected);
    case 'contains':
      return String(actual ?? '').includes(String(expected));
    case 'lessThan':
      return Number(actual) < Number(expected);
    case 'greaterThan':
      return Number(actual) > Number(expected);
    default:
      return false;
  }
}

/**
 * Evaluate assertions against a run.
 *
 * Values are stringified for comparison so `200` from a JSON body and `"200"` typed into the
 * editor mean the same thing — every expectation arrives from a text input.
 */
export function evaluateAssertions(assertions = [], run) {
  return assertions
    .filter((a) => a.enabled !== false)
    .map((assertion) => {
      const actual = actualValue(assertion, run);
      const passed = compare(assertion.operator, actual, assertion.expected);
      return {
        ...assertion,
        actual: actual === undefined ? null : actual,
        passed,
        summary: describeAssertion(assertion, actual, passed),
      };
    });
}

function describeAssertion(assertion, actual, passed) {
  const subject =
    assertion.type === 'status'
      ? 'status'
      : assertion.type === 'responseTime'
        ? 'response time'
        : assertion.type === 'header'
          ? `header ${assertion.target}`
          : assertion.type === 'bodyContains'
            ? 'body'
            : assertion.target;

  if (assertion.operator === 'exists') {
    return passed ? `${subject} is present` : `${subject} is missing`;
  }
  return passed
    ? `${subject} ${assertion.operator} ${assertion.expected}`
    : `expected ${subject} ${assertion.operator} ${assertion.expected}, got ${format(actual)}`;
}

function format(value) {
  if (value === undefined || value === null) return 'nothing';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/**
 * Pull values out of a response into named variables for later requests.
 * A capture marked secret is wrapped so masking applies to it downstream.
 */
export function applyCaptures(captures = [], run) {
  const values = {};
  const results = [];

  for (const capture of captures) {
    let value;
    switch (capture.from) {
      case 'status':
        value = run.response.status;
        break;
      case 'header':
        value = run.response.headers[capture.path.toLowerCase()];
        break;
      default:
        value = readPath(parsedBody(run.response), capture.path);
    }

    const found = value !== undefined && value !== null;
    if (found) {
      values[capture.name] = capture.secret
        ? { value: String(value), secret: true }
        : { value: String(value), secret: false };
    }

    results.push({
      name: capture.name,
      found,
      // Never echo a captured secret; the point is often to capture a token.
      value: found ? (capture.secret ? '••••' : String(value)) : null,
    });
  }

  return { values, results };
}
