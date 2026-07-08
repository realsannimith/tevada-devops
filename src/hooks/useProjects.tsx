/**
 * Shared project state: the local list of projects (server groupings + per-project
 * agent memory). Mirrors ServersProvider — a thin Context over the
 * window.easyhost.projects.* IPC surface. Server↔project membership lives on the
 * ServerProfile (projectIds); this context owns only the Project records.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import type { Project } from '@/shared/ipc-types';

type NewProject = Pick<Project, 'name' | 'color' | 'memory'>;

type ProjectsCtx = {
  projects: Project[];
  projectOf: (projectId: string | null | undefined) => Project | undefined;
  refresh: () => Promise<void>;
  add: (project: NewProject) => Promise<Project>;
  update: (
    id: string,
    patch: Partial<Omit<Project, 'id' | 'createdAt'>>,
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

const Ctx = createContext<ProjectsCtx | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);

  const refresh = useCallback(async () => {
    const list = await window.easyhost.projects.list();
    setProjects(list);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = useCallback(
    async (project: NewProject) => {
      const created = await window.easyhost.projects.add(project);
      await refresh();
      return created;
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, patch: Partial<Omit<Project, 'id' | 'createdAt'>>) => {
      await window.easyhost.projects.update(id, patch);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await window.easyhost.projects.remove(id);
      await refresh();
      toast.success('Project deleted', {
        description: 'Its servers and chats were kept.',
      });
    },
    [refresh],
  );

  const projectOf = useCallback(
    (projectId: string | null | undefined) =>
      projectId ? projects.find((p) => p.id === projectId) : undefined,
    [projects],
  );

  const value = useMemo(
    () => ({ projects, projectOf, refresh, add, update, remove }),
    [projects, projectOf, refresh, add, update, remove],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProjects(): ProjectsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useProjects must be used within ProjectsProvider');
  return ctx;
}

export type { NewProject };
