import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./db.js";
import {
  createKeyPair,
  exportPrivate,
  exportPublic,
  importPrivate,
} from "../public/e2ee.js";

const FILE = join(HOME, "daemon-key.json");

/**
 * Paseo-style persistent daemon identity. The public key is the trust anchor
 * in the pairing link; the private key never leaves this file.
 */
export async function loadOrCreateKeyPair() {
  if (existsSync(FILE)) {
    const j = JSON.parse(readFileSync(FILE, "utf8"));
    if (j?.privateKey && j?.publicKey) {
      return {
        publicKeyB64: j.publicKey,
        privateKey: await importPrivate(j.privateKey),
      };
    }
  }

  const kp = await createKeyPair();
  const pub = await exportPublic(kp.publicKey);
  const priv = await exportPrivate(kp.privateKey);
  writeFileSync(
    FILE,
    JSON.stringify(
      { v: 1, publicKey: pub, privateKey: priv, createdAt: Date.now() },
      null,
      2
    ),
    { mode: 0o600 }
  );
  return { publicKeyB64: pub, privateKey: kp.privateKey };
}
