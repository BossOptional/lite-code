import { Relay } from "./relay-do.js";

export { Relay };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, relay: "lite-code" });
    }

    if (url.pathname === "/daemon" || url.pathname === "/client") {
      const serverId = url.searchParams.get("server");
      if (!serverId) return new Response("missing server", { status: 400 });
      const id = env.RELAY.idFromName(serverId);
      return env.RELAY.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
