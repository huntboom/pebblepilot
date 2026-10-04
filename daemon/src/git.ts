import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiffStats } from "./types.js";

const execFileAsync = promisify(execFile);

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

    // Also count untracked files roughly via status porcelain
    const { stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      { cwd, timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    const dirtyLines = status.split("\n").filter((l) => l.trim()).length;
    if (dirtyLines > filesChanged) filesChanged = dirtyLines;

    if (filesChanged === 0 && insertions === 0 && deletions === 0) {
      return { filesChanged: 0, insertions: 0, deletions: 0 };
    }

    return { filesChanged, insertions, deletions };
  } catch {
    return undefined;
  }
}
