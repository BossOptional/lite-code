const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const S = {
  projects: [],
  threads: [],
  activeProjectId: localStorage.getItem("t3lite.project") || null,
  activeThreadId: localStorage.getItem("t3lite.thread") || null,
  items: [],
  status: "idle",
  diff: { status: "", diff: "" },
  ws: null,
  liveEl: null,
  mock: false,
  retry: 0,
  pendingThread: false,
};

/* Remote mode: ?relay=wss://...&server=...&hash=... */
const params = new URLSearchParams(location.search);
if (params.get("local") === "1") {
  localStorage.removeItem("t3lite.remote");
}
let REMOTE = null;
if (params.get("relay") && params.get("server") && params.get("hash")) {
  REMOTE = {
    relay: params.get("relay"),
    server: params.get("server"),
    hash: params.get("hash"),
  };
  localStorage.setItem("t3lite.remote", JSON.stringify(REMOTE));
  history.replaceState(null, "", location.pathname);
} else {
  try {
    REMOTE = JSON.parse(localStorage.getItem("t3lite.remote") || "null");
  } catch {
    REMOTE = null;
  }
}

function sendMsg(obj) {
  if (!S.ws || S.ws.readyState !== 1) return;
  S.ws.send(
    REMOTE ? JSON.stringify({ type: "data", data: JSON.stringify(obj) }) : JSON.stringify(obj)
  );
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function showToast(text, ms = 2600) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (t.hidden = true), ms);
}

function setConn(ok, text) {
  const c = $("#conn");
  c.textContent = text;
  c.className = "conn " + (ok ? "ok" : "bad");
}

/* ---------- sidebar ---------- */

function renderProjects() {
  const box = $("#projects");
  box.replaceChildren();
  if (!S.projects.length) {
    box.append(el("div", "project", "还没有项目"));
    return;
  }
  for (const p of S.projects) {
    const n = el("div", "project" + (p.id === S.activeProjectId ? " active" : ""));
    n.append(el("b", null, p.name), el("small", null, p.path));
    n.onclick = () => {
      S.activeProjectId = p.id;
      localStorage.setItem("t3lite.project", p.id);
      renderProjects();
      renderThreads();
      $("#addThread").disabled = false;
    };
    box.append(n);
  }
}

function renderThreads() {
  const box = $("#threads");
  box.replaceChildren();
  const list = S.threads.filter(
    (t) => !S.activeProjectId || t.project_id === S.activeProjectId
  );
  if (!list.length) {
    box.append(el("div", "project", "还没有线程"));
    return;
  }
  for (const t of list) {
    const n = el("div", "thread" + (t.id === S.activeThreadId ? " active" : ""));
    const s = el("span", "s " + (t.status || "idle"));
    const wrap = el("div", "t");
    wrap.append(el("b", null, t.title || "New thread"));
    wrap.append(el("small", null, `${t.agent || "pi"} · ${fmtTime(t.updated_at)}`));
    n.append(s, wrap);
    n.onclick = () => selectThread(t.id);
    box.append(n);
  }
}

/* ---------- messages ---------- */

function clearMessages() {
  $("#messages").replaceChildren();
  S.liveEl = null;
}

function nearBottom() {
  const m = $("#messages");
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
}

function scrollBottom(force = false) {
  const m = $("#messages");
  if (force || nearBottom()) m.scrollTop = m.scrollHeight;
}

function renderItems() {
  clearMessages();
  const box = $("#messages");
  for (const item of S.items) {
    const n = renderItem(item);
    if (n) box.append(n);
  }
  scrollBottom(true);
}

function renderItem(item) {
  const box = $("#messages");
  if (item.type === "user_message") {
    const w = el("div", "msg user");
    const b = el("div", "bubble", item.payload?.text || "");
    w.append(b);
    return w;
  }

  if (item.type === "agent_message") {
    S.liveEl?.remove();
    S.liveEl = null;
    const w = el("div", "msg agent");
    w.append(el("div", "bubble", item.payload?.text || ""));
    return w;
  }

  if (item.type === "error") {
    const w = el("div", "msg error");
    w.append(el("div", "bubble", item.payload?.message || "unknown error"));
    return w;
  }

  if (item.type === "tool_call") {
    const p = item.payload || {};
    const card = el("div", "tool");
    card.dataset.toolId = p.toolCallId || "";
    const head = el("div", "tool-head");
    head.append(el("b", null, p.toolName || "tool"), el("span", "tag", "running"));
    const pre = el("pre");
    pre.textContent = JSON.stringify(p.args ?? {}, null, 2);
    card.append(head, pre);
    head.onclick = () => (pre.hidden = !pre.hidden);
    return card;
  }

  if (item.type === "tool_result") {
    const p = item.payload || {};
    const existing = p.toolCallId
      ? box.querySelector(`[data-tool-id="${CSS.escape(p.toolCallId)}"]`)
      : null;
    const out = el("pre");
    out.textContent = toolResultText(p.result);
    if (existing) {
      existing.classList.toggle("error", !!p.isError);
      const tag = existing.querySelector(".tag");
      if (tag) tag.textContent = p.isError ? "error" : "done";
      existing.append(out);
      return null;
    }
    const card = el("div", "tool" + (p.isError ? " error" : ""));
    const head = el("div", "tool-head");
    head.append(el("b", null, p.toolName || "tool"), el("span", "tag", p.isError ? "error" : "done"));
    card.append(head, out);
    return card;
  }

  if (item.type === "permission") {
    return renderPermission(item.payload || {});
  }

  return null;
}

function toolResultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) {
    return result.content
      .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
  }
  return JSON.stringify(result, null, 2);
}

function renderPermission(p) {
  const card = el("div", "perm");
  card.append(el("div", "pt", p.title || "需要你的确认"));
  if (p.message) card.append(el("div", "pm", p.message));
  const bar = el("div", "pb");

  const respond = (response) => {
    sendMsg({
      type: "permission",
      threadId: S.activeThreadId,
      requestId: p.requestId,
      response,
    });
    bar.querySelectorAll("button").forEach((b) => (b.disabled = true));
    card.append(el("div", "pm", "已响应"));
  };

  if (p.method === "confirm") {
    const allow = el("button", null, "允许");
    allow.onclick = () => respond({ confirmed: true });
    const deny = el("button", "cancel", "拒绝");
    deny.onclick = () => respond({ confirmed: false });
    bar.append(allow, deny);
  } else if (p.method === "select") {
    for (const opt of p.options || []) {
      const b = el("button", null, opt);
      b.onclick = () => respond({ value: opt });
      bar.append(b);
    }
  } else if (p.method === "input" || p.method === "editor") {
    const b = el("button", null, "填写…");
    b.onclick = () => {
      const v = window.prompt(p.title || "输入", "");
      if (v == null) respond({ cancelled: true });
      else respond({ value: v });
    };
    bar.append(b);
  }

  const cancel = el("button", "cancel", "取消");
  cancel.onclick = () => respond({ cancelled: true });
  bar.append(cancel);
  card.append(bar);
  return card;
}

function appendDelta(text) {
  const box = $("#messages");
  if (!S.liveEl) {
    const w = el("div", "msg agent");
    S.liveEl = el("div", "bubble live");
    w.append(S.liveEl);
    box.append(w);
  }
  S.liveEl.textContent += text;
  scrollBottom();
}

/* ---------- status / diff ---------- */

function setStatus(status, stats) {
  S.status = status;
  $("#statusDot").className = "status-dot " + status;
  $("#statusText").textContent = status;
  $("#abortBtn").disabled = status !== "running" && status !== "waiting";
  const t = S.threads.find((x) => x.id === S.activeThreadId);
  if (t) t.status = status;
  renderThreads();
  if (stats?.tokens) {
    $("#threadMeta").textContent = `${stats.tokens.total ?? 0} tokens · $${(
      stats.cost ?? 0
    ).toFixed(3)}`;
  }
}

function renderDiff(d) {
  S.diff = d || { status: "", diff: "" };
  $("#diffBtn").disabled = !S.activeThreadId;
  const body = $("#diffBody");
  body.replaceChildren();
  const text = [S.diff.status, S.diff.diff].filter(Boolean).join("\n\n");
  if (!text.trim()) {
    body.textContent = "工作区没有改动。";
    return;
  }
  const frag = document.createDocumentFragment();
  for (const line of text.split("\n")) {
    const span = el("span");
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index "))
      span.className = "meta";
    else if (line.startsWith("+")) span.className = "add";
    else if (line.startsWith("-")) span.className = "del";
    else if (line.startsWith("@@")) span.className = "hunk";
    span.textContent = line + "\n";
    frag.append(span);
  }
  body.append(frag);
}

function openDrawer() {
  $("#drawer").hidden = false;
  renderDiff(S.diff);
}
function closeDrawer() {
  $("#drawer").hidden = true;
}

/* ---------- selection ---------- */

function selectThread(id) {
  S.activeThreadId = id;
  localStorage.setItem("t3lite.thread", id);
  const t = S.threads.find((x) => x.id === id);
  const p = S.projects.find((x) => x.id === t?.project_id);
  $("#threadTitle").textContent = t?.title || "Thread";
  $("#threadMeta").textContent = [p?.name, t?.worktree_path].filter(Boolean).join(" · ");
  $("#input").disabled = false;
  $("#send").disabled = false;
  $("#diffBtn").disabled = false;
  $("#addThread").disabled = !S.activeProjectId;
  clearMessages();
  sendMsg({ type: "subscribe", threadId: id });
  closeSidebar();
}

/* ---------- websocket ---------- */

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let endpoint;
  if (REMOTE) {
    const base = REMOTE.relay.replace(/^http/, "ws").replace(/\/$/, "");
    endpoint = `${base}/client?server=${encodeURIComponent(
      REMOTE.server
    )}&hash=${encodeURIComponent(REMOTE.hash)}`;
  } else {
    endpoint = `${proto}://${location.host}/ws`;
  }
  const ws = new WebSocket(endpoint);
  S.ws = ws;

  ws.onopen = () => {
    S.retry = 0;
    setConn(true, REMOTE ? "已连接 · relay" : "已连接");
    sendMsg({ type: "bootstrap" });
  };

  ws.onclose = () => {
    setConn(false, "断线，重连中…");
    S.retry = Math.min(S.retry + 1, 6);
    setTimeout(connect, 500 * S.retry);
  };

  ws.onerror = () => setConn(false, "连接失败");

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (REMOTE) {
      if (msg.type === "open") return;
      if (msg.type !== "data") return;
      try {
        msg = JSON.parse(msg.data);
      } catch {
        return;
      }
    }
    handle(msg);
  };
}

function handle(msg) {
  if (msg.type === "bootstrap") {
    S.projects = msg.projects || [];
    S.threads = msg.threads || [];
    S.mock = !!msg.mock;
    if (!S.activeProjectId && S.projects[0]) S.activeProjectId = S.projects[0].id;
    renderProjects();
    renderThreads();
    if (S.activeThreadId && S.threads.some((t) => t.id === S.activeThreadId)) {
      selectThread(S.activeThreadId);
    } else {
      S.activeThreadId = null;
      localStorage.removeItem("t3lite.thread");
    }
    return;
  }

  if (msg.type === "project") {
    if (!S.projects.some((p) => p.id === msg.project.id)) S.projects.push(msg.project);
    S.activeProjectId = msg.project.id;
    localStorage.setItem("t3lite.project", S.activeProjectId);
    renderProjects();
    renderThreads();
    return;
  }

  if (msg.type === "thread") {
    if (!S.threads.some((t) => t.id === msg.thread.id)) S.threads.unshift(msg.thread);
    else Object.assign(S.threads.find((t) => t.id === msg.thread.id), msg.thread);
    renderThreads();
    if (S.pendingThread) {
      S.pendingThread = false;
      selectThread(msg.thread.id);
    }
    return;
  }

  if (msg.type === "hello") {
    S.mock = !!msg.mock;
    $("#modeLabel").textContent = S.mock
      ? "pi · mock"
      : REMOTE
      ? "pi · relay"
      : "pi · local";
    $("#emptyHint").textContent = S.mock
      ? "当前是 mock 模式（T3LITE_MOCK=1），不会调用真实 Pi。"
      : "T3 Lite 会启动 `pi --mode rpc`，用你本机已登录的 Pi。";
    return;
  }

  if (msg.type === "snapshot") {
    if (msg.thread?.id !== S.activeThreadId) return;
    S.items = msg.items || [];
    S.diff = msg.diff || { status: "", diff: "" };
    const t = S.threads.find((x) => x.id === S.activeThreadId);
    if (t && msg.thread) Object.assign(t, msg.thread);
    renderItems();
    setStatus(msg.status || "idle");
    renderDiff(S.diff);
    return;
  }

  if (msg.threadId && msg.threadId !== S.activeThreadId) return;

  if (msg.type === "item") {
    S.items.push(msg.item);
    const n = renderItem(msg.item);
    if (n) $("#messages").append(n);
    scrollBottom();
    return;
  }

  if (msg.type === "delta") {
    appendDelta(msg.text || "");
    return;
  }

  if (msg.type === "thinking") {
    return;
  }

  if (msg.type === "status") {
    setStatus(msg.status, msg.stats);
    return;
  }

  if (msg.type === "diff") {
    renderDiff(msg);
    if (!$("#drawer").hidden) renderDiff(msg);
    return;
  }

  if (msg.type === "toast") {
    showToast(msg.message || "");
    return;
  }

  if (msg.type === "error") {
    S.pendingThread = false;
    showToast(msg.error || "出错了");
  }
}

/* ---------- actions ---------- */

function boot() {
  connect();
}

function newProject() {
  const path = window.prompt("项目目录的绝对路径（Linux 服务器上）", "");
  if (!path) return;
  sendMsg({ type: "createProject", path });
}

function newThread() {
  if (!S.activeProjectId) return;
  S.pendingThread = true;
  sendMsg({ type: "createThread", projectId: S.activeProjectId });
}

function sendPrompt() {
  const input = $("#input");
  const text = input.value.trim();
  if (!text || !S.activeThreadId) return;
  if (S.status === "running" || S.status === "waiting") {
    showToast("先等当前回合结束，或点停止");
    return;
  }
  sendMsg({ type: "prompt", threadId: S.activeThreadId, text });
  input.value = "";
  input.style.height = "auto";
}

/* ---------- UI wiring ---------- */

function openSidebar() {
  $("#sidebar").classList.add("open");
}
function closeSidebar() {
  $("#sidebar").classList.remove("open");
}

$("#addProject").onclick = newProject;
$("#addThread").onclick = newThread;
$("#openSidebar").onclick = openSidebar;
$("#closeSidebar").onclick = closeSidebar;
$("#diffBtn").onclick = openDrawer;
$("#closeDrawer").onclick = closeDrawer;
$("#copyDiff").onclick = async () => {
  const text = [S.diff.status, S.diff.diff].filter(Boolean).join("\n\n");
  await navigator.clipboard?.writeText(text);
  showToast("已复制");
};
$("#abortBtn").onclick = () => {
  if (!S.activeThreadId) return;
  sendMsg({ type: "abort", threadId: S.activeThreadId });
};
$("#composer").onsubmit = (e) => {
  e.preventDefault();
  sendPrompt();
};
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendPrompt();
  }
});
$("#input").addEventListener("input", () => {
  const t = $("#input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 180) + "px";
});

boot();
