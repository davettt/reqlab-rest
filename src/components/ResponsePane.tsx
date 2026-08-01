import { useState } from 'react';
import { useStore } from '../stores/appStore';
import {
  formatBytes,
  formatMs,
  formatXml,
  looksLikeXml,
  statusTone,
  type RunResult,
} from '../types';

const TABS = ['Body', 'Headers', 'Request', 'Cookies', 'Timing', 'Checks'] as const;
type Tab = (typeof TABS)[number];

export default function ResponsePane() {
  const { result, running } = useStore();
  const [tab, setTab] = useState<Tab>('Body');

  if (running) {
    return <Centered>Sending…</Centered>;
  }
  if (!result) {
    return <Centered>Send a request to see the response.</Centered>;
  }
  if (result.failed) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm font-medium text-rose-400">The request could not be sent</p>
        <p className="max-w-md text-sm text-slate-400">{result.error}</p>
      </div>
    );
  }

  const failedChecks = result.assertions.filter((a) => !a.passed).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-3 py-2 text-sm">
        <span className={`font-semibold ${statusTone(result.response.status)}`}>
          {result.response.status} {result.response.statusText}
        </span>
        <span className="text-slate-400">{formatMs(result.timing.totalMs)}</span>
        <span className="text-slate-400">{formatBytes(result.response.sizeBytes)}</span>
        {result.assertions.length > 0 && (
          <span className={failedChecks ? 'text-rose-400' : 'text-emerald-400'}>
            {failedChecks
              ? `${failedChecks} check${failedChecks > 1 ? 's' : ''} failed`
              : 'checks passed'}
          </span>
        )}
        {result.response.truncated && (
          <span className="text-amber-400">truncated at the size cap</span>
        )}
      </div>

      {result.warnings.length > 0 && (
        <ul className="border-b border-slate-800 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          {result.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      <div className="flex gap-1 border-b border-slate-800 px-3">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`border-b-2 px-3 py-2 text-xs ${
              tab === t
                ? 'border-sky-500 text-slate-100'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === 'Body' && <BodyView result={result} />}
        {tab === 'Headers' && <Table rows={Object.entries(result.response.headers)} />}
        {tab === 'Request' && <RequestView result={result} />}
        {tab === 'Cookies' && <CookieView result={result} />}
        {tab === 'Timing' && <TimingView result={result} />}
        {tab === 'Checks' && <ChecksView result={result} />}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-slate-500">{children}</div>
  );
}

function BodyView({ result }: { result: RunResult }) {
  const [raw, setRaw] = useState(false);

  if (result.response.bodyEncoding === 'base64') {
    return (
      <p className="text-sm text-slate-400">
        Binary response ({formatBytes(result.response.sizeBytes)}), not shown as text.
      </p>
    );
  }

  const contentType = result.response.headers['content-type'];
  let pretty = result.response.body;
  let formatted = false;

  try {
    pretty = JSON.stringify(JSON.parse(result.response.body), null, 2);
    formatted = true;
  } catch {
    // Not JSON. XML is the other format worth indenting — plenty of APIs still return it,
    // and an unbroken single line is unreadable.
    if (looksLikeXml(contentType, result.response.body)) {
      pretty = formatXml(result.response.body);
      formatted = true;
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {formatted && (
        <button
          type="button"
          onClick={() => setRaw(!raw)}
          className="self-start text-xs text-slate-500 hover:text-slate-300"
        >
          {raw ? 'Show formatted' : 'Show raw'}
        </button>
      )}
      <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-slate-300">
        {raw ? result.response.body : pretty}
      </pre>
    </div>
  );
}

function Table({ rows }: { rows: [string, string][] }) {
  if (!rows.length) return <p className="text-sm text-slate-500">None.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left font-mono text-xs">
        <tbody>
          {rows.map(([key, value]) => (
            <tr key={key} className="border-b border-slate-800/60">
              <td className="py-1 pr-4 align-top text-slate-500">{key}</td>
              <td className="py-1 break-all text-slate-300">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CookieView({ result }: { result: RunResult }) {
  if (!result.response.cookies.length) return <p className="text-sm text-slate-500">None.</p>;
  return (
    <div className="flex flex-col gap-2">
      {result.response.cookies.map((c) => (
        <div key={c.name} className="rounded border border-slate-800 p-2 font-mono text-xs">
          <span className="text-slate-300">
            {c.name}={c.value}
          </span>
          <div className="mt-1 flex gap-2 text-slate-500">
            {c.httpOnly && <span>HttpOnly</span>}
            {c.secure && <span>Secure</span>}
            {c.sameSite && <span>SameSite={c.sameSite}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Timing waterfall. Phases are drawn proportionally to the total, which is what makes an
 * outlier (a slow DNS, a slow server) visible at a glance rather than needing arithmetic.
 */
function TimingView({ result }: { result: RunResult }) {
  const { dnsMs, connectMs, ttfbMs, downloadMs, totalMs } = result.timing;

  // TTFB includes DNS and connect, so the server's own think time is what remains.
  const waitMs = Math.max(0, (ttfbMs ?? 0) - (dnsMs ?? 0) - (connectMs ?? 0));

  const phases = [
    { label: 'DNS', ms: dnsMs, tone: 'bg-sky-500' },
    { label: 'Connect (TCP + TLS)', ms: connectMs, tone: 'bg-violet-500' },
    { label: 'Waiting (server)', ms: waitMs, tone: 'bg-amber-500' },
    { label: 'Download', ms: downloadMs, tone: 'bg-emerald-500' },
  ];

  return (
    <div className="flex flex-col gap-3">
      {phases.map((phase) => (
        <div key={phase.label} className="flex items-center gap-3 text-xs">
          <span className="w-40 shrink-0 text-slate-400">{phase.label}</span>
          <div className="h-2 flex-1 overflow-hidden rounded bg-slate-800">
            <div
              className={`h-full ${phase.tone}`}
              style={{
                width: totalMs ? `${Math.min(100, ((phase.ms ?? 0) / totalMs) * 100)}%` : 0,
              }}
            />
          </div>
          <span className="w-20 shrink-0 text-right font-mono text-slate-300">
            {formatMs(phase.ms)}
          </span>
        </div>
      ))}

      <div className="mt-1 flex items-center gap-3 border-t border-slate-800 pt-2 text-xs">
        <span className="w-40 shrink-0 font-medium text-slate-300">Total</span>
        <div className="flex-1" />
        <span className="w-20 shrink-0 text-right font-mono text-slate-100">
          {formatMs(totalMs)}
        </span>
      </div>

      {dnsMs === null && (
        <p className="text-xs text-slate-500">
          No DNS phase — the host was an IP address, so nothing needed resolving.
        </p>
      )}

      {result.redirects.length > 0 && (
        <div className="mt-2">
          <p className="mb-1 text-xs font-medium text-slate-400">
            Redirect chain ({result.redirects.length})
          </p>
          <ol className="flex flex-col gap-1 font-mono text-xs text-slate-400">
            {result.redirects.map((hop, i) => (
              <li key={i} className="break-all">
                <span className={statusTone(hop.status)}>{hop.status}</span> {hop.from} → {hop.to}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function ChecksView({ result }: { result: RunResult }) {
  if (!result.assertions.length && !result.captures.length) {
    return <p className="text-sm text-slate-500">No checks or captures on this request.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {result.assertions.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs">
          {result.assertions.map((a, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className={a.passed ? 'text-emerald-400' : 'text-rose-400'}>
                {a.passed ? '✓' : '✗'}
              </span>
              <span className="text-slate-300">{a.summary}</span>
            </li>
          ))}
        </ul>
      )}

      {result.captures.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-slate-400">Captured</p>
          <ul className="flex flex-col gap-1 font-mono text-xs">
            {result.captures.map((c) => (
              <li key={c.name} className={c.found ? 'text-slate-300' : 'text-amber-400'}>
                {c.name} = {c.found ? c.value : 'not found'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * What was actually sent. Previously the only headers on show were the response's, which
 * left no way to confirm that an auth header, or a resolved {{variable}}, went out as
 * intended — the most common thing to want when a request misbehaves.
 */
function RequestView({ result }: { result: RunResult }) {
  const redirected = result.finalRequest && result.finalRequest.url !== result.request.url;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-1 text-xs font-medium text-slate-400">Sent</p>
        <p className="font-mono text-xs break-all text-slate-300">
          {result.request.method} {result.request.url}
        </p>
      </div>

      <div>
        <p className="mb-1 text-xs font-medium text-slate-400">Request headers</p>
        <Table rows={Object.entries(result.request.headers)} />
        <p className="mt-1 text-xs text-slate-600">
          Secret values show as •••• — the real value was sent, but never reaches this page.
        </p>
      </div>

      {result.request.body.text && (
        <div>
          <p className="mb-1 text-xs font-medium text-slate-400">
            Request body ({result.request.body.type})
          </p>
          <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-slate-300">
            {result.request.body.text}
          </pre>
        </div>
      )}

      {redirected && result.finalRequest && (
        <div>
          <p className="mb-1 text-xs font-medium text-slate-400">
            After {result.redirects.length} redirect
            {result.redirects.length > 1 ? 's' : ''}, the final hop was
          </p>
          <p className="font-mono text-xs break-all text-slate-300">
            {result.finalRequest.method} {result.finalRequest.url}
          </p>
          <Table rows={Object.entries(result.finalRequest.headers)} />
        </div>
      )}
    </div>
  );
}
