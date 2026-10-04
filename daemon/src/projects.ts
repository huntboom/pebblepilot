import type { AppConfig, ProjectConfig } from "./types.js";

export class ProjectRegistry {
  constructor(private readonly config: AppConfig) {}

  list(): ProjectConfig[] {
    return this.config.projects.map((p) => ({ ...p }));
  }

  get(id: string): ProjectConfig | undefined {
    return this.config.projects.find((p) => p.id === id);
  }
}
