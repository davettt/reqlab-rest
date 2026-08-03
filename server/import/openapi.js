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

      const body = buildRequestBody(doc, operation, warnings);
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
      const success = Object.keys(operation.responses ?? {}).find((code) => /^2\d\d$/.test(code));
      if (success) {
        request.assertions.push({
          type: 'status',
          target: '',
          operator: 'equals',
          expected: success,
          enabled: true,
        });
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

function buildRequestBody(doc, operation, warnings) {
  const requestBody = resolveRef(doc, operation.requestBody);
  if (!requestBody?.content) return null;

  const types = Object.keys(requestBody.content);
  const json = types.find((t) => t.includes('json'));
  const form = types.find((t) => t.includes('x-www-form-urlencoded'));

  if (json) {
    const schema = requestBody.content[json].schema;
    const example = requestBody.content[json].example ?? sampleFromSchema(doc, schema);
    return { type: 'json', content: JSON.stringify(example, null, 2) };
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
    case 'array':
      return [sampleFromSchema(doc, resolved.items, depth + 1, seen)].filter((v) => v !== null);
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    default:
      return placeholderForFormat(resolved.format);
  }
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
