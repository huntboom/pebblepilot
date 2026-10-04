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
  /** Where this project came from */
  source?: "config" | "github" | "local";
  cloneUrl?: string;
  sshUrl?: string;
  fullName?: string;
}

export interface RepoGitInfo {
  branch: string;
  head: string;
  subject: string;
  dirty: boolean;
  changed: number;
  ahead: number;
  behind: number;
  statusLabel: string;
}

export interface ProjectListItem extends ProjectConfig {
  ready: boolean;
  lastAgentId?: string;
  lastTask?: string;
  lastStatus?: AgentStatus;
  lastActivity?: string;
  git?: RepoGitInfo;
}

export type PushPolicy = "none" | "ask" | "push";

export interface AppConfig {
  host: string;
  port: number;
  token: string;
  cursorApiKeyEnv: string;
  defaultModel: string;
  pollIntervalMs: number;
  projects: ProjectConfig[];
  /** GitHub username/org whose repos appear on the watch */
  githubUser: string;
  /** Local directory where repos are cloned (e.g. ~/github) */
  reposRoot: string;
  /** Optional PAT for private repos + higher rate limits */
  githubToken?: string;
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
  /** none = no commit/push; ask = commit ok, no push; push = commit+push when done */
  pushPolicy?: PushPolicy;
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
