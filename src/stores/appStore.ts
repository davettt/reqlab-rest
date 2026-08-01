import { create } from 'zustand';
import type { ApiRequest, Environment, Project, RunResult } from '../types';
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
  running: boolean;
  error: string | null;
  loading: boolean;

  loadProjects: () => Promise<void>;
  createProject: (name: string) => Promise<void>;
  openProject: (id: string, options?: { keepDraft?: boolean }) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;

  selectRequest: (id: string) => void;
  newRequest: () => void;
  updateDraft: (patch: Partial<ApiRequest>) => void;
  saveDraft: () => Promise<void>;
  deleteRequest: (id: string) => Promise<void>;

  setEnvironment: (id: string | null) => void;
  saveEnvironment: (env: Environment) => Promise<void>;
  createEnvironment: (name: string) => Promise<void>;

  transfer: (args: {
    targetProjectId: string;
    mode: 'copy' | 'move';
    requestIds?: string[];
    environmentIds?: string[];
  }) => Promise<string | null>;

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
      result: null,
    });
  },

  newRequest() {
    const { draft, dirty, drafts } = get();
    const stashed = dirty && draft ? { ...drafts, [draft.id]: draft } : drafts;
    set({
      drafts: stashed,
      draft: { id: '', ...emptyRequest() } as ApiRequest,
      dirty: true,
      result: null,
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

  async send() {
    const { draft, project, environmentId } = get();
    if (!draft) return;

    set({ running: true, error: null });
    try {
      // The draft is sent inline rather than by id, so unsaved edits are what actually run.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- id is not part of the input
      const { id, ...request } = draft;
      const result = await call<RunResult>('/run', {
        method: 'POST',
        body: JSON.stringify({ projectId: project?.id, environmentId, request }),
      });
      set({ result, running: false });
    } catch (err) {
      set({ error: (err as Error).message, running: false });
    }
  },
}));
