import type { NextRequest } from "next/server";
import { store } from "@/lib/market/store";
import { ensureWorkerStarted } from "@/lib/worker";
import type { Timeframe } from "@/lib/engine/types";

export const dynamic = "force-dynamic";

/**
 * Typed intel resources. Every response is either `{available:true, …}` with
 * real Upstox-derived values, or `{available:false, reason, code}`.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ resource: string }> }) {
  ensureWorkerStarted();
  const { resource } = await params;
  const sp = req.nextUrl.searchParams;
  const symbol = (sp.get("symbol") ?? "NIFTY").toUpperCase();
  const tf = (sp.get("tf") ?? "5m") as Timeframe;
  const perSymbol = !["overview", "dominance", "futures-all"].includes(resource);
  if (perSymbol) store.setFocus(symbol);
  const expiry = sp.get("expiry") ?? store.expiriesOf(symbol)[0];

  /**
   * Warm-ups run in PARALLEL and are time-bounded. Previously these were
   * sequential awaits, so a first visit to a symbol blocked the response for
   * the SUM of several Upstox round trips (~1s). Now the response returns
   * with whatever is ready; the client's next poll picks up the rest.
   */
  const warm: Promise<unknown>[] = [];
  const needsChain = ["oi-momentum", "premium-momentum", "workspace", "sr-levels"].includes(resource);
  const needsCandles = ["sr", "sr-levels", "structure", "volume-profile", "fmpi", "fmpi-series", "targets", "workspace", "order-flow"].includes(resource);

  if (needsChain && expiry) warm.push(store.refreshChain(symbol, expiry).catch(() => undefined));
  if (needsCandles) {
    warm.push(store.getCandles(symbol, "1m").catch(() => undefined));
    if (resource === "sr" || resource === "sr-levels" || resource === "workspace") warm.push(store.getDailyCandles(symbol).catch(() => undefined));
    if (store.isIndex(symbol)) warm.push(store.buildMappedProfile(symbol, tf === "1D" ? "5m" : tf).catch(() => undefined));
  }
  if (warm.length) {
    // never hold the response longer than this; data lands on the next poll
    await Promise.race([Promise.all(warm), new Promise((r) => setTimeout(r, 2500))]);
  }

  switch (resource) {
    case "coverage":
    case "data-health":
      return Response.json(store.coveragePayload());
    case "overview":
      return Response.json(store.overviewPayload());
    case "dominance":
      return Response.json(store.dominancePayload());
    case "oi-momentum":
      return Response.json(expiry ? store.oiMomentumPayload(symbol, expiry) : noExpiry(symbol));
    case "futures":
      return Response.json(store.futuresPayload(symbol));
    case "futures-all":
      return Response.json(store.futuresAllPayload());
    case "premium-momentum":
      return Response.json(expiry ? store.premiumMomentumPayload(symbol, expiry) : noExpiry(symbol));
    case "fmpi": {
      const gate = store.gate();
      if (gate) return Response.json(gate);
      const f = store.fmpiFor(symbol, tf);
      return Response.json(f ? { available: true, symbol, tf, ...f } : { available: false, reason: "No live quote for this instrument yet.", code: "NO_QUOTE" });
    }
    case "fmpi-series":
      return Response.json(store.fmpiSeries(symbol, tf));
    case "sr":
      return Response.json(store.srPayload(symbol, tf));
    case "sr-levels":
      return Response.json(store.srLevelsPayload(symbol, tf));
    case "structure":
      return Response.json(store.structurePayload(symbol, tf));
    case "volume-profile":
      return Response.json(store.volumeProfilePayload(symbol));
    case "order-flow":
      return Response.json(store.orderFlowPayload(symbol));
    case "targets":
      return Response.json(store.targetsPayload(symbol));
    case "workspace":
      return Response.json(store.workspacePayload(symbol, expiry ?? undefined));
    default:
      return Response.json({ available: false, reason: `Unknown resource ${resource}`, code: "UNKNOWN" }, { status: 404 });
  }
}

function noExpiry(symbol: string) {
  return { available: false, reason: `No listed option expiry for ${symbol} in the Upstox master.`, code: "NO_EXPIRY" };
}
