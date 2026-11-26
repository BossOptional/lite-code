import { EventEmitter } from "node:events";
import {
  deriveKey,
  hmacB64,
  importPublic,
  open,
  randomB64u,
  seal,
  verifyHmac,
} from "../public/e2ee.js";

/**
 * Wraps an untrusted transport (the relay's VirtualSocket) in the same
 * Paseo-style handshake as the browser client. Once the handshake completes,
 * the wrapped object behaves like a WebSocket for src/server.js: send(),
 * on("message"), on("close"), readyState.
 */
export class SecureServer extends EventEmitter {
  constructor(socket, { serverId, privateKey, publicKeyB64 }) {
    super();
    this.socket = socket;
    this.serverId = serverId;
    this.privateKey = privateKey;
    this.publicKeyB64 = publicKeyB64;
    this.ready = false;
    this.key = null;
    this.sendSeq = 0;
    this.recvSeq = 0;
    this.buffered = [];
    this._chain = Promise.resolve();
    this._out = Promise.resolve();
    this._started = false;

    socket.on("message", (data) => {
      this._chain = this._chain
        .then(() => this._handle(data))
        .catch((e) => this._fail(e));
    });
    socket.on("close", () => this.emit("close"));
    socket.on("error", (e) => this.emit("error", e));
  }

  get readyState() {
    return this.socket.readyState;
  }

  on(event, listener) {
    const ret = super.on(event, listener);
    if (event === "message" && this.buffered.length) {
      const queued = this.buffered.splice(0);
      for (const text of queued) listener(text);
    }
    return ret;
  }

  start() {
    if (this._started) return this._promise;
    this._started = true;
    this._promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      this._timer = setTimeout(
        () => this._fail(new Error("handshake timeout")),
        10000
      );
    });
    return this._promise;
  }

  async _handle(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === "string" ? data : data.toString());
    } catch {
      return;
    }

    if (!this.ready) {
      if (msg.type !== "hello" || msg.v !== 1) {
        throw new Error("expected hello");
      }
      if (!msg.pub || !msg.nonce || !msg.proof) throw new Error("bad hello");
      const clientPub = msg.pub;
      const peer = await importPublic(clientPub);
      this.key = await deriveKey({
        privateKey: this.privateKey,
        peerPublicKey: peer,
        daemonPub: this.publicKeyB64,
        clientPub,
        serverId: this.serverId,
      });
      const ok = await verifyHmac(
        this.key,
        `hello|${this.serverId}|${msg.nonce}`,
        msg.proof
      );
      if (!ok) throw new Error("client proof failed");

      const serverNonce = randomB64u(16);
      const proof = await hmacB64(
        this.key,
        `ready|${this.serverId}|${msg.nonce}|${serverNonce}`
      );
      this.socket.send(
        JSON.stringify({ type: "ready", v: 1, nonce: serverNonce, proof })
      );
      this.ready = true;
      clearTimeout(this._timer);
      this._resolve();
      return;
    }

    if (msg.type !== "enc") throw new Error("expected encrypted frame");
    if (msg.n !== this.recvSeq) throw new Error("bad sequence");
    const text = await open(this.key, msg, {
      dir: "c2s",
      serverId: this.serverId,
    });
    this.recvSeq++;
    if (this.listenerCount("message") > 0) this.emit("message", text);
    else this.buffered.push(text);
  }

  send(text) {
    if (!this.ready) return;
    this._out = this._out
      .then(async () => {
        const n = this.sendSeq++;
        const frame = await seal(this.key, text, {
          dir: "s2c",
          n,
          serverId: this.serverId,
        });
        this.socket.send(JSON.stringify(frame));
      })
      .catch((e) => this._fail(e));
  }

  close() {
    try {
      this.socket.close();
    } catch {}
  }

  _fail(err) {
    clearTimeout(this._timer);
    this.emit("error", err);
    try {
      this._reject?.(err);
    } catch {}
    try {
      this.socket.close();
    } catch {}
  }
}
