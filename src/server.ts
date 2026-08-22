import type { ServerMessage, StateSnapshot } from "./types";

export interface ServerHandlers {
  getSnapshot: () => StateSnapshot;
  injectIncident: (riderId: string) => void;
  injectOutage: (zoneId: string) => void;
  start: () => void;
  stop: () => void;
}

export function createServer(port: number, handlers: ServerHandlers) {
  const clients = new Set<import("bun").ServerWebSocket<unknown>>();

  function broadcast(msg: ServerMessage) {
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      try {
        ws.send(payload);
      } catch {
        // client likely gone; it'll be cleaned up on close
      }
    }
  }

  const server = Bun.serve({
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (srv.upgrade(req)) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Deliberately independent of simulation/engine state — a health check should
      // answer "is the process alive" fast, not "is the simulation behaving correctly."
      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json({ status: "ok", uptimeSec: process.uptime() });
      }

      if (url.pathname === "/api/state" && req.method === "GET") {
        return Response.json(handlers.getSnapshot());
      }

      if (url.pathname === "/api/inject-incident" && req.method === "POST") {
        const body = (await req.json()) as { riderId?: string };
        if (!body.riderId) return new Response("riderId required", { status: 400 });
        handlers.injectIncident(body.riderId);
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/inject-outage" && req.method === "POST") {
        const body = (await req.json()) as { zoneId?: string };
        if (!body.zoneId) return new Response("zoneId required", { status: 400 });
        handlers.injectOutage(body.zoneId);
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/start" && req.method === "POST") {
        handlers.start();
        broadcast({ type: "snapshot", data: handlers.getSnapshot() });
        return Response.json({ ok: true });
      }

      if (url.pathname === "/api/stop" && req.method === "POST") {
        handlers.stop();
        broadcast({ type: "snapshot", data: handlers.getSnapshot() });
        return Response.json({ ok: true });
      }

      // Static dashboard files — the built bundle in dashboard/dist takes priority,
      // plain static assets (index.html, styles.css) live directly in dashboard/.
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      for (const base of ["dashboard/dist", "dashboard"]) {
        const file = Bun.file(`${base}${path}`);
        if (await file.exists()) return new Response(file);
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(JSON.stringify({ type: "snapshot", data: handlers.getSnapshot() } satisfies ServerMessage));
      },
      close(ws) {
        clients.delete(ws);
      },
      message() {
        // Dashboard is read-only by design (§3/§9 of PLAN.md) — no client message
        // ever changes engine state. Demo controls go through the REST endpoints
        // above, which act on the simulator, not on any escalation decision.
      },
    },
  });

  return { server, broadcast };
}
