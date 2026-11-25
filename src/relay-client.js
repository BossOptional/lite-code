import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import WebSocket from "ws";

/**
 * A socket-like object backed by a multiplexed channel on the relay connection.
 * The daemon handles it exactly like a local browser WebSocket.
 */
class VirtualSocket extends EventEmitter {
  constructor(channel, relay) {
    super();
    this.channel = channel;
    this.relay = relay;
    this.readyState = 1;
  }

  send(data) {
    if (this.readyState !== 1) return;
    try {
      this.relay.send(JSON.stringify({ type: "data", channel: this.channel, data }));
    } catch {
      this.close();
    }
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
}

export function startRelayClient({
  url,
  token,
  serverId,
  hash,
  onSocket,
  log = console.log,
}) {
  let ws = null;
  let backoff = 800;
  let stopped = false;
  const sockets = new Map();

  const connect = () => {
    if (stopped) return;
    const endpoint = new URL("/daemon", url.replace(/^http/, "ws"));
    endpoint.searchParams.set("server", serverId);
    endpoint.searchParams.set("hash", hash);

    ws = new WebSocket(endpoint, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

    ws.on("open", () => {
      backoff = 800;
      log(`relay connected: ${endpoint.origin} server=${serverId}`);
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "open" && msg.channel) {
        const vs = new VirtualSocket(msg.channel, ws);
        sockets.set(msg.channel, vs);
        vs.on("close", () => sockets.delete(msg.channel));
        log(`relay channel open: ${msg.channel.slice(0, 8)}`);
        onSocket(vs);
      } else if (msg.type === "data" && msg.channel) {
        sockets.get(msg.channel)?.emit("message", msg.data);
      } else if (msg.type === "error") {
        log(`relay error: ${msg.error}`);
      }
    });

    ws.on("close", () => {
      for (const vs of sockets.values()) vs.close();
      sockets.clear();
      if (stopped) return;
      log(`relay disconnected; retrying in ${backoff}ms`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    });

    ws.on("error", (err) => log(`relay socket error: ${err.message}`));
  };

  connect();

  return {
    stop() {
      stopped = true;
      try {
        ws?.close();
      } catch {}
    },
  };
}

export function pairHash(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}
