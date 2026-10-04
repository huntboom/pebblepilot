export type AgentStatus =
  | "idle"
  | "starting"
  | "working"
  | "waiting"
  | "finished"
  | "error"
  | "stopped";

export interface ProjectConfig {
  id: string;
  name: string;
  cwd: string;
  presets?: string[];
}

export interface AppConfig {
  host: string;
  port: number;
  token: string;
  cursorApiKeyEnv: string;
  defaultModel: string;
  pollIntervalMs: number;
  projects: ProjectConfig[];
}

export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface AgentSession {
  id: string;
  projectId: string;
  projectName: string;
  cwd: string;
  task: string;
  status: AgentStatus;
  cursorAgentId?: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs: number;
  lastActivity: string;
  activityLog: string[];
  resultSummary?: string;
  error?: string;
  diff?: DiffStats;
  needsApproval: boolean;
  approvalPrompt?: string;
}

export interface CreateAgentRequest {
  projectId: string;
  prompt: string;
}

export interface MessageAgentRequest {
  text: string;
}

export interface CompactAgent {
  id: string;
  projectId: string;
  projectName: string;
  task: string;
  status: AgentStatus;
  elapsedMs: number;
  lastActivity: string;
  needsApproval: boolean;
  diff?: DiffStats;
}

export type WsEvent =
  | { type: "agents"; agents: CompactAgent[] }
  | { type: "agent"; agent: AgentSession }
  | { type: "notification"; title: string; body: string; agentId?: string };

export type ApiErrorCode =
  | "unauthorized"
  | "not_found"
  | "missing_api_key"
  | "validation_error"
  | "invalid_json";

export interface ApiErrorBody {
  error: string;
  code: ApiErrorCode;
}
