import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiffStats, RepoGitInfo } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(
  cwd: string,
  args: string[],
  timeout = 5000,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

/** Snapshot of a local checkout for the watch / agent prompt context. */
export async function getRepoGitInfo(cwd: string): Promise<RepoGitInfo | undefined> {
  try {
    const [branch, head, subject, porcelain, statusShort] = await Promise.all([
      git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD"),
      git(cwd, ["rev-parse", "--short", "HEAD"]).catch(() => ""),
      git(cwd, ["log", "-1", "--pretty=%s"]).catch(() => ""),
      git(cwd, ["status", "--porcelain"]).catch(() => ""),
      git(cwd, ["status", "-sb"]).catch(() => ""),
    ]);

    const dirtyLines = porcelain
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const dirty = dirtyLines.length > 0;

    // Parse ahead/behind from first line of `git status -sb`, e.g. ## main...origin/main [ahead 1]
    let ahead = 0;
    let behind = 0;
    const track = statusShort.split("\n")[0] || "";
    const aheadMatch = track.match(/ahead (\d+)/);
    const behindMatch = track.match(/behind (\d+)/);
    if (aheadMatch) ahead = Number(aheadMatch[1]) || 0;
    if (behindMatch) behind = Number(behindMatch[1]) || 0;

    let statusLabel = "clean";
    if (dirty) statusLabel = `${dirtyLines.length} changed`;
    else if (ahead && behind) statusLabel = `↑${ahead} ↓${behind}`;
    else if (ahead) statusLabel = `↑${ahead} ahead`;
    else if (behind) statusLabel = `↓${behind} behind`;

    return {
      branch: branch || "HEAD",
      head: head || "",
      subject: subject || "(no commits)",
      dirty,
      changed: dirtyLines.length,
      ahead,
      behind,
      statusLabel,
    };
  } catch {
    return undefined;
  }
}

export async function getDiffStats(cwd: string): Promise<DiffStats | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--numstat", "HEAD"],
      { cwd, timeout: 5000, maxBuffer: 1024 * 1024 },
    );

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;

    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const [ins, del] = line.split("\t");
      if (ins === undefined || del === undefined) continue;
      filesChanged += 1;
      if (ins !== "-") insertions += Number(ins) || 0;
      if (del !== "-") deletions += Number(del) || 0;
    }

    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      { cwd, timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    const dirtyLines = status.split("\n").filter((l) => l.trim()).length;
    if (dirtyLines > filesChanged) filesChanged = dirtyLines;

    return { filesChanged, insertions, deletions };
  } catch {
    return undefined;
  }
}

/** Build the prompt prefix so the agent uses the local checkout correctly. */
export function buildAgentPrompt(
  userTask: string,
  cwd: string,
  gitInfo: RepoGitInfo | undefined,
  pushPolicy: "none" | "ask" | "push",
): string {
  const lines = [
    `Work in this local git checkout (do not re-clone): ${cwd}`,
  ];

  if (gitInfo) {
    lines.push(
      `Branch: ${gitInfo.branch} @ ${gitInfo.head}`,
      `Last commit: ${gitInfo.subject}`,
      `Working tree: ${gitInfo.statusLabel}${gitInfo.dirty ? " (has local changes)" : ""}`,
    );
  } else {
    lines.push("Run `git status` and `git log -1` before making changes.");
  }

  if (pushPolicy === "none") {
    lines.push(
      "Push policy: do NOT commit or push unless the user explicitly asks in this task.",
    );
  } else if (pushPolicy === "ask") {
    lines.push(
      "Push policy: you may commit locally if useful; do NOT push — stop and ask before pushing.",
    );
  } else {
    lines.push(
      "Push policy: when the task is done, commit with a clear message and push to the tracked remote.",
    );
  }

  lines.push("", "User task:", userTask.trim());
  return lines.join("\n");
}
