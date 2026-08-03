/**
 * Contract conformance: does the live API do what its documentation says?
 *
 * This is the suite that answers "is our API working as advertised in our docs". It sends each
 * documented operation and compares the real response against the spec — status codes,
 * required fields, types, enums — plus a conventions audit for the things specs rarely state
 * but everyone expects (201 on create, a Location header, ISO dates, consistent naming).
 *
 * Fully deterministic. No model is involved in deciding whether something passes.
 */
import { finding, evidenceFrom } from './findings.js';

const SUITE = 'contract';

/**
 * @param {object} args
 * @param {object} args.spec       the parsed OpenAPI document
 * @param {Function} args.send     async (request) => sanitised run record
 * @param {object[]} args.requests requests produced by the importer, in spec order
 */
export async function runContract({ spec, send, requests }) {
  const findings = [];
  const operations = indexOperations(spec);
  const naming = { camel: 0, snake: 0 };
  const unmatched = [];

  for (const request of requests) {
    const operation = operations.get(operationKey(request));
    if (!operation) {
      // Recorded, not ignored. A request the spec does not describe is not "passing" — it is
      // untested, and a report that omits it silently implies coverage it does not have.
      unmatched.push(operationKey(request));
      continue;
    }

    let run;
    try {
      run = await send(request);
    } catch (err) {
      findings.push(
        finding({
          suite: SUITE,
          severity: 'blocker',
          endpoint: operationKey(request),
          title: `${request.method} ${operation.path} could not be reached`,
          whatHappened: err.message,
          whyItMatters:
            'A documented endpoint that cannot be called at all is the most severe kind of ' +
            'mismatch: the documentation promises something that does not exist.',
          expected: 'a response',
          actual: 'no response',
        }),
      );
      continue;
    }

    checkStatus({ findings, request, operation, run });
    checkContentType({ findings, request, operation, run });
    checkBody({ findings, request, operation, run, spec, naming });
    checkConventions({ findings, request, operation, run });
  }

  checkNamingConsistency({ findings, naming });
  reportCoverage({ findings, requests, unmatched, operations });
  return findings;
}

/**
 * State plainly which requests the specification covered.
 *
 * Pasting a spec for one endpoint while the project holds ten is an easy mistake, and without
 * this the other nine would simply not appear in the report — indistinguishable from nine
 * endpoints that passed.
 */
function reportCoverage({ findings, requests, unmatched, operations }) {
  const checked = requests.length - unmatched.length;

  if (checked === 0) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'major',
        endpoint: null,
        title: 'The specification does not describe any of these requests',
        whatHappened:
          `None of the ${requests.length} request${requests.length === 1 ? '' : 's'} matched an ` +
          `operation in the specification, which describes ${operations.size} operation` +
          `${operations.size === 1 ? '' : 's'}. Nothing was compared.`,
        whyItMatters:
          'Usually this means the specification is for a different API, or the request URLs ' +
          'do not line up with its paths — check the server URL and that paths match, ' +
          'including any prefix such as /v1.',
        expected: 'requests matching the documented operations',
        actual: 'no matches',
      }),
    );
    return;
  }

  if (unmatched.length) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'info',
        endpoint: null,
        title: `${unmatched.length} request${unmatched.length === 1 ? ' was' : 's were'} not covered by the specification`,
        whatHappened: `Checked ${checked} of ${requests.length}. Not described: ${unmatched
          .slice(0, 10)
          .join(', ')}${unmatched.length > 10 ? `, and ${unmatched.length - 10} more` : ''}.`,
        whyItMatters:
          'These endpoints were not compared against anything, so this report says nothing ' +
          'about them. Either the specification is incomplete, or those requests belong to a ' +
          'different API.',
        expected: `${requests.length} requests described`,
        actual: `${checked} described`,
      }),
    );
  }
}

/* ---------------------------------------------------------------- *
 * Status
 * ---------------------------------------------------------------- */

function checkStatus({ findings, request, operation, run }) {
  const documented = Object.keys(operation.responses ?? {}).filter((c) => /^\d{3}$/.test(c));
  const status = run.response.status;

  if (!documented.length) return;
  if (documented.includes(String(status))) return;

  // A documented default covers anything not listed explicitly.
  if (operation.responses?.default && status >= 400) return;

  // The conventions check reports this same defect in more actionable terms ("returned 200
  // rather than 201"), so the generic version is suppressed. Two findings for one bug is how
  // a report becomes something people skim past.
  if (request.method === 'POST' && status === 200 && documented.includes('201')) return;

  findings.push(
    finding({
      suite: SUITE,
      severity: status >= 500 ? 'blocker' : 'major',
      endpoint: operationKey(request),
      specRef: `paths.${operation.path}.${operation.method}.responses`,
      title: `${request.method} ${operation.path} returned an undocumented ${status}`,
      whatHappened:
        `The documentation lists ${documented.join(', ')} for this endpoint, but it ` +
        `returned ${status}.`,
      whyItMatters:
        status >= 500
          ? 'A 5xx means the server failed. Whatever the cause, callers written against the ' +
            'documentation have no way to handle a status it never mentions.'
          : 'Callers handle the statuses the documentation lists. An undocumented status is ' +
            'either a missing doc or a bug, and both surprise the caller.',
      expected: documented.join(' or '),
      actual: String(status),
      evidence: evidenceFrom(run),
    }),
  );
}

function checkContentType({ findings, request, operation, run }) {
  const response = operation.responses?.[String(run.response.status)];
  const documented = Object.keys(response?.content ?? {});
  if (!documented.length) return;

  const actual = (run.response.headers['content-type'] ?? '').split(';')[0].trim();
  if (!actual) return;
  if (documented.some((type) => type === actual || type === '*/*')) return;

  findings.push(
    finding({
      suite: SUITE,
      severity: 'minor',
      endpoint: operationKey(request),
      title: `${request.method} ${operation.path} returned ${actual}`,
      whatHappened: `The documentation says this returns ${documented.join(' or ')}.`,
      whyItMatters:
        'A client that parses the documented type will fail on a different one, usually with ' +
        'an error that points at the client rather than the API.',
      expected: documented.join(' or '),
      actual,
      evidence: evidenceFrom(run),
    }),
  );
}

/* ---------------------------------------------------------------- *
 * Body shape
 * ---------------------------------------------------------------- */

function checkBody({ findings, request, operation, run, spec, naming }) {
  const response = operation.responses?.[String(run.response.status)];
  const schema = resolve(spec, response?.content?.['application/json']?.schema);
  if (!schema) return;
  if (run.response.bodyEncoding !== 'utf8') return;

  let body;
  try {
    body = JSON.parse(run.response.body);
  } catch {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'major',
        endpoint: operationKey(request),
        title: `${request.method} ${operation.path} did not return valid JSON`,
        whatHappened: 'The documentation describes a JSON response, but the body did not parse.',
        whyItMatters: 'Every client of this endpoint will fail at the parse step.',
        expected: 'valid JSON',
        actual: run.response.body.slice(0, 120),
        evidence: evidenceFrom(run),
      }),
    );
    return;
  }

  countNaming(body, naming);

  for (const problem of validate(spec, schema, body, '')) {
    findings.push(
      finding({
        suite: SUITE,
        severity: problem.severity,
        endpoint: operationKey(request),
        specRef: `paths.${operation.path}.${operation.method}.responses.${run.response.status}`,
        title: `${request.method} ${operation.path}: ${problem.title}`,
        whatHappened: problem.detail,
        whyItMatters: problem.why,
        expected: problem.expected,
        actual: problem.actual,
        evidence: evidenceFrom(run),
      }),
    );
  }
}

/**
 * Compare a value against a schema.
 *
 * Intentionally partial: required fields, types, enums and nullability are what break callers.
 * A full JSON Schema validator would add a dependency and a great deal of noise about
 * constructs (allOf composition, conditional schemas) that rarely indicate a real defect.
 */
function validate(spec, rawSchema, value, path, depth = 0) {
  const schema = resolve(spec, rawSchema);
  if (!schema || depth > 8) return [];

  const problems = [];
  const where = path || 'the response body';

  if (value === null) {
    if (schema.nullable !== true && schema.type) {
      problems.push({
        severity: 'major',
        title: `${where} was null`,
        detail: `The documentation types this as ${schema.type} and does not mark it nullable.`,
        why: 'A caller that trusts the documentation will not null-check this, and will crash.',
        expected: `${schema.type}, not null`,
        actual: 'null',
      });
    }
    return problems;
  }

  if (schema.type === 'object' || schema.properties) {
    if (typeof value !== 'object' || Array.isArray(value)) {
      return [typeMismatch(where, 'object', value)];
    }

    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        problems.push({
          severity: 'major',
          title: `${where}.${key} is missing`,
          detail: 'The documentation marks this field as required, but the response omits it.',
          why:
            'Required means a caller may rely on it without checking. Its absence causes ' +
            'undefined values to spread through the calling code.',
          expected: `${key} present`,
          actual: 'absent',
        });
      }
    }

    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (!Object.hasOwn(value, key)) continue;
      problems.push(
        ...validate(spec, propertySchema, value[key], path ? `${path}.${key}` : key, depth + 1),
      );
    }

    // Fields the API returns that the documentation does not mention. Reported as minor
    // rather than major: an undocumented field breaks nobody today, but it is either a doc
    // that has fallen behind or data leaking out of an endpoint that was not meant to
    // expose it — and the second case is worth a look. Only checked where the schema
    // actually enumerates properties, and not where the spec permits extras.
    if (schema.properties && schema.additionalProperties !== true) {
      const undocumented = Object.keys(value).filter((key) => !schema.properties[key]);
      if (undocumented.length) {
        problems.push({
          severity: 'minor',
          title: `${where} contains undocumented field${undocumented.length > 1 ? 's' : ''}`,
          detail: `The response included ${undocumented.slice(0, 8).join(', ')}${
            undocumented.length > 8 ? `, and ${undocumented.length - 8} more` : ''
          }, which the documentation does not describe.`,
          why:
            'Either the documentation has fallen behind the implementation, or the endpoint is ' +
            'returning more than it intends to. The second is worth checking: internal fields ' +
            'leak this way.',
          expected: Object.keys(schema.properties).join(', ') || 'no additional fields',
          actual: undocumented.join(', '),
        });
      }
    }

    return problems;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [typeMismatch(where, 'array', value)];
    // One element is enough to catch a wrong element type; validating thousands adds nothing.
    if (value.length) {
      problems.push(...validate(spec, schema.items, value[0], `${where}[0]`, depth + 1));
    }
    return problems;
  }

  if (schema.enum?.length && !schema.enum.includes(value)) {
    problems.push({
      severity: 'major',
      title: `${where} was outside its documented values`,
      detail: `The documentation lists ${schema.enum.join(', ')}.`,
      why:
        'Callers switch on documented values and often treat anything else as an error, so ' +
        'an undocumented value can break behaviour rather than just widen it.',
      expected: schema.enum.join(' | '),
      actual: String(value),
    });
  }

  const actualType = typeOf(value);
  if (schema.type && !typeMatches(schema.type, value)) {
    problems.push(typeMismatch(where, schema.type, value));
  } else if (schema.format === 'date-time' && actualType === 'string') {
    if (Number.isNaN(Date.parse(value))) {
      problems.push({
        severity: 'minor',
        title: `${where} is not a valid date-time`,
        detail: `The documentation formats this as date-time; the value was "${value}".`,
        why: 'Clients parse date-time fields directly, and an unparseable value becomes NaN.',
        expected: 'an ISO 8601 date-time',
        actual: String(value),
      });
    }
  }

  return problems;
}

function typeMismatch(where, expected, value) {
  return {
    severity: 'major',
    title: `${where} was the wrong type`,
    detail: `The documentation types this as ${expected}; the response contained ${typeOf(value)}.`,
    why:
      'A type mismatch is the failure that surfaces furthest from its cause — usually as an ' +
      'error in the calling code rather than a complaint about the API.',
    expected,
    actual: typeOf(value),
  };
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(expected, value) {
  switch (expected) {
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return true;
  }
}

/* ---------------------------------------------------------------- *
 * Conventions — what specs rarely state but callers expect
 * ---------------------------------------------------------------- */

function checkConventions({ findings, request, operation, run }) {
  const status = run.response.status;

  if (request.method === 'POST' && status === 200) {
    const documented = Object.keys(operation.responses ?? {});

    // Only a contradiction of the spec is reported. Not every POST creates a resource —
    // validate, search and action endpoints legitimately answer 200 — so "POST should return
    // 201" as a general rule produces false positives on endpoints that are behaving exactly
    // as documented. If the spec says 201 and the API says 200, that is a real mismatch.
    if (documented.includes('201') && !documented.includes('200')) {
      findings.push(
        finding({
          suite: SUITE,
          severity: 'major',
          endpoint: operationKey(request),
          specRef: `paths.${operation.path}.${operation.method}.responses`,
          title: `${request.method} ${operation.path} returned 200 rather than 201`,
          whatHappened: 'The documentation says this returns 201 Created, but it returned 200 OK.',
          whyItMatters:
            'Clients and tooling use 201 to distinguish creation from a plain success, which ' +
            'matters for retries and for knowing whether a resource now exists.',
          expected: '201',
          actual: String(status),
          evidence: evidenceFrom(run),
        }),
      );
    }
  }

  if (status === 201 && !run.response.headers['location']) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'minor',
        endpoint: operationKey(request),
        title: `${request.method} ${operation.path} returned 201 without a Location header`,
        whatHappened: 'The response created something but did not say where it now lives.',
        whyItMatters:
          'Callers use Location to fetch or link the new resource without guessing how its ' +
          'URL is built.',
        expected: 'a Location header',
        actual: 'no Location header',
        evidence: evidenceFrom(run),
      }),
    );
  }
}

/** Mixed naming across a payload is a real interoperability smell, so it is counted globally. */
function countNaming(value, naming, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return;

  for (const [key, child] of Object.entries(value)) {
    const style = namingStyle(key);
    if (style === 'camel') naming.camel += 1;
    else if (style === 'snake') naming.snake += 1;
    countNaming(child, naming, depth + 1);
  }
}

/**
 * Classify a field name as camelCase, snake_case, or neither.
 *
 * A linear scan rather than a pattern: the obvious regexes for these
 * (^[a-z]+(?:[A-Z][a-z0-9]*)+$) nest quantifiers, which is a ReDoS shape — and these keys
 * come straight from the API being tested, so the input is not ours to trust.
 */
function namingStyle(key) {
  if (!key || !/^[a-z]/.test(key[0])) return null;

  let hasUpper = false;
  let hasUnderscore = false;

  for (const char of key) {
    if (char >= 'A' && char <= 'Z') hasUpper = true;
    else if (char === '_') hasUnderscore = true;
    else if (!((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9'))) return null;
  }

  if (hasUpper && !hasUnderscore) return 'camel';
  if (hasUnderscore && !hasUpper) return 'snake';
  return null;
}

function checkNamingConsistency({ findings, naming }) {
  const { camel, snake } = naming;
  if (!camel || !snake) return;

  const minority = Math.min(camel, snake);
  const total = camel + snake;
  if (minority / total < 0.05) return; // a stray field is not a convention problem

  findings.push(
    finding({
      suite: SUITE,
      severity: 'minor',
      endpoint: null,
      title: 'Responses mix camelCase and snake_case field names',
      whatHappened: `${camel} camelCase and ${snake} snake_case field names were seen.`,
      whyItMatters:
        'Callers end up mapping field names by hand and getting them wrong, and generated ' +
        'clients produce awkward mixed types. It is cheap to fix early and expensive later.',
      expected: 'one naming convention',
      actual: 'both',
    }),
  );
}

/* ---------------------------------------------------------------- *
 * Spec helpers
 * ---------------------------------------------------------------- */

function indexOperations(spec) {
  const map = new Map();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      if (!item?.[method]) continue;
      map.set(`${method.toUpperCase()} ${path}`, { ...item[method], path, method });
    }
  }
  return map;
}

/**
 * Match a live request back to its spec operation.
 *
 * The importer templated `/users/{id}` into `/users/{{id}}`, so the mapping is by shape rather
 * than by literal path.
 */
function operationKey(request) {
  const path = String(request.url ?? '')
    .replace(/^\{\{baseUrl\}\}/, '')
    .replace(/\?.*$/, '')
    .replace(/\{\{(\w+)\}\}/g, '{$1}');
  return `${request.method} ${path}`;
}

function resolve(spec, node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 10) return node;
  if (!node.$ref) return node;
  if (!node.$ref.startsWith('#/')) return null;

  let current = spec;
  for (const segment of node.$ref.slice(2).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current == null || typeof current !== 'object' || !Object.hasOwn(current, key)) return null;
    // Own properties only, so a crafted "$ref": "#/__proto__/x" resolves to nothing. Read-only
    // traversal — nothing is ever assigned.
    // nosemgrep: prototype-pollution-loop
    current = current[key];
  }
  return resolve(spec, current, depth + 1);
}

export { operationKey };
