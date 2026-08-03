import { useState } from 'react';
import { useStore } from '../stores/appStore';
import { methodTone } from '../types';
import ImportDialog from './ImportDialog';

export default function Sidebar() {
  const {
    projects,
    project,
    requests,
    draft,
    openProject,
    createProject,
    selectRequest,
    newRequest,
    deleteRequest,
    renameProject,
    deleteProject,
  } = useStore();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [renamingProject, setRenamingProject] = useState(false);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false);
  const [projectName, setProjectName] = useState('');

  const submit = () => {
    if (!name.trim()) return;
    void createProject(name.trim());
    setName('');
    setCreating(false);
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-800">
      <div className="border-b border-slate-800 p-2">
        {creating ? (
          <div className="flex gap-1">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
                if (e.key === 'Escape') setCreating(false);
              }}
              placeholder="Project name"
              className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 focus:border-sky-600 focus:outline-none"
            />
            <button type="button" onClick={submit} className="px-1 text-sm text-emerald-400">
              ✓
            </button>
          </div>
        ) : renamingProject && project ? (
          <div className="flex gap-1">
            <input
              autoFocus
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && projectName.trim()) {
                  void renameProject(project.id, projectName.trim());
                  setRenamingProject(false);
                }
                if (e.key === 'Escape') setRenamingProject(false);
              }}
              className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 focus:border-sky-600 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                if (projectName.trim()) void renameProject(project.id, projectName.trim());
                setRenamingProject(false);
              }}
              className="px-1 text-sm text-emerald-400"
            >
              ✓
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1">
              <select
                value={project?.id ?? ''}
                onChange={(e) => void openProject(e.target.value)}
                className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 focus:border-sky-600 focus:outline-none"
              >
                {!project && <option value="">No project</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="px-1 text-lg leading-none text-slate-500 hover:text-slate-200"
                aria-label="New project"
              >
                +
              </button>
            </div>

            {project && !confirmDeleteProject && (
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setProjectName(project.name);
                    setRenamingProject(true);
                  }}
                  className="text-xs text-slate-600 hover:text-slate-300"
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteProject(true)}
                  className="text-xs text-slate-600 hover:text-rose-400"
                >
                  Delete project
                </button>
              </div>
            )}

            {project && confirmDeleteProject && (
              // Names the consequences: deleting a project takes its requests, environments
              // and any secrets stored in them, and none of that can be recovered.
              <div className="mt-1 flex flex-col gap-1 text-xs">
                <span className="text-rose-300">
                  Delete “{project.name}” with its {requests.length} request
                  {requests.length === 1 ? '' : 's'}, environments and stored secrets?
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void deleteProject(project.id);
                      setConfirmDeleteProject(false);
                    }}
                    className="text-rose-400 hover:text-rose-300"
                  >
                    Delete permanently
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteProject(false)}
                    className="text-slate-500 hover:text-slate-300"
                  >
                    Cancel
                  </button>
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs tracking-wide text-slate-500 uppercase">Requests</span>
        <span className="flex gap-2">
          <button
            type="button"
            onClick={() => setImporting(true)}
            disabled={!project}
            className="text-xs text-slate-500 hover:text-slate-200 disabled:opacity-40"
          >
            Import
          </button>
          <button
            type="button"
            onClick={newRequest}
            disabled={!project}
            className="text-xs text-slate-500 hover:text-slate-200 disabled:opacity-40"
          >
            + New
          </button>
        </span>
      </div>

      {importing && <ImportDialog onClose={() => setImporting(false)} />}

      <ul className="min-h-0 flex-1 overflow-auto">
        {requests.map((request) => (
          <li key={request.id} className="group flex items-center">
            <button
              type="button"
              onClick={() => selectRequest(request.id)}
              className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-sm ${
                draft?.id === request.id
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-800/50'
              }`}
            >
              <span className={`w-12 shrink-0 font-mono text-[10px] ${methodTone(request.method)}`}>
                {request.method}
              </span>
              <span className="truncate">{request.name}</span>
            </button>

            {confirmDelete === request.id ? (
              // Inline confirm rather than window.confirm — house rule, and it keeps the
              // decision next to the thing being deleted.
              <span className="flex shrink-0 items-center gap-1 pr-2 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    void deleteRequest(request.id);
                    setConfirmDelete(null);
                  }}
                  className="text-rose-400 hover:text-rose-300"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(null)}
                  className="text-slate-500 hover:text-slate-300"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(request.id)}
                className="shrink-0 px-2 text-slate-700 opacity-0 group-hover:opacity-100 hover:text-rose-400"
                aria-label={`Delete ${request.name}`}
              >
                ×
              </button>
            )}
          </li>
        ))}

        {project && requests.length === 0 && (
          <li className="px-3 py-2 text-xs text-slate-600">
            No saved requests yet. “+ New” to start one.
          </li>
        )}
      </ul>
    </aside>
  );
}
