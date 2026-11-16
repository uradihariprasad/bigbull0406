import type { NextRequest } from "next/server";
import { store } from "@/lib/market/store";
import { ensureWorkerStarted } from "@/lib/worker";
import { requireSameOrigin, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Manual "Scan now" — forces an immediate refresh of quotes, focused option
 * chains and all derived engines. Automatic polling continues on its own 30s
 * cadence; this only short-circuits the wait.
 */
export async function POST(req: NextRequest) {
  ensureWorkerStarted();
  const origin = requireSameOrigin(req);
  if (origin) return origin;
  const limited = rateLimit(req, "scan", 6, 60_000);
  if (limited) return limited;

  const started = Date.now();
  // A manual Scan must be able to BOOTSTRAP, not silently no-op while the
  // instrument master is still missing (the old behaviour after a fresh
  // token entry).
  if (!store.masterLoadedAt) {
    if (!store.tokenPresent) return Response.json({ ...store.gate(), scanned: false });
    await store.bootstrap();
    const st = await store.statusPayload();
    return Response.json({
      available: st.universe > 0,
      scanned: st.universe > 0,
      bootstrapped: true,
      stage: st.bootstrapStage,
      universe: st.universe,
      durationMs: Date.now() - started,
      reason: st.universe > 0 ? undefined : st.masterError ?? "Instrument master still loading",
      ts: Date.now(),
    });
  }

  const gate = store.gate();
  if (gate) return Response.json({ ...gate, scanned: false });

  const symbol = req.nextUrl.searchParams.get("symbol")?.toUpperCase();
  if (symbol) store.setFocus(symbol);
  await store.pollUniverse();
  await store.pollFocus();
  await store.refreshRvol();
  store.refreshEngines();
  const status = await store.statusPayload();
  return Response.json({
    available: true,
    scanned: true,
    durationMs: Date.now() - started,
    universe: status.universe,
    coverage: status.coverage,
    transport: status.transport,
    ts: Date.now(),
  });
}
