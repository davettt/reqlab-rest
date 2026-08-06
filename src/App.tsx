import { useEffect, useState } from 'react';
import { useStore } from './stores/appStore';
import Sidebar from './components/Sidebar';
import EnvironmentBar from './components/EnvironmentBar';
import RequestEditor from './components/RequestEditor';
import ResponsePane from './components/ResponsePane';
import SettingsDialog from './components/SettingsDialog';
import LabPanel from './components/LabPanel';
import ScenarioPanel from './components/ScenarioPanel';

export default function App() {
  const { loadProjects, error, clearError, project, projects, loading } = useStore();
  const [showSettings, setShowSettings] = useState(false);
  const [showLab, setShowLab] = useState(false);
  const [showScenarios, setShowScenarios] = useState(false);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-slate-800 px-4 py-2">
        <h1 className="text-sm font-semibold text-slate-100">ReqLab REST</h1>
        <span className="text-xs text-slate-600">local · nothing leaves this machine</span>
        <button
          type="button"
          onClick={() => setShowScenarios(true)}
          disabled={!project}
          className="ml-auto text-xs text-slate-500 hover:text-slate-200 disabled:opacity-40"
        >
          Scenarios
        </button>
        <button
          type="button"
          onClick={() => setShowLab(true)}
          disabled={!project}
          className="text-xs text-slate-500 hover:text-slate-200 disabled:opacity-40"
        >
          Lab
        </button>
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className="text-xs text-slate-500 hover:text-slate-200"
        >
          Settings
        </button>
      </header>

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showLab && <LabPanel onClose={() => setShowLab(false)} />}
      {showScenarios && <ScenarioPanel onClose={() => setShowScenarios(false)} />}

      {error && (
        <div className="flex items-center justify-between gap-4 bg-rose-950/50 px-4 py-2 text-sm text-rose-300">
          <span>{error}</span>
          <button
            type="button"
            onClick={clearError}
            className="text-rose-400 hover:text-rose-200"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <Sidebar />

        <main className="flex min-w-0 flex-1 flex-col">
          <EnvironmentBar />

          {loading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
              Loading…
            </div>
          ) : !project && projects.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm text-slate-400">No projects yet.</p>
              <p className="max-w-sm text-xs text-slate-600">
                Create one with the + button above the request list. A project holds your requests
                and its own environments.
              </p>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col border-r border-slate-800">
                <RequestEditor />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <ResponsePane />
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
