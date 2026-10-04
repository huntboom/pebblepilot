import { Agent, CursorAgentError, type Run, type SDKAgent } from "@cursor/sdk";
import type { AgentStatus } from "./types.js";

export interface CursorRunCallbacks {
  onActivity: (text: string) => void;
  onStatus: (status: AgentStatus) => void;
  onError: (message: string) => void;
  onFinished: (summary: string) => void | Promise<void>;
}

function extractAssistantText(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as {
    type?: string;
    message?: { content?: Array<{ type?: string; text?: string }> };
  };
  if (e.type !== "assistant" || !e.message?.content) return undefined;
  const parts = e.message.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.join(" ");
}

function extractToolHint(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as {
    type?: string;
    name?: string;
    tool?: string;
    toolCall?: { name?: string };
    message?: { name?: string };
  };
  const name =
    e.name || e.tool || e.toolCall?.name || e.message?.name || undefined;
  if (!name) return undefined;
  if (e.type?.includes("tool") || e.type === "tool_call" || e.type === "tool-call") {
    return `> ${name}`;
  }
  return undefined;
}

export class CursorBridge {
  constructor(
    private apiKey: string,
    private readonly modelId: string,
  ) {}

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey.trim();
  }

  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  async startAgent(
    cwd: string,
    prompt: string,
    callbacks: CursorRunCallbacks,
  ): Promise<{ agent: SDKAgent; run: Run; agentId: string; runId: string }> {
    if (!this.apiKey) {
      throw new Error("CURSOR_API_KEY is not set");
    }
    callbacks.onStatus("starting");

    const agent = await Agent.create({
      apiKey: this.apiKey,
      model: { id: this.modelId },
      local: { cwd },
    });

    const run = await agent.send(prompt);
    callbacks.onStatus("working");
    void this.consumeRun(run, callbacks);

    return {
      agent,
      run,
      agentId: agent.agentId,
      runId: run.id,
    };
  }

  async sendFollowUp(
    agent: SDKAgent,
    text: string,
    callbacks: CursorRunCallbacks,
  ): Promise<{ run: Run; runId: string }> {
    callbacks.onStatus("working");
    const run = await agent.send(text);
    void this.consumeRun(run, callbacks);
    return { run, runId: run.id };
  }

  async stopRun(run: Run | undefined): Promise<void> {
    if (!run) return;
    try {
      if (run.supports("cancel")) {
        await run.cancel();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[pebblepilot] cancel failed: ${message}`);
    }
  }

  async disposeAgent(agent: SDKAgent | undefined): Promise<void> {
    if (!agent) return;
    try {
      await agent[Symbol.asyncDispose]();
    } catch {
      try {
        agent.close();
      } catch {
        // ignore
      }
    }
  }

  private async consumeRun(run: Run, callbacks: CursorRunCallbacks): Promise<void> {
    try {
      for await (const event of run.stream()) {
        const toolHint = extractToolHint(event);
        if (toolHint) callbacks.onActivity(toolHint);

        const text = extractAssistantText(event);
        if (text) {
          const clipped = text.length > 120 ? `${text.slice(0, 117)}...` : text;
          callbacks.onActivity(clipped);
        }
      }

      const result = await run.wait();
      if (result.status === "error") {
        callbacks.onStatus("error");
        callbacks.onError(`Run failed (${result.id})`);
        return;
      }
      if (result.status === "cancelled") {
        callbacks.onStatus("stopped");
        callbacks.onActivity("Stopped");
        return;
      }

      const summary =
        typeof result.result === "string" && result.result.trim()
          ? result.result.trim().slice(0, 240)
          : "Agent finished";
      await callbacks.onFinished(summary);
      callbacks.onStatus("finished");
    } catch (err) {
      if (err instanceof CursorAgentError) {
        callbacks.onStatus("error");
        callbacks.onError(err.message);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      callbacks.onStatus("error");
      callbacks.onError(message);
    }
  }
}
