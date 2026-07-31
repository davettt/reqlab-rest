/**
 * Auth helpers.
 *
 * Everything here runs server-side after variable resolution, so credentials exist in
 * plaintext only for the duration of the send. Nothing returned from this module is echoed to
 * the client without passing through maskDeep() first.
 */

/**
 * Apply an auth config to a request in place.
 *
 * @param {object} auth      resolved auth config (no {{placeholders}} left)
 * @param {Headers} headers  mutated with any auth headers
 * @param {URL} url          mutated for query-parameter auth
 * @returns {Promise<{warnings: string[]}>}
 */
export async function applyAuth(auth, headers, url) {
  const warnings = [];
  const type = auth?.type ?? 'none';

  switch (type) {
    case 'none':
      break;

    case 'bearer':
      if (auth.token) headers.set('authorization', `Bearer ${auth.token}`);
      break;

    case 'basic': {
      const encoded = Buffer.from(`${auth.username ?? ''}:${auth.password ?? ''}`).toString(
        'base64',
      );
      headers.set('authorization', `Basic ${encoded}`);
      break;
    }

    case 'apiKey': {
      const key = auth.key ?? '';
      const value = auth.value ?? '';
      if (!key) {
        warnings.push('API key auth is selected but no parameter name is set.');
        break;
      }
      if (auth.in === 'query') {
        url.searchParams.set(key, value);
        warnings.push(
          'This request sends its API key in the query string, where it lands in server ' +
            'logs, proxies, and browser history. A header is safer.',
        );
      } else {
        headers.set(key.toLowerCase(), value);
      }
      break;
    }

    case 'oauth2-cc': {
      const token = await clientCredentialsToken(auth, warnings);
      if (token) headers.set('authorization', `${auth.tokenPrefix ?? 'Bearer'} ${token}`);
      break;
    }

    default:
      warnings.push(`Unknown auth type "${type}" — sending the request unauthenticated.`);
  }

  return { warnings };
}

/* ---------------------------------------------------------------- *
 * OAuth2 client credentials
 * ---------------------------------------------------------------- */

/** In-memory only: tokens are short-lived and must not outlive the process. */
const tokenCache = new Map();

const EXPIRY_SKEW_MS = 30_000;

function cacheKey(auth) {
  return [auth.tokenUrl, auth.clientId, auth.scope ?? '', auth.audience ?? ''].join('|');
}

async function clientCredentialsToken(auth, warnings) {
  if (!auth.tokenUrl || !auth.clientId) {
    warnings.push('OAuth2 client credentials needs both a token URL and a client ID.');
    return null;
  }

  const key = cacheKey(auth);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached.token;

  const params = new URLSearchParams({ grant_type: 'client_credentials' });
  if (auth.scope) params.set('scope', auth.scope);
  if (auth.audience) params.set('audience', auth.audience);

  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (auth.clientAuth === 'body') {
    params.set('client_id', auth.clientId);
    params.set('client_secret', auth.clientSecret ?? '');
  } else {
    const basic = Buffer.from(`${auth.clientId}:${auth.clientSecret ?? ''}`).toString('base64');
    headers.authorization = `Basic ${basic}`;
  }

  let res;
  try {
    res = await fetch(auth.tokenUrl, {
      method: 'POST',
      headers,
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    warnings.push(`Could not reach the token endpoint: ${err.message}`);
    return null;
  }

  const text = await res.text();
  if (!res.ok) {
    // The token endpoint's own error body is the most useful thing to surface here.
    warnings.push(`Token request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    warnings.push('The token endpoint did not return JSON.');
    return null;
  }

  const token = payload.access_token;
  if (!token) {
    warnings.push('The token response contained no access_token.');
    return null;
  }

  const expiresInMs = Number(payload.expires_in ?? 3600) * 1000;
  tokenCache.set(key, { token, expiresAt: Date.now() + expiresInMs });
  return token;
}

/** Drop cached tokens — used when auth settings change or the user forces a re-auth. */
export function clearTokenCache() {
  tokenCache.clear();
}
