export const MASK = '••••';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export const METHODS: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export type BodyType =
  'none' | 'json' | 'text' | 'xml' | 'form' | 'multipart' | 'graphql' | 'binary';

export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
  /** Documented accepted values — rendered as a dropdown rather than a free-text box. */
  options?: string[];
  description?: string;
}

export interface Variable extends KeyValue {
  secret: boolean;
  /**
   * Server-assigned, and the reason renaming a secret no longer loses it: the server matches
   * on this rather than on the key. Absent on a row that has not been saved yet.
   */
  id?: string;
}

export interface RequestBody {
  type: BodyType;
  content?: string;
  query?: string;
  variables?: string;
  fields?: (KeyValue & { type?: 'text' | 'file'; filename?: string })[];
}

export type Auth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKey'; in: 'header' | 'query'; key: string; value: string }
  | {
      type: 'oauth2-cc';
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      scope?: string;
      audience?: string;
      clientAuth: 'header' | 'body';
    };

export interface Assertion {
  type: 'status' | 'header' | 'jsonPath' | 'responseTime' | 'bodyContains';
  target: string;
  operator: 'equals' | 'notEquals' | 'contains' | 'lessThan' | 'greaterThan' | 'exists';
  expected: string;
  enabled: boolean;
}

export interface AssertionResult extends Assertion {
  actual: unknown;
  passed: boolean;
  summary: string;
}

export interface Capture {
  name: string;
  from: 'body' | 'header' | 'status';
  path: string;
  secret: boolean;
}

export interface CaptureResult {
  name: string;
  found: boolean;
  value: string | null;
}

export interface ApiRequest {
  id: string;
  name: string;
  folderId: string | null;
  method: Method;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  body: RequestBody;
  auth: Auth;
  assertions: Assertion[];
  captures: Capture[];
  updatedAt?: string;
}

export interface Environment {
  id: string;
  name: string;
  variables: Variable[];
}

export interface Project {
  id: string;
  name: string;
  description: string;
  variables: Variable[];
  updatedAt?: string;
}

export interface Timing {
  dnsMs: number | null;
  connectMs: number | null;
  ttfbMs: number | null;
  downloadMs: number | null;
  totalMs: number;
}

export interface RunResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  cookies: {
    name: string;
    value: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: string;
  }[];
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  sizeBytes: number;
  truncated: boolean;
}

export interface RunResult {
  startedAt: number;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: { type: string; text: string };
  };
  finalRequest?: { method: string; url: string; headers: Record<string, string> };
  response: RunResponse;
  redirects: { from: string; to: string; status: number; method: string }[];
  timing: Timing;
  warnings: string[];
  assertions: AssertionResult[];
  captures: CaptureResult[];
  passed: boolean;
  /** Present instead of the above when the request could not be sent at all. */
  failed?: boolean;
  error?: string;
}

export interface ImportPreview {
  source: string;
  info: { title: string; version: string; format: string; description?: string };
  warnings: string[];
  redirects: string[];
  variables: Variable[];
  requests: ApiRequest[];
  summary: { requests: number; variables: number; secrets: number };
}

export interface ImportFailure {
  error: string;
  unstructured?: boolean;
  needsKey?: boolean;
}

export interface VerifyFinding {
  suite: string;
  severity: 'blocker' | 'major' | 'minor' | 'info';
  title: string;
  whatHappened: string;
  whyItMatters: string;
  expected: unknown;
  actual: unknown;
  endpoint: string | null;
}

export interface VerifySummary {
  total: number;
  blocker: number;
  major: number;
  minor: number;
  info: number;
  passed: boolean;
}

export interface LatencyStats {
  samples: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Present only when the latency suite ran — it is the one suite producing more than findings. */
export interface LatencyResult {
  measurements: Record<string, LatencyStats>;
  comparedAgainst: number | null;
}

export interface VerifyRun {
  id: string;
  target: string;
  startedAt: number;
  finishedAt: number;
  suites: string[];
  skipped: { suite: string; reason: string }[];
  latency: LatencyResult | null;
  findings: VerifyFinding[];
  summary: VerifySummary;
}

export interface ScenarioStep {
  requestId: string;
  name?: string;
}

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  steps: ScenarioStep[];
}

export interface ScenarioStepResult {
  position: number;
  name: string;
  requestId: string;
  method?: string;
  url?: string;
  status: number | null;
  timingMs: number | null;
  body?: string;
  assertions?: AssertionResult[];
  captured?: string[];
  error?: string;
  outcome: 'passed' | 'failed' | 'error' | 'missing' | 'not-run';
}

export interface ScenarioRun {
  id: string;
  scenarioId: string;
  name: string;
  startedAt: number;
  finishedAt: number;
  steps: ScenarioStepResult[];
  passed: boolean;
  findings: VerifyFinding[];
}

export interface AiSettings {
  provider: 'anthropic' | 'openai';
  tier: 'fast' | 'smart';
  configured: { anthropic: boolean; openai: boolean };
  models: Record<'anthropic' | 'openai', { fast: string; smart: string }>;
  providers: string[];
}

export function emptyRequest(): Omit<ApiRequest, 'id'> {
  return {
    name: 'Untitled request',
    folderId: null,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    assertions: [],
    captures: [],
  };
}

export function statusTone(status: number): string {
  if (status >= 500) return 'text-rose-400';
  if (status >= 400) return 'text-amber-400';
  if (status >= 300) return 'text-sky-400';
  if (status >= 200) return 'text-emerald-400';
  return 'text-slate-400';
}

export function methodTone(method: string): string {
  switch (method) {
    case 'GET':
      return 'text-emerald-400';
    case 'POST':
      return 'text-sky-400';
    case 'PUT':
    case 'PATCH':
      return 'text-amber-400';
    case 'DELETE':
      return 'text-rose-400';
    default:
      return 'text-slate-400';
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Indent XML for display. Deliberately a small formatter rather than a parser dependency:
 * responses are shown, not manipulated, and a malformed document must still render as
 * something readable rather than throwing.
 */
export function formatXml(input: string): string {
  const tokens = input
    .replace(/\r?\n/g, '')
    .replace(/>\s+</g, '><')
    .split(/(<[^>]+>)/)
    .filter((token) => token.trim().length > 0);

  const lines: string[] = [];
  let depth = 0;

  for (const token of tokens) {
    const isTag = token.startsWith('<');
    const isClosing = token.startsWith('</');
    const isSelfContained =
      token.endsWith('/>') || token.startsWith('<?') || token.startsWith('<!');

    if (!isTag) {
      // Text content stays on the line of the tag that opened it.
      lines[lines.length - 1] = (lines[lines.length - 1] ?? '') + token;
      continue;
    }

    if (isClosing) {
      depth = Math.max(0, depth - 1);
      const previous = lines[lines.length - 1] ?? '';
      // A closing tag directly after text belongs on the same line: <name>value</name>.
      if (previous && !previous.trimEnd().endsWith('>')) {
        lines[lines.length - 1] = previous + token;
        continue;
      }
      lines.push('  '.repeat(depth) + token);
      continue;
    }

    lines.push('  '.repeat(depth) + token);
    if (!isSelfContained) depth += 1;
  }

  return lines.join('\n');
}

export function looksLikeXml(contentType: string | undefined, body: string): boolean {
  if (contentType && /xml/i.test(contentType)) return true;
  return body.trimStart().startsWith('<?xml') || /^<[a-zA-Z]/.test(body.trimStart());
}
