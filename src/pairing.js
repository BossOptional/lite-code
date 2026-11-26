import { b64u } from "../public/e2ee.js";

/**
 * Pairing link:
 *   https://relay/#offer=<base64url({v,relay,server,pub,exp})>
 *
 * The fragment is never sent to the relay. It contains the daemon's public
 * key, which is the trust anchor for the E2EE handshake (Paseo-style).
 */
export function buildPairOffer({
  relay,
  serverId,
  publicKeyB64,
  ttlMs = 24 * 3600 * 1000,
}) {
  const exp = Date.now() + ttlMs;
  const offer = {
    v: 1,
    relay,
    server: serverId,
    pub: publicKeyB64,
    exp,
  };
  const base = relay.replace(/^ws/, "http").replace(/\/$/, "");
  return {
    url: `${base}/#offer=${b64u(new TextEncoder().encode(JSON.stringify(offer)))}`,
    expiresAt: exp,
    serverId,
  };
}
