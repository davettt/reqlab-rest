/**
 * OpenAPI 3 and Swagger 2 → requests.
 *
 * Fully deterministic: no model is involved, so an imported spec produces exactly what the
 * spec says and nothing invented. This is also what the contract-verification suite will
 * generate its cases from later, so fidelity here matters more than convenience.
 *
 * Servers, security schemes and parameter locations are all honoured; anything the spec
 * leaves ambiguous becomes a {{variable}} for the user to fill in rather than a guess.
 */

import { promoteCredential } from './credentials.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export function isOpenApi(doc) {
  return Boolean(doc && (doc.openapi || doc.swagger));
}

/**
 * @returns {{requests: object[], variables: object[], warnings: string[], info: object}}
 */
export function parseOpenApi(doc) {
  // A Set: a security scheme or body type that cannot be auto-configured produces the same
  // warning on every operation using it, and twenty identical lines tell you nothing extra.
  const warnings = new Set();
  const swagger2 = Boolean(doc.swagger);

  const baseUrl = swagger2 ? swagger2BaseUrl(doc) : openApi3BaseUrl(doc, warnings);
  const variables = [{ key: 'baseUrl', value: baseUrl, enabled: true, secret: false }];

  const securitySchemes = swagger2
    ? (doc.securityDefinitions ?? {})
    : (doc.components?.securitySchemes ?? {});

  // Auth values become secret variables rather than literals on the request: a spec is often
  // committed to a repo, and a token belongs in an environment either way.
  const authVariables = new Map();

  const requests = [];

  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map(
        (p) => resolveRef(doc, p),
      );

      const request = {
        name: operationName(operation, method, path),
        folderId: null,
        method: method.toUpperCase(),
        url: `{{baseUrl}}${templatePath(path, parameters, variables)}`,
        params: [],
        headers: [],
        body: { type: 'none' },
        auth: { type: 'none' },
        assertions: [],
        captures: [],
      };

      for (const parameter of parameters) {
        if (!parameter?.name) continue;
        const placeholder = exampleFor(parameter, swagger2);
        const schema = swagger2 ? parameter : parameter.schema;
        const extra = {
          ...(schema?.enum?.length ? { options: schema.enum.map(String) } : {}),
          ...(parameter.description ? { description: parameter.description.slice(0, 1000) } : {}),
        };

        if (parameter.in === 'query') {
          request.params.push({
            key: parameter.name,
            value: placeholder,
            // Optional parameters are imported but unchecked: seeing what an endpoint
            // supports is useful, sending it by default is not.
            enabled: parameter.required !== false,
            ...extra,
          });
        } else if (parameter.in === 'header') {
          request.headers.push({
            key: parameter.name,
            value: placeholder,
            enabled: parameter.required !== false,
            ...extra,
          });
        } else if (parameter.in === 'body' && swagger2) {
          // Swagger 2 carries the body as a parameter rather than requestBody.
          request.body = {
            type: 'json',
            content: JSON.stringify(sampleFromSchema(doc, parameter.schema), null, 2),
          };
        }
      }

      const body = buildRequestBody(doc, operation, warnings, `${method.toUpperCase()} ${path}`);
      if (body) request.body = body;

      applySecurity({
        doc,
        operation,
        securitySchemes,
        request,
        authVariables,
        warnings,
      });

      // A spec states the success status; asserting it makes an imported request immediately
      // useful as a check rather than just a saved URL.
      //
      // When an operation documents more than one success status, no single code is the right
      // assertion — the API is permitted to answer with any of them, and picking one produces
      // a check that fails on a correct response. A create that documents both 201 and a 200
      // idempotent replay is the common case, and asserting 200 there fails every first call.
      const successCodes = Object.keys(operation.responses ?? {})
        .filter((code) => /^2\d\d$/.test(code))
        .sort();

      if (successCodes.length === 1) {
        request.assertions.push({
          type: 'status',
          target: '',
          operator: 'equals',
          expected: successCodes[0],
          enabled: true,
        });
      } else if (successCodes.length > 1) {
        request.assertions.push({
          type: 'status',
          target: '',
          operator: 'lessThan',
          expected: '300',
          enabled: true,
        });
        warnings.add(
          `${request.method} ${path} documents more than one success status ` +
            `(${successCodes.join(', ')}), so the imported check asserts any 2xx rather than ` +
            'one of them. Narrow it by hand if you want to pin a specific code.',
        );
      }

      // A literal Idempotency-Key taken from the spec's example is a trap: the second send
      // replays the first response instead of doing anything, or is rejected outright if the
      // body changed. The header is standard enough to name specifically.
      const idempotency = request.headers.find(
        (h) => h.key.toLowerCase() === 'idempotency-key' && h.value,
      );
      if (idempotency) {
        warnings.add(
          `${request.method} ${path} takes an Idempotency-Key, imported with the example value ` +
            `"${idempotency.value}". Change it for each genuinely new request — reusing it is ` +
            'how the API is told "this is a retry", so a second send will replay the first ' +
            'response rather than create anything.',
        );
      }

      // Specs frequently document an API key as an ordinary parameter rather than declaring
      // a security scheme. A declared scheme already set auth above, and wins.
      const { promoted } = promoteCredential(request);
      if (promoted) {
        authVariables.set('apiKey', {
          key: 'apiKey',
          value: '',
          enabled: true,
          secret: true,
        });
        warnings.add(
          `Moved ${promoted} to the Auth tab as an API key. Move it back to Params if it is ` +
            'not actually a credential.',
        );
      }

      requests.push(request);
    }
  }

  variables.push(...authVariables.values());

  return {
    requests,
    variables,
    warnings: [...warnings],
    info: {
      title: doc.info?.title ?? 'Imported API',
      version: doc.info?.version ?? '',
      format: swagger2 ? 'Swagger 2' : `OpenAPI ${doc.openapi}`,
    },
  };
}

/* ---------------------------------------------------------------- *
 * Servers and paths
 * ---------------------------------------------------------------- */

function openApi3BaseUrl(doc, warnings) {
  const server = doc.servers?.[0];
  if (!server?.url) {
    warnings.add('The spec declares no servers, so baseUrl is empty — set it before sending.');
    return '';
  }

  // Taking the first server silently is fine until the list happens to be ordered with
  // production first, at which point an import points a test tool at live data without ever
  // saying so. Name the choice and the alternatives and let the reader decide.
  if ((doc.servers?.length ?? 0) > 1) {
    const others = doc.servers
      .slice(1)
      .map((s) => (s.description ? `${s.url} (${s.description})` : s.url))
      .join(', ');

    warnings.add(
      `The spec lists ${doc.servers.length} servers. baseUrl is set to the first, ` +
        `${server.url}${server.description ? ` (${server.description})` : ''}. The others are: ` +
        `${others}. Check baseUrl before sending anything that writes.`,
    );
  }

  // Server templates ({region}.api.example.com) are resolved from their declared default.
  return server.url.replace(/\{(\w+)\}/g, (match, name) => {
    const variable = server.variables?.[name];
    if (variable?.default) return variable.default;
    warnings.add(`Server variable "${name}" has no default; left as a placeholder.`);
    return match;
  });
}

function swagger2BaseUrl(doc) {
  const scheme = doc.schemes?.includes('https') ? 'https' : (doc.schemes?.[0] ?? 'https');
  const host = doc.host ?? '';
  return host ? `${scheme}://${host}${doc.basePath ?? ''}` : (doc.basePath ?? '');
}

/**
 * `/users/{id}` → `/users/{{id}}`, and the path parameter is registered as a variable so the
 * request is runnable rather than containing a literal brace placeholder.
 */
function templatePath(path, parameters, variables) {
  return path.replace(/\{([^}]+)\}/g, (_match, name) => {
    if (!variables.some((v) => v.key === name)) {
      const parameter = parameters.find((p) => p?.name === name && p.in === 'path');
      variables.push({
        key: name,
        value: parameter ? String(exampleFor(parameter, false)) : '',
        enabled: true,
        secret: false,
      });
    }
    return `{{${name}}}`;
  });
}

function operationName(operation, method, path) {
  if (operation.summary) return operation.summary.slice(0, 200);
  if (operation.operationId) return operation.operationId.slice(0, 200);
  return `${method.toUpperCase()} ${path}`;
}

/* ---------------------------------------------------------------- *
 * Bodies
 * ---------------------------------------------------------------- */

function buildRequestBody(doc, operation, warnings, label) {
  const requestBody = resolveRef(doc, operation.requestBody);
  if (!requestBody?.content) return null;

  const types = Object.keys(requestBody.content);
  const json = types.find((t) => t.includes('json'));
  const form = types.find((t) => t.includes('x-www-form-urlencoded'));

  if (json) {
    const schema = requestBody.content[json].schema;
    const declared = requestBody.content[json].example;
    let value = declared ?? sampleFromSchema(doc, schema);

    // A spec's own example is preferred over anything generated — it is written by someone who
    // knows the API. It is not, however, guaranteed to be valid: examples drift from the schema
    // they sit beside. A missing required field would be imported verbatim and rejected on the
    // first send, which reads as a fault in this tool rather than in the document.
    if (declared !== undefined) {
      const missing = [];
      value = fillMissingRequired(doc, schema, value, missing);

      if (missing.length) {
        warnings.add(
          `${label}: the specification's example omits required field` +
            `${missing.length === 1 ? '' : 's'} ${missing.join(', ')}. ` +
            'A placeholder has been filled in from the schema — replace it before sending.',
        );
      }
    }

    describeRequired(doc, schema, warnings, label);

    // Reduce to the required fields.
    //
    // A specification's example demonstrates the endpoint's full range, which is the opposite
    // of what you want in a request you are about to send: it arrives holding illustrative
    // business codes for every optional field, each of which the API then tries to resolve and
    // rejects. A body you add to is easier to work with than one you have to prune, and the
    // fields left out are named below so nothing becomes invisible.
    const omitted = [];
    const minimal = requiredOnly(doc, schema, value, omitted);

    if (omitted.length) {
      warnings.add(
        `${label}: the body holds the required fields only. The specification's example also ` +
          `showed ${omitted.join(', ')} — add any you need.`,
      );
    }

    return { type: 'json', content: JSON.stringify(minimal, null, 2) };
  }

  if (form) {
    const schema = resolveRef(doc, requestBody.content[form].schema) ?? {};
    return {
      type: 'form',
      fields: Object.keys(schema.properties ?? {}).map((key) => ({
        key,
        value: '',
        enabled: true,
        type: 'text',
      })),
    };
  }

  warnings.add(`Body type ${types[0]} is not generated automatically — fill it in by hand.`);
  return null;
}

/**
 * Build a representative example from a schema.
 *
 * Depth-limited and cycle-aware: `$ref` chains in real specs are frequently recursive
 * (a Node with children of type Node), and a naive walk never returns.
 */
function sampleFromSchema(doc, schema, depth = 0, seen = new Set()) {
  const resolved = resolveRef(doc, schema);
  if (!resolved || depth > 6) return null;

  if (resolved.example !== undefined) return resolved.example;
  if (resolved.default !== undefined) return resolved.default;
  if (resolved.enum?.length) return resolved.enum[0];
  // OpenAPI 3.1 is JSON Schema 2020-12, where `const` is a single permitted value. Without
  // this it fell through to the type and produced "string" where only one literal is valid.
  if (resolved.const !== undefined) return resolved.const;

  const composed = resolved.allOf ?? resolved.oneOf ?? resolved.anyOf;
  if (composed?.length) return sampleFromSchema(doc, composed[0], depth + 1, seen);

  switch (resolved.type) {
    case 'object':
    case undefined: {
      if (!resolved.properties) return {};
      const key = JSON.stringify(Object.keys(resolved.properties));
      if (seen.has(key)) return {};
      const nextSeen = new Set(seen).add(key);

      const out = {};
      for (const [name, property] of Object.entries(resolved.properties)) {
        out[name] = sampleFromSchema(doc, property, depth + 1, nextSeen);
      }
      return out;
    }
    case 'array': {
      // A schema permitting no entries must sample as empty. Generating one anyway produced a
      // body the API documents as invalid — a reserved field with maxItems: 0 is the case that
      // exposed this, where the generated entry is rejected outright.
      const max = typeof resolved.maxItems === 'number' ? resolved.maxItems : Infinity;
      if (max <= 0) return [];

      const min = typeof resolved.minItems === 'number' ? resolved.minItems : 0;
      // One entry is enough to show the shape; more only when the schema insists on it.
      const count = Math.min(Math.max(min, 1), max);

      const items = [];
      for (let i = 0; i < count; i += 1) {
        const item = sampleFromSchema(doc, resolved.items, depth + 1, seen);
        if (item !== null) items.push(item);
      }
      return items;
    }
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    default:
      return placeholderForFormat(resolved.format);
  }
}

/**
 * Fill in any required field the example left out, and report which ones those were.
 *
 * Only ever adds: a value the example does supply is never replaced, however odd it looks,
 * because the example's author knows things the schema does not. Recurses through objects the
 * example actually contains and through array entries it actually has — an absent optional
 * array is left absent rather than conjured into existence, since its contents are only
 * required once you choose to send it.
 */
function fillMissingRequired(doc, schema, value, missing, path = '', depth = 0) {
  const resolved = resolveRef(doc, schema);
  if (!resolved || depth > 6) return value;

  if (resolved.type === 'array' || Array.isArray(value)) {
    if (!Array.isArray(value) || !resolved.items) return value;
    return value.map((entry, i) =>
      fillMissingRequired(doc, resolved.items, entry, missing, `${path}[${i}]`, depth + 1),
    );
  }

  if (!isPlainObject(value) || !resolved.properties) return value;

  const out = { ...value };

  for (const name of resolved.required ?? []) {
    const property = resolved.properties[name];
    if (!property || name in out) continue;

    missing.push(path ? `${path}.${name}` : name);
    out[name] = sampleFromSchema(doc, property, depth + 1);
  }

  for (const [name, property] of Object.entries(resolved.properties)) {
    if (!(name in out)) continue;
    out[name] = fillMissingRequired(
      doc,
      property,
      out[name],
      missing,
      path ? `${path}.${name}` : name,
      depth + 1,
    );
  }

  return out;
}

/**
 * Keep only the fields the schema requires, recording the names of those dropped.
 *
 * Values are taken from whatever was already there — the specification's own example where it
 * supplied one — so the result is the example narrowed, not a fresh set of placeholders.
 *
 * A schema that requires nothing is left exactly as it was: reducing it would produce `{}`,
 * which is not a helpful starting point and is very likely invalid for reasons the `required`
 * array does not capture.
 */
function requiredOnly(doc, schema, value, omitted, path = '', depth = 0) {
  const resolved = resolveRef(doc, schema);
  if (!resolved || depth > 6) return value;

  if (Array.isArray(value)) {
    if (!resolved.items) return value;
    return value.map((entry) => requiredOnly(doc, resolved.items, entry, omitted, path, depth + 1));
  }

  if (!isPlainObject(value) || !resolved.properties) return value;

  const required = new Set(resolved.required ?? []);
  if (!required.size) return value;

  const out = {};
  for (const [name, entry] of Object.entries(value)) {
    const full = path ? `${path}.${name}` : name;

    if (!required.has(name)) {
      pushUnique(omitted, full);
      continue;
    }
    out[name] = requiredOnly(doc, resolved.properties[name], entry, omitted, full, depth + 1);
  }
  return out;
}

/**
 * State which fields the body requires, separating the unconditional from the conditional.
 *
 * The distinction is the whole point. A flat list saying `plant` is required is misleading:
 * `plants` is optional, and `plant` only becomes required once you decide to send an entry in
 * it. Reported as a warning rather than dropped, because the schema knows this and the imported
 * JSON body — a flat blob of text — cannot express it.
 */
function describeRequired(doc, schema, warnings, label) {
  const always = [];
  const conditional = new Map();

  walkRequired(doc, schema, { always, conditional, path: '', condition: null, depth: 0 });

  if (always.length) {
    warnings.add(`${label} requires ${always.join(', ')}.`);
  }

  for (const [condition, fields] of conditional) {
    warnings.add(
      `${label}: if you include ${condition}, each entry requires ${fields.join(', ')}.`,
    );
  }
}

function walkRequired(doc, schema, ctx) {
  const resolved = resolveRef(doc, schema);
  if (!resolved?.properties || ctx.depth > 6) return;

  const required = new Set(resolved.required ?? []);

  for (const name of required) {
    const full = ctx.path ? `${ctx.path}.${name}` : name;
    if (ctx.condition) {
      if (!ctx.conditional.has(ctx.condition)) ctx.conditional.set(ctx.condition, []);
      ctx.conditional.get(ctx.condition).push(name);
    } else {
      pushUnique(ctx.always, full);
    }
  }

  for (const [name, property] of Object.entries(resolved.properties)) {
    const child = resolveRef(doc, property);
    if (!child) continue;

    const full = ctx.path ? `${ctx.path}.${name}` : name;

    if (child.type === 'array' && child.items) {
      // Entries in an array are always conditional: sending none is valid unless minItems says
      // otherwise, and an array capped at zero entries can never carry anything at all.
      if (child.maxItems === 0) continue;
      walkRequired(doc, child.items, {
        ...ctx,
        path: `${full}[]`,
        condition: `${full}[]`,
        depth: ctx.depth + 1,
      });
    } else if (child.properties) {
      // A required object keeps its parent's condition; an optional one introduces its own.
      const condition = ctx.condition ?? (required.has(name) ? null : full);
      walkRequired(doc, child, { ...ctx, path: full, condition, depth: ctx.depth + 1 });
    }
  }
}

/** Push without duplicating — the same field can be reached twice through a shared $ref. */
function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function placeholderForFormat(format) {
  switch (format) {
    case 'date-time':
      return new Date().toISOString();
    case 'date':
      return new Date().toISOString().slice(0, 10);
    case 'email':
      return 'user@example.com';
    case 'uuid':
      return '00000000-0000-0000-0000-000000000000';
    case 'uri':
      return 'https://example.com';
    default:
      return 'string';
  }
}

function exampleFor(parameter, swagger2) {
  if (parameter.example !== undefined) return String(parameter.example);
  const schema = swagger2 ? parameter : parameter.schema;
  if (schema?.example !== undefined) return String(schema.example);
  if (schema?.default !== undefined) return String(schema.default);
  if (schema?.enum?.length) return String(schema.enum[0]);
  if (schema?.type === 'integer' || schema?.type === 'number') return '0';
  if (schema?.type === 'boolean') return 'false';
  return '';
}

/* ---------------------------------------------------------------- *
 * Security
 * ---------------------------------------------------------------- */

function applySecurity({ doc, operation, securitySchemes, request, authVariables, warnings }) {
  const requirements = operation.security ?? doc.security ?? [];
  const name = Object.keys(requirements[0] ?? {})[0];
  if (!name) return;

  const scheme = resolveRef(doc, securitySchemes[name]);
  if (!scheme) return;

  const remember = (key) => {
    if (!authVariables.has(key)) {
      authVariables.set(key, { key, value: '', enabled: true, secret: true });
    }
    return `{{${key}}}`;
  };

  const type = (scheme.type ?? '').toLowerCase();

  if (type === 'http' && (scheme.scheme ?? '').toLowerCase() === 'bearer') {
    request.auth = { type: 'bearer', token: remember('bearerToken') };
    return;
  }
  if (type === 'http' && (scheme.scheme ?? '').toLowerCase() === 'basic') {
    request.auth = {
      type: 'basic',
      username: remember('username'),
      password: remember('password'),
    };
    return;
  }
  if (type === 'apikey' || type === 'apiKey') {
    request.auth = {
      type: 'apiKey',
      in: scheme.in === 'query' ? 'query' : 'header',
      key: scheme.name ?? 'X-API-Key',
      value: remember('apiKey'),
    };
    if (scheme.in === 'cookie') {
      warnings.add(
        `${name} is a cookie API key; imported as a header — adjust it on the Auth tab.`,
      );
    }
    return;
  }
  if (type === 'oauth2') {
    const flow = scheme.flows?.clientCredentials ?? scheme.flows?.password;
    request.auth = {
      type: 'oauth2-cc',
      tokenUrl: flow?.tokenUrl ?? scheme.tokenUrl ?? '',
      clientId: remember('clientId'),
      clientSecret: remember('clientSecret'),
      clientAuth: 'header',
    };
    if (!flow && !scheme.tokenUrl) {
      warnings.add(
        `${name} uses an OAuth2 flow with no client-credentials token URL; set it by hand.`,
      );
    }
    return;
  }

  warnings.add(`Security scheme "${name}" (${type}) has no direct equivalent — set auth by hand.`);
}

/* ---------------------------------------------------------------- *
 * $ref
 * ---------------------------------------------------------------- */

/** Local `#/...` refs only; a remote ref would mean fetching arbitrary URLs during import. */
function resolveRef(doc, node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 10) return node;
  if (!node.$ref) return node;
  if (!node.$ref.startsWith('#/')) return null;

  let current = doc;
  for (const segment of node.$ref.slice(2).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current == null || typeof current !== 'object') return null;
    // Own properties only, so a crafted "$ref": "#/__proto__/x" resolves to nothing rather
    // than walking into the prototype chain. Read-only throughout — nothing is assigned.
    if (!Object.hasOwn(current, key)) return null;
    // nosemgrep: prototype-pollution-loop
    current = current[key];
  }
  return resolveRef(doc, current, depth + 1);
}
