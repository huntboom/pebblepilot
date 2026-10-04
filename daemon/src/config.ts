import { existsSync, readFileSync } from "node:fs";
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
  };

  // Env wins for secrets / bind settings
  if (process.env.PEBBLEPILOT_HOST) config.host = process.env.PEBBLEPILOT_HOST;
  if (process.env.PEBBLEPILOT_PORT) config.port = Number(process.env.PEBBLEPILOT_PORT) || config.port;
  if (process.env.PEBBLEPILOT_TOKEN) config.token = process.env.PEBBLEPILOT_TOKEN;

  if (!path) {
    console.warn(
      "[pebblepilot] No config.json found — using .env / defaults. Copy config.example.json for projects.",
    );
  }

  if (!config.token || config.token === "change-me" || config.token === "change-me-to-a-long-random-string") {
    console.warn(
      "[pebblepilot] WARNING: using a weak/default token. Set PEBBLEPILOT_TOKEN in .env.",
    );
  }

  if (config.projects.length === 0) {
    console.warn("[pebblepilot] WARNING: no projects configured.");
  }

  for (const project of config.projects) {
    if (!existsSync(project.cwd)) {
      console.warn(
        `[pebblepilot] WARNING: project "${project.id}" cwd does not exist: ${project.cwd}`,
      );
    }
  }

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
