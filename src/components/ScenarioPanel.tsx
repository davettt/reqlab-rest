import { useEffect, useState } from 'react';
import { useStore } from '../stores/appStore';
import type { Scenario, ScenarioRun, ScenarioStepResult } from '../types';

const OUTCOME: Record<ScenarioStepResult['outcome'], { label: string; tone: string }> = {
  passed: { label: 'passed', tone: 'text-emerald-400' },
  failed: { label: 'failed', tone: 'text-rose-400' },
  error: { label: 'could not send', tone: 'text-rose-400' },
  missing: { label: 'request missing', tone: 'text-rose-400' },
  // Deliberately not styled like a pass: a step that never ran is untested, and the colour is
  // the first thing anyone reads off this list.
  'not-run': { label: 'not run', tone: 'text-slate-500' },
};

const TONE: Record<string, string> = {
  blocker: 'text-rose-400',
  major: 'text-amber-400',
  minor: 'text-yellow-500',
  info: 'text-sky-400',
};

/**
 * Scenarios: ordered runs where each step can use what the last one captured.
 *
 * The editor is deliberately a list of requests rather than a second place to define them.
 * A step *is* a saved request — its assertions and captures come with it — so there is one
 * definition of every request in the project and no way for the two to drift apart.
 */
export default function ScenarioPanel({ onClose }: { onClose: () => void }) {
  const {
    project,
    requests,
    environmentId,
    scenarios,
    loadScenarios,
    createScenario,
    updateScenario,
    deleteScenario,
    runScenario,
  } = useStore();

  const [editing, setEditing] = useState<Scenario | null>(null);
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<ScenarioRun | null>(null);

  useEffect(() => {
    if (project) void loadScenarios(project.id);
  }, [project, loadScenarios]);

  const startNew = () => {
    setEditing(null);
    setName('');
    setSteps([]);
    setRun(null);
    setError(null);
  };

  const startEdit = (scenario: Scenario) => {
    setEditing(scenario);
    setName(scenario.name);
    setSteps(scenario.steps.map((s) => s.requestId));
    setRun(null);
    setError(null);
  };

  const save = async () => {
    if (!project || !name.trim() || steps.length === 0) return;
    const input = { name: name.trim(), steps: steps.map((requestId) => ({ requestId })) };

    if (editing) await updateScenario(project.id, editing.id, input);
    else await createScenario(project.id, input);

    startNew();
  };

  const start = async (scenario: Scenario) => {
    if (!project) return;
    setBusy(true);
    setError(null);
    setRun(null);

    const result = await runScenario(project.id, scenario.id, environmentId ?? undefined);
    setBusy(false);

    if ('error' in result) setError(result.error);
    else setRun(result);
  };

  const move = (index: number, by: number) => {
    const target = index + by;
    if (target < 0 || target >= steps.length) return;

    const from = steps[index];
    const to = steps[target];
    if (from === undefined || to === undefined) return;

    const next = [...steps];
    next[index] = to;
    next[target] = from;
    setSteps(next);
  };

  const nameOf = (requestId: string) =>
    requests.find((r) => r.id === requestId)?.name ?? 'deleted request';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-950/80 p-6">
      <div className="flex w-full max-w-4xl flex-col gap-4 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">Scenarios</h2>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-200">
            ×
          </button>
        </div>

        <p className="text-xs text-slate-500">
          An ordered run where each step can use what the last one captured — create, read it back,
          update, confirm. A step is one of this project’s saved requests, so its assertions and
          captures come with it. A failed step stops the run and the steps after it are reported as
          not run, never as passed.
        </p>

        {/* ---- the saved scenarios ---- */}
        <div className="flex flex-col gap-1">
          {scenarios.length === 0 && (
            <p className="text-xs text-slate-600">No scenarios yet. Build one below.</p>
          )}
          {scenarios.map((scenario) => (
            <div
              key={scenario.id}
              className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950/40 p-2 text-xs"
            >
              <span className="text-slate-200">{scenario.name}</span>
              <span className="text-slate-600">
                {scenario.steps.length} step{scenario.steps.length === 1 ? '' : 's'}
              </span>
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => void start(scenario)}
                  disabled={busy}
                  className="text-sky-400 hover:text-sky-300 disabled:opacity-40"
                >
                  {busy ? 'running…' : 'run'}
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(scenario)}
                  className="text-slate-400 hover:text-slate-200"
                >
                  edit
                </button>
                {/* Inline confirm rather than window.confirm, per the project conventions. */}
                {confirmDelete === scenario.id ? (
                  <>
                    <button
                      type="button"
                      onClick={async () => {
                        if (project) await deleteScenario(project.id, scenario.id);
                        setConfirmDelete(null);
                      }}
                      className="text-rose-400 hover:text-rose-300"
                    >
                      delete it and its runs
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(null)}
                      className="text-slate-500 hover:text-slate-300"
                    >
                      cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(scenario.id)}
                    className="text-slate-500 hover:text-rose-400"
                  >
                    delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* ---- the editor ---- */}
        <div className="flex flex-col gap-2 rounded border border-slate-800 p-2">
          <div className="flex items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Scenario name, e.g. Sign up and place an order"
              className="flex-1 rounded border border-slate-800 bg-slate-950 px-2 py-1 text-xs text-slate-200"
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={!name.trim() || steps.length === 0}
              className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-40"
            >
              {editing ? 'Save changes' : 'Create scenario'}
            </button>
            {editing && (
              <button
                type="button"
                onClick={startNew}
                className="text-xs text-slate-500 hover:text-slate-300"
              >
                cancel
              </button>
            )}
          </div>

          <ol className="flex flex-col gap-1">
            {steps.map((requestId, index) => (
              <li key={`${requestId}-${index}`} className="flex items-center gap-2 text-xs">
                <span className="w-5 text-right text-slate-600">{index + 1}</span>
                <span className="flex-1 text-slate-300">{nameOf(requestId)}</span>
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  className="text-slate-500 hover:text-slate-200"
                  aria-label="Move step up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  className="text-slate-500 hover:text-slate-200"
                  aria-label="Move step down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => setSteps(steps.filter((_, i) => i !== index))}
                  className="text-slate-500 hover:text-rose-400"
                  aria-label="Remove step"
                >
                  ×
                </button>
              </li>
            ))}
          </ol>

          <select
            value=""
            onChange={(e) => {
              if (e.target.value) setSteps([...steps, e.target.value]);
            }}
            className="rounded border border-slate-800 bg-slate-950 px-2 py-1 text-xs text-slate-300"
          >
            <option value="">Add a step…</option>
            {requests.map((request) => (
              <option key={request.id} value={request.id}>
                {request.method} {request.name}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p className="rounded border border-rose-900 bg-rose-950/40 p-2 text-xs text-rose-300">
            {error}
          </p>
        )}

        {/* ---- the last run ---- */}
        {run && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3 text-sm">
              <span className={run.passed ? 'text-emerald-400' : 'text-rose-400'}>
                {run.passed ? 'Every step passed' : 'The run did not complete'}
              </span>
              <span className="text-xs text-slate-600">
                {run.steps.length} step{run.steps.length === 1 ? '' : 's'} ·{' '}
                {run.finishedAt - run.startedAt}ms
              </span>
            </div>

            <ol className="rounded border border-slate-800">
              {run.steps.map((step) => (
                <li
                  key={step.position}
                  className="flex items-center gap-2 border-b border-slate-800/60 p-2 text-xs last:border-b-0"
                >
                  <span className="w-5 text-right text-slate-600">{step.position}</span>
                  <span className="flex-1 text-slate-300">{step.name}</span>
                  {step.captured && step.captured.length > 0 && (
                    <span className="text-slate-600">captured {step.captured.join(', ')}</span>
                  )}
                  {step.status !== null && step.status !== undefined && (
                    <span className="text-slate-500">{step.status}</span>
                  )}
                  {step.timingMs !== null && step.timingMs !== undefined && (
                    <span className="text-slate-600">{Math.round(step.timingMs)}ms</span>
                  )}
                  <span className={OUTCOME[step.outcome].tone}>{OUTCOME[step.outcome].label}</span>
                </li>
              ))}
            </ol>

            {run.findings.length > 0 && (
              <div className="max-h-72 overflow-auto rounded border border-slate-800">
                {run.findings.map((f, i) => (
                  <div key={i} className="border-b border-slate-800/60 p-2 text-xs last:border-b-0">
                    <div className="flex gap-2">
                      <span className={`font-semibold uppercase ${TONE[f.severity]}`}>
                        {f.severity}
                      </span>
                      <span className="text-slate-200">{f.title}</span>
                    </div>
                    <p className="mt-1 text-slate-400">{f.whatHappened}</p>
                    <p className="mt-1 text-slate-500">{f.whyItMatters}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
