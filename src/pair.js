import os from "node:os";
import crypto from "node:crypto";
import { getSetting, setSetting } from "./db.js";
import { loadOrCreateKeyPair } from "./keys.js";
import { buildPairOffer } from "./pairing.js";

const relay = process.env.RELAY_URL || getSetting("relay_url");
if (!relay) {
  console.error("RELAY_URL is not set. Example:");
  console.error(
    "  RELAY_URL=wss://lite.agentx1.com node src/pair.js"
  );
  process.exit(1);
}

let serverId = process.env.T3LITE_SERVER_ID || getSetting("server_id");
if (!serverId) {
  serverId =
    os.hostname().replace(/[^a-zA-Z0-9_-]/g, "-") +
    "-" +
    crypto.randomBytes(2).toString("hex");
  setSetting("server_id", serverId);
}

const keypair = await loadOrCreateKeyPair();
const offer = buildPairOffer({
  relay,
  serverId,
  publicKeyB64: keypair.publicKeyB64,
  ttlMs: Number(process.env.T3LITE_PAIR_TTL_MS || 24 * 3600 * 1000),
});

console.log("");
console.log("Pair this device (open on your phone):");
console.log("");
console.log(offer.url);
console.log("");
console.log(
  `server=${offer.serverId}  expires=${new Date(offer.expiresAt).toISOString()}`
);
console.log("");
