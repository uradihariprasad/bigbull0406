"use client";

/**
 * Data Health dashboard — full F&O universe coverage, straight from runtime
 * collection results. No hardcoded symbol lists; every eligible underlying
 * from the Upstox instrument master is audited automatically.
 */
import { useMemo, useState } from "react";
import { useApi, useApp, istTime, type J } from "@/lib/client";
import { Panel, Badge, Loading, NoData, isUnavailable } from "@/components/ui";

const STATE_TONE: Record<string, string> = {
  LIVE: "text-green",
  DELAYED: "text-blue",
  COMPLETE: "text-green",
  PARTIAL: "text-amber",
  STALE: "text-amber",
  DELAYED_COV: "text-amber",
  UNAVAILABLE: "text-red",
  INSTRUMENT_NOT_FOUND: "text-red",
  CONTRACT_NOT_AVAILABLE: "text-grey",
  NO_TRADES: "text-grey",
  RATE_LIMITED: "text-amber",
  AUTH_ERROR: "text-red",
  PROVIDER_ERROR: "text-red",
  INVALID_MAPPING: "text-red",
  INSUFFICIENT_HISTORY: "text-amber",
  UNSUPPORTED_DATA: "text-grey",
  NOT_FETCHED: "text-grey",
};

function Cell({ s }: { s: string }) {
  return <span className={`text-[9.5px] font-semibold ${STATE_TONE[s] ?? "text-grey"}`}>{s.replaceAll("_", " ")}</span>;
}

const FILTERS = ["ALL", "COMPLETE", "PARTIAL", "UNAVAILABLE", "DELAYED", "MAPPING_ERRORS", "RATE_LIMITED", "CHAIN_FAILURES"] as const;

export function DataHealth() {
  const { data, loading } = useApi<J>("/api/intel/data-health", 10_000);
  const { openWorkspace } = useApp();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    if (!data || isUnavailable(data)) return [];
    let r: J[] = data.rows ?? [];
    if (q) r = r.filter((x) => x.symbol.toUpperCase().includes(q.toUpperCase()) || (x.name ?? "").toUpperCase().includes(q.toUpperCase()));
    switch (filter) {
      case "COMPLETE": return r.filter((x) => x.level === "COMPLETE");
      case "PARTIAL": return r.filter((x) => x.level === "PARTIAL");
      case "UNAVAILABLE": return r.filter((x) => x.level === "UNAVAILABLE");
      case "DELAYED": return r.filter((x) => x.level === "DELAYED");
      case "MAPPING_ERRORS": return r.filter((x) => [x.spotState, x.chainState].some((s: string) => s === "INVALID_MAPPING" || s === "INSTRUMENT_NOT_FOUND"));
      case "RATE_LIMITED": return r.filter((x) => [x.spotState, x.futuresState, x.candleState, x.chainState].includes("RATE_LIMITED"));
      case "CHAIN_FAILURES": return r.filter((x) => x.chainState !== "LIVE" && x.chainState !== "DELAYED" && x.chainState !== "CONTRACT_NOT_AVAILABLE");
      default: return r;
    }
  }, [data, filter, q]);

  if (loading && !data) return <Loading label="Auditing the full F&O universe" />;
  if (!data || isUnavailable(data))
    return <Panel title="Data Health"><NoData reason={isUnavailable(data) ? data.reason : "Loading…"} code={isUnavailable(data) ? data.code : "LOADING"} /></Panel>;

  const c = data.counts ?? {};
  const cf = data.categoryFailures ?? {};
  const Metric = ({ label, val, tone = "text-txt" }: { label: string; val: number | string; tone?: string }) => (
    <div className="pg-panel-2 p-2">
      <div className="text-[8.5px] font-semibold uppercase tracking-wider text-grey">{label}</div>
      <div className={`tnum mt-0.5 text-[15px] font-bold ${tone}`}>{val}</div>
    </div>
  );

  return (
    <div className="space-y-2.5">
      <Panel
        title="Data Health — full F&O universe"
        sub={`${data.audited}/${data.total} underlyings audited · ${data.marketPhase ?? ""} · transport ${data.provider?.transport ?? "—"} · updated ${istTime(data.updatedAt)}`}
      >
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <Metric label="Eligible" val={data.total} tone="text-blue" />
          <Metric label="Complete" val={c.COMPLETE ?? 0} tone="text-green" />
          <Metric label="Partial" val={c.PARTIAL ?? 0} tone="text-amber" />
          <Metric label="Delayed" val={c.DELAYED ?? 0} tone="text-amber" />
          <Metric label="Unavailable" val={c.UNAVAILABLE ?? 0} tone="text-red" />
          <Metric label="Chain fails" val={cf.chain ?? 0} tone={cf.chain ? "text-amber" : "text-txt"} />
          <Metric label="Rate limited" val={cf.rateLimited ?? 0} tone={cf.rateLimited ? "text-amber" : "text-txt"} />
        </div>
        {data.marketPhase && data.marketPhase !== "OPEN" && (
          <p className="mt-2 rounded border border-blue/20 bg-blue/5 px-2 py-1 text-[9.5px] text-blue">
            Market is {String(data.marketPhase).toLowerCase()} — spot/futures show the last session close (expected), and option chains fill in progressively as the background collector sweeps the universe.
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[9.5px] text-grey">
          <span>spot fails {cf.spot ?? 0}</span>
          <span>futures fails {cf.futures ?? 0}</span>
          <span>candle fails {cf.candles ?? 0}</span>
          <span>OI history gaps {cf.oi ?? 0}</span>
          <span>mapping errors {cf.invalidMapping ?? 0}</span>
          <span>not yet fetched {cf.notFetched ?? 0}</span>
        </div>
      </Panel>

      <Panel
        pad={false}
        title="Instrument coverage"
        right={
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search symbol…"
            className="h-6 w-36 rounded border border-border bg-panel2 px-2 text-[10.5px] outline-none placeholder:text-grey/60 focus:border-blue/50"
          />
        }
      >
        <div className="flex flex-wrap gap-1 border-b border-border p-2">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded border px-2 py-0.5 text-[9.5px] font-semibold ${filter === f ? "border-blue/50 bg-blue/10 text-blue" : "border-border bg-panel2 text-txt-dim"}`}
            >
              {f.replaceAll("_", " ")}
            </button>
          ))}
          <span className="ml-auto self-center text-[9.5px] text-grey">{rows.length} shown</span>
        </div>
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full">
            <thead className="sticky top-0 bg-panel">
              <tr>
                {["Symbol", "Spot", "Futures", "Candles", "Option Chain", "OI History", "Overall", "Last OK", "Reason"].map((h) => (
                  <th key={h} className="pg-th">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} onClick={() => openWorkspace(r.symbol)} className="pg-row-hover cursor-pointer">
                  <td className="pg-td font-bold text-txt" title={`${r.name ?? ""} · ${r.spotKey ?? ""}`}>{r.symbol}</td>
                  <td className="pg-td"><Cell s={r.spotState} /></td>
                  <td className="pg-td"><Cell s={r.futuresState} /></td>
                  <td className="pg-td"><Cell s={r.candleState} /></td>
                  <td className="pg-td"><Cell s={r.chainState} /></td>
                  <td className="pg-td"><Cell s={r.oiState} /></td>
                  <td className="pg-td">
                    <Badge tone={r.level === "COMPLETE" ? "green" : r.level === "UNAVAILABLE" ? "red" : "amber"}>{r.level}</Badge>
                  </td>
                  <td className="pg-td text-[9.5px] text-txt-dim">{r.lastSuccessAt ? istTime(r.lastSuccessAt) : "—"}</td>
                  <td className="pg-td max-w-[220px] truncate text-[9px] text-grey" title={r.lastError ?? ""}>{r.lastError ?? (r.level === "COMPLETE" ? "" : r.missing?.join(", "))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="py-6 text-center text-[11px] text-grey">No instruments match this filter</div>}
        </div>
        <div className="border-t border-border px-3 py-1.5 text-[9px] text-grey">
          Audited automatically from live collection results · click any row to open its workspace · PARTIAL/UNAVAILABLE instruments are retried with backoff
        </div>
      </Panel>
    </div>
  );
}
