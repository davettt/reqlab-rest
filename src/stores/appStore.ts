import { create } from 'zustand';
import type {
  AiSettings,
  ApiRequest,
  Environment,
  ImportFailure,
  ImportPreview,
  Project,
  RunResult,
  Variable,
  VerifyRun,
} from '../types';
import { emptyRequest } from '../types';

/* ---------------------------------------------------------------- *
 * API client
 * ---------------------------------------------------------------- */

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });

  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;

  if (!res.ok) {
    // Field-level detail from Zod is far more useful than "Invalid request".
    const issues = payload?.issues as { field: string; message: string }[] | undefined;
    const detail = issues?.length
      ? issues.map((i) => `${i.field}: ${i.message}`).join('; ')
      : (payload?.error ?? `HTTP ${res.status}`);
    throw new Error(detail);
  }
  return payload as T;
}

/** Keep the most recent responses only: a stored response can be megabytes. */
const MAX_REMEMBERED = 10;

function remember(
  results: Record<string, RunResult>,
  id: string,
  result: RunResult,
): Record<string, RunResult> {
  const next = { ...results, [id]: result };
  const keys = Object.keys(next);
  if (keys.length <= MAX_REMEMBERED) return next;

  // Drop the oldest insertion — object key order is insertion order for string keys.
  return Object.fromEntries(Object.entries(next).slice(keys.length - MAX_REMEMBERED));
}

interface State {
  projects: Pick<Project, 'id' | 'name'>[];
  project: Project | null;
  requests: ApiRequest[];
  environments: Environment[];
  environmentId: string | null;

  /** The request being edited. Held separately from `requests` so you can send before saving. */
  draft: ApiRequest | null;
  dirty: boolean;
  /**
   * Unsaved edits, keyed by request id (empty string for a brand-new request).
   *
   * Without this, switching request — or any action that reloads the project, which used to
   * include move/copy — silently replaced the editor with the stored copy and threw the edits
   * away. Losing typed work with no warning is not an acceptable failure mode.
   */
  drafts: Record<string, ApiRequest>;

  result: RunResult | null;
  /**
   * The last response per request, so switching away and back shows what that request
   * returned rather than an empty pane. Capped, because a response can be megabytes.
   */
  results: Record<string, RunResult>;
  running: boolean;
  error: string | null;
  loading: boolean;

  loadProjects: () => Promise<void>;
  createProject: (name: string) => Promise<void>;
  openProject: (id: string, options?: { keepDraft?: boolean }) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;

  selectRequest: (id: string) => void;
  newRequest: () => void;
  updateDraft: (patch: Partial<ApiRequest>) => void;
  saveDraft: () => Promise<void>;
  deleteRequest: (id: string) => Promise<void>;

  setEnvironment: (id: string | null) => void;
  saveEnvironment: (env: Environment) => Promise<void>;
  createEnvironment: (name: string) => Promise<void>;
  renameEnvironment: (id: string, name: string) => Promise<void>;
  deleteEnvironment: (id: string) => Promise<void>;

  transfer: (args: {
    targetProjectId: string;
    mode: 'copy' | 'move';
    requestIds?: string[];
    environmentIds?: string[];
  }) => Promise<string | null>;

  importPreview: (
    input: ({ url: string } | { text: string }) & { useAi?: boolean },
  ) => Promise<ImportPreview | ImportFailure>;
  importApply: (args: {
    projectId: string;
    environmentId?: string | null;
    environmentName: string;
    requests: ApiRequest[];
    variables: Variable[];
  }) => Promise<string | null>;

  settings: AiSettings | null;
  runs: Pick<VerifyRun, 'id' | 'startedAt' | 'summary'>[];
  loadRuns: (projectId: string) => Promise<void>;
  runVerification: (args: {
    projectId: string;
    suites: string[];
    environmentIds: string[];
    spec?: unknown;
    specText?: string;
    specUrl?: string;
    acknowledged: boolean;
  }) => Promise<VerifyRun | { error: string }>;
  loadSettings: () => Promise<void>;
  saveSettings: (
    patch: Partial<AiSettings> & { apiKeys?: Record<string, string> },
  ) => Promise<void>;

  generateCode: (
    request: ApiRequest,
    target: string,
    inlineSecrets: boolean,
  ) => Promise<{ code: string; notes: string[] } | null>;

  send: () => Promise<void>;
  clearError: () => void;
}

export const useStore = create<State>((set, get) => ({
  projects: [],
  project: null,
  requests: [],
  environments: [],
  environmentId: null,
  draft: null,
  dirty: false,
  drafts: {},
  results: {},
  settings: null,
  runs: [],
  result: null,
  running: false,
  error: null,
  loading: false,

  clearError: () => set({ error: null }),

  async loadProjects() {
    try {
      const { projects } = await call<{ projects: Project[] }>('/projects');
      set({ projects });
      if (!get().project && projects[0]) await get().openProject(projects[0].id);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async createProject(name) {
    try {
      const project = await call<Project>('/projects', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      await get().loadProjects();
      await get().openProject(project.id);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async openProject(id, options) {
    set({ loading: true });
    const previous = get();
    // keepDraft is used by actions that reload the project as a side effect (move/copy):
    // refreshing the sidebar must never cost the user their in-progress edits.
    const keep = options?.keepDraft && previous.project?.id === id;

    try {
      const data = await call<{
        project: Project;
        requests: ApiRequest[];
        environments: Environment[];
      }>(`/projects/${id}`);

      set({
        project: data.project,
        requests: data.requests,
        environments: data.environments,
        environmentId: keep ? previous.environmentId : (data.environments[0]?.id ?? null),
        draft: keep ? previous.draft : (data.requests[0] ?? null),
        dirty: keep ? previous.dirty : false,
        drafts: keep ? previous.drafts : {},
        result: keep ? previous.result : null,
        results: keep ? previous.results : {},
        loading: false,
      });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  async deleteProject(id) {
    try {
      await call(`/projects/${id}`, { method: 'DELETE' });
      set({ project: null, requests: [], environments: [], draft: null, result: null });
      await get().loadProjects();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async renameProject(id, name) {
    try {
      await call<Project>(`/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      await get().loadProjects();
      const project = get().project;
      if (project?.id === id) set({ project: { ...project, name } });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  selectRequest(id) {
    const { draft, dirty, drafts, requests } = get();

    // Stash the outgoing edits so switching away and back does not lose them.
    const stashed = dirty && draft ? { ...drafts, [draft.id]: draft } : drafts;

    const target = stashed[id] ?? requests.find((r) => r.id === id);
    if (!target) return;

    set({
      drafts: stashed,
      draft: { ...target },
      dirty: Boolean(stashed[id]),
      // Show what this request last returned. Clearing it meant a response was gone the
      // moment you looked at anything else.
      result: get().results[id] ?? null,
    });
  },

  newRequest() {
    const { draft, dirty, drafts } = get();
    const stashed = dirty && draft ? { ...drafts, [draft.id]: draft } : drafts;
    set({
      drafts: stashed,
      draft: { id: '', ...emptyRequest() } as ApiRequest,
      dirty: true,
      result: get().results[''] ?? null,
    });
  },

  updateDraft(patch) {
    const draft = get().draft;
    if (!draft) return;
    set({ draft: { ...draft, ...patch }, dirty: true });
  },

  async saveDraft() {
    const { draft, project } = get();
    if (!draft || !project) return;

    try {
      const { id, ...payload } = draft;
      const saved = id
        ? await call<ApiRequest>(`/projects/${project.id}/requests/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          })
        : await call<ApiRequest>(`/projects/${project.id}/requests`, {
            method: 'POST',
            body: JSON.stringify(payload),
          });

      const requests = id
        ? get().requests.map((r) => (r.id === id ? saved : r))
        : [...get().requests, saved];

      // Drop the stashed edits for this request (and the "new request" slot) now they are
      // persisted. Rebuilt rather than deleted so the keys stay statically analysable.
      const remaining = Object.fromEntries(
        Object.entries(get().drafts).filter(([key]) => key !== id && key !== ''),
      );

      set({
        requests: requests.sort((a, b) => a.name.localeCompare(b.name)),
        draft: saved,
        dirty: false,
        drafts: remaining,
      });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async deleteRequest(id) {
    const project = get().project;
    if (!project) return;
    try {
      await call(`/projects/${project.id}/requests/${id}`, { method: 'DELETE' });
      const requests = get().requests.filter((r) => r.id !== id);
      set({
        requests,
        draft: get().draft?.id === id ? (requests[0] ?? null) : get().draft,
        dirty: false,
      });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  setEnvironment(id) {
    set({ environmentId: id });
  },

  async createEnvironment(name) {
    const project = get().project;
    if (!project) return;
    try {
      const env = await call<Environment>(`/projects/${project.id}/environments`, {
        method: 'POST',
        body: JSON.stringify({ name, variables: [] }),
      });
      set({ environments: [...get().environments, env], environmentId: env.id });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async saveEnvironment(environment) {
    const project = get().project;
    if (!project) return;
    try {
      const saved = await call<Environment>(
        `/projects/${project.id}/environments/${environment.id}`,
        { method: 'PATCH', body: JSON.stringify(environment) },
      );
      set({ environments: get().environments.map((e) => (e.id === saved.id ? saved : e)) });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async renameEnvironment(id, name) {
    const project = get().project;
    if (!project) return;
    try {
      const saved = await call<Environment>(`/projects/${project.id}/environments/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      set({ environments: get().environments.map((e) => (e.id === id ? saved : e)) });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async deleteEnvironment(id) {
    const project = get().project;
    if (!project) return;
    try {
      await call(`/projects/${project.id}/environments/${id}`, { method: 'DELETE' });
      const remaining = get().environments.filter((e) => e.id !== id);
      set({
        environments: remaining,
        // Fall back to another environment rather than none: leaving nothing selected makes
        // every {{variable}} silently unresolved.
        environmentId:
          get().environmentId === id ? (remaining[0]?.id ?? null) : get().environmentId,
      });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async transfer(args) {
    const project = get().project;
    if (!project) return null;
    try {
      const result = await call<{
        mode: string;
        target: string;
        requests: string[];
        environments: string[];
      }>(`/projects/${project.id}/transfer`, { method: 'POST', body: JSON.stringify(args) });
      // Reload so a move is reflected in the sidebar immediately — but keep whatever is in
      // the editor: refreshing a list must not discard unsaved work.
      await get().openProject(project.id, { keepDraft: true });
      await get().loadProjects();

      const parts = [];
      if (result.requests.length) parts.push(`${result.requests.length} request(s)`);
      if (result.environments.length) parts.push(`${result.environments.length} environment(s)`);
      return `${result.mode === 'move' ? 'Moved' : 'Copied'} ${parts.join(' and ')} to ${result.target}`;
    } catch (err) {
      set({ error: (err as Error).message });
      return null;
    }
  },

  async importPreview(input) {
    try {
      return await call<ImportPreview>('/import/preview', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    } catch (err) {
      // Reported inside the dialog rather than the global banner: it is part of the flow,
      // and "that is not a spec" is guidance, not a failure of the app.
      const message = (err as Error).message;
      return {
        error: message,
        unstructured: message.includes('written documentation'),
        needsKey: message.includes('API key is configured'),
      };
    }
  },

  async importApply(args) {
    try {
      const result = await call<{
        requests: number;
        environmentId: string | null;
        addedVariables: string[];
        keptVariables: string[];
        secretsToFill: string[];
      }>('/import/apply', {
        method: 'POST',
        body: JSON.stringify(args),
      });
      await get().openProject(args.projectId);

      // Select the environment the import just created. openProject picks the first
      // environment, which left an imported baseUrl unselected and every imported request
      // failing with an unresolved {{baseUrl}}.
      if (result.environmentId) set({ environmentId: result.environmentId });

      const parts = [`Imported ${result.requests} request${result.requests === 1 ? '' : 's'}.`];
      if (result.addedVariables.length) {
        parts.push(`Added variables: ${result.addedVariables.join(', ')}.`);
      }
      if (result.keptVariables.length) {
        parts.push(`Kept your existing values for: ${result.keptVariables.join(', ')}.`);
      }
      if (result.secretsToFill.length) {
        parts.push(`Fill in the secret variables: ${result.secretsToFill.join(', ')}.`);
      }
      return parts.join(' ');
    } catch (err) {
      set({ error: (err as Error).message });
      return null;
    }
  },

  async loadRuns(projectId) {
    try {
      const { runs } = await call<{ runs: VerifyRun[] }>(`/verify/${projectId}/runs`);
      set({ runs });
    } catch {
      // A missing run history is not worth an error banner: it just means none have run.
      set({ runs: [] });
    }
  },

  async runVerification(args) {
    try {
      const run = await call<VerifyRun>('/verify', {
        method: 'POST',
        body: JSON.stringify(args),
      });
      await get().loadRuns(args.projectId);
      return run;
    } catch (err) {
      // Reported inside the Lab rather than the global banner: the refusal to test a host
      // you have not vouched for is part of the flow, not a failure of the app.
      return { error: (err as Error).message };
    }
  },

  async loadSettings() {
    try {
      set({ settings: await call<AiSettings>('/settings') });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async saveSettings(patch) {
    try {
      const updated = await call<AiSettings>('/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      set({ settings: updated });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async generateCode(request, target, inlineSecrets) {
    const { project, environmentId } = get();
    try {
      // The id is not part of the codegen input; the rest of the request is.
      const definition = { ...request, id: undefined };
      delete definition.id;

      return await call<{ code: string; notes: string[] }>('/codegen', {
        method: 'POST',
        body: JSON.stringify({
          target,
          request: definition,
          projectId: project?.id,
          environmentId,
          inlineSecrets,
        }),
      });
    } catch (err) {
      set({ error: (err as Error).message });
      return null;
    }
  },

  async send() {
    const { draft, project, environmentId } = get();
    if (!draft) return;

    set({ running: true, error: null });
    try {
      // The draft is sent inline rather than by id, so unsaved edits are what actually run.
      // The id is still needed, to file the response against the request it came from.
      const { id, ...request } = draft;
      const result = await call<RunResult>('/run', {
        method: 'POST',
        body: JSON.stringify({ projectId: project?.id, environmentId, request }),
      });
      set({ result, running: false, results: remember(get().results, id, result) });
    } catch (err) {
      set({ error: (err as Error).message, running: false });
    }
  },
}));
