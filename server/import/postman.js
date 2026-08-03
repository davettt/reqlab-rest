/**
 * Postman collections (v2.0 / v2.1) and HAR files → requests.
 *
 * Both are exports of things that already worked, so they carry real values rather than
 * schemas. That makes them the highest-fidelity import — and the one most likely to contain
 * live credentials, which is why anything that looks like a secret is lifted out into a
 * variable rather than saved onto the request.
 */

/** Header names whose values are credentials, and must not be stored on a request. */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
]);

export function isPostman(doc) {
  return Boolean(doc?.info?.schema?.includes('getpostman.com') || (doc?.info && doc?.item));
}

export function isHar(doc) {
  return Boolean(doc?.log?.entries);
}

/* ---------------------------------------------------------------- *
 * Postman
 * ---------------------------------------------------------------- */

export function parsePostman(doc) {
  const warnings = [];
  const requests = [];
  const variables = (doc.variable ?? []).map((v) => ({
    key: v.key,
    value: String(v.value ?? ''),
    enabled: true,
    secret: false,
  }));
  const secrets = new Map();

  const walk = (items, trail) => {
    for (const item of items ?? []) {
      if (item.item) {
        walk(item.item, [...trail, item.name]);
        continue;
      }
      if (!item.request) continue;

      const request = convertPostmanRequest(item, trail, secrets, warnings);
      if (request) requests.push(request);
    }
  };

  walk(doc.item, []);
  variables.push(...secrets.values());

  return {
    requests,
    variables,
    warnings,
    info: { title: doc.info?.name ?? 'Postman collection', version: '', format: 'Postman' },
  };
}

function convertPostmanRequest(item, trail, secrets, warnings) {
  const source = item.request;
  const url = typeof source.url === 'string' ? { raw: source.url } : (source.url ?? {});

  const raw =
    url.raw ??
    [
      url.protocol ? `${url.protocol}://` : '',
      Array.isArray(url.host) ? url.host.join('.') : (url.host ?? ''),
      Array.isArray(url.path) ? `/${url.path.join('/')}` : (url.path ?? ''),
    ].join('');

  // Postman uses :param in paths and {{var}} for variables — the latter is already our syntax.
  const cleanUrl = raw
    .split('?')[0]
    .replace(/:(\w+)/g, (match, name) => (match.startsWith('://') ? match : `{{${name}}}`));

  const request = {
    name: [...trail, item.name].filter(Boolean).join(' / ').slice(0, 300) || 'Imported request',
    folderId: null,
    method: (source.method ?? 'GET').toUpperCase(),
    url: cleanUrl,
    params: (url.query ?? [])
      .filter((q) => q?.key)
      .map((q) => ({ key: q.key, value: String(q.value ?? ''), enabled: q.disabled !== true })),
    headers: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    assertions: [],
    captures: [],
  };

  for (const header of source.header ?? []) {
    if (!header?.key || header.disabled) continue;
    const lower = header.key.toLowerCase();

    if (CREDENTIAL_HEADERS.has(lower)) {
      request.auth = credentialFromHeader(header, secrets);
      continue;
    }
    request.headers.push({ key: header.key, value: String(header.value ?? ''), enabled: true });
  }

  const body = source.body;
  if (body?.mode === 'raw' && body.raw) {
    const isJson = body.options?.raw?.language === 'json' || looksLikeJson(body.raw);
    request.body = { type: isJson ? 'json' : 'text', content: body.raw };
  } else if (body?.mode === 'urlencoded') {
    request.body = {
      type: 'form',
      fields: (body.urlencoded ?? []).map((f) => ({
        key: f.key,
        value: String(f.value ?? ''),
        enabled: f.disabled !== true,
        type: 'text',
      })),
    };
  } else if (body?.mode === 'formdata') {
    request.body = {
      type: 'multipart',
      fields: (body.formdata ?? [])
        .filter((f) => f.type !== 'file')
        .map((f) => ({ key: f.key, value: String(f.value ?? ''), enabled: true, type: 'text' })),
    };
    if ((body.formdata ?? []).some((f) => f.type === 'file')) {
      warnings.push(`"${item.name}" uploads a file; the file itself is not imported.`);
    }
  } else if (body?.mode === 'graphql') {
    request.body = {
      type: 'graphql',
      query: body.graphql?.query ?? '',
      variables: body.graphql?.variables ?? '',
    };
  }

  if (source.auth) applyPostmanAuth(source.auth, request, secrets);

  return request;
}

function applyPostmanAuth(auth, request, secrets) {
  const remember = (key) => {
    if (!secrets.has(key)) secrets.set(key, { key, value: '', enabled: true, secret: true });
    return `{{${key}}}`;
  };
  const valueOf = (list, name) => list?.find((entry) => entry.key === name)?.value ?? '';

  switch (auth.type) {
    case 'bearer':
      request.auth = { type: 'bearer', token: remember('bearerToken') };
      break;
    case 'basic':
      request.auth = {
        type: 'basic',
        username: String(valueOf(auth.basic, 'username') || remember('username')),
        password: remember('password'),
      };
      break;
    case 'apikey':
      request.auth = {
        type: 'apiKey',
        in: valueOf(auth.apikey, 'in') === 'query' ? 'query' : 'header',
        key: String(valueOf(auth.apikey, 'key') || 'X-API-Key'),
        value: remember('apiKey'),
      };
      break;
    default:
      break;
  }
}

/**
 * A credential found on a request is replaced by a variable reference. The exported value is
 * discarded rather than saved: importing someone's collection should not silently plant their
 * live token in your project.
 */
function credentialFromHeader(header, secrets) {
  const remember = (key) => {
    if (!secrets.has(key)) secrets.set(key, { key, value: '', enabled: true, secret: true });
    return `{{${key}}}`;
  };

  const value = String(header.value ?? '');
  const lower = header.key.toLowerCase();

  if (lower === 'authorization' && /^bearer /i.test(value)) {
    return { type: 'bearer', token: remember('bearerToken') };
  }
  if (lower === 'authorization' && /^basic /i.test(value)) {
    return { type: 'basic', username: remember('username'), password: remember('password') };
  }
  return { type: 'apiKey', in: 'header', key: header.key, value: remember('apiKey') };
}

function looksLikeJson(text) {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/* ---------------------------------------------------------------- *
 * HAR
 * ---------------------------------------------------------------- */

export function parseHar(doc) {
  const warnings = [];
  const requests = [];
  const secrets = new Map();
  const seen = new Set();
  const origins = new Set();

  for (const entry of doc.log.entries ?? []) {
    const source = entry.request;
    if (!source?.url) continue;

    let url;
    try {
      url = new URL(source.url);
    } catch {
      continue;
    }

    // A HAR of a browsing session repeats the same endpoint many times; one per
    // method+path is what is useful, not one per page load.
    const key = `${source.method} ${url.origin}${url.pathname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    origins.add(url.origin);

    const request = {
      name: `${source.method} ${url.pathname}`.slice(0, 300),
      folderId: null,
      method: (source.method ?? 'GET').toUpperCase(),
      url: `{{baseUrl}}${url.pathname}`,
      params: (source.queryString ?? []).map((q) => ({
        key: q.name,
        value: String(q.value ?? ''),
        enabled: true,
      })),
      headers: [],
      body: { type: 'none' },
      auth: { type: 'none' },
      assertions: [],
      captures: [],
    };

    for (const header of source.headers ?? []) {
      const lower = (header.name ?? '').toLowerCase();
      // Browser-managed headers describe the capture, not the request you want to replay.
      if (lower.startsWith(':') || ['host', 'content-length', 'connection'].includes(lower)) {
        continue;
      }
      if (CREDENTIAL_HEADERS.has(lower)) {
        request.auth = credentialFromHeader({ key: header.name, value: header.value }, secrets);
        continue;
      }
      request.headers.push({ key: header.name, value: String(header.value ?? ''), enabled: true });
    }

    const text = source.postData?.text;
    if (text) {
      request.body = looksLikeJson(text)
        ? { type: 'json', content: text }
        : { type: 'text', content: text };
    }

    requests.push(request);
  }

  if (origins.size > 1) {
    warnings.push(
      `The capture spans ${origins.size} origins (${[...origins].slice(0, 3).join(', ')}…). ` +
        'baseUrl is set to the first; adjust requests from other hosts.',
    );
  }

  const variables = [
    { key: 'baseUrl', value: [...origins][0] ?? '', enabled: true, secret: false },
    ...secrets.values(),
  ];

  return {
    requests,
    variables,
    warnings,
    info: { title: 'HAR capture', version: '', format: 'HAR' },
  };
}
