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
    renameEnvironment,
    deleteEnvironment,
    project,
  } = useStore();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
              placeholder="production"
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 focus:border-sky-600 focus:outline-none"
            />
            {/* Environments are deployment targets, so the conventional names are the useful
                default — offered as one-click rather than explained in a paragraph. */}
            {['development', 'staging', 'production'].map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => {
                  void createEnvironment(suggestion);
                  setCreating(false);
                }}
                className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:border-slate-500 hover:text-slate-200"
              >
                {suggestion}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="text-xs text-slate-500"
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <select
              value={environmentId ?? ''}
              onChange={(e) => setEnvironment(e.target.value || null)}
              disabled={!project}
              // Bounded width: a select sizes itself to its widest option, and one long
              // environment name would otherwise stretch the bar and push the controls
              // beside it off-screen.
              className="max-w-56 truncate rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 focus:border-sky-600 focus:outline-none disabled:opacity-40"
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

            {active && !renaming && !confirmDelete && (
              <>
                <button
                  type="button"
                  onClick={() => setOpen(!open)}
                  className="text-xs text-slate-500 hover:text-slate-200"
                >
                  {open ? 'Hide variables' : `Variables (${active.variables.length})`}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setName(active.name);
                    setRenaming(true);
                  }}
                  className="text-xs text-slate-500 hover:text-slate-200"
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="text-xs text-slate-500 hover:text-rose-400"
                >
                  Delete
                </button>
                <TransferControl label="Move / copy to project…" environmentIds={[active.id]} />
              </>
            )}

            {active && renaming && (
              <span className="flex items-center gap-1">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && name.trim()) {
                      void renameEnvironment(active.id, name.trim());
                      setRenaming(false);
                    }
                    if (e.key === 'Escape') setRenaming(false);
                  }}
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 focus:border-sky-600 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (name.trim()) void renameEnvironment(active.id, name.trim());
                    setRenaming(false);
                  }}
                  className="text-xs text-emerald-400"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setRenaming(false)}
                  className="text-xs text-slate-500"
                >
                  Cancel
                </button>
              </span>
            )}

            {active && confirmDelete && (
              // Inline rather than a browser dialog, and it names what is about to go: the
              // variables are the painful part to lose, especially a filled-in secret.
              <span className="flex items-center gap-2 text-xs">
                <span className="text-rose-300">
                  Delete “{active.name}” and its {active.variables.length} variable
                  {active.variables.length === 1 ? '' : 's'}?
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void deleteEnvironment(active.id);
                    setConfirmDelete(false);
                    setOpen(false);
                  }}
                  className="text-rose-400 hover:text-rose-300"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="text-slate-500 hover:text-slate-300"
                >
                  Cancel
                </button>
              </span>
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
