import { execFileSync } from "node:child_process";
import { existsSync, rmSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { HOME } from "./db.js";

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function isGitRepo(path) {
  try {
    return git(path, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

export function createWorktree(projectPath, threadId) {
  if (!isGitRepo(projectPath)) return projectPath;

  const short = threadId.slice(0, 8);
  const dir = join(HOME, "worktrees", `${basename(projectPath)}-${short}`);
  const branch = `t3/${short}`;

  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }

  try {
    git(projectPath, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  } catch (err) {
    // Branch may already exist from a previous run; retry without -b.
    try {
      git(projectPath, ["worktree", "add", dir, branch]);
    } catch {
      throw new Error(`git worktree failed: ${err.stderr || err.message}`);
    }
  }
  return dir;
}

export function removeWorktree(projectPath, worktreePath) {
  if (!worktreePath || worktreePath === projectPath) return;
  try {
    git(projectPath, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {}
  }
}

export function getDiff(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath) || !isGitRepo(worktreePath)) {
    return { status: "", diff: "" };
  }
  let status = "";
  let diff = "";
  try {
    status = git(worktreePath, ["status", "--porcelain=v1"]).trimEnd();
  } catch {}
  try {
    diff = git(worktreePath, ["diff", "--no-color", "--no-ext-diff"]).trimEnd();
  } catch {}
  // Include staged changes, if any (agent usually doesn't stage).
  try {
    const staged = git(worktreePath, ["diff", "--cached", "--no-color", "--no-ext-diff"]).trimEnd();
    if (staged) diff = [diff, staged].filter(Boolean).join("\n");
  } catch {}

  // `git diff` ignores untracked files. Show small text ones, so a new file is visible.
  for (const line of status.split("\n")) {
    if (!line.startsWith("?? ")) continue;
    const rel = line.slice(3).trim();
    if (!rel) continue;
    const file = join(worktreePath, rel);
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > 128 * 1024) continue;
      const buf = readFileSync(file);
      if (buf.includes(0)) continue;
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      diff = [
        diff,
        `diff --git a/${rel} b/${rel}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${rel}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`),
      ]
        .filter(Boolean)
        .join("\n");
    } catch {}
  }

  return { status, diff };
}
