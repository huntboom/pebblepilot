import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadEnvFiles } from "./env.js";
import type { AppConfig } from "./types.js";

const DEFAULTS: AppConfig = {
  host: "127.0.0.1",
  port: 8787,
  token: "change-me",
  cursorApiKeyEnv: "CURSOR_API_KEY",
  defaultModel: "composer-2.5",
  pollIntervalMs: 4000,
  projects: [],
  githubUser: "huntboom",
  reposRoot: resolve(homedir(), "github"),
};

function findConfigPath(): string | null {
  const fromEnv = process.env.PEBBLEPILOT_CONFIG;
  if (fromEnv) return resolve(fromEnv);

  const candidates = [
    resolve(process.cwd(), "config.json"),
    resolve(process.cwd(), "../config.json"),
    resolve(import.meta.dirname, "../../config.json"),
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

export function loadConfig(): AppConfig {
  loadEnvFiles();

  const path = findConfigPath();
  const raw = path
    ? (JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>)
    : {};

  const config: AppConfig = {
    ...DEFAULTS,
    ...raw,
    projects: raw.projects ?? [],
    githubUser: raw.githubUser ?? DEFAULTS.githubUser,
    reposRoot: raw.reposRoot ?? DEFAULTS.reposRoot,
  };

  // Env wins for secrets / bind / GitHub settings
  if (process.env.PEBBLEPILOT_HOST) config.host = process.env.PEBBLEPILOT_HOST;
  if (process.env.PEBBLEPILOT_PORT) {
    config.port = Number(process.env.PEBBLEPILOT_PORT) || config.port;
  }
  if (process.env.PEBBLEPILOT_TOKEN) config.token = process.env.PEBBLEPILOT_TOKEN;
  if (process.env.PEBBLEPILOT_GITHUB_USER) {
    config.githubUser = process.env.PEBBLEPILOT_GITHUB_USER;
  }
  if (process.env.PEBBLEPILOT_REPOS_ROOT) {
    config.reposRoot = resolve(process.env.PEBBLEPILOT_REPOS_ROOT);
  } else {
    config.reposRoot = resolve(config.reposRoot);
  }
  if (process.env.GITHUB_TOKEN?.trim()) {
    config.githubToken = process.env.GITHUB_TOKEN.trim();
  } else if (process.env.GH_TOKEN?.trim()) {
    config.githubToken = process.env.GH_TOKEN.trim();
  }

  if (!path) {
    console.warn(
      "[pebblepilot] No config.json found — using GitHub/local discovery + .env.",
    );
  }

  if (
    !config.token ||
    config.token === "change-me" ||
    config.token === "change-me-to-a-long-random-string"
  ) {
    console.warn(
      "[pebblepilot] WARNING: using a weak/default token. Set PEBBLEPILOT_TOKEN in .env.",
    );
  }

  console.log(
    `[pebblepilot] repos: github.com/${config.githubUser} → ${config.reposRoot}`,
  );

  return config;
}

export function resolveApiKey(config: AppConfig): string {
  const key = process.env[config.cursorApiKeyEnv]?.trim();
  if (!key) {
    throw new Error(
      `Missing ${config.cursorApiKeyEnv}. Set it in .env or export it before starting the daemon.`,
    );
  }
  return key;
}
