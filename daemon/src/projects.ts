import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_PRESETS,
  ensureProjectClone,
  githubReposToProjects,
  listGithubRepos,
  scanLocalRepos,
  slugId,
} from "./github.js";
import { getRepoGitInfo } from "./git.js";
import type {
  AppConfig,
  ProjectConfig,
  ProjectListItem,
  RepoGitInfo,
} from "./types.js";

function mergeProjects(
  configured: ProjectConfig[],
  discovered: ProjectConfig[],
): ProjectConfig[] {
  const byId = new Map<string, ProjectConfig>();

  for (const p of discovered) {
    byId.set(p.id, {
      ...p,
      presets: p.presets?.length ? p.presets : [...DEFAULT_PRESETS],
    });
  }

  // Config wins on cwd / presets / name for the same id
  for (const p of configured) {
    const id = slugId(p.id || p.name);
    const prev = byId.get(id);
    byId.set(id, {
      ...prev,
      ...p,
      id,
      source: "config",
      presets: p.presets?.length
        ? p.presets
        : prev?.presets?.length
          ? prev.presets
          : [...DEFAULT_PRESETS],
      cloneUrl: p.cloneUrl || prev?.cloneUrl,
      sshUrl: p.sshUrl || prev?.sshUrl,
      fullName: p.fullName || prev?.fullName,
    });
  }

  // Prefer an existing local checkout path when both local + github entries merged
  for (const [id, p] of byId) {
    const cwd = resolve(p.cwd);
    if (existsSync(join(cwd, ".git"))) {
      byId.set(id, { ...p, cwd, source: p.source === "config" ? "config" : "local" });
    }
  }

  return [...byId.values()].sort((a, b) => {
    // Local checkouts first, then name
    const ar = existsSync(join(resolve(a.cwd), ".git")) ? 0 : 1;
    const br = existsSync(join(resolve(b.cwd), ".git")) ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export class ProjectRegistry {
  private projects: ProjectConfig[] = [];
  private lastRefreshAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly config: AppConfig) {
    this.projects = mergeProjects(
      config.projects,
      scanLocalRepos(config.reposRoot, config.githubUser),
    );
  }

  list(): ProjectConfig[] {
    return this.projects.map((p) => ({ ...p }));
  }

  get(id: string): ProjectConfig | undefined {
    const key = slugId(id);
    return this.projects.find((p) => p.id === key || slugId(p.name) === key);
  }

  isReady(project: ProjectConfig): boolean {
    return existsSync(join(resolve(project.cwd), ".git"));
  }

  listForApi(
    enrich?: (project: ProjectConfig) => Partial<ProjectListItem>,
  ): ProjectListItem[] {
    return this.projects.map((p) => {
      const extra = enrich?.(p) ?? {};
      return {
        ...p,
        ready: this.isReady(p),
        ...extra,
      };
    });
  }

  async getGitInfo(projectId: string): Promise<RepoGitInfo | undefined> {
    const project = this.get(projectId);
    if (!project || !this.isReady(project)) return undefined;
    return getRepoGitInfo(resolve(project.cwd));
  }

  async detail(
    projectId: string,
    enrich?: (project: ProjectConfig) => Partial<ProjectListItem>,
  ): Promise<ProjectListItem | undefined> {
    await this.refresh(false);
    const project = this.get(projectId);
    if (!project) return undefined;
    const ready = this.isReady(project);
    const git = ready ? await getRepoGitInfo(resolve(project.cwd)) : undefined;
    const extra = enrich?.(project) ?? {};
    return {
      ...project,
      ready,
      git,
      ...extra,
    };
  }

  async refresh(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const stale = Date.now() - this.lastRefreshAt > 60_000;
    if (!force && !stale && this.projects.length > 0) return;

    this.refreshing = (async () => {
      const local = scanLocalRepos(
        this.config.reposRoot,
        this.config.githubUser,
      );
      console.log(
        `[pebblepilot] local checkouts under ${this.config.reposRoot}: ${local.length}`,
      );

      let github: ProjectConfig[] = [];
      const includeRemote = process.env.PEBBLEPILOT_INCLUDE_REMOTE !== "0";

      if (includeRemote) {
        try {
          const repos = await listGithubRepos(
            this.config.githubUser,
            this.config.githubToken,
          );
          github = githubReposToProjects(
            repos,
            this.config.reposRoot,
            this.config.githubUser,
          );
          console.log(
            `[pebblepilot] GitHub: ${repos.length} repos for ${this.config.githubUser}` +
              (this.config.githubToken ? " (authenticated)" : " (public only)"),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[pebblepilot] GitHub list failed: ${message}`);
        }
      }

      // Local paths win; GitHub only fills metadata / remote-only repos
      this.projects = mergeProjects(this.config.projects, [
        ...github,
        ...local,
      ]);
      this.lastRefreshAt = Date.now();
    })().finally(() => {
      this.refreshing = null;
    });

    return this.refreshing;
  }

  /**
   * Use the existing local checkout when present.
   * Only clone from GitHub if the folder is missing (opt-in remote repos).
   */
  async ensureReady(projectId: string): Promise<ProjectConfig> {
    await this.refresh(false);
    const project = this.get(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);

    const cwd = resolve(project.cwd);
    if (existsSync(join(cwd, ".git"))) {
      project.cwd = cwd;
      console.log(`[pebblepilot] using local checkout ${project.name} → ${cwd}`);
      return { ...project };
    }

    console.log(
      `[pebblepilot] no local checkout for ${project.name}; cloning into ${cwd}`,
    );
    const cloned = await ensureProjectClone(project, this.config.githubToken);
    project.cwd = cloned;
    return { ...project };
  }
}
