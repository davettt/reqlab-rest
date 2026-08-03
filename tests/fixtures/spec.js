/**
 * An OpenAPI spec for the fixture API.
 *
 * It describes what a *correct* implementation would do. The fixture's /good endpoints comply;
 * the /broken ones deliberately do not. That difference is the ground truth: the contract
 * suite must flag every /broken endpoint and leave every /good one alone.
 *
 * Testing only that a suite finds problems is half a test. A suite that flagged everything
 * would pass that half while being useless.
 */
export const fixtureSpec = {
  openapi: '3.0.3',
  info: { title: 'Fixture API', version: '1.0.0' },
  servers: [{ url: '{{baseUrl}}' }],
  components: {
    schemas: {
      Widget: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
      },
      Item: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
        },
      },
      ItemPage: {
        type: 'object',
        required: ['total', 'page', 'data'],
        properties: {
          total: { type: 'integer' },
          page: { type: 'integer' },
          limit: { type: 'integer' },
          data: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
        },
      },
      Document: {
        type: 'object',
        required: ['body'],
        properties: { body: { type: 'string' } },
      },
      Error: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string' } },
      },
    },
  },
  paths: {
    /* ---- correct twins ---- */
    '/good/widgets': {
      post: {
        summary: 'Create a widget',
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Widget' } },
          },
        },
        responses: {
          201: {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
          },
        },
      },
    },
    '/good/items': {
      get: {
        summary: 'List items',
        responses: {
          200: {
            description: 'A page of items',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ItemPage' } } },
          },
        },
      },
    },
    '/good/document': {
      get: {
        summary: 'Get the document',
        responses: {
          200: {
            description: 'The document',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Document' } } },
          },
        },
      },
    },
    '/good/validate': {
      post: {
        summary: 'Validate input',
        responses: {
          200: { description: 'Valid' },
          400: {
            description: 'Invalid input',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },

    /* ---- deliberately broken ---- */
    '/broken/widgets': {
      post: {
        summary: 'Create a widget (broken: returns 200, omits Location)',
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Widget' } },
          },
        },
        responses: {
          201: {
            description: 'Created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
          },
        },
      },
    },
    '/broken/validate': {
      post: {
        summary: 'Validate input (broken: 500 instead of 400)',
        responses: {
          200: { description: 'Valid' },
          400: {
            description: 'Invalid input',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
    '/broken/document-extra': {
      get: {
        summary: 'Get the document (broken: returns an undocumented field)',
        responses: {
          200: {
            description: 'The document',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Document' } } },
          },
        },
      },
    },
    '/broken/document': {
      get: {
        summary: 'Get the document (broken: no ETag)',
        responses: {
          200: {
            description: 'The document',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Document' } } },
          },
        },
      },
    },
  },
};

/** Requests matching the spec, shaped as the importer would produce them. */
export function fixtureRequests() {
  return [
    request('POST', '/good/widgets', { name: 'ok' }),
    request('GET', '/good/items'),
    request('GET', '/good/document'),
    request('POST', '/good/validate', { name: 'ok' }),

    request('POST', '/broken/widgets', { name: 'bad' }),
    // Sends a wrong-typed field on purpose: the endpoint answers 500 where the spec says 400.
    request('POST', '/broken/validate', { name: 123 }),
    request('GET', '/broken/document'),
    request('GET', '/broken/document-extra'),
  ];
}

function request(method, path, body) {
  return {
    name: `${method} ${path}`,
    folderId: null,
    method,
    url: `{{baseUrl}}${path}`,
    params: [],
    headers: [],
    body: body ? { type: 'json', content: JSON.stringify(body) } : { type: 'none' },
    auth: { type: 'none' },
    assertions: [],
    captures: [],
  };
}
