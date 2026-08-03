/**
 * AI import: prose documentation → proposed requests.
 *
 * Only reached when the deterministic parsers cannot help. Three rules shape this file:
 *
 *  1. The model's output is a *proposal*. It is validated against the same Zod schema as any
 *     hand-written request and then shown for accept/reject. Nothing is written unreviewed.
 *  2. The model never sees a credential. Documentation is chunked and sent as-is, but the
 *     user's own secrets live in environments and are not part of the prompt.
 *  3. Anything the docs do not state becomes a {{variable}} or is left empty. A plausible
 *     invented endpoint is worse than an obvious gap, because it looks finished.
 */
import { z } from 'zod';
import { completeJson, AiError } from '../ai/providers.js';
import { promoteCredential } from './credentials.js';
import { requestInput } from '../model.js';

/** Documentation pages are frequently enormous; this bounds cost and context per call. */
const MAX_CHARS = 60_000;
const CHUNK_CHARS = 24_000;

const SYSTEM = `You extract HTTP requests from API documentation.

Rules:
- Only describe endpoints the documentation actually states. Never invent an endpoint, a
  parameter, or a field name. Missing information is expected and fine.
- Use {{variableName}} only for values that change between environments or callers: the base
  URL, credentials, and resource identifiers that appear in the path. Everything else — body
  fields in particular — should carry the documented example value inline, so the request is
  runnable as imported. A request body of {"title": "foo", "userId": 1} taken from the docs is
  far more useful than one of {"title": "{{title}}", "userId": {{userId}}}, which cannot be
  sent until the user invents values.
- Put the base URL in a variable called baseUrl and start each url with {{baseUrl}}.
- Credentials must be variables, never literal values, even if the docs show an example key.
- If the docs show an API key in a query parameter or header, set auth accordingly.
- Prefer the documented example request when there is one.
- Include OPTIONAL parameters as well as required ones, and set optional: true on them. Seeing
  what an endpoint supports is useful even when the parameter is not sent by default.
- When the docs state a closed set of accepted values, list them in options (for example
  ["JSON", "XML"]). Use the documented default as the value.
- The url must include the full endpoint path, not just the host: {{baseUrl}}/api/v2, not
  {{baseUrl}}.
- A value that appears in the path must not also be listed as a query parameter. GET /posts/1
  has the id in the path; GET /comments?postId=1 has it in the query. They are different
  endpoints, so give each its own request.
- Never use a filler value like <UNKNOWN>, YOUR_KEY or REPLACE_ME. If a value is not stated,
  use a {{variable}} named after the parameter.`;

const schema = {
  type: 'object',
  properties: {
    requests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
          url: { type: 'string' },
          params: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                value: { type: 'string' },
                optional: { type: 'boolean', description: 'True when the parameter is optional' },
                options: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Accepted values, when the docs state a closed set',
                },
                description: { type: 'string' },
              },
              required: ['key'],
            },
          },
          headers: {
            type: 'array',
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, value: { type: 'string' } },
              required: ['key'],
            },
          },
          bodyJson: { type: 'string', description: 'JSON body as text, or empty' },
          authType: { type: 'string', enum: ['none', 'bearer', 'basic', 'apiKey'] },
          authIn: { type: 'string', enum: ['header', 'query'] },
          authKey: { type: 'string', description: 'Header or query parameter name for apiKey' },
          notes: { type: 'string' },
        },
        required: ['name', 'method', 'url'],
      },
    },
    variables: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          secret: { type: 'boolean' },
        },
        required: ['key'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['requests'],
};

/**
 * @param {string} text documentation, already stripped of markup
 * @param {{provider: string, tier: string, apiKey: string}} config
 * @param {{complete?: Function}} deps the model call, injectable so the handling of a
 *   model's output — including malformed or credential-bearing output — can be tested
 *   without a key, a network call, or the hope of provoking that response for real
 */
export async function importWithAi(text, config, deps = {}) {
  const complete = deps.complete ?? completeJson;
  const sourceUrl = deps.sourceUrl ?? null;
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new AiError('There is no documentation text to read.');

  const chunks = chunk(trimmed.slice(0, MAX_CHARS));
  let requests = [];
  const variables = new Map();
  const warnings = [];
  const summaries = [];

  if (trimmed.length > MAX_CHARS) {
    warnings.push(
      `The document is ${Math.round(trimmed.length / 1000)}k characters; only the first ` +
        `${MAX_CHARS / 1000}k were read. Import the rest separately if endpoints are missing.`,
    );
  }

  for (const [index, part] of chunks.entries()) {
    const result = await complete(config, {
      system: SYSTEM,
      user: [
        // The docs' own address is strong evidence for the API host, and the model cannot
        // see it otherwise — the page content rarely repeats its own origin.
        sourceUrl ? `This documentation was fetched from: ${sourceUrl}` : null,
        chunks.length > 1
          ? `Documentation (part ${index + 1} of ${chunks.length}):\n\n${part}`
          : `Documentation:\n\n${part}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      schema,
      schemaName: 'extracted_requests',
    });

    if (result.summary) summaries.push(result.summary);

    const filledVariables = new Set();
    const promoted = new Set();

    for (const proposed of result.requests ?? []) {
      const converted = toRequest(proposed, warnings, filledVariables);
      if (!converted) continue;

      // An API key documented as a query parameter belongs on the Auth tab: that is where
      // the query-string exposure warning lives, and it keeps the credential out of a list
      // that gets copied around.
      const { promoted: moved, deduped } = promoteCredential(converted);
      if (moved) promoted.add(moved);
      for (const name of deduped ?? []) promoted.add(name);

      requests.push(converted);
    }

    if (promoted.size) {
      warnings.push(
        `${[...promoted].join(', ')} is handled on the Auth tab, so it was removed from ` +
          'Params. Move it back if it is not actually a credential.',
      );
    }

    // A variable invented to replace a filler value must exist, or the request fails with an
    // unresolved placeholder instead.
    for (const name of filledVariables) {
      if (!variables.has(name)) {
        variables.set(name, { key: name, value: '', enabled: true, secret: false });
      }
    }

    // The auth tab holds {{apiKey}}, {{username}} and friends. Those placeholders are written
    // by buildAuth rather than by the model, so nothing else would ever create them, and a
    // request whose credential resolves to nothing is refused before it is sent. They are
    // registered first so they are always secret — the model calling apiKey a plain variable
    // must not downgrade it into something that gets written to disk in the clear.
    for (const request of requests) {
      for (const [, key] of JSON.stringify(request.auth ?? {}).matchAll(
        /\{\{\s*([\w.-]+)\s*\}\}/g,
      )) {
        variables.set(key, { key, value: '', enabled: true, secret: true });
      }
    }

    for (const variable of result.variables ?? []) {
      if (!variable?.key || variables.has(variable.key)) continue;
      variables.set(variable.key, {
        key: variable.key,
        // A secret's value is never taken from the model, even if the docs contained an
        // example key: an example key in real docs is sometimes a real leaked key.
        value: variable.secret ? '' : (variable.value ?? ''),
        enabled: true,
        secret: Boolean(variable.secret),
      });
    }
  }

  // The same endpoint described in two places produces two identical requests. Keep the one
  // that carries more detail — a body or parameters — rather than whichever came first.
  const byKey = new Map();
  for (const request of requests) {
    const key = `${request.method} ${request.url}`;
    const existing = byKey.get(key);
    const detail = (r) =>
      (r.params?.length ?? 0) + (r.headers?.length ?? 0) + (r.body?.content ? 5 : 0);

    if (!existing || detail(request) > detail(existing)) byKey.set(key, request);
  }
  requests = [...byKey.values()];

  if (!requests.length) {
    throw new AiError(
      'No requests could be extracted from that text. It may not be API documentation, or the ' +
        'endpoints may be described in a way the model could not read.',
    );
  }

  // Resource identifiers belong in the request, not the environment.
  //
  // An environment holds what changes between deployments — the base URL and credentials.
  // A resource id is per-request data: putting postId in the environment means the GET, the
  // PATCH and the DELETE all act on whichever single id is set there, so changing it for one
  // silently changes what the others touch. Each request keeps its own documented value, and
  // the model's inconsistency (/posts/{{postId}} here, /comments/1 there) is settled by
  // inlining rather than by promoting everything to a variable.
  // A path variable repeated as a query parameter produces /posts/{{postId}}?postId=... —
  // the model conflating two endpoints that happen to share a value's name.
  //
  // This has to run *before* the ids are inlined. Afterwards the path holds `1` rather than
  // `{{postId}}`, so there is no variable name left to match and the stray parameter would
  // survive — which is what "the URL is /posts/1 and there is still an id=1 in Params" is.
  for (const request of requests) {
    const inPath = new Set(
      [...String(request.url).matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]),
    );

    // Match on the value as well as the name. The model is not consistent about what it calls
    // things: /posts/{{postId}} paired with a parameter named `id` carrying the same 1 is the
    // same duplication, and matching only names misses it.
    const pathValues = new Set(
      [...inPath].map((name) => variables.get(name)?.value).filter(Boolean),
    );

    // And on the literal path segments. The model frequently skips the variable entirely and
    // copies the documentation's example address verbatim — GET {{baseUrl}}/posts/1 — while
    // still listing `id: 1` under parameters. There is no variable name involved anywhere, so
    // neither of the checks above sees it, and the request goes out as /posts/1?id=1.
    const segments = new Set(
      String(request.url)
        .split('?')[0]
        .split('/')
        .filter((s) => s && !s.includes('{{')),
    );

    const duplicated = (request.params ?? []).filter(
      (p) =>
        inPath.has(p.key) ||
        (p.value && pathValues.has(p.value)) ||
        (p.value && segments.has(p.value) && looksLikeIdentifier(p)),
    );

    if (duplicated.length) {
      for (const param of duplicated) param.enabled = false;
      warnings.push(
        `${duplicated.map((p) => p.key).join(', ')} already appears in the path of ` +
          `"${request.name}", and was also listed as a query parameter. The query version has ` +
          'been unticked — if the endpoint really takes it twice, tick it again.',
      );
    }
  }

  inlineRequestScopedValues(requests, variables);

  // A URL with no path is almost always the model dropping the endpoint rather than an API
  // served from the host root. Worth naming, because it fails in a way that looks like a
  // network problem rather than a bad import.
  const pathless = requests.filter((r) => /^\{\{\w+\}\}\/?$/.test(r.url.trim()));
  if (pathless.length) {
    warnings.push(
      `${pathless.length === 1 ? 'One request has' : `${pathless.length} requests have`} no ` +
        'endpoint path, only the base URL. Check the documentation for the path (for example ' +
        '/api/v2) and add it before sending.',
    );
  }

  // Every proposal carries this: the user is reviewing a guess, and should know it.
  warnings.push(
    'These requests were inferred from prose by a language model. Check each URL, parameter ' +
      'and body against the documentation before relying on them.',
  );

  // baseUrl is the one variable that makes every request unusable when empty, so it gets a
  // deterministic fallback: the origin of the page the docs came from. Documentation is
  // almost always served from the same host as the API it documents, and a good default the
  // user can correct beats a blank field they have to go and look up.
  const existing = variables.get('baseUrl');
  if (!existing || !existing.value) {
    const fallback = originOf(sourceUrl);
    if (fallback) {
      variables.set('baseUrl', { key: 'baseUrl', value: fallback, enabled: true, secret: false });
      warnings.push(
        `The documentation did not state a base URL, so baseUrl was set to ${fallback} — the ` +
          'host the docs were fetched from. Check it against the docs before sending.',
      );
    } else {
      variables.set('baseUrl', { key: 'baseUrl', value: '', enabled: true, secret: false });
      warnings.push('No base URL was found in the documentation — set baseUrl before sending.');
    }
  }

  // Anything else left empty is worth naming explicitly, rather than the user discovering it
  // when a request silently sends a literal placeholder.
  const blanks = [...variables.values()]
    .filter((v) => !v.secret && !v.value && v.key !== 'baseUrl')
    .map((v) => v.key);
  if (blanks.length) {
    warnings.push(`These variables have no value yet: ${blanks.join(', ')}.`);
  }

  return {
    source: 'ai',
    requests,
    variables: [...variables.values()],
    warnings,
    info: {
      // A name, not a description. The model's summary is a sentence, and using it made
      // environments called "Domain Reputation API v2 - Single endpoint for evaluating…".
      // The docs host is short, stable, and recognisable; the summary becomes the subtitle.
      title: shortName(sourceUrl, summaries[0]),
      description: summaries[0] ?? '',
      version: '',
      format: `AI (${config.provider} ${config.tier ?? 'smart'})`,
    },
  };
}

/**
 * Convert one proposal into a real request, validated by the same schema as everything else.
 * A proposal that fails validation is dropped with a warning rather than silently repaired —
 * a half-understood endpoint is not worth guessing at.
 */
function toRequest(proposed, warnings, filledVariables = new Set()) {
  const auth = buildAuth(proposed);

  const candidate = {
    name: proposed.name?.slice(0, 300) || 'Imported request',
    folderId: null,
    method: (proposed.method ?? 'GET').toUpperCase(),
    url: proposed.url ?? '',
    params: normaliseFiller(
      (proposed.params ?? [])
        .filter((p) => p?.key)
        .map((p) => ({
          key: p.key,
          value: p.value ?? '',
          // Optional parameters arrive unchecked: visible, documented, and not sent.
          enabled: p.optional !== true,
          ...(p.options?.length ? { options: p.options.map(String).slice(0, 100) } : {}),
          ...(p.description ? { description: String(p.description).slice(0, 1000) } : {}),
        })),
      filledVariables,
    ),
    headers: (proposed.headers ?? [])
      .filter((h) => h?.key)
      // Auth headers are expressed through the auth config, not duplicated here.
      .filter((h) => h.key.toLowerCase() !== 'authorization')
      .map((h) => ({ key: h.key, value: h.value ?? '', enabled: true })),
    body: proposed.bodyJson?.trim()
      ? { type: 'json', content: proposed.bodyJson }
      : { type: 'none' },
    auth,
    assertions: [],
    captures: [],
  };

  const parsed = requestInput.safeParse(candidate);
  if (!parsed.success) {
    warnings.push(
      `Skipped a proposed request ("${candidate.name}") that did not validate: ` +
        parsed.error.issues
          .slice(0, 2)
          .map((i) => i.path.join('.') + ' ' + i.message)
          .join('; '),
    );
    return null;
  }
  return parsed.data;
}

/**
 * Filler values a model reaches for when the docs give no example: <UNKNOWN>, YOUR_API_KEY,
 * REPLACE_ME. Worse than an empty field, because they get sent — and the upstream error that
 * follows is confusing. Turn them into a variable named after the parameter, which is what
 * they were standing in for.
 */
const FILLER =
  /^(<[^>]*>|\{[A-Z_]+\}|(YOUR|INSERT|REPLACE|SOME|EXAMPLE)[_\s-]?\w*|UNKNOWN|TODO|N\/A)$/i;

function normaliseFiller(entries, variables) {
  return entries.map((entry) => {
    if (!FILLER.test((entry.value ?? '').trim())) return entry;

    const name = entry.key.replace(/[^\w.-]/g, '') || 'value';
    variables.add(name);
    return { ...entry, value: `{{${name}}}` };
  });
}

function buildAuth(proposed) {
  switch (proposed.authType) {
    case 'bearer':
      return { type: 'bearer', token: '{{apiKey}}' };
    case 'basic':
      return { type: 'basic', username: '{{username}}', password: '{{password}}' };
    case 'apiKey':
      return {
        type: 'apiKey',
        in: proposed.authIn === 'query' ? 'query' : 'header',
        key: proposed.authKey || 'X-API-Key',
        value: '{{apiKey}}',
      };
    default:
      return { type: 'none' };
  }
}

/** A short, human name for what was imported: the docs host, else the first few words. */
function shortName(sourceUrl, summary) {
  const host = sourceUrl && originOf(sourceUrl)?.replace(/^https?:\/\//, '');
  if (host) return host.replace(/^www\./, '');

  if (summary) {
    const firstClause = summary.split(/[.\-–—:]/)[0].trim();
    if (firstClause && firstClause.length <= 60) return firstClause;
    return summary.slice(0, 40).trim() + '…';
  }
  return 'Imported from documentation';
}

/**
 * Replace {{variables}} in a URL with their value, except those that genuinely belong to the
 * environment. Variables left unused afterwards are dropped, so the environment holds only
 * what it should.
 */
function inlineRequestScopedValues(requests, variables) {
  const environmentScoped = (key) => {
    const variable = variables.get(key);
    return key === 'baseUrl' || variable?.secret === true;
  };

  for (const request of requests) {
    request.url = String(request.url ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key) => {
      if (environmentScoped(key)) return match;
      const value = variables.get(key)?.value;
      // Without a value there is nothing to inline; the empty-variable warning covers it.
      return value ? value : match;
    });
  }

  const referenced = new Set();
  for (const request of requests) {
    const text = [
      request.url,
      JSON.stringify(request.params ?? []),
      JSON.stringify(request.headers ?? []),
      JSON.stringify(request.auth ?? {}),
      request.body?.content ?? '',
    ].join(' ');
    for (const [, key] of text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) referenced.add(key);
  }

  for (const key of [...variables.keys()]) {
    if (!referenced.has(key) && !environmentScoped(key)) variables.delete(key);
  }
}

/**
 * Is this parameter plausibly the resource identifier the path already carries?
 *
 * Deliberately narrow. Matching a path segment on its own is not enough: `/posts?status=posts`
 * would qualify, and unticking a real parameter is worse than leaving a redundant one, because
 * the request then quietly returns the wrong data instead of obviously duplicating a value.
 * Both a name that reads like an id and a value shaped like one are required.
 */
function looksLikeIdentifier(param) {
  const named = /(^|[^a-z])id$|^id$/i.test(param.key) || /^[a-z]+Id$/i.test(param.key);
  const valued = /^\d+$/.test(param.value) || /^[0-9a-f-]{16,}$/i.test(param.value);
  return named && valued;
}

function originOf(url) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Split on blank lines so an endpoint's description is not cut in half mid-sentence. */
function chunk(text) {
  if (text.length <= CHUNK_CHARS) return [text];

  const parts = [];
  let current = '';

  for (const paragraph of text.split(/\n{2,}/)) {
    if (current.length + paragraph.length > CHUNK_CHARS && current) {
      parts.push(current);
      current = '';
    }
    current += (current ? '\n\n' : '') + paragraph;
  }
  if (current) parts.push(current);
  return parts;
}

/** Strip HTML down to readable text, so a docs page can be pasted or fetched directly. */
export function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|pre|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const aiSettingsInput = z.object({
  provider: z.enum(['anthropic', 'openai']),
  tier: z.enum(['fast', 'smart']).default('smart'),
  apiKey: z.string().max(500),
});
