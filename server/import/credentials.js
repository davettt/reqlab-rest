/**
 * Recognising a credential that arrived as an ordinary parameter or header.
 *
 * Imports routinely describe an API key as just another query parameter, because that is how
 * the documentation presents it. Leaving it there works, but the Auth tab is the better home:
 * it is where the query-string exposure warning lives, it keeps the credential out of a list
 * that gets copied around, and it states the intent.
 *
 * The matching is deliberately conservative. A false positive moves a real parameter into the
 * auth slot and quietly changes what the request sends, which is worse than leaving an API key
 * in the params list where the user can see it. Anything promoted is reported, so it can be
 * undone.
 */

/** Names that are a credential in effectively every API that uses them. */
const CREDENTIAL_NAMES = new Set([
  'apikey',
  'api_key',
  'api-key',
  'x-api-key',
  'apisecret',
  'api_secret',
  'access_token',
  'accesstoken',
  'auth_token',
  'authtoken',
  'authorization',
  'subscription-key',
  'subscription_key',
  'ocp-apim-subscription-key',
  'private_key',
  'app_key',
  'appkey',
  'secret_key',
  'token',
]);

/**
 * Names that contain a credential word but are not credentials. Pagination in particular is
 * full of tokens, and moving a page cursor into the auth slot would break the request in a
 * way that is hard to spot.
 */
const NOT_CREDENTIALS = /(page|next|prev|cursor|continuation|sync|csrf|xsrf|idempotency)/i;

export function isCredentialName(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase().trim();
  if (NOT_CREDENTIALS.test(lower)) return false;
  return CREDENTIAL_NAMES.has(lower);
}

/**
 * Move a credential-looking parameter or header into the request's auth config.
 *
 * Only acts when auth is not already configured — an explicit security scheme from a spec
 * always wins over a guess made from a parameter name.
 *
 * @returns {{promoted: string|null}} the name that was moved, for reporting
 */
export function promoteCredential(request, { variableName = 'apiKey' } = {}) {
  if (request.auth && request.auth.type !== 'none') {
    // Auth is already configured — but an import often lists the same credential a second
    // time as an ordinary parameter, because that is how the docs present it. Sending it
    // twice is at best redundant and at worst sends an empty value alongside the real one.
    return { promoted: null, deduped: dedupeAgainstAuth(request) };
  }

  const fromParams = (request.params ?? []).findIndex((p) => isCredentialName(p.key));
  if (fromParams !== -1) {
    const [param] = request.params.splice(fromParams, 1);
    request.auth = {
      type: 'apiKey',
      in: 'query',
      key: param.key,
      // Keep whatever reference the import already produced, so a {{variable}} is not
      // replaced by a different one.
      value: /\{\{.+\}\}/.test(param.value ?? '') ? param.value : `{{${variableName}}}`,
    };
    return { promoted: param.key };
  }

  const fromHeaders = (request.headers ?? []).findIndex((h) => isCredentialName(h.key));
  if (fromHeaders !== -1) {
    const [header] = request.headers.splice(fromHeaders, 1);
    const isBearer = /^bearer\s/i.test(header.value ?? '');

    request.auth = isBearer
      ? { type: 'bearer', token: `{{${variableName}}}` }
      : {
          type: 'apiKey',
          in: 'header',
          key: header.key,
          value: /\{\{.+\}\}/.test(header.value ?? '') ? header.value : `{{${variableName}}}`,
        };
    return { promoted: header.key };
  }

  return { promoted: null };
}

/** Drop a parameter or header that duplicates the already-configured auth credential. */
function dedupeAgainstAuth(request) {
  const auth = request.auth;
  const names = new Set();

  if (auth.type === 'apiKey' && auth.key) names.add(auth.key.toLowerCase());
  if (auth.type === 'bearer' || auth.type === 'basic') names.add('authorization');
  if (!names.size) return null;

  const removed = [];

  const strip = (list) => {
    if (!list) return list;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (names.has((list[i].key ?? '').toLowerCase())) {
        removed.push(list[i].key);
        list.splice(i, 1);
      }
    }
    return list;
  };

  strip(request.params);
  strip(request.headers);

  return removed.length ? removed : null;
}
