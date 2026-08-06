/**
 * Code export.
 *
 * Turns a request into a snippet you can paste into a shell, an app, or a script.
 *
 * The central decision is what to do with secrets. A snippet is meant to be copied — into a
 * terminal, a file, a chat message — so inlining a real credential is how tokens end up in
 * version control. By default every secret becomes an environment-variable reference in the
 * target language, and the caller has to ask explicitly for the resolved value.
 */
import { interpolate, interpolateDeep, referencedVars, DYNAMIC_NAMES } from '../vars.js';
import { buildBody } from '../exec/bodies.js';

export const TARGETS = ['curl', 'fetch', 'tanstack', 'axios', 'python'];

/**
 * Resolve a request against a scope, keeping secrets symbolic.
 *
 * @param {object} definition raw request
 * @param {Map} scope from buildScope()
 * @param {{inlineSecrets?: boolean}} options
 */
function resolveForExport(definition, scope, { inlineSecrets = false } = {}) {
  // Secret variables are swapped for a marker before interpolation, so the resolved request
  // carries a placeholder the generators can render idiomatically per language.
  const exportScope = new Map();
  const secretNames = [];

  for (const [key, entry] of scope.entries()) {
    if (entry.secret && !inlineSecrets) {
      const envName = toEnvName(key);
      secretNames.push({ key, envName });
      exportScope.set(key, { value: `__RL_SECRET_${envName}__`, secret: false });
    } else {
      exportScope.set(key, entry);
    }
  }

  const url = new URL(interpolate(definition.url ?? '', exportScope).text || 'http://localhost');
  for (const param of definition.params ?? []) {
    if (!param.key || param.enabled === false) continue;
    url.searchParams.append(
      interpolate(param.key, exportScope).text,
      interpolate(param.value ?? '', exportScope).text,
    );
  }

  const headers = {};
  for (const header of definition.headers ?? []) {
    if (!header.key || header.enabled === false) continue;
    headers[interpolate(header.key, exportScope).text] = interpolate(
      header.value ?? '',
      exportScope,
    ).text;
  }

  const auth = interpolateDeep(definition.auth ?? { type: 'none' }, exportScope).value;
  applyAuthForExport(auth, headers, url, secretNames);

  const bodyDef = interpolateDeep(definition.body ?? { type: 'none' }, exportScope).value;
  const { payload, contentType } = buildBody(bodyDef);
  if (contentType && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = contentType;
  }

  return {
    method: (definition.method ?? 'GET').toUpperCase(),
    url: url.toString(),
    headers,
    body: typeof payload === 'string' ? payload : null,
    bodyType: bodyDef.type,
    secrets: secretNames,
    name: definition.name ?? 'request',
  };
}

/** OAuth2 cannot be expressed as a single request, so it is reported rather than faked. */
function applyAuthForExport(auth, headers, url, secretNames) {
  switch (auth?.type) {
    case 'bearer':
      if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
      break;
    case 'basic': {
      // Left symbolic when either half is a secret marker: base64 of a placeholder would be
      // meaningless, and worse, would look like a real credential.
      const raw = `${auth.username ?? ''}:${auth.password ?? ''}`;
      headers.Authorization = /__RL_SECRET_/.test(raw)
        ? `Basic <base64 of ${raw.replace(SECRET_MARKER, '$$$1')}>`
        : `Basic ${Buffer.from(raw).toString('base64')}`;
      break;
    }
    case 'apiKey':
      if (!auth.key) break;
      if (auth.in === 'query') url.searchParams.set(auth.key, auth.value ?? '');
      else headers[auth.key] = auth.value ?? '';
      break;
    case 'oauth2-cc':
      headers.Authorization = 'Bearer <token from the OAuth2 client-credentials exchange>';
      secretNames.push({ key: 'oauth2', envName: null, note: true });
      break;
    default:
      break;
  }
}

function toEnvName(key) {
  return (
    key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .toUpperCase()
      .replace(/^_+|_+$/g, '') || 'SECRET'
  );
}

/* ---------------------------------------------------------------- *
 * Generators
 * ---------------------------------------------------------------- */

/**
 * Secrets are carried through resolution as __RL_SECRET_NAME__ so each generator can render
 * them in its own idiom. A readable token rather than a control character: this shows up in
 * intermediate values and error messages, and needs to be recognisable when it does.
 */
const SECRET_MARKER = /__RL_SECRET_([A-Z0-9_]+)__/g;
const marker = (text, render) => text.replace(SECRET_MARKER, (_m, name) => render(name));

function curl(r) {
  /**
   * Escape first, substitute second. The shell-variable form is '"$VAR"' — it contains
   * single quotes of its own, so escaping after substitution mangles them into '\''"$VAR"'\'
   * which is a different (broken) command.
   */
  const q = (value) => {
    const escaped = value.replace(/'/g, `'\\''`);
    const withVars = marker(escaped, (n) => `'"$${n}"'`);
    // Leading/trailing empty '' pairs are valid but read as a mistake in a pasted snippet.
    return `'${withVars}'`.replace(/^''/, '').replace(/''$/, '') || "''";
  };

  const lines = [`curl -X ${r.method} ${q(r.url)}`];
  for (const [key, value] of Object.entries(r.headers)) {
    lines.push(`  -H ${q(`${key}: ${value}`)}`);
  }
  if (r.body) lines.push(`  -d ${q(r.body)}`);
  return lines.join(' \\\n');
}

function fetchJs(r) {
  const js = (value) => JSON.stringify(marker(value, (n) => `\${process.env.${n}}`));
  const needsTemplate = (value) => /__RL_SECRET_/.test(value);
  const str = (value) =>
    needsTemplate(value)
      ? '`' + marker(value, (n) => `\${process.env.${n}}`).replace(/`/g, '\\`') + '`'
      : js(value);

  const headers = Object.entries(r.headers)
    .map(([key, value]) => `    ${JSON.stringify(key)}: ${str(value)},`)
    .join('\n');

  const parts = [
    `const res = await fetch(${str(r.url)}, {`,
    `  method: ${JSON.stringify(r.method)},`,
  ];
  if (headers) parts.push('  headers: {', headers, '  },');
  if (r.body) parts.push(`  body: ${str(r.body)},`);
  parts.push(
    '});',
    '',
    'if (!res.ok) throw new Error(`HTTP ${res.status}`);',
    'const data = await res.json();',
  );
  return parts.join('\n');
}

function tanstack(r) {
  const hookName =
    'use' +
    (r.name.replace(/[^A-Za-z0-9]+(.)/g, (_m, c) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '') ||
      'Request');
  const mutation = r.method !== 'GET' && r.method !== 'HEAD';
  const inner = fetchJs(r)
    .split('\n')
    .map((line) => (line ? `    ${line}` : ''))
    .join('\n');

  if (mutation) {
    return [
      `import { useMutation } from '@tanstack/react-query';`,
      '',
      `export function ${hookName}() {`,
      '  return useMutation({',
      '    mutationFn: async () => {',
      inner.replace(/^ {4}/gm, '      '),
      '      return data;',
      '    },',
      '  });',
      '}',
    ].join('\n');
  }

  return [
    `import { useQuery } from '@tanstack/react-query';`,
    '',
    `export function ${hookName}() {`,
    '  return useQuery({',
    `    queryKey: [${JSON.stringify(r.name)}],`,
    '    queryFn: async () => {',
    inner.replace(/^ {4}/gm, '      '),
    '      return data;',
    '    },',
    '  });',
    '}',
  ].join('\n');
}

function axios(r) {
  const str = (value) =>
    /__RL_SECRET_/.test(value)
      ? '`' + marker(value, (n) => `\${process.env.${n}}`) + '`'
      : JSON.stringify(value);

  const parts = [`import axios from 'axios';`, '', 'const res = await axios({'];
  parts.push(`  method: ${JSON.stringify(r.method.toLowerCase())},`);
  parts.push(`  url: ${str(r.url)},`);
  if (Object.keys(r.headers).length) {
    parts.push('  headers: {');
    for (const [key, value] of Object.entries(r.headers)) {
      parts.push(`    ${JSON.stringify(key)}: ${str(value)},`);
    }
    parts.push('  },');
  }
  if (r.body) {
    parts.push(
      r.bodyType === 'json' ? `  data: ${r.body.trim() || '{}'},` : `  data: ${str(r.body)},`,
    );
  }
  parts.push('});');
  return parts.join('\n');
}

function python(r) {
  const str = (value) =>
    /__RL_SECRET_/.test(value)
      ? `f"${marker(value, (n) => `{os.environ['${n}']}`)}"`
      : JSON.stringify(value);

  const parts = ['import os', 'import requests', '', 'res = requests.request('];
  parts.push(`    ${JSON.stringify(r.method)},`);
  parts.push(`    ${str(r.url)},`);
  if (Object.keys(r.headers).length) {
    parts.push('    headers={');
    for (const [key, value] of Object.entries(r.headers)) {
      parts.push(`        ${JSON.stringify(key)}: ${str(value)},`);
    }
    parts.push('    },');
  }
  if (r.body) {
    parts.push(
      r.bodyType === 'json'
        ? `    json=${indentLiteral(pythonLiteral(r.body))},`
        : `    data=${str(r.body)},`,
    );
  }
  parts.push(')', 'res.raise_for_status()', 'data = res.json()');
  return parts.join('\n');
}

/** Re-indent a multi-line literal so it lines up inside the call it sits in. */
function indentLiteral(literal) {
  const [first, ...rest] = literal.split('\n');
  return [first, ...rest.map((line) => `    ${line}`)].join('\n');
}

/** JSON is almost Python; the literals are what differ. */
function pythonLiteral(json) {
  try {
    return JSON.stringify(JSON.parse(json), null, 4)
      .replace(/\btrue\b/g, 'True')
      .replace(/\bfalse\b/g, 'False')
      .replace(/\bnull\b/g, 'None');
  } catch {
    return JSON.stringify(json);
  }
}

const GENERATORS = { curl, fetch: fetchJs, tanstack, axios, python };

/**
 * @returns {{code: string, secrets: string[], notes: string[]}}
 */
export function generate(definition, scope, target, options = {}) {
  if (!GENERATORS[target]) throw new Error(`Unknown code target "${target}"`);

  const resolved = resolveForExport(definition, scope, options);
  const code = GENERATORS[target](resolved);

  const notes = [];
  const envNames = resolved.secrets.filter((s) => s.envName).map((s) => s.envName);
  if (envNames.length && !options.inlineSecrets) {
    notes.push(
      `Reads ${envNames.join(', ')} from the environment — the real values are not in this snippet.`,
    );
  }
  if (options.inlineSecrets && envNames.length === 0 && scope.size) {
    notes.push('Secrets are inlined in this snippet. Do not commit it.');
  }
  if (resolved.secrets.some((s) => s.note)) {
    notes.push('OAuth2 needs a token exchange first; the snippet shows where the token goes.');
  }

  // A generated value is generated once, at export. Left unsaid, a snippet carrying a frozen
  // Idempotency-Key looks correct and does the opposite of what the header is for: every run
  // of it is treated by the server as a retry of the first.
  // Parsed with the same placeholder grammar the resolver uses, rather than a hand-built
  // pattern, so "{{ $uuid }}" is recognised exactly as the resolver recognised it.
  const referenced = new Set(referencedVars(JSON.stringify(definition ?? {})));
  const dynamic = DYNAMIC_NAMES.filter((name) => referenced.has(name));
  if (dynamic.length) {
    notes.push(
      `${dynamic.join(', ')} ${dynamic.length === 1 ? 'was' : 'were'} resolved to a fixed value ` +
        'when this snippet was generated. Generate a fresh one in your own code if the request ' +
        'needs a different value each time — an Idempotency-Key reused is read as a retry.',
    );
  }

  return { code, secrets: envNames, notes };
}
