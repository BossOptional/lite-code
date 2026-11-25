import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * Minimal Pi RPC client.
 * Protocol: JSONL on stdin/stdout, one JSON object per line.
 * Docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
 */
export class PiAgent extends EventEmitter {
  constructor({ cwd, bin = process.env.PI_BIN || "pi", env = process.env }) {
    super();
    this.cwd = cwd;
    this.bin = bin;
    this.env = env;
    this.proc = null;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.alive = false;
  }

  start() {
    if (this.proc) return this;
    const env = { ...this.env, NO_COLOR: "1", TERM: "dumb" };
    // Useful for isolated installs and for testing in a sandbox.
    if (process.env.PI_HOME) env.HOME = process.env.PI_HOME;
    const proc = spawn(this.bin, ["--mode", "rpc"], {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.alive = true;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this.#onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.emit("stderr", text);
    });

    proc.on("error", (err) => {
      this.alive = false;
      this.emit("error", err);
    });

    proc.on("exit", (code, signal) => {
      this.alive = false;
      this.proc = null;
      for (const [, p] of this.pending) {
        p.reject(new Error(`pi exited (code=${code}, signal=${signal})`));
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
    });

    return this;
  }

  #onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("stderr", `non-json stdout: ${line.slice(0, 200)}`);
        continue;
      }
      this.#onMessage(msg);
    }
  }

  #onMessage(msg) {
    if (msg.type === "response") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.success) p.resolve(msg.data ?? {});
        else p.reject(new Error(msg.error || `command failed: ${msg.command}`));
      }
      this.emit("response", msg);
      return;
    }
    this.emit("event", msg);
  }

  request(cmd, timeoutMs = 60_000) {
    if (!this.proc || !this.alive) {
      return Promise.reject(new Error("pi is not running"));
    }
    const id = `req-${this.nextId++}`;
    const record = { id, ...cmd };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command timed out: ${cmd.type}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(JSON.stringify(record) + "\n");
    });
  }

  send(cmd) {
    if (!this.proc || !this.alive) throw new Error("pi is not running");
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  async getState() {
    return this.request({ type: "get_state" });
  }

  async getStats() {
    return this.request({ type: "get_session_stats" });
  }

  async switchSession(sessionPath) {
    return this.request({ type: "switch_session", sessionPath });
  }

  async prompt(message, images) {
    const cmd = { type: "prompt", message };
    if (images?.length) cmd.images = images;
    return this.request(cmd, 120_000);
  }

  async abort() {
    return this.request({ type: "abort" }, 30_000);
  }

  respondUi(id, response) {
    this.send({ type: "extension_ui_response", id, ...response });
  }

  stop() {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch {}
    const proc = this.proc;
    setTimeout(() => {
      if (this.proc === proc) {
        try {
          proc.kill("SIGTERM");
        } catch {}
      }
    }, 2000);
  }
}
