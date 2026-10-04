import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export interface GithubRepo {
  id: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  sshUrl: string;
  private: boolean;
  updatedAt: string;
}

const DEFAULT_PRESETS = [
  "Summarize this repository in three short bullets.",
  "Check git status and summarize open work.",
  "Suggest one small improvement I can ship today.",
];

function slugId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function ghFetch(url: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "pebblepilot",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200) || res.statusText}`);
  }
  return res;
}

/** List repos owned by `user`. With a token, includes private repos. */
export async function listGithubRepos(
  user: string,
  token?: string,
): Promise<GithubRepo[]> {
  const owner = user.trim();
  if (!owner) return [];

  const out: GithubRepo[] = [];
  let page = 1;
  const maxPages = 10;

  while (page <= maxPages) {
    const url = token
      ? `https://api.github.com/user/repos?per_page=100&page=${page}&affiliation=owner&sort=updated`
      : `https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=100&page=${page}&type=owner&sort=updated`;

    const res = await ghFetch(url, token);
    const batch = (await res.json()) as Array<{
      name: string;
      full_name: string;
      clone_url: string;
      ssh_url: string;
      private: boolean;
      updated_at: string;
      owner?: { login?: string };
      fork?: boolean;
    }>;

    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const repo of batch) {
      const login = repo.owner?.login?.toLowerCase();
      if (login && login !== owner.toLowerCase()) continue;
      if (repo.fork) continue;
      out.push({
        id: slugId(repo.name),
        name: repo.name,
        fullName: repo.full_name,
        cloneUrl: repo.clone_url,
        sshUrl: repo.ssh_url,
        private: !!repo.private,
        updatedAt: repo.updated_at,
      });
    }

    if (batch.length < 100) break;
    page++;
  }

  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

/** Discover git checkouts under reposRoot (e.g. ~/github). */
export function scanLocalRepos(
  reposRoot: string,
  owner = "huntboom",
): ProjectConfig[] {
  const root = resolve(reposRoot);
  if (!existsSync(root)) return [];

  const projects: ProjectConfig[] = [];
  for (const entry of readdirSync(root)) {
    const cwd = join(root, entry);
    try {
      if (!statSync(cwd).isDirectory()) continue;
      if (!existsSync(join(cwd, ".git"))) continue;
    } catch {
      continue;
    }
    const fullName = `${owner}/${entry}`;
    projects.push({
      id: slugId(entry),
      name: entry,
      cwd,
      presets: [...DEFAULT_PRESETS],
      source: "local",
      fullName,
      cloneUrl: `https://github.com/${fullName}.git`,
      sshUrl: `git@github.com:${fullName}.git`,
    });
  }
  return projects;
}

export function githubReposToProjects(
  repos: GithubRepo[],
  reposRoot: string,
  owner: string,
): ProjectConfig[] {
  const root = resolve(reposRoot);
  return repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    cwd: join(root, repo.name),
    presets: [...DEFAULT_PRESETS],
    source: "github" as const,
    cloneUrl: repo.cloneUrl,
    sshUrl: repo.sshUrl,
    fullName: repo.fullName || `${owner}/${repo.name}`,
  }));
}

function cloneUrlFor(project: ProjectConfig, token?: string): string {
  if (token && project.cloneUrl?.startsWith("https://")) {
    return project.cloneUrl.replace(
      "https://",
      `https://x-access-token:${encodeURIComponent(token)}@`,
    );
  }
  // Prefer SSH when available (no token needed if keys are set up)
  if (project.sshUrl) return project.sshUrl;
  if (project.cloneUrl) return project.cloneUrl;
  if (project.fullName) return `git@github.com:${project.fullName}.git`;
  return `git@github.com:${project.name}.git`;
}

/** Ensure the project directory exists as a git clone; clone if missing. */
export async function ensureProjectClone(
  project: ProjectConfig,
  token?: string,
): Promise<string> {
  const cwd = resolve(project.cwd);
  if (existsSync(join(cwd, ".git"))) return cwd;

  if (existsSync(cwd)) {
    throw new Error(
      `Path exists but is not a git repo: ${cwd}. Remove it or point config elsewhere.`,
    );
  }

  const parent = resolve(cwd, "..");
  mkdirSync(parent, { recursive: true });

  const url = cloneUrlFor(project, token);
  console.log(`[pebblepilot] cloning ${project.fullName || project.name} → ${cwd}`);
  try {
    await execFileAsync("git", ["clone", "--depth", "1", url, cwd], {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Fall back to public HTTPS if SSH failed and we have a cloneUrl
    if (project.cloneUrl && url !== project.cloneUrl && !token) {
      console.warn(`[pebblepilot] clone via SSH failed, retrying HTTPS: ${message}`);
      await execFileAsync("git", ["clone", "--depth", "1", project.cloneUrl, cwd], {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } else {
      throw new Error(`Failed to clone ${project.name}: ${message}`);
    }
  }

  return cwd;
}

export { DEFAULT_PRESETS, slugId };
