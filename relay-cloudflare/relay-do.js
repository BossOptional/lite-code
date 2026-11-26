import { DurableObject } from "cloudflare:workers";

function closeQuietly(ws, code, reason) {
  try {
    if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) {
      ws.close(code, String(reason || "").slice(0, 120));
    } else {
      ws.close();
    }
  } catch {}
}

/**
 * One Durable Object per server id.
 *
 * daemon:  /daemon?server=<id>&hash=<sha256(pairSecret)>  + Authorization: Bearer <RELAY_TOKEN>
 * client:  /client?server=<id>&hash=<sha256(pairSecret)>
 *
 * The DO only routes opaque frames:
 *   client -> daemon: { type: "data", channel, data }
 *   daemon -> client: { type: "data", data }
 *   daemon -> client: { type: "open", channel } on attach
 *   daemon -> client: { type: "close", channel } on detach
 *
 * Use the Hibernation WebSocket API so idle relays cost nothing.
 */
export class Relay extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const serverId = url.searchParams.get("server");
    if (!serverId) return new Response("missing server", { status: 400 });
    const hash = url.searchParams.get("hash") || "";

    if (url.pathname === "/daemon") {
      const auth = request.headers.get("authorization") || "";
      if (this.env.RELAY_TOKEN && auth !== `Bearer ${this.env.RELAY_TOKEN}`) {
        return new Response("unauthorized", { status: 401 });
      }
      if (!hash) return new Response("missing hash", { status: 400 });

      // Replace a previous daemon connection for this server id.
      for (const old of this.ctx.getWebSockets("daemon")) {
        closeQuietly(old, 4000, "replaced");
      }
      await this.ctx.storage.put("hash", hash);

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, ["daemon"]);
      server.serializeAttachment({ role: "daemon" });
      return new Response(null, { status: 101, webSocket: client });
    }

    // Client attach.
    const stored = await this.ctx.storage.get("hash");
    if (!stored || stored !== hash) {
      return new Response("unauthorized", { status: 401 });
    }
    const daemon = this.ctx.getWebSockets("daemon")[0];
    if (!daemon) return new Response("daemon offline", { status: 503 });

    const channel = crypto.randomUUID();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [`c:${channel}`]);
    server.serializeAttachment({ role: "client", channel });

    daemon.send(JSON.stringify({ type: "open", channel }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() || {};

    if (att.role === "daemon") {
      if (msg.type === "data" && msg.channel) {
        const client = this.ctx.getWebSockets(`c:${msg.channel}`)[0];
        if (client) {
          try {
            client.send(JSON.stringify({ type: "data", data: msg.data }));
          } catch {}
        }
      }
      return;
    }

    if (att.role === "client" && msg.type === "data") {
      const daemon = this.ctx.getWebSockets("daemon")[0];
      if (daemon) {
        try {
          daemon.send(
            JSON.stringify({ type: "data", channel: att.channel, data: msg.data })
          );
        } catch {}
      }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const att = ws.deserializeAttachment() || {};
    closeQuietly(ws, code, reason);

    if (att.role === "client") {
      const daemon = this.ctx.getWebSockets("daemon")[0];
      if (daemon) {
        try {
          daemon.send(JSON.stringify({ type: "close", channel: att.channel }));
        } catch {}
      }
      return;
    }

    if (att.role === "daemon") {
      // Do not kick everyone if a replacement daemon already connected.
      const others = this.ctx.getWebSockets("daemon").filter((s) => s !== ws);
      if (others.length > 0) return;
      for (const client of this.ctx.getWebSockets()) {
        const a = client.deserializeAttachment() || {};
        if (a.role === "client") closeQuietly(client, 4001, "daemon offline");
      }
    }
  }

  async webSocketError(ws, error) {
    closeQuietly(ws, 1011, "relay error");
  }
}
