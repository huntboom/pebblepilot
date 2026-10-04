import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { isAuthorized } from "./auth.js";
import type { CursorBridge } from "./cursor.js";
import type {
  ApiErrorCode,
  AppConfig,
  CreateAgentRequest,
  MessageAgentRequest,
  WsEvent,
} from "./types.js";
import type { ProjectRegistry } from "./projects.js";
import type { SessionManager } from "./sessions.js";
import type { NotificationBus } from "./notifications.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, x-cursor-api-key",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(payload);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: ApiErrorCode,
  error: string,
): void {
  sendJson(res, status, { error, code });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {} as T;
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Invalid JSON body");
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function errorFromMessage(message: string): { status: number; code: ApiErrorCode } {
  if (message.startsWith("Unknown agent:") || message.startsWith("Unknown project:")) {
    return { status: 404, code: "not_found" };
  }
  if (
    message === "prompt is required" ||
    message === "text is required" ||
    message.includes("Agent handle is not available")
  ) {
    return { status: 400, code: "validation_error" };
  }
  if (message === "CURSOR_API_KEY is not set") {
    return { status: 400, code: "missing_api_key" };
  }
  return { status: 400, code: "validation_error" };
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Compact watch-friendly payloads */
function pebbleAgents(sessions: SessionManager) {
  return sessions.list().map((a) => ({
    id: a.id,
    projectId: a.projectId,
    name: a.projectName,
    task: a.task,
    status: a.status,
    elapsed: formatElapsed(a.elapsedMs),
    activity: a.lastActivity,
    needsApproval: a.needsApproval,
    files: a.diff?.filesChanged ?? 0,
  }));
}

function pebbleAgent(sessions: SessionManager, id: string) {
  const a = sessions.get(id);
  if (!a) return null;
  return {
    id: a.id,
    name: a.projectName,
    task: a.task,
    status: a.status,
    elapsed: formatElapsed(a.elapsedMs),
    activity: a.lastActivity,
    log: a.activityLog.slice(0, 6),
    summary: a.resultSummary ?? "",
    error: a.error ?? "",
    needsApproval: a.needsApproval,
    approvalPrompt: a.approvalPrompt ?? "",
    files: a.diff?.filesChanged ?? 0,
    insertions: a.diff?.insertions ?? 0,
    deletions: a.diff?.deletions ?? 0,
  };
}

export function startServer(
  config: AppConfig,
  projects: ProjectRegistry,
  sessions: SessionManager,
  bus: NotificationBus,
  cursor: CursorBridge,
): { close: () => Promise<void> } {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          service: "pebblepilot",
          hasApiKey: cursor.hasApiKey(),
        });
        return;
      }

      if (!isAuthorized(req, config)) {
        sendError(res, 401, "unauthorized", "Unauthorized");
        return;
      }

      // Phone/Clay can supply the Cursor API key on every request.
      const headerKey = req.headers["x-cursor-api-key"];
      if (typeof headerKey === "string" && headerKey.trim()) {
        cursor.setApiKey(headerKey);
      }

      if (req.method === "GET" && url.pathname === "/settings") {
        sendJson(res, 200, {
          hasApiKey: cursor.hasApiKey(),
          defaultModel: config.defaultModel,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/settings") {
        const body = await readJson<{ cursorApiKey?: string }>(req);
        if (typeof body.cursorApiKey === "string" && body.cursorApiKey.trim()) {
          cursor.setApiKey(body.cursorApiKey.trim());
          console.log(
            `[pebblepilot] Cursor API key updated via /settings (len=${body.cursorApiKey.trim().length})`,
          );
        }
        sendJson(res, 200, { ok: true, hasApiKey: cursor.hasApiKey() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/agents" && !cursor.hasApiKey()) {
        sendError(
          res,
          400,
          "missing_api_key",
          "CURSOR_API_KEY missing on daemon. Open PebblePilot settings on your phone, paste your Cursor API key, and Save.",
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/projects/refresh") {
        await projects.refresh(true);
        sendJson(res, 200, {
          ok: true,
          projects: projects.listForApi((p) => {
            const last = sessions.latestForProject(p.id);
            return last
              ? {
                  lastAgentId: last.id,
                  lastTask: last.task,
                  lastStatus: last.status,
                  lastActivity: last.lastActivity,
                }
              : {};
          }),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/projects") {
        // Refresh GitHub/local list in the background; await if still empty.
        if (projects.list().length === 0) await projects.refresh(true);
        else void projects.refresh(false);

        sendJson(res, 200, {
          projects: projects.listForApi((p) => {
            const last = sessions.latestForProject(p.id);
            return last
              ? {
                  lastAgentId: last.id,
                  lastTask: last.task,
                  lastStatus: last.status,
                  lastActivity: last.lastActivity,
                }
              : {};
          }),
        });
        return;
      }

      const projectMatch = url.pathname.match(/^\/projects\/([^/]+)$/);
      if (req.method === "GET" && projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1]!);
        const detail = await projects.detail(projectId, (p) => {
          const last = sessions.latestForProject(p.id);
          return last
            ? {
                lastAgentId: last.id,
                lastTask: last.task,
                lastStatus: last.status,
                lastActivity: last.lastActivity,
              }
            : {};
        });
        if (!detail) {
          sendError(res, 404, "not_found", "Project not found");
          return;
        }
        sendJson(res, 200, { project: detail });
        return;
      }

      if (req.method === "GET" && url.pathname === "/agents") {
        sendJson(res, 200, { agents: sessions.list() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/pebble/agents") {
        sendJson(res, 200, { agents: pebbleAgents(sessions) });
        return;
      }

      const agentMatch = url.pathname.match(/^\/agents\/([^/]+)(?:\/(stop|message|approve))?$/);
      const pebbleAgentMatch = url.pathname.match(/^\/pebble\/agents\/([^/]+)$/);

      if (req.method === "GET" && pebbleAgentMatch) {
        const agent = pebbleAgent(sessions, decodeURIComponent(pebbleAgentMatch[1]!));
        if (!agent) {
          sendError(res, 404, "not_found", "Agent not found");
          return;
        }
        sendJson(res, 200, { agent });
        return;
      }

      if (req.method === "GET" && agentMatch && !agentMatch[2]) {
        const agent = sessions.get(decodeURIComponent(agentMatch[1]!));
        if (!agent) {
          sendError(res, 404, "not_found", "Agent not found");
          return;
        }
        sendJson(res, 200, { agent });
        return;
      }

      if (req.method === "POST" && url.pathname === "/agents") {
        const body = await readJson<CreateAgentRequest>(req);
        const agent = await sessions.create(body);
        sendJson(res, 201, { agent });
        return;
      }

      if (req.method === "POST" && agentMatch?.[2] === "stop") {
        const agent = await sessions.stop(decodeURIComponent(agentMatch[1]!));
        sendJson(res, 200, { agent });
        return;
      }

      if (req.method === "POST" && agentMatch?.[2] === "message") {
        const body = await readJson<MessageAgentRequest>(req);
        const agent = await sessions.message(decodeURIComponent(agentMatch[1]!), body.text);
        sendJson(res, 200, { agent });
        return;
      }

      if (req.method === "POST" && agentMatch?.[2] === "approve") {
        const body = await readJson<{ choice?: string }>(req);
        const agent = await sessions.approve(
          decodeURIComponent(agentMatch[1]!),
          body.choice ?? "continue",
        );
        sendJson(res, 200, { agent });
        return;
      }

      sendError(res, 404, "not_found", "Not found");
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const { status, code } = errorFromMessage(message);
      sendError(res, status, code, message);
    }
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WebSocket>();

  wss.on("connection", (socket, req) => {
    if (!isAuthorized(req, config)) {
      socket.close(1008, "unauthorized");
      return;
    }

    clients.add(socket);
    const hello: WsEvent = { type: "agents", agents: sessions.list() };
    socket.send(JSON.stringify(hello));

    socket.on("close", () => clients.delete(socket));
  });

  const onEvent = (event: WsEvent) => {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  };
  bus.on("event", onEvent);

  server.listen(config.port, config.host, () => {
    console.log(
      `[pebblepilot] listening on http://${config.host}:${config.port} (ws /ws)`,
    );
  });

  return {
    close: async () => {
      bus.off("event", onEvent);
      for (const client of clients) client.close();
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
