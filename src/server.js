import http from "node:http";
import os from "node:os";
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  listProjects,
  getProject,
  addProject,
  listThreads,
  getThread,
  addThread,
  updateThread,
  deleteThread,
  appendItem,
  listItems,
  getSetting,
  setSetting,
} from "./db.js";
import { startRelayClient, pairHash } from "./relay-client.js";
import { createWorktree, removeWorktree, getDiff } from "./worktree.js";
import { PiAgent } from "./pi-agent.js";
import { MockAgent } from "./mock-agent.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || "127.0.0.1";
const MOCK = process.env.T3LITE_MOCK === "1";

/** threadId -> { agent, status, pendingUi: Map } */
const sessions = new Map();
const wsClients = new Set();

const log = (...args) => console.log(new Date().toISOString(), ...args);

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState !== 1) continue;
    try {
      ws.send(data);
    } catch {}
  }
}

function send(ws, msg) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function threadStatus(threadId) {
  return sessions.get(threadId)?.status || "idle";
}

function ensureAgent(thread) {
  const existing = sessions.get(thread.id);
  if (existing?.agent?.alive) return existing.agent;

  const project = getProject(thread.project_id);
  const cwd = thread.worktree_path || project?.path;
  if (!cwd || !existsSync(cwd)) {
    throw new Error(`working directory not found: ${cwd || "(empty)"}`);
  }
  const agent = MOCK ? new MockAgent() : new PiAgent({ cwd });
  const state = existing || { pendingUi: new Map() };
  state.agent = agent;
  state.status = "idle";
  sessions.set(thread.id, state);

  agent.on("event", (ev) => handlePiEvent(thread.id, ev).catch((e) => log("event error", e)));
  agent.on("error", (err) => {
    log("agent error", thread.id, err.message);
    appendItem(thread.id, "error", { message: err.message });
    broadcast({ type: "item", threadId: thread.id, item: lastItem(thread.id) });
    setStatus(thread.id, "error");
  });
  agent.on("exit", ({ code, signal }) => {
    log("agent exit", thread.id, code, signal);
    if (state.status === "running" || state.status === "waiting") {
      setStatus(thread.id, "error", { message: `pi exited (${code ?? signal})` });
    }
  });
  agent.on("stderr", (line) => log("pi stderr", line.slice(0, 400)));

  agent.start();

  // Restore the Pi session if this thread has one.
  if (thread.session_file) {
    agent
      .switchSession(thread.session_file)
      .catch((e) => log("switch_session failed", e.message));
  } else {
    agent
      .getState()
      .then((st) => {
        if (st?.sessionFile) updateThread(thread.id, { session_file: st.sessionFile });
      })
      .catch(() => {});
  }

  return agent;
}

function lastItem(threadId) {
  const items = listItems(threadId, 0);
  return items[items.length - 1];
}

function setStatus(threadId, status, extra = {}) {
  const state = sessions.get(threadId);
  if (state) state.status = status;
  updateThread(threadId, { status });
  broadcast({ type: "status", threadId, status, ...extra });
}

async function handlePiEvent(threadId, ev) {
  const thread = getThread(threadId);
  if (!thread) return;
  const state = sessions.get(threadId);

  switch (ev.type) {
    case "message_update": {
      const a = ev.assistantMessageEvent;
      if (a?.type === "text_delta" && a.delta) {
        broadcast({ type: "delta", threadId, text: a.delta });
      } else if (a?.type === "thinking_delta" && a.delta) {
        broadcast({ type: "thinking", threadId, text: a.delta });
      }
      break;
    }

    case "tool_execution_start": {
      const item = appendItem(threadId, "tool_call", {
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        args: ev.args,
      });
      broadcast({ type: "item", threadId, item });
      break;
    }

    case "tool_execution_end": {
      const item = appendItem(threadId, "tool_result", {
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        result: ev.result,
        isError: !!ev.isError,
        durationMs: ev.durationMs,
      });
      broadcast({ type: "item", threadId, item });
      broadcastDiff(threadId);
      break;
    }

    case "message_end": {
      const msg = ev.message;
      if (msg?.role === "assistant") {
        const text = textOf(msg);
        if (text) {
          const item = appendItem(threadId, "agent_message", {
            text,
            stopReason: msg.stopReason,
            usage: msg.usage,
          });
          broadcast({ type: "item", threadId, item });
        }
      }
      break;
    }

    case "extension_ui_request": {
      if (["select", "confirm", "input", "editor"].includes(ev.method)) {
        state?.pendingUi.set(ev.id, ev);
        const item = appendItem(threadId, "permission", {
          requestId: ev.id,
          method: ev.method,
          title: ev.title,
          message: ev.message,
          options: ev.options,
          placeholder: ev.placeholder,
        });
        broadcast({ type: "item", threadId, item });
        setStatus(threadId, "waiting");
      } else {
        broadcast({
          type: "toast",
          threadId,
          method: ev.method,
          message: ev.message || ev.title || ev.statusText || "",
        });
      }
      break;
    }

    case "agent_settled": {
      try {
        const stats = await state?.agent?.getStats?.();
        setStatus(threadId, "idle", { stats });
      } catch {
        setStatus(threadId, "idle");
      }
      broadcastDiff(threadId);
      break;
    }

    case "compaction_start":
      broadcast({ type: "toast", threadId, message: "compacting context…" });
      break;

    case "auto_retry_start":
      broadcast({
        type: "toast",
        threadId,
        message: `retrying (${ev.attempt}/${ev.maxAttempts}): ${ev.errorMessage || ""}`,
      });
      break;

    case "extension_error":
      log("extension error", ev.error);
      break;

    default:
      break;
  }
}

function broadcastDiff(threadId) {
  const thread = getThread(threadId);
  if (!thread) return;
  const d = getDiff(thread.worktree_path || getProject(thread.project_id)?.path);
  broadcast({ type: "diff", threadId, ...d });
}

async function handlePrompt(threadId, text) {
  const thread = getThread(threadId);
  if (!thread) throw new Error("thread not found");
  if (!text?.trim()) return;

  if (threadStatus(threadId) === "running") {
    throw new Error("agent is running; abort first (steering comes later)");
  }

  const item = appendItem(threadId, "user_message", { text });
  broadcast({ type: "item", threadId, item });
  setStatus(threadId, "running");

  try {
    const agent = ensureAgent(thread);
    await agent.prompt(text);
  } catch (err) {
    appendItem(threadId, "error", { message: err.message });
    broadcast({ type: "item", threadId, item: lastItem(threadId) });
    setStatus(threadId, "error");
  }
}

async function handleAbort(threadId) {
  const state = sessions.get(threadId);
  if (!state?.agent) return;
  try {
    await state.agent.abort();
  } catch (e) {
    log("abort failed", e.message);
  }
}

function handlePermission(threadId, requestId, response) {
  const state = sessions.get(threadId);
  const req = state?.pendingUi.get(requestId);
  if (!req) return;
  state.pendingUi.delete(requestId);
  state.agent.respondUi(requestId, response || { cancelled: true });
  setStatus(threadId, "running");
}

function makeThread(projectId, title) {
  const project = getProject(projectId);
  if (!project) throw new Error("project not found");
  const thread = addThread({ projectId, title, agent: "pi" });
  let worktreePath = null;
  try {
    worktreePath = createWorktree(project.path, thread.id);
  } catch (e) {
    log("worktree failed", e.message);
  }
  const updated = updateThread(thread.id, {
    worktree_path: worktreePath || project.path,
  });
  broadcast({ type: "thread", thread: updated });
  return updated;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.includes("..")) {
    res.writeHead(403).end("forbidden");
    return;
  }
  const file = join(PUBLIC, rel);
  if (!existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    "content-type": MIME[file.slice(file.lastIndexOf("."))] || "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const m = req.method;

    if (p === "/api/health") return json(res, 200, { ok: true, mock: MOCK });

    if (p === "/api/bootstrap" && m === "GET") {
      return json(res, 200, {
        projects: listProjects(),
        threads: listThreads(),
        mock: MOCK,
      });
    }

    if (p === "/api/projects" && m === "POST") {
      const body = await readBody(req);
      if (!body.path) return json(res, 400, { error: "path required" });
      if (!existsSync(body.path)) return json(res, 400, { error: "path not found" });
      const project = addProject({ name: body.name, path: body.path });
      broadcast({ type: "project", project });
      return json(res, 200, { project });
    }

    if (p === "/api/threads" && m === "POST") {
      const body = await readBody(req);
      const thread = makeThread(body.projectId, body.title);
      return json(res, 200, { thread });
    }

    const threadMatch = p.match(/^\/api\/threads\/([^/]+)(\/[a-z]+)?$/);
    if (threadMatch) {
      const thread = getThread(threadMatch[1]);
      if (!thread) return json(res, 404, { error: "thread not found" });
      const sub = threadMatch[2];

      if (!sub && m === "DELETE") {
        const project = getProject(thread.project_id);
        removeWorktree(project?.path, thread.worktree_path);
        sessions.get(thread.id)?.agent?.stop?.();
        sessions.delete(thread.id);
        deleteThread(thread.id);
        broadcast({ type: "thread_deleted", threadId: thread.id });
        return json(res, 200, { ok: true });
      }

      if (sub === "/items" && m === "GET") {
        const after = Number(url.searchParams.get("after") || 0);
        return json(res, 200, { items: listItems(thread.id, after) });
      }

      if (sub === "/diff" && m === "GET") {
        const project = getProject(thread.project_id);
        return json(
          res,
          200,
          getDiff(thread.worktree_path || project?.path)
        );
      }
    }

    if (p.startsWith("/api/")) return json(res, 404, { error: "not found" });

    return serveStatic(res, p);
  } catch (err) {
    log("http error", err);
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });

function handleWs(ws) {
  wsClients.add(ws);
  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => wsClients.delete(ws));

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      if (msg.type === "bootstrap") {
        send(ws, {
          type: "bootstrap",
          projects: listProjects(),
          threads: listThreads(),
          mock: MOCK,
        });
        return;
      }
      if (msg.type === "createProject") {
        if (!msg.path) throw new Error("path required");
        if (!existsSync(msg.path)) throw new Error("path not found");
        const project = addProject({ name: msg.name, path: msg.path });
        broadcast({ type: "project", project });
        return;
      }
      if (msg.type === "createThread") {
        const thread = makeThread(msg.projectId, msg.title);
        return;
      }
      if (msg.type === "subscribe") {
        const thread = getThread(msg.threadId);
        if (!thread) return send(ws, { type: "error", error: "thread not found" });
        const project = getProject(thread.project_id);
        const d = getDiff(thread.worktree_path || project?.path);
        send(ws, {
          type: "snapshot",
          thread,
          project,
          items: listItems(thread.id, 0),
          status: threadStatus(thread.id),
          diff: d,
        });
        return;
      }
      if (msg.type === "prompt") {
        await handlePrompt(msg.threadId, msg.text);
        return;
      }
      if (msg.type === "abort") {
        await handleAbort(msg.threadId);
        return;
      }
      if (msg.type === "permission") {
        handlePermission(msg.threadId, msg.requestId, msg.response);
        return;
      }
    } catch (e) {
      send(ws, { type: "error", threadId: msg.threadId, error: e.message });
    }
  });

  send(ws, { type: "hello", mock: MOCK });
}

wss.on("connection", handleWs);

// On boot, nothing is running. Reset transient statuses.
for (const t of listThreads()) {
  if (t.status === "running" || t.status === "waiting") {
    updateThread(t.id, { status: "idle" });
  }
}

server.listen(PORT, HOST, () => {
  log(`t3lite listening on http://${HOST}:${PORT}  (mock=${MOCK})`);
  log("Pi:", process.env.PI_BIN || "pi");
  setupRelay();
});

let relayHandle = null;

function setupRelay() {
  const relayUrl = process.env.RELAY_URL;
  if (!relayUrl) return;

  let serverId = process.env.T3LITE_SERVER_ID || getSetting("server_id");
  if (!serverId) {
    serverId =
      os.hostname().replace(/[^a-zA-Z0-9_-]/g, "-") +
      "-" +
      crypto.randomBytes(2).toString("hex");
    setSetting("server_id", serverId);
  }

  let secret = getSetting("pair_secret");
  if (!secret) {
    secret = crypto.randomBytes(24).toString("base64url");
    setSetting("pair_secret", secret);
  }
  const hash = pairHash(secret);

  relayHandle = startRelayClient({
    url: relayUrl,
    token: process.env.RELAY_TOKEN || "",
    serverId,
    hash,
    onSocket: handleWs,
    log,
  });

  const httpBase = relayUrl.replace(/^ws/, "http").replace(/\/$/, "");
  log(
    `remote url: ${httpBase}/?relay=${encodeURIComponent(
      relayUrl
    )}&server=${encodeURIComponent(serverId)}&hash=${hash}`
  );
}

function shutdown() {
  relayHandle?.stop?.();
  for (const s of sessions.values()) s.agent?.stop?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
