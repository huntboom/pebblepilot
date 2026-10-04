import { randomUUID } from "node:crypto";
import type { Run, SDKAgent } from "@cursor/sdk";
import { CursorBridge } from "./cursor.js";
import { buildAgentPrompt, getDiffStats, getRepoGitInfo } from "./git.js";
import { NotificationBus } from "./notifications.js";
import { ProjectRegistry } from "./projects.js";
import type {
  AgentSession,
  AgentStatus,
  CompactAgent,
  CreateAgentRequest,
  PushPolicy,
} from "./types.js";

interface LiveHandles {
  agent?: SDKAgent;
  run?: Run;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clip(text: string, max = 80): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 3)}...`;
}

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly handles = new Map<string, LiveHandles>();

  constructor(
    private readonly projects: ProjectRegistry,
    private readonly cursor: CursorBridge,
    private readonly bus: NotificationBus,
  ) {}

  list(): CompactAgent[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => this.toCompact(s));
  }

  get(id: string): AgentSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    this.refreshElapsed(session);
    return { ...session, activityLog: [...session.activityLog] };
  }

  /** Most recently updated session for a project (if any). */
  latestForProject(projectId: string): AgentSession | undefined {
    let best: AgentSession | undefined;
    for (const session of this.sessions.values()) {
      if (session.projectId !== projectId) continue;
      if (!best || session.updatedAt > best.updatedAt) best = session;
    }
    if (!best) return undefined;
    this.refreshElapsed(best);
    return { ...best, activityLog: [...best.activityLog] };
  }

  async create(req: CreateAgentRequest): Promise<AgentSession> {
    const prompt = req.prompt?.trim();
    if (!prompt) throw new Error("prompt is required");

    const pushPolicy: PushPolicy = req.pushPolicy ?? "none";

    // Prefer existing /home/hunt/github/<repo>; clone only if missing.
    const project = await this.projects.ensureReady(req.projectId);
    const gitInfo = await getRepoGitInfo(project.cwd);
    const fullPrompt = buildAgentPrompt(prompt, project.cwd, gitInfo, pushPolicy);

    const id = randomUUID();
    const createdAt = nowIso();
    const session: AgentSession = {
      id,
      projectId: project.id,
      projectName: project.name,
      cwd: project.cwd,
      task: clip(prompt, 100),
      status: "starting",
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt,
      elapsedMs: 0,
      lastActivity: gitInfo
        ? `${gitInfo.branch} · ${gitInfo.statusLabel}`
        : "Starting agent...",
      activityLog: [
        gitInfo
          ? `Local ${gitInfo.branch} @ ${gitInfo.head}: ${clip(gitInfo.subject, 60)}`
          : "Starting agent...",
      ],
      needsApproval: false,
    };

    this.sessions.set(id, session);
    this.handles.set(id, {});
    this.publish(session);

    const callbacks = this.makeCallbacks(id);

    try {
      const { agent, run, agentId, runId } = await this.cursor.startAgent(
        project.cwd,
        fullPrompt,
        callbacks,
      );
      const live = this.handles.get(id);
      if (live) {
        live.agent = agent;
        live.run = run;
      }
      session.cursorAgentId = agentId;
      session.runId = runId;
      session.status = "working";
      session.updatedAt = nowIso();
      this.pushActivity(session, "Working");
      this.publish(session);
      this.bus.notify(project.name, "Agent working", id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      session.status = "error";
      session.error = message;
      session.finishedAt = nowIso();
      session.updatedAt = session.finishedAt;
      this.pushActivity(session, `Error: ${message}`);
      this.publish(session);
      this.bus.notify(project.name, "Agent failed to start", id);
    }

    return this.get(id)!;
  }

  async message(id: string, text: string): Promise<AgentSession> {
    const session = this.require(id);
    const prompt = text.trim();
    if (!prompt) throw new Error("text is required");

    const live = this.handles.get(id);
    if (!live?.agent) {
      throw new Error("Agent handle is not available for follow-up");
    }

    session.status = "working";
    session.needsApproval = false;
    session.approvalPrompt = undefined;
    session.error = undefined;
    session.finishedAt = undefined;
    session.updatedAt = nowIso();
    this.pushActivity(session, `You: ${clip(prompt, 60)}`);
    this.publish(session);

    const { run, runId } = await this.cursor.sendFollowUp(
      live.agent,
      prompt,
      this.makeCallbacks(id),
    );
    live.run = run;
    session.runId = runId;
    this.publish(session);
    return this.get(id)!;
  }

  async stop(id: string): Promise<AgentSession> {
    const session = this.require(id);
    const live = this.handles.get(id);
    await this.cursor.stopRun(live?.run);
    session.status = "stopped";
    session.finishedAt = nowIso();
    session.updatedAt = session.finishedAt;
    this.pushActivity(session, "Stopped");
    this.publish(session);
    this.bus.notify(session.projectName, "Agent stopped", id);
    return this.get(id)!;
  }

  async approve(id: string, choice = "continue"): Promise<AgentSession> {
    const session = this.require(id);
    const text =
      choice.toLowerCase() === "no" || choice.toLowerCase() === "reject"
        ? "Stop. Do not proceed with the pending action."
        : "Approved. Continue with the recommended approach.";
    session.needsApproval = false;
    session.approvalPrompt = undefined;
    return this.message(id, text);
  }

  async refreshDiff(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.diff = await getDiffStats(session.cwd);
    session.updatedAt = nowIso();
    this.publish(session);
  }

  private makeCallbacks(id: string) {
    return {
      onActivity: (text: string) => {
        const session = this.sessions.get(id);
        if (!session) return;
        this.pushActivity(session, text);
        this.publish(session);
      },
      onStatus: (status: AgentStatus) => {
        const session = this.sessions.get(id);
        if (!session) return;
        session.status = status;
        session.updatedAt = nowIso();
        if (status === "finished" || status === "error" || status === "stopped") {
          session.finishedAt = session.finishedAt ?? nowIso();
        }
        this.publish(session);
      },
      onError: (message: string) => {
        const session = this.sessions.get(id);
        if (!session) return;
        session.status = "error";
        session.error = message;
        session.finishedAt = nowIso();
        session.updatedAt = session.finishedAt;
        this.pushActivity(session, `Error: ${message}`);
        this.publish(session);
        this.bus.notify(session.projectName, "Agent error", id);
      },
      onFinished: async (summary: string) => {
        const session = this.sessions.get(id);
        if (!session) return;
        session.status = "finished";
        session.resultSummary = clip(summary, 200);
        session.finishedAt = nowIso();
        session.updatedAt = session.finishedAt;
        session.diff = await getDiffStats(session.cwd);
        this.pushActivity(session, "Finished");
        this.publish(session);
        const diffBit = session.diff
          ? `${session.diff.filesChanged} files changed`
          : "Done";
        this.bus.notify(session.projectName, `Agent finished · ${diffBit}`, id);
      },
    };
  }

  private require(id: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown agent: ${id}`);
    this.refreshElapsed(session);
    return session;
  }

  private pushActivity(session: AgentSession, text: string): void {
    const line = clip(text, 100);
    session.lastActivity = line;
    session.activityLog = [line, ...session.activityLog].slice(0, 12);
    session.updatedAt = nowIso();
    this.refreshElapsed(session);
  }

  private refreshElapsed(session: AgentSession): void {
    if (!session.startedAt) {
      session.elapsedMs = 0;
      return;
    }
    const end = session.finishedAt
      ? Date.parse(session.finishedAt)
      : Date.now();
    session.elapsedMs = Math.max(0, end - Date.parse(session.startedAt));
  }

  private toCompact(session: AgentSession): CompactAgent {
    this.refreshElapsed(session);
    return {
      id: session.id,
      projectId: session.projectId,
      projectName: session.projectName,
      task: session.task,
      status: session.status,
      elapsedMs: session.elapsedMs,
      lastActivity: session.lastActivity,
      needsApproval: session.needsApproval,
      diff: session.diff,
    };
  }

  private publish(session: AgentSession): void {
    this.refreshElapsed(session);
    this.bus.emitEvent({ type: "agent", agent: this.get(session.id)! });
    this.bus.emitEvent({ type: "agents", agents: this.list() });
  }
}
