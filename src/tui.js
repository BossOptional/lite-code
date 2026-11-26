#!/usr/bin/env node
/**
 * A small TUI for T3 Lite.
 *
 *   node src/tui.js
 *   node src/tui.js --ws ws://127.0.0.1:4317/ws
 *   node src/tui.js --offer 'https://lite.agentx1.com/#offer=...'
 *
 * Keys:
 *   Enter send · Tab next thread · ↑/↓ or j/k scroll · d diff
 *   y/n approve/deny · 1-9 select · Esc cancel/clear · q quit
 */

import WebSocket from "ws";
import { SecureClient, sha256Hex, unb64u } from "../public/e2ee.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`T3 Lite TUI

Usage:
  node src/tui.js                         # local daemon (127.0.0.1:4317)
  node src/tui.js --ws ws://host:4317/ws  # another daemon
  node src/tui.js --offer <pair-url>      # relay + E2EE

Options:
  --ws <url>       WebSocket URL for a local/direct daemon
  --offer <value>  pairing URL (https://...#offer=...) or raw offer
  --thread <id>    open a specific thread
  --no-color       disable ANSI colors
  -h, --help       show this help

Keys:
  Enter send · Tab next thread · ↑/↓ or j/k scroll · d diff
  y/n approve/deny · 1-9 select · Esc cancel/clear · q quit
`);
  process.exit(0);
}

function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const NO_COLOR = args.includes("--no-color") || process.env.NO_COLOR;
const C = NO_COLOR
  ? {
      reset: "",
      dim: "",
      bold: "",
      red: "",
      green: "",
      yellow: "",
      cyan: "",
      blue: "",
      magenta: "",
      gray: "",
      inv: "",
    }
  : {
      reset: "\x1b[0m",
      dim: "\x1b[2m",
      bold: "\x1b[1m",
      red: "\x1b[31m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      cyan: "\x1b[36m",
      blue: "\x1b[34m",
      magenta: "\x1b[35m",
      gray: "\x1b[90m",
      inv: "\x1b[7m",
    };

const WELCOME = [
  "T3 Lite",
  "",
  "Tab 切换线程 · Enter 发送 · n 新线程 · p 新项目 · d 看 diff · q 退出",
  "按 p 新建项目，n 新建线程；也可以先用 Web UI 建。",
];

const state = {
  projects: [],
  threads: [],
  activeProjectId: null,
  activeThreadId: null,
  items: [],
  status: "idle",
  pending: null,
  live: "",
  diff: "",
  mode: "chat",
  scroll: 0,
  input: "",
  conn: "connecting",
  mock: false,
  e2ee: false,
  toast: "",
  toastAt: 0,
  rows: 30,
  cols: 100,
  prompt: null,
  awaitProject: false,
  awaitThread: false,
};

/* ---------- width-aware text ---------- */

function charWidth(cp) {
  if (cp === 0x200b || (cp >= 0x0300 && cp <= 0x036f)) return 0;
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

function widthOf(text) {
  let w = 0;
  for (const ch of String(text)) w += charWidth(ch.codePointAt(0));
  return w;
}

function sliceWidth(text, max) {
  if (max <= 0) return "";
  let out = "";
  let w = 0;
  for (const ch of String(text)) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max) return out + (max > 1 ? "…" : "");
    out += ch;
    w += cw;
  }
  return out;
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function padWidth(text, width) {
  const plain = stripAnsi(text);
  const w = widthOf(plain);
  if (w >= width) return sliceWidth(plain, width);
  return text + " ".repeat(width - w);
}

function wrap(text, width) {
  const max = Math.max(4, width);
  const lines = [];
  for (const para of String(text).replace(/\t/g, "  ").split("\n")) {
    if (!para) {
      lines.push("");
      continue;
    }
    let line = "";
    let w = 0;
    for (const ch of para) {
      const cw = charWidth(ch.codePointAt(0));
      if (w + cw > max) {
        lines.push(line);
        line = "";
        w = 0;
      }
      line += ch;
      w += cw;
    }
    lines.push(line);
  }
  return lines;
}

/* ---------- rendering ---------- */

function color(line, code) {
  return code ? code + line + C.reset : line;
}

function itemLines(item, width) {
  const out = [];
  const p = item.payload || {};
  const indent = "  ";
  if (item.type === "user_message") {
    out.push(color("You", C.cyan + C.bold));
    for (const l of wrap(p.text || "", width - 2)) out.push(indent + l);
  } else if (item.type === "agent_message") {
    out.push(color("Pi", C.green + C.bold));
    for (const l of wrap(p.text || "", width - 2)) out.push(indent + l);
  } else if (item.type === "tool_call") {
    const name = p.toolName || "tool";
    let args = "";
    try {
      args = JSON.stringify(p.args ?? {});
    } catch {}
    if (args.length > 120) args = args.slice(0, 117) + "…";
    out.push(color(`⚙ ${name}`, C.yellow));
    if (args && args !== "{}") for (const l of wrap(args, width - 4)) out.push(indent + l);
  } else if (item.type === "tool_result") {
    const text = toolText(p.result);
    const one = text.replace(/\s+/g, " ");
    out.push(color(sliceWidth(`  ↳ ${one}`, width), p.isError ? C.red : C.gray));
  } else if (item.type === "permission") {
    out.push(
      color(sliceWidth(`[!] ${p.title || "需要确认"}`, width), C.magenta + C.bold)
    );
    if (p.message) for (const l of wrap(p.message, width - 4)) out.push(indent + l);
  } else if (item.type === "error") {
    for (const l of wrap(p.message || "error", width)) out.push(color(l, C.red));
  }
  return out;
}

function toolText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) {
    return result.content
      .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
      .join(" ");
  }
  return JSON.stringify(result);
}

function diffLines(width) {
  if (!state.diff.trim()) return ["(没有改动)"];
  const out = [];
  for (const line of state.diff.split("\n")) {
    let code = "";
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index "))
      code = C.gray;
    else if (line.startsWith("+")) code = C.green;
    else if (line.startsWith("-")) code = C.red;
    else if (line.startsWith("@@")) code = C.cyan;
    out.push(color(sliceWidth(line, width), code));
  }
  return out;
}

function chatLines(width) {
  const lines = [];
  if (state.mode === "diff") return diffLines(width);
  if (!state.items.length && !state.live) {
    for (const l of WELCOME) lines.push(color(sliceWidth(l, width), C.gray));
    return lines;
  }
  for (const item of state.items) lines.push(...itemLines(item, width));
  if (state.live) {
    lines.push(color("Pi", C.green + C.bold));
    for (const l of wrap(state.live + "▍", width - 2)) lines.push("  " + l);
  }
  return lines;
}

function sidebarLines(width, height) {
  const lines = [];
  for (const p of state.projects) {
    const isActive = p.id === state.activeProjectId;
    lines.push(color(sliceWidth(`▸ ${p.name}`, width), isActive ? C.bold : C.gray));
    for (const t of state.threads.filter((x) => x.project_id === p.id)) {
      const active = t.id === state.activeThreadId;
      const dot =
        t.status === "running"
          ? color("●", C.yellow)
          : t.status === "waiting"
          ? color("●", C.cyan)
          : t.status === "error"
          ? color("●", C.red)
          : color("○", C.gray);
      const title = sliceWidth(t.title || "New thread", width - 4);
      lines.push(`${active ? "›" : " "} ${dot} ${color(title, active ? C.bold : "")}`);
    }
  }
  if (!lines.length) lines.push(color("(还没有项目)", C.gray));
  const start = Math.max(0, lines.length - height);
  return lines.slice(start).map((l) => padWidth(l, width));
}

function render() {
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;
  state.cols = cols;
  state.rows = rows;
  const sideW = cols >= 76 ? Math.min(30, Math.floor(cols * 0.28)) : 0;
  const divW = sideW ? 1 : 0;
  const chatW = Math.max(10, cols - sideW - divW);
  const bodyH = Math.max(3, rows - 3);

  const header = `${C.inv}${C.bold} T3 Lite  ·  ${state.conn}${state.mock ? "  · mock" : ""}${
    state.e2ee ? "  · E2EE" : ""
  } ${C.reset}`;
  const headerLine = padWidth(header, cols);

  const allChat = chatLines(chatW);
  const maxScroll = Math.max(0, allChat.length - bodyH);
  if (state.scroll > maxScroll) state.scroll = maxScroll;
  const start = Math.max(0, allChat.length - bodyH - state.scroll);
  const visible = allChat.slice(start, start + bodyH);
  const alignTop =
    (state.mode === "chat" && !state.items.length && !state.live) ||
    state.mode === "diff";
  while (visible.length < bodyH) {
    if (alignTop) visible.push("");
    else visible.unshift("");
  }

  const side = sidebarLines(sideW, bodyH);

  const out = [headerLine];
  for (let i = 0; i < bodyH; i++) {
    const left = sideW ? (side[i] || " ".repeat(sideW)) + color("│", C.gray) : "";
    out.push(left + visible[i]);
  }

  const label = state.prompt ? state.prompt.label : "";
  const value = state.prompt
    ? state.prompt.value
    : state.input || "(输入消息…)";
  const activeInput = !!state.prompt || !!state.input;
  const inputLine = padWidth(
    color("> ", C.cyan + C.bold) +
      color(label, C.magenta) +
      color(value, activeInput ? "" : C.gray) +
      (activeInput ? "▍" : ""),
    cols
  );
  out.push(inputLine);

  const hint = state.prompt
    ? "Enter 确认 · Esc 取消"
    : state.pending
    ? `待审批：${state.pending.title || ""}  y/n · Esc 取消`
    : "Enter 发送 · Tab 切换 · n 新线程 · p 新项目 · ↑↓ 滚动 · d diff · q 退出";
  const toast = state.toast && Date.now() - state.toastAt < 3000 ? "  " + state.toast : "";
  out.push(padWidth(color(`${hint}${toast}`, C.gray), cols));

  process.stdout.write("\x1b[?25l\x1b[2J\x1b[H" + out.join("\n"));
}

/* ---------- helpers ---------- */

function toast(text) {
  state.toast = text;
  state.toastAt = Date.now();
  render();
}

function activeThread() {
  return state.threads.find((t) => t.id === state.activeThreadId) || null;
}

function activeProject() {
  return state.projects.find((p) => p.id === state.activeProjectId) || null;
}

function upsertThread(t) {
  const i = state.threads.findIndex((x) => x.id === t.id);
  if (i >= 0) state.threads[i] = { ...state.threads[i], ...t };
  else state.threads.unshift(t);
}

function selectThread(id) {
  state.activeThreadId = id;
  state.items = [];
  state.live = "";
  state.diff = "";
  state.pending = null;
  state.mode = "chat";
  state.scroll = 0;
  send({ type: "subscribe", threadId: id });
  render();
}

function nextThread() {
  if (!state.threads.length) return;
  const i = state.threads.findIndex((t) => t.id === state.activeThreadId);
  const next = state.threads[(i + 1) % state.threads.length];
  state.activeProjectId = next.project_id;
  selectThread(next.id);
}

function send(obj) {
  if (state.secure) {
    if (state.secure.ready) state.secure.send(JSON.stringify(obj));
    return;
  }
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(obj));
}

function sendPrompt() {
  const text = state.input.trim();
  if (!text || !state.activeThreadId) return;
  if (state.status === "running" || state.status === "waiting") {
    toast("当前回合还没结束，先等或按 Esc");
    return;
  }
  send({ type: "prompt", threadId: state.activeThreadId, text });
  state.input = "";
  state.scroll = 0;
  render();
}

function respondPermission(response) {
  if (!state.pending) return;
  send({
    type: "permission",
    threadId: state.activeThreadId,
    requestId: state.pending.requestId,
    response,
  });
  state.pending = null;
  render();
}

function newThreadTitle() {
  return `Thread ${new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function submitPrompt() {
  const p = state.prompt;
  if (!p) return;
  const value = p.value.trim();
  if (!value) return toast("路径不能为空");
  if (p.kind === "project") {
    state.awaitProject = true;
    send({ type: "createProject", path: value });
  }
  state.prompt = null;
  render();
}

function handleKey(key, seq) {
  if (key === "\x03") exit(); // Ctrl-C
  if (state.prompt) {
    if (key === "\r" || key === "\n") return submitPrompt();
    if (key === "\x1b") {
      state.prompt = null;
      return render();
    }
    if (key === "\x7f" || key === "\b") {
      state.prompt.value = [...state.prompt.value].slice(0, -1).join("");
      return render();
    }
    if (key >= " " && key !== "\x7f") {
      state.prompt.value += key;
      render();
    }
    return;
  }
  if (seq === "\x1b[A") {
    state.scroll = Math.min(state.scroll + 1, 9999);
    render();
    return;
  }
  if (seq === "\x1b[B") {
    state.scroll = Math.max(0, state.scroll - 1);
    render();
    return;
  }
  if (seq === "\x1b[5~") {
    state.scroll = Math.min(state.scroll + Math.max(3, state.rows - 4), 9999);
    render();
    return;
  }
  if (seq === "\x1b[6~") {
    state.scroll = Math.max(0, state.scroll - Math.max(3, state.rows - 4));
    render();
    return;
  }
  if (key === "\t") return nextThread();
  if (key === "\r" || key === "\n") {
    if (state.pending) return;
    return sendPrompt();
  }
  if (key === "\x7f" || key === "\b") {
    state.input = [...state.input].slice(0, -1).join("");
    render();
    return;
  }
  if (key === "\x1b") {
    if (state.pending) return respondPermission({ cancelled: true });
    state.input = "";
    render();
    return;
  }

  if (state.pending) {
    if (key === "y" && state.pending.method === "confirm") return respondPermission({ confirmed: true });
    if (key === "n") {
      if (state.pending.method === "confirm") return respondPermission({ confirmed: false });
      return respondPermission({ cancelled: true });
    }
    if (/^[1-9]$/.test(key) && state.pending.method === "select") {
      const opt = (state.pending.options || [])[Number(key) - 1];
      if (opt != null) return respondPermission({ value: opt });
    }
    return;
  }

  if (!state.input) {
    if (key === "q") return exit();
    if (key === "j") {
      state.scroll = Math.min(state.scroll + 1, 9999);
      return render();
    }
    if (key === "k") {
      state.scroll = Math.max(0, state.scroll - 1);
      return render();
    }
    if (key === "n") {
      if (!state.activeProjectId) return toast("先按 p 新建项目");
      state.awaitThread = true;
      send({
        type: "createThread",
        projectId: state.activeProjectId,
        title: newThreadTitle(),
      });
      return toast("正在新建线程…");
    }
    if (key === "p") {
      state.prompt = { kind: "project", label: "项目路径: ", value: "" };
      return render();
    }
    if (key === "d") {
      state.mode = state.mode === "diff" ? "chat" : "diff";
      if (state.mode === "diff" && state.activeThreadId) {
        send({ type: "diff", threadId: state.activeThreadId });
      }
      return render();
    }
    if (key === "r") {
      if (state.conn !== "connected") return connect();
      state.scroll = 0;
      send({ type: "bootstrap" });
      return;
    }
  }

  if (key >= " " && key !== "\x7f") {
    state.input += key;
    render();
  }
}

/* ---------- connection ---------- */

function parseOffer(value) {
  let raw = value;
  if (raw.includes("#offer=")) raw = raw.split("#offer=")[1];
  else if (raw.includes("offer=")) raw = raw.split("offer=")[1];
  raw = raw.split("&")[0];
  const obj = JSON.parse(new TextDecoder().decode(unb64u(raw)));
  if (obj.v !== 1 || !obj.relay || !obj.server || !obj.pub) {
    throw new Error("invalid offer");
  }
  return obj;
}

async function connect() {
  const offerValue = arg("--offer");
  const wsUrl = arg("--ws", process.env.T3LITE_WS || "ws://127.0.0.1:4317/ws");

  if (offerValue) {
    let offer;
    try {
      offer = parseOffer(offerValue);
    } catch (e) {
      console.error("配对链接无效：" + e.message);
      process.exit(1);
    }
    if (offer.exp && Date.now() > offer.exp) {
      console.error("配对链接已过期，请重新运行 node src/pair.js");
      process.exit(1);
    }
    state.e2ee = true;
    state.conn = "handshake";
    render();
    const hash = await sha256Hex("t3lite-pair:" + offer.pub);
    const base = offer.relay.replace(/^http/, "ws").replace(/\/$/, "");
    const url = `${base}/client?server=${encodeURIComponent(
      offer.server
    )}&hash=${hash}`;
    const ws = new WebSocket(url);
    state.ws = ws;
    ws.on("open", async () => {
      const secure = new SecureClient(ws, {
        serverId: offer.server,
        daemonPub: offer.pub,
      });
      state.secure = secure;
      secure.onMessage = (text) => {
        try {
          handle(JSON.parse(text));
        } catch {}
      };
      secure.onError = (e) => {
        state.conn = "error";
        toast("E2EE: " + e.message);
        render();
      };
      try {
        await secure.start();
      } catch (e) {
        state.conn = "error";
        toast("握手失败: " + e.message);
        render();
        return;
      }
      state.conn = "connected";
      send({ type: "bootstrap" });
      render();
    });
    ws.on("error", (e) => {
      state.conn = "error";
      toast(e.message);
      render();
    });
    ws.on("close", () => {
      state.conn = "disconnected";
      state.secure = null;
      render();
    });
    return;
  }

  state.conn = "connecting";
  render();
  const ws = new WebSocket(wsUrl);
  state.ws = ws;
  ws.on("open", () => {
    state.conn = "connected";
    send({ type: "bootstrap" });
    render();
  });
  ws.on("message", (data) => {
    try {
      handle(JSON.parse(data.toString()));
    } catch {}
  });
  ws.on("error", (e) => {
    state.conn = "error";
    toast(e.message);
    render();
  });
  ws.on("close", () => {
    state.conn = "disconnected";
    render();
  });
}

/* ---------- protocol ---------- */

function handle(msg) {
  if (msg.type === "hello") {
    state.mock = !!msg.mock;
    render();
    return;
  }
  if (msg.type === "bootstrap") {
    state.projects = msg.projects || [];
    state.threads = msg.threads || [];
    state.mock = !!msg.mock;
    if (!state.activeProjectId && state.projects[0]) state.activeProjectId = state.projects[0].id;
    const wanted = arg("--thread");
    const t =
      (wanted && state.threads.find((x) => x.id === wanted)) ||
      state.threads.find((x) => x.id === state.activeThreadId) ||
      state.threads[0];
    if (t) {
      state.activeProjectId = t.project_id;
      selectThread(t.id);
    } else {
      render();
    }
    return;
  }
  if (msg.type === "project") {
    if (!state.projects.some((p) => p.id === msg.project.id)) state.projects.push(msg.project);
    state.activeProjectId = msg.project.id;
    if (state.awaitProject) {
      state.awaitProject = false;
      state.awaitThread = true;
      send({
        type: "createThread",
        projectId: msg.project.id,
        title: newThreadTitle(),
      });
      render();
      return;
    }
    render();
    return;
  }
  if (msg.type === "thread") {
    upsertThread(msg.thread);
    if (state.awaitThread) {
      state.awaitThread = false;
      state.activeProjectId = msg.thread.project_id;
      selectThread(msg.thread.id);
      return;
    }
    if (!state.activeThreadId) {
      state.activeProjectId = msg.thread.project_id;
      selectThread(msg.thread.id);
    } else render();
    return;
  }
  if (msg.type === "thread_deleted") {
    state.threads = state.threads.filter((t) => t.id !== msg.threadId);
    if (state.activeThreadId === msg.threadId) state.activeThreadId = null;
    render();
    return;
  }
  if (msg.threadId && msg.threadId !== state.activeThreadId) return;

  if (msg.type === "snapshot") {
    state.items = msg.items || [];
    state.status = msg.status || "idle";
    state.diff = [msg.diff?.status, msg.diff?.diff].filter(Boolean).join("\n\n");
    state.live = "";
    state.scroll = 0;
    const t = state.threads.find((x) => x.id === state.activeThreadId);
    if (t && msg.thread) Object.assign(t, msg.thread);
    render();
    return;
  }
  if (msg.type === "item") {
    state.items.push(msg.item);
    if (msg.item.type === "agent_message") state.live = "";
    if (msg.item.type === "permission") state.pending = msg.item.payload;
    render();
    return;
  }
  if (msg.type === "delta") {
    state.live += msg.text || "";
    render();
    return;
  }
  if (msg.type === "status") {
    state.status = msg.status;
    const t = state.threads.find((x) => x.id === state.activeThreadId);
    if (t) t.status = msg.status;
    if (msg.status === "idle" && state.live) state.live = "";
    render();
    return;
  }
  if (msg.type === "diff") {
    state.diff = [msg.status, msg.diff].filter(Boolean).join("\n\n");
    if (state.mode === "diff") render();
    return;
  }
  if (msg.type === "toast") {
    toast(msg.message || "");
    return;
  }
  if (msg.type === "error") {
    state.awaitProject = false;
    state.awaitThread = false;
    toast(msg.error || "error");
  }
}

/* ---------- lifecycle ---------- */

function exit() {
  process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[0m\n");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}

function start() {
  if (!process.stdin.isTTY) {
    console.error("TUI 需要 TTY。请在终端里运行，或用 --help。");
    process.exit(1);
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  process.stdout.on("resize", render);
  process.stdin.on("data", (data) => {
    const s = String(data);
    // Arrow / paging sequences first.
    for (const seq of ["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~"]) {
      if (s === seq) {
        handleKey(seq, seq);
        return;
      }
    }
    if (s === "\x1b") {
      handleKey("\x1b", null);
      return;
    }
    if (s.startsWith("\x1b[")) return; // unmapped escape sequence
    for (const ch of [...s]) handleKey(ch, null);
  });
  process.on("SIGINT", exit);
  process.on("SIGTERM", exit);
  render();
  connect();
}

start();
