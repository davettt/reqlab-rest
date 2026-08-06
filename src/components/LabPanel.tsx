import { useEffect, useState } from 'react';
import { useStore } from '../stores/appStore';
import type { VerifyRun } from '../types';

const SUITES = [
  {
    id: 'contract',
    label: 'Contract conformance',
    blurb:
      'Sends this project’s saved requests and compares each response against the specification you paste below — statuses, required fields, types, enums, and fields the docs do not mention. Only requests matching an operation in the spec are checked.',
  },
  {
    id: 'negative',
    label: 'Negative testing',
    blurb:
      'Bad credentials, malformed bodies, wrong types and methods — checks the right errors come back and nothing leaks.',
  },
  {
    id: 'authz',
    label: 'Authorisation — can one user reach another user’s data?',
    blurb:
      'Replays each request with a second user’s credentials, and with none at all. If the second user gets the first user’s data back, anyone can read anyone’s by changing an id in the URL — known as an insecure direct object reference (IDOR). Needs two environments holding different users’ credentials.',
  },
  {
    id: 'pagination',
    label: 'Pagination — does walking every page give you every record?',
    blurb:
      'Walks the pages of any request that returns a list and checks the boundaries: records returned twice, records skipped, a total that moves while you page, a page size that is ignored, and what happens past the last page. Read-only.',
  },
  {
    id: 'idempotency',
    label: 'Idempotency — is it safe to send the same request twice?',
    blurb:
      'Repeats each PUT and DELETE, and any create carrying an Idempotency-Key, then compares the results. Catches a PUT that increments rather than sets, a delete that errors the second time, and a key that is accepted but ignored. This one genuinely writes twice.',
  },
  {
    id: 'caching',
    label: 'Caching',
    blurb:
      'Checks each GET for an ETag or Last-Modified, confirms a conditional re-request actually returns 304, and flags an authenticated response that a shared proxy is allowed to store and serve to someone else.',
  },
  {
    id: 'latency',
    label: 'Latency — has anything got slower?',
    blurb:
      'Times each GET over a dozen sequential requests and compares the percentiles against the saved baseline. The first run becomes the baseline; after that, promoting a run is deliberate. Not load testing — only reads are repeated.',
  },
] as const;

/** Kept in step with INTRUSIVE_SUITES in server/verify/runner.js. */
const INTRUSIVE: string[] = ['negative', 'authz', 'idempotency'];

const TONE: Record<string, string> = {
  blocker: 'text-rose-400',
  major: 'text-amber-400',
  minor: 'text-yellow-500',
  info: 'text-sky-400',
};

/**
 * The Lab: run the verification suites against this project and read the findings.
 *
 * The acknowledgement is not a formality. These suites send deliberately malformed requests
 * and replay them with other credentials, so the server refuses a non-loopback target until
 * the user confirms it is theirs to test.
 */
export default function LabPanel({ onClose }: { onClose: () => void }) {
  const {
    project,
    environments,
    environmentId,
    runVerification,
    saveLatencyBaseline,
    loadRuns,
    runs,
  } = useStore();

  const [selected, setSelected] = useState<string[]>(['negative']);
  // Defaults to whatever is selected in the header. Without this the lab sent no environment
  // at all unless you were configuring identities for the IDOR suite, so every {{variable}}
  // was unresolved and the run refused with "nothing was tested".
  const [identityIds, setIdentityIds] = useState<string[]>(environmentId ? [environmentId] : []);
  const [acknowledged, setAcknowledged] = useState(false);
  const [specText, setSpecText] = useState('');
  const [specUrl, setSpecUrl] = useState('');
  const [specMode, setSpecMode] = useState<'url' | 'paste'>('url');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<VerifyRun | null>(null);
  const [baselineSaved, setBaselineSaved] = useState(false);

  useEffect(() => {
    if (project) void loadRuns(project.id);
  }, [project, loadRuns]);

  const toggle = (id: string) =>
    setSelected(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  const start = async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    setBaselineSaved(false);

    const result = await runVerification({
      projectId: project.id,
      suites: selected,
      environmentIds: identityIds,
      // Sent as-is: the server parses JSON or YAML and fetches a URL, the same way import
      // does, and explains it if the document turns out not to be a specification.
      ...(selected.includes('contract') && specMode === 'url' && specUrl.trim()
        ? { specUrl: specUrl.trim() }
        : {}),
      ...(selected.includes('contract') && specMode === 'paste' && specText.trim()
        ? { specText }
        : {}),
      acknowledged,
    });
    setBusy(false);

    if ('error' in result) setError(result.error);
    else setRun(result);
  };

  // Only the intrusive suites need the acknowledgement. Contract, pagination and caching send
  // the documented requests, walk pages and re-request with a conditional header, which is
  // what any consumer does anyway. Idempotency repeats writes, so it belongs with the rest.
  const intrusive = selected.filter((s) => INTRUSIVE.includes(s));
  const needsAcknowledgement = intrusive.length > 0;

  const reportUrl = (format: string) =>
    project && run ? `/api/verify/${project.id}/runs/${run.id}?format=${format}` : '#';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-950/80 p-6">
      <div className="flex w-full max-w-4xl flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">Verification lab</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {!run ? (
          <>
            <p className="text-xs text-slate-500">
              Runs checks against the saved requests in this project and produces a report you can
              hand to whoever built the API.
            </p>

            <p className="text-xs text-slate-400">
              Variables come from{' '}
              {identityIds.length ? (
                <span className="text-slate-200">
                  {identityIds
                    .map((id) => environments.find((e) => e.id === id)?.name)
                    .filter(Boolean)
                    .join(' and ')}
                </span>
              ) : (
                <span className="text-amber-400">no environment — requests will not resolve</span>
              )}
              .
            </p>

            <div className="flex flex-col gap-2">
              {SUITES.map((suite) => (
                <label key={suite.id} className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(suite.id)}
                    onChange={() => toggle(suite.id)}
                    className="mt-1 accent-sky-500"
                  />
                  <span>
                    <span className="text-slate-200">{suite.label}</span>
                    <span className="block text-xs text-slate-500">{suite.blurb}</span>
                  </span>
                </label>
              ))}
            </div>

            {selected.includes('contract') && (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-slate-500">
                  Needs an OpenAPI or Swagger specification — the machine-readable document, usually
                  published at a URL like <code className="text-slate-400">/openapi.json</code> or{' '}
                  <code className="text-slate-400">/swagger.json</code>, not the documentation web
                  page. Every request in this project is compared against it; any it does not
                  describe is reported as not covered.
                </p>

                <div className="flex gap-2 text-xs">
                  {(['url', 'paste'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setSpecMode(mode)}
                      className={`rounded px-2 py-1 ${
                        specMode === mode
                          ? 'bg-slate-800 text-slate-100'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {mode === 'url' ? 'From a URL' : 'Paste it'}
                    </button>
                  ))}
                </div>

                {specMode === 'url' ? (
                  <input
                    value={specUrl}
                    onChange={(e) => setSpecUrl(e.target.value)}
                    placeholder="https://api.example.com/openapi.json"
                    className="rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
                  />
                ) : (
                  <textarea
                    value={specText}
                    onChange={(e) => setSpecText(e.target.value)}
                    placeholder="Paste the specification — JSON or YAML"
                    className="h-28 rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
                    spellCheck={false}
                  />
                )}
              </div>
            )}

            {environments.length > 0 && (
              <div className="text-xs text-slate-400">
                <p className="mb-1">
                  {selected.includes('authz')
                    ? 'Environments — pick two holding different users’ credentials. Only variables marked secret are swapped between them, so the request asks for the same resource with a different user’s credential:'
                    : 'Environment — supplies the variables these requests use:'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {environments.map((env) => (
                    <label key={env.id} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={identityIds.includes(env.id)}
                        onChange={() =>
                          setIdentityIds(
                            identityIds.includes(env.id)
                              ? identityIds.filter((i) => i !== env.id)
                              : [...identityIds, env.id],
                          )
                        }
                        className="accent-sky-500"
                      />
                      {env.name}
                    </label>
                  ))}
                </div>
                {selected.includes('authz') && identityIds.length < 2 && (
                  <p className="mt-1 text-slate-600">
                    With fewer than two, cross-user checks are skipped and the report says so.
                  </p>
                )}
              </div>
            )}

            {needsAcknowledgement ? (
              <label className="flex gap-2 rounded border border-amber-900/60 bg-amber-950/20 p-2 text-xs text-amber-300">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  className="mt-0.5 accent-amber-500"
                />
                <span>
                  I own, or am authorised to test, the API these requests point at.{' '}
                  {intrusive.join(' and ')} send malformed requests, oversized bodies and requests
                  with credentials removed or swapped.
                </span>
              </label>
            ) : (
              <p className="rounded border border-slate-800 bg-slate-950/40 p-2 text-xs text-slate-500">
                Contract conformance only sends the requests your documentation describes and
                compares the responses, so it needs no confirmation — checking whether an API
                matches its own docs is fair game whether or not you own it.
              </p>
            )}

            {error && (
              <p className="rounded border border-rose-900 bg-rose-950/40 p-2 text-xs text-rose-300">
                {error}
              </p>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void start()}
                disabled={
                  busy || !selected.length || !project || (needsAcknowledgement && !acknowledged)
                }
                className="rounded bg-sky-600 px-3 py-1 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
              >
                {busy ? 'Running…' : 'Run checks'}
              </button>
              {busy && <span className="text-xs text-slate-500">Sending probes…</span>}
              {!busy && needsAcknowledgement && !acknowledged && (
                <span className="text-xs text-slate-500">
                  Tick the confirmation above to run {intrusive.join(' and ')}.
                </span>
              )}
            </div>

            {runs.length > 0 && (
              <div className="border-t border-slate-800 pt-2 text-xs">
                <p className="mb-1 text-slate-500">Previous runs</p>
                <ul className="flex flex-col gap-1">
                  {runs.slice(0, 5).map((previous) => (
                    <li key={previous.id} className="flex items-center gap-2 text-slate-400">
                      <span>{new Date(previous.startedAt).toLocaleString()}</span>
                      <span
                        className={previous.summary.passed ? 'text-emerald-400' : 'text-rose-400'}
                      >
                        {previous.summary.passed
                          ? 'passed'
                          : `${previous.summary.total} finding${previous.summary.total === 1 ? '' : 's'}`}
                      </span>
                      <a
                        href={`/api/verify/${project?.id}/runs/${previous.id}?format=html`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-400 hover:text-sky-300"
                      >
                        report
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className={run.summary.passed ? 'text-emerald-400' : 'text-rose-400'}>
                {run.summary.passed
                  ? 'No blocking problems found'
                  : `${run.summary.total} problem${run.summary.total === 1 ? '' : 's'} found`}
              </span>
              {(['blocker', 'major', 'minor', 'info'] as const)
                .filter((s) => run.summary[s] > 0)
                .map((s) => (
                  <span key={s} className={`text-xs ${TONE[s]}`}>
                    {run.summary[s]} {s}
                  </span>
                ))}
              <span className="text-xs text-slate-600">suites: {run.suites.join(', ')}</span>
            </div>

            {run.skipped.length > 0 && (
              <ul className="rounded border border-slate-800 bg-slate-950/40 p-2 text-xs text-slate-400">
                {run.skipped.map((s) => (
                  <li key={s.suite}>
                    <span className="text-slate-300">{s.suite} did not run.</span> {s.reason}
                  </li>
                ))}
              </ul>
            )}

            {run.latency && Object.keys(run.latency.measurements).length > 0 && (
              <div className="rounded border border-slate-800 bg-slate-950/40 p-2">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-slate-300">
                    Timings{' '}
                    <span className="text-slate-600">
                      {run.latency.comparedAgainst
                        ? `compared against the baseline saved ${new Date(
                            run.latency.comparedAgainst,
                          ).toLocaleString()}`
                        : 'recorded as the baseline'}
                    </span>
                  </span>
                  {/* Promoting a run is explicit: adopting a slower run as the new normal is a
                      decision, and a baseline that updated itself every run would never show a
                      regression that arrived gradually. */}
                  {run.latency.comparedAgainst !== null && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (!project) return;
                        const ok = await saveLatencyBaseline(project.id, run.id);
                        if (ok) setBaselineSaved(true);
                      }}
                      className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:border-slate-500"
                    >
                      {baselineSaved ? 'Saved as baseline' : 'Save these as the baseline'}
                    </button>
                  )}
                </div>
                <table className="w-full text-left text-xs text-slate-400">
                  <thead className="text-slate-600">
                    <tr>
                      <th className="py-0.5 font-normal">endpoint</th>
                      <th className="py-0.5 text-right font-normal">p50</th>
                      <th className="py-0.5 text-right font-normal">p95</th>
                      <th className="py-0.5 text-right font-normal">p99</th>
                      <th className="py-0.5 text-right font-normal">n</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(run.latency.measurements).map(([endpoint, stats]) => (
                      <tr key={endpoint} className="border-t border-slate-800/60">
                        <td className="py-0.5 font-mono text-slate-300">{endpoint}</td>
                        <td className="py-0.5 text-right">{stats.p50}ms</td>
                        <td className="py-0.5 text-right">{stats.p95}ms</td>
                        <td className="py-0.5 text-right">{stats.p99}ms</td>
                        <td className="py-0.5 text-right text-slate-600">{stats.samples}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="max-h-96 overflow-auto rounded border border-slate-800">
              {run.findings.map((f, i) => (
                <div key={i} className="border-b border-slate-800/60 p-2 text-xs">
                  <div className="flex gap-2">
                    <span className={`font-semibold uppercase ${TONE[f.severity]}`}>
                      {f.severity}
                    </span>
                    <span className="text-slate-200">{f.title}</span>
                  </div>
                  <p className="mt-1 text-slate-400">{f.whatHappened}</p>
                  <p className="mt-1 text-slate-500">{f.whyItMatters}</p>
                  {f.expected !== null && (
                    <p className="mt-1 font-mono text-slate-600">
                      expected {String(f.expected)} · actual {String(f.actual)}
                    </p>
                  )}
                </div>
              ))}
              {run.findings.length === 0 && (
                <p className="p-3 text-xs text-slate-400">Every check passed.</p>
              )}
            </div>

            <div className="flex items-center gap-3">
              <a
                href={reportUrl('html')}
                target="_blank"
                rel="noreferrer"
                className="rounded bg-sky-600 px-3 py-1 text-sm text-white hover:bg-sky-500"
              >
                Open HTML report
              </a>
              <a
                href={reportUrl('markdown')}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-slate-400 hover:text-slate-200"
              >
                Markdown summary
              </a>
              <button
                type="button"
                onClick={() => setRun(null)}
                className="text-xs text-slate-500 hover:text-slate-300"
              >
                Run again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
