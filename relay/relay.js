import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

/**
 * A deliberately dumb relay.
 *
 * - Daemon connects to /daemon, authenticates with RELAY_TOKEN, registers
 *   serverId + pairHash (sha256 of a pairing secret).
 * - Browser connects to /client?server=...&hash=..., proves it knows the
 *   pairing secret by presenting the same hash.
 * - Relay creates a channel and forwards opaque frames. It does not parse
 *   the application protocol.
 *
 * Run behind TLS (Caddy/nginx) in production; use wss:// from clients.
 */

const PORT = Number(process.env.RELAY_PORT || 4400);
const HOST = process.env.RELAY_HOST || "0.0.0.0";
const TOKEN = process.env.RELAY_TOKEN || "";

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** serverId -> { ws, hash } */
const servers = new Map();
/** channel -> { client, serverId } */
const channels = new Map();

const PUBLIC =
  process.env.RELAY_PUBLIC ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "public");

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
  if (rel.includes("..")) return res.writeHead(403).end("forbidden");
  const file = join(PUBLIC, rel);
  if (!existsSync(file)) return res.writeHead(404).end("not found");
  const body = readFileSync(file);
  res.writeHead(200, {
    "content-type":
      MIME[file.slice(file.lastIndexOf("."))] || "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        servers: servers.size,
        channels: channels.size,
      })
    );
    return;
  }
  return serveStatic(res, url.pathname);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/daemon") {
    const auth = req.headers.authorization || "";
    if (TOKEN && auth !== `Bearer ${TOKEN}`) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const serverId = url.searchParams.get("server");
    const hash = url.searchParams.get("hash");
    if (!serverId || !hash) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const previous = servers.get(serverId);
      if (previous && previous.ws !== ws) {
        try {
          previous.ws.close(4000, "replaced");
        } catch {}
      }
      servers.set(serverId, { ws, hash });
      log(`daemon online: ${serverId} (${servers.size} total)`);

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "data" && msg.channel) {
          const ch = channels.get(msg.channel);
          if (ch && ch.client.readyState === 1) {
            ch.client.send(JSON.stringify({ type: "data", data: msg.data }));
          }
        } else if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      });

      ws.on("close", () => {
        if (servers.get(serverId)?.ws === ws) servers.delete(serverId);
        for (const [id, ch] of channels) {
          if (ch.serverId === serverId) {
            try {
              ch.client.close(4001, "daemon offline");
            } catch {}
            channels.delete(id);
          }
        }
        log(`daemon offline: ${serverId}`);
      });
    });
    return;
  }

  if (url.pathname === "/client") {
    const serverId = url.searchParams.get("server");
    const hash = url.searchParams.get("hash");
    const entry = servers.get(serverId);
    if (!entry || entry.hash !== hash) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const channel = crypto.randomUUID();
      channels.set(channel, { client: ws, serverId });
      entry.ws.send(JSON.stringify({ type: "open", channel }));
      ws.send(JSON.stringify({ type: "open", channel }));
      log(`client attached: ${serverId} channel=${channel.slice(0, 8)}`);

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "data") {
          const current = servers.get(serverId);
          if (current && current.ws.readyState === 1) {
            current.ws.send(JSON.stringify({ type: "data", channel, data: msg.data }));
          }
        }
      });

      ws.on("close", () => {
        channels.delete(channel);
        const current = servers.get(serverId);
        if (current && current.ws.readyState === 1) {
          current.ws.send(JSON.stringify({ type: "close", channel }));
        }
        log(`client detached: ${serverId} channel=${channel.slice(0, 8)}`);
      });
    });
    return;
  }

  socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
  socket.destroy();
});

// Heartbeat to reap dead sockets behind proxies.
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch {}
  }
}, 30_000);
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
});

server.listen(PORT, HOST, () => {
  log(`relay listening on http://${HOST}:${PORT} (token=${TOKEN ? "set" : "off"})`);
});

function shutdown() {
  clearInterval(heartbeat);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
