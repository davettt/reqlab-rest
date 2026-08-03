/**
 * Import parser tests. Run: npm run test:import
 *
 * The specs here are small but deliberately awkward: a recursive $ref, a templated server,
 * a path parameter, and credentials embedded in an export. Those are the cases that turn a
 * parser from "works on the example file" into one that survives real documents.
 */
import { test, assert, assertEqual, summarise } from './util.js';
import { parseDocument, looksUnstructured, ImportError } from '../server/import/index.js';

console.log('import: reqlab-rest');

/* ---------------------------------------------------------------- *
 * OpenAPI 3
 * ---------------------------------------------------------------- */

const openapi = {
  openapi: '3.0.3',
  info: { title: 'Payments API', version: '2.1.0' },
  servers: [
    {
      url: 'https://{region}.api.example.com/v2',
      variables: { region: { default: 'eu' } },
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
    schemas: {
      // Recursive on purpose: a naive sample builder never terminates on this.
      Node: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          child: { $ref: '#/components/schemas/Node' },
        },
      },
      Payment: {
        type: 'object',
        properties: {
          amount: { type: 'integer' },
          currency: { type: 'string', enum: ['GBP', 'USD'] },
          createdAt: { type: 'string', format: 'date-time' },
          tree: { $ref: '#/components/schemas/Node' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/payments': {
      get: {
        summary: 'List payments',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 25 } },
          { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'ok' } },
      },
      post: {
        operationId: 'createPayment',
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Payment' } },
          },
        },
        responses: { 201: { description: 'created' } },
      },
    },
    '/payments/{paymentId}': {
      get: {
        summary: 'Get a payment',
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } },
      },
    },
  },
};

const oas = parseDocument(JSON.stringify(openapi));

await test('openapi: every operation becomes a request', () => {
  assertEqual(oas.source, 'openapi', 'detected');
  assertEqual(oas.requests.length, 3, 'GET/POST /payments and GET /payments/{id}');
  assertEqual(oas.info.title, 'Payments API', 'title');
});

await test('openapi: templated server resolves from its default', () => {
  const baseUrl = oas.variables.find((v) => v.key === 'baseUrl');
  assertEqual(baseUrl.value, 'https://eu.api.example.com/v2', '{region} replaced');
});

await test('openapi: path parameters become variables, not literal braces', () => {
  const byId = oas.requests.find((r) => r.url.includes('paymentId'));
  assertEqual(byId.url, '{{baseUrl}}/payments/{{paymentId}}', 'templated');
  assert(
    oas.variables.some((v) => v.key === 'paymentId'),
    'and registered as a variable',
  );
});

await test('openapi: query and header parameters land in the right place', () => {
  const list = oas.requests.find((r) => r.name === 'List payments');
  assertEqual(list.params[0].key, 'limit', 'query param');
  assertEqual(list.params[0].value, '25', 'default used as the example');
  assertEqual(list.headers[0].key, 'X-Trace', 'header param');
});

await test('openapi: a recursive $ref terminates and still produces a body', () => {
  const create = oas.requests.find((r) => r.method === 'POST');
  const body = JSON.parse(create.body.content);
  assertEqual(body.currency, 'GBP', 'enum first value');
  assertEqual(body.amount, 0, 'integer sample');
  assert(typeof body.tree === 'object', 'recursive branch produced an object, not a hang');
});

await test('openapi: optional parameters import unchecked, with their accepted values', () => {
  const parsed = parseDocument(
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Options', version: '1' },
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/report': {
          get: {
            summary: 'Report',
            parameters: [
              { name: 'domainName', in: 'query', required: true, schema: { type: 'string' } },
              {
                name: 'outputFormat',
                in: 'query',
                required: false,
                description: 'Response output format.',
                schema: { type: 'string', enum: ['JSON', 'XML'], default: 'JSON' },
              },
            ],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    }),
  );

  const report = parsed.requests[0];
  const required = report.params.find((p) => p.key === 'domainName');
  const optional = report.params.find((p) => p.key === 'outputFormat');

  assertEqual(required.enabled, true, 'required parameters are active');
  // Imported so the user can see the endpoint supports it, but not sent by default.
  assertEqual(optional.enabled, false, 'optional parameters import unchecked');
  assertEqual(optional.value, 'JSON', 'the documented default is used');
  assertEqual(optional.options.join('|'), 'JSON|XML', 'accepted values are carried through');
  assert(optional.description.includes('output format'), 'description carried through');
});

await test('openapi: security becomes auth plus a secret variable, never a literal', () => {
  const list = oas.requests.find((r) => r.name === 'List payments');
  assertEqual(list.auth.type, 'bearer', 'bearer auth');
  assertEqual(list.auth.token, '{{bearerToken}}', 'references a variable');

  const token = oas.variables.find((v) => v.key === 'bearerToken');
  assertEqual(token.secret, true, 'marked secret');
  assertEqual(token.value, '', 'and empty — a spec never carries a real credential');
});

await test('openapi: the documented success status becomes an assertion', () => {
  const create = oas.requests.find((r) => r.method === 'POST');
  assertEqual(create.assertions[0].expected, '201', 'asserts what the spec promises');
});

await test('openapi: YAML parses identically to JSON', () => {
  const yamlSpec = `
openapi: 3.0.0
info:
  title: Tiny
  version: "1.0"
servers:
  - url: https://api.example.com
paths:
  /ping:
    get:
      summary: Ping
      responses:
        "200":
          description: ok
`;
  const parsed = parseDocument(yamlSpec);
  assertEqual(parsed.requests.length, 1, 'one request');
  assertEqual(parsed.requests[0].url, '{{baseUrl}}/ping', 'url');
});

await test('openapi: a spec with no servers warns rather than inventing a host', () => {
  const parsed = parseDocument(
    JSON.stringify({ openapi: '3.0.0', info: { title: 'x' }, paths: {} }),
  );
  assert(
    parsed.warnings.some((w) => w.includes('no servers')),
    'should warn',
  );
});

/* ---------------------------------------------------------------- *
 * Swagger 2
 * ---------------------------------------------------------------- */

await test('swagger 2: host, basePath and body parameter are handled', () => {
  const parsed = parseDocument(
    JSON.stringify({
      swagger: '2.0',
      info: { title: 'Legacy', version: '1' },
      host: 'legacy.example.com',
      basePath: '/api',
      schemes: ['https'],
      securityDefinitions: { key: { type: 'apiKey', name: 'X-Key', in: 'header' } },
      security: [{ key: [] }],
      paths: {
        '/things': {
          post: {
            summary: 'Create thing',
            parameters: [
              {
                name: 'body',
                in: 'body',
                schema: { type: 'object', properties: { n: { type: 'string' } } },
              },
            ],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    }),
  );

  assertEqual(parsed.info.format, 'Swagger 2', 'format');
  assertEqual(
    parsed.variables.find((v) => v.key === 'baseUrl').value,
    'https://legacy.example.com/api',
  );

  const create = parsed.requests[0];
  assertEqual(create.body.type, 'json', 'body parameter became a JSON body');
  assertEqual(create.auth.type, 'apiKey', 'api key auth');
  assertEqual(create.auth.key, 'X-Key', 'header name from the spec');
});

/* ---------------------------------------------------------------- *
 * Postman
 * ---------------------------------------------------------------- */

await test('postman: folders, bodies and query params import', () => {
  const parsed = parseDocument(
    JSON.stringify({
      info: {
        name: 'Team collection',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      variable: [{ key: 'baseUrl', value: 'https://api.example.com' }],
      item: [
        {
          name: 'Users',
          item: [
            {
              name: 'Create user',
              request: {
                method: 'POST',
                url: {
                  raw: 'https://api.example.com/users?notify=true',
                  query: [{ key: 'notify', value: 'true' }],
                },
                header: [{ key: 'Content-Type', value: 'application/json' }],
                body: {
                  mode: 'raw',
                  raw: '{"name":"Ada"}',
                  options: { raw: { language: 'json' } },
                },
              },
            },
          ],
        },
      ],
    }),
  );

  assertEqual(parsed.source, 'postman', 'detected');
  const create = parsed.requests[0];
  assertEqual(create.name, 'Users / Create user', 'folder path in the name');
  assertEqual(create.method, 'POST', 'method');
  assertEqual(create.params[0].key, 'notify', 'query param');
  assertEqual(create.body.type, 'json', 'json body');
});

await test('postman: an exported credential is replaced by a variable, not saved', () => {
  const parsed = parseDocument(
    JSON.stringify({
      info: {
        name: 'c',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'Secured',
          request: {
            method: 'GET',
            url: { raw: 'https://api.example.com/me' },
            header: [{ key: 'Authorization', value: 'Bearer real-live-token-from-their-export' }],
          },
        },
      ],
    }),
  );

  const serialised = JSON.stringify(parsed);
  assert(
    !serialised.includes('real-live-token-from-their-export'),
    "someone else's live token must never be imported into your project",
  );
  assertEqual(parsed.requests[0].auth.type, 'bearer', 'recognised as bearer auth');
  assertEqual(parsed.requests[0].auth.token, '{{bearerToken}}', 'references a variable instead');
});

/* ---------------------------------------------------------------- *
 * HAR
 * ---------------------------------------------------------------- */

await test('har: repeated calls collapse to one request per endpoint', () => {
  const entry = (url, method = 'GET') => ({
    request: {
      method,
      url,
      headers: [{ name: 'Accept', value: 'application/json' }],
      queryString: [],
    },
  });

  const parsed = parseDocument(
    JSON.stringify({
      log: {
        entries: [
          entry('https://api.example.com/feed'),
          entry('https://api.example.com/feed'),
          entry('https://api.example.com/feed'),
          entry('https://api.example.com/profile'),
        ],
      },
    }),
  );

  assertEqual(parsed.source, 'har', 'detected');
  assertEqual(parsed.requests.length, 2, 'deduplicated by method + path');
  assertEqual(parsed.variables.find((v) => v.key === 'baseUrl').value, 'https://api.example.com');
});

await test('har: browser-managed headers are dropped', () => {
  const parsed = parseDocument(
    JSON.stringify({
      log: {
        entries: [
          {
            request: {
              method: 'GET',
              url: 'https://api.example.com/x',
              queryString: [],
              headers: [
                { name: ':authority', value: 'api.example.com' },
                { name: 'Host', value: 'api.example.com' },
                { name: 'Content-Length', value: '0' },
                { name: 'Accept', value: 'application/json' },
              ],
            },
          },
        ],
      },
    }),
  );

  const names = parsed.requests[0].headers.map((h) => h.key.toLowerCase());
  assertEqual(names.length, 1, 'only the meaningful header survives');
  assertEqual(names[0], 'accept', 'accept kept');
});

/* ---------------------------------------------------------------- *
 * Rejection
 * ---------------------------------------------------------------- */

await test('unstructured prose is refused, and identified as such', () => {
  const prose = 'To authenticate, send your API key in the Authorization header as a bearer token.';
  assertEqual(looksUnstructured(prose), true, 'detected as prose');

  let err = null;
  try {
    parseDocument(prose);
  } catch (e) {
    err = e;
  }
  assert(err instanceof ImportError, 'typed error');
  assert(err.message.includes('AI import'), 'points at the right tool');
});

await test('openapi: a crafted $ref cannot walk the prototype chain', () => {
  const parsed = parseDocument(
    JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Hostile', version: '1' },
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/x': {
          post: {
            summary: 'Crafted',
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/__proto__/polluted' } } },
            },
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    }),
  );

  // The ref resolves to nothing, so no body is generated — and crucially nothing is added
  // to Object.prototype along the way.
  assertEqual({}.polluted, undefined, 'Object.prototype must be untouched');
  assertEqual(parsed.requests.length, 1, 'the operation still imports');
});

await test('a valid JSON document that is not a known format is refused clearly', () => {
  let message = '';
  try {
    parseDocument('{"hello":"world"}');
  } catch (e) {
    message = e.message;
  }
  assert(message.includes('not a format this recognises'), `unexpected: ${message}`);
});

await test('empty input is refused', () => {
  let threw = false;
  try {
    parseDocument('   ');
  } catch {
    threw = true;
  }
  assert(threw, 'should refuse');
});

summarise('import');
