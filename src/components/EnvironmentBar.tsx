import { useState } from 'react';
import { useStore } from '../stores/appStore';
import VariableEditor from './VariableEditor';
import TransferControl from './TransferControl';
import type { Variable } from '../types';

/**
 * Environment selector plus an inline variable editor.
 *
 * Secret values arrive already masked and are sent back masked unless edited — the server
 * treats the mask as "keep what you have", so editing a name never clears a token.
 */
export default function EnvironmentBar() {
  const {
    environments,
    environmentId,
    setEnvironment,
    createEnvironment,
    saveEnvironment,
    project,
  } = useStore();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const active = environments.find((e) => e.id === environmentId) ?? null;

  const setVariables = (variables: Variable[]) => {
    if (!active) return;
    void saveEnvironment({ ...active, variables });
  };

  return (
    <div className="border-b border-slate-800">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-xs text-slate-500">Environment</span>

        {creating ? (
          <div className="flex gap-1">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) {
                  void createEnvironment(name.trim());
                  setName('');
                  setCreating(false);
                }
                if (e.key === 'Escape') setCreating(false);
              }}
              placeholder="Environment name"
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 focus:border-sky-600 focus:outline-none"
            />
          </div>
        ) : (
          <>
            <select
              value={environmentId ?? ''}
              onChange={(e) => setEnvironment(e.target.value || null)}
              disabled={!project}
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 focus:border-sky-600 focus:outline-none disabled:opacity-40"
            >
              <option value="">None</option>
              {environments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => setCreating(true)}
              disabled={!project}
              className="text-xs text-slate-500 hover:text-slate-200 disabled:opacity-40"
            >
              + New
            </button>

            {active && (
              <>
                <button
                  type="button"
                  onClick={() => setOpen(!open)}
                  className="text-xs text-slate-500 hover:text-slate-200"
                >
                  {open ? 'Hide variables' : `Variables (${active.variables.length})`}
                </button>
                <TransferControl label="Move / copy to project…" environmentIds={[active.id]} />
              </>
            )}
          </>
        )}
      </div>

      {open && active && (
        <div className="border-t border-slate-800 px-3 py-2">
          <VariableEditor variables={active.variables} onSave={setVariables} />
        </div>
      )}
    </div>
  );
}
