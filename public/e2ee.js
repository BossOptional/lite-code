/**
 * T3 Lite end-to-end encryption.
 *
 * Paseo-style pairing:
 *  - the daemon has a persistent X25519 keypair (public key goes in the pairing link)
 *  - the client generates an ephemeral X25519 keypair per session
 *  - both derive the same AES-256-GCM key with HKDF-SHA256
 *  - the relay only sees ciphertext
 *
 * Runs on WebCrypto (browsers + Node 24+). No dependencies.
 */

const TE = new TextEncoder();
const TD = new TextDecoder();
const VERSION = 1;
const INFO = "t3lite-e2ee-v1";

export function b64u(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomB64u(n = 16) {
  return b64u(crypto.getRandomValues(new Uint8Array(n)));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", TE.encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createKeyPair() {
  return crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
}

export async function exportPublic(key) {
  return b64u(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

export async function exportPrivate(key) {
  return b64u(new Uint8Array(await crypto.subtle.exportKey("pkcs8", key)));
}

export async function importPublic(b64) {
  return crypto.subtle.importKey("raw", unb64u(b64), { name: "X25519" }, false, []);
}

export async function importPrivate(b64) {
  return crypto.subtle.importKey(
    "pkcs8",
    unb64u(b64),
    { name: "X25519" },
    false,
    ["deriveBits"]
  );
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function deriveKey({
  privateKey,
  peerPublicKey,
  daemonPub,
  clientPub,
  serverId,
}) {
  const shared = await crypto.subtle.deriveBits(
    { name: "X25519", public: peerPublicKey },
    privateKey,
    256
  );
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveBits",
  ]);
  const salt = concat(unb64u(daemonPub), unb64u(clientPub));
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: TE.encode(`${INFO}|${serverId}`),
    },
    ikm,
    256
  );
  return new Uint8Array(bits);
}

export async function hmacB64(key, text) {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, TE.encode(text))));
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function verifyHmac(key, text, sigB64) {
  const expected = unb64u(await hmacB64(key, text));
  let actual;
  try {
    actual = unb64u(sigB64);
  } catch {
    return false;
  }
  return equalBytes(expected, actual);
}

async function aesKey(key) {
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function ivFor(dir, n) {
  const iv = new Uint8Array(12);
  iv[0] = dir === "c2s" ? 1 : 2;
  new DataView(iv.buffer).setBigUint64(4, BigInt(n));
  return iv;
}

export async function seal(key, text, { dir, n, serverId }) {
  const iv = ivFor(dir, n);
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: TE.encode(`${serverId}|${dir}|${n}`),
    },
    await aesKey(key),
    TE.encode(text)
  );
  return { type: "enc", n, iv: b64u(iv), d: b64u(new Uint8Array(ct)) };
}

export async function open(key, frame, { dir, serverId }) {
  if (!frame || !frame.iv || !frame.d) throw new Error("bad frame");
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: unb64u(frame.iv),
      additionalData: TE.encode(`${serverId}|${dir}|${frame.n}`),
    },
    await aesKey(key),
    unb64u(frame.d)
  );
  return TD.decode(pt);
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

export class SecureClient {
  constructor(ws, { serverId, daemonPub, relay = true }) {
    this.ws = ws;
    this.serverId = serverId;
    this.daemonPub = daemonPub;
    this.relay = relay;
    this.ready = false;
    this.key = null;
    this.sendSeq = 0;
    this.recvSeq = 0;
    this.onMessage = () => {};
    this.onError = () => {};
    this._chain = Promise.resolve();
    this._out = Promise.resolve();
    this._read = (data) => {
      this._chain = this._chain
        .then(() => this._handle(data))
        .catch((e) => this._fail(e));
    };
    if (typeof ws.addEventListener === "function") {
      ws.addEventListener("message", (ev) => this._read(ev.data));
    } else if (typeof ws.on === "function") {
      ws.on("message", (data) => this._read(data.toString()));
    }
  }

  async start() {
    const kp = await createKeyPair();
    const clientPub = await exportPublic(kp.publicKey);
    const daemonKey = await importPublic(this.daemonPub);
    this.key = await deriveKey({
      privateKey: kp.privateKey,
      peerPublicKey: daemonKey,
      daemonPub: this.daemonPub,
      clientPub,
      serverId: this.serverId,
    });
    this.clientNonce = randomB64u(16);
    const proof = await hmacB64(
      this.key,
      `hello|${this.serverId}|${this.clientNonce}`
    );
    this._sendRaw(
      JSON.stringify({
        type: "hello",
        v: VERSION,
        pub: clientPub,
        nonce: this.clientNonce,
        proof,
      })
    );
    await new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      this._timer = setTimeout(
        () => reject(new Error("handshake timeout")),
        10000
      );
    });
  }

  _sendRaw(text) {
    this.ws.send(
      this.relay ? JSON.stringify({ type: "data", data: text }) : text
    );
  }

  async _handle(data) {
    let raw = typeof data === "string" ? data : TD.decode(data);
    if (this.relay) {
      try {
        const wrapper = JSON.parse(raw);
        if (wrapper.type !== "data") return;
        raw = wrapper.data;
      } catch {
        return;
      }
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!this.ready && msg.type === "ready") {
      const ok = await verifyHmac(
        this.key,
        `ready|${this.serverId}|${this.clientNonce}|${msg.nonce}`,
        msg.proof
      );
      if (!ok) throw new Error("daemon proof failed");
      this.ready = true;
      clearTimeout(this._timer);
      this._resolve();
      return;
    }
    if (this.ready && msg.type === "enc") {
      if (msg.n !== this.recvSeq) throw new Error("bad sequence");
      const text = await open(this.key, msg, {
        dir: "s2c",
        serverId: this.serverId,
      });
      this.recvSeq++;
      this.onMessage(text);
    }
  }

  send(obj) {
    if (!this.ready) return false;
    const text = typeof obj === "string" ? obj : JSON.stringify(obj);
    this._out = this._out
      .then(async () => {
        const n = this.sendSeq++;
        const frame = await seal(this.key, text, {
          dir: "c2s",
          n,
          serverId: this.serverId,
        });
        this._sendRaw(JSON.stringify(frame));
      })
      .catch((e) => this._fail(e));
    return true;
  }

  _fail(err) {
    clearTimeout(this._timer);
    this.onError(err);
    try {
      this.ws.close();
    } catch {}
  }
}
