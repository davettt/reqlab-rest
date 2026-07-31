/**
 * Request body construction.
 *
 * Each body type returns the payload plus the Content-Type it implies. An explicit
 * Content-Type header the user set always wins — overriding it would make it impossible to
 * test how an API behaves when the declared type is deliberately wrong, which is exactly what
 * the negative-testing suite needs to do.
 */

export const BODY_TYPES = ['none', 'json', 'text', 'xml', 'form', 'multipart', 'graphql', 'binary'];

/**
 * @param {{type: string, content?: string, fields?: Array<{key:string,value:string,type?:string,filename?:string}>, query?: string, variables?: string}} body
 * @returns {{payload: any, contentType: string|null, warnings: string[]}}
 */
export function buildBody(body) {
  const type = body?.type ?? 'none';
  const warnings = [];

  switch (type) {
    case 'none':
      return { payload: undefined, contentType: null, warnings };

    case 'json': {
      const raw = body.content ?? '';
      if (raw.trim()) {
        try {
          JSON.parse(raw);
        } catch (err) {
          // Sent as-is. Malformed JSON is a legitimate test case, so this is a warning and
          // never a hard failure — the user needs to see what the server does with it.
          warnings.push(`Body is not valid JSON: ${err.message}`);
        }
      }
      return { payload: raw, contentType: 'application/json', warnings };
    }

    case 'text':
      return { payload: body.content ?? '', contentType: 'text/plain', warnings };

    case 'xml':
      return { payload: body.content ?? '', contentType: 'application/xml', warnings };

    case 'form': {
      const params = new URLSearchParams();
      for (const field of body.fields ?? []) {
        if (!field.key || field.enabled === false) continue;
        params.append(field.key, field.value ?? '');
      }
      return {
        payload: params.toString(),
        contentType: 'application/x-www-form-urlencoded',
        warnings,
      };
    }

    case 'multipart': {
      const form = new FormData();
      for (const field of body.fields ?? []) {
        if (!field.key || field.enabled === false) continue;
        if (field.type === 'file') {
          const bytes = Buffer.from(field.value ?? '', 'base64');
          form.append(field.key, new Blob([bytes]), field.filename ?? 'upload.bin');
        } else {
          form.append(field.key, field.value ?? '');
        }
      }
      // Left null on purpose: fetch must set the multipart boundary itself.
      return { payload: form, contentType: null, warnings };
    }

    case 'graphql': {
      const payload = JSON.stringify({
        query: body.query ?? '',
        variables: parseGraphqlVariables(body.variables, warnings),
      });
      return { payload, contentType: 'application/json', warnings };
    }

    case 'binary':
      return {
        payload: Buffer.from(body.content ?? '', 'base64'),
        contentType: 'application/octet-stream',
        warnings,
      };

    default:
      warnings.push(`Unknown body type "${type}" — sending no body.`);
      return { payload: undefined, contentType: null, warnings };
  }
}

function parseGraphqlVariables(raw, warnings) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    warnings.push(`GraphQL variables are not valid JSON: ${err.message}`);
    return {};
  }
}

/** Content types whose bodies are safe to show as text rather than base64. */
const TEXTUAL = [
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-www-form-urlencoded',
  'application/graphql',
  'application/ld+json',
  'application/problem+json',
];

export function isTextualContentType(contentType) {
  if (!contentType) return true; // no type declared — assume text and let the UI show it
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type.startsWith('text/')) return true;
  if (type.endsWith('+json') || type.endsWith('+xml')) return true;
  return TEXTUAL.includes(type);
}
