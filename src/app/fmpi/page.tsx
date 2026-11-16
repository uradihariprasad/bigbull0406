"use client";

/** Module 11 — FMPI Momentum (component decomposition + history + universe) */
import { useState } from "react";
import { useApi, useApp, useBreakpoint, fmt, clsColor, type J, apiUrl, istTime } from "@/lib/client";
import { Panel, Badge, ClassChip, Loading, SymbolPicker, Meter, EvidenceBars, FreshnessDot, NoData, isUnavailable } from "@/components/ui";
import { Sparkline, FMPIGauge } from "@/components/charts";
import { Gauge } from "lucide-react";

const COMPONENT_LABELS: Record<string, string> = {
  underlying: "Underlying momentum",
  options: "Options premium",
  futures: "Futures",
  oiFlow: "OI flow",
  volume: "Volume / RVOL",
  structure: "Market structure",
  trend: "VWAP · EMA",
};

export default function FmpiPage() {
  const { symbol, openWorkspace } = useApp();
  const [tf, setTf] = useState("5m");
  const { data: f } = useApi<J>(apiUrl("/api/intel/fmpi", { symbol, tf }), 5000);
  const { data: series } = useApi<J>(apiUrl("/api/intel/fmpi-series", { symbol, tf }), 10000);
  const { data: ov } = useApi<J>("/api/intel/overview", 6000);
  const { isMobile, width } = useBreakpoint();

  if (!f) return <Loading label="Computing FMPI" />;
  if (isUnavailable(f))
    return (
      <div className="space-y-2.5">
        <Panel pad><SymbolPicker /></Panel>
        <Panel title="FMPI Momentum"><NoData reason={f.reason} code={f.code} /></Panel>
      </div>
    );
  const seriesOk = series && !isUnavailable(series) ? series : null;
  const ovOk = ov && !isUnavailable(ov) ? ov : null;

  return (
    <div className="space-y-2.5">
      <Panel pad>
        <div className="flex flex-wrap items-center gap-3">
          <SymbolPicker />
          <div className="flex gap-0.5 rounded-md border border-border bg-panel2 p-0.5">
            {["5m", "10m", "15m"].map((t) => (
              <button key={t} onClick={() => setTf(t)} className={`rounded px-2 py-0.5 text-[10px] font-semibold ${tf === t ? "bg-blue/15 text-blue" : "text-txt-dim"}`}>{t}</button>
            ))}
          </div>
          <span className="text-[10px] text-grey">missing components reduce coverage — they never become zero evidence</span>
          <span className="ml-auto"><FreshnessDot f="LIVE" /></span>
        </div>
      </Panel>

      <div className="grid gap-2.5 lg:grid-cols-3">
        <Panel title={<span className="flex items-center gap-1.5"><Gauge className="h-3 w-3 text-blue" />FMPI {tf}</span>}>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className={`tnum text-3xl font-bold ${clsColor(f.value)}`}>{f.value}</span>
              <ClassChip v={f.classification} />
            </div>
            <FMPIGauge value={f.value} />
            <div className="grid grid-cols-3 gap-1.5 pt-1">
              {[
                ["RAW", f.value, "immediate pressure"],
                ["SMOOTHED", f.smoothed, `α ${f.smoothingAlpha ?? "—"}`],
                ["CONFIRMED", f.confirmed, "completed candle"],
              ].map(([l, v, hint]) => (
                <div key={l as string} className="rounded bg-panel2 p-1.5">
                  <div className="text-[8.5px] uppercase tracking-wider text-grey">{l}</div>
                  <div className={`tnum text-[13px] font-bold ${clsColor(v as number)}`}>{v == null ? "—" : (v as number).toFixed(1)}</div>
                  <div className="text-[8px] text-grey">{hint}</div>
                </div>
              ))}
            </div>
            {f.impulse && (
              <div className={`rounded border px-2 py-1 text-[10px] font-semibold ${f.impulse.kind === "BULLISH_IMPULSE" ? "border-green/30 bg-green/10 text-green" : "border-red/30 bg-red/10 text-red"}`}>
                {f.impulse.kind.replaceAll("_", " ")} · {f.impulse.delta > 0 ? "+" : ""}{f.impulse.delta} pts ({f.impulse.from.toFixed(0)} → {f.impulse.to.toFixed(0)})
              </div>
            )}
            <div className="flex justify-between text-[9px] text-grey"><span>−100</span><span>adaptive bands ±{f.thresholds?.moderate} / ±{f.thresholds?.strong}</span><span>+100</span></div>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={f.acceleration === "ACCELERATING" ? "green" : f.acceleration === "DECELERATING" ? "amber" : "grey"}>{f.acceleration}</Badge>
              {f.exhaustionCandidate && <Badge tone="amber">MOMENTUM EXHAUSTION CANDIDATE</Badge>}
              {f.divergence !== "NONE" && <Badge tone="amber">{f.divergence.replaceAll("_", " ")}</Badge>}
            </div>
            <div>
              <div className="flex justify-between text-[9.5px] text-txt-dim"><span>Evidence coverage</span><EvidenceBars coverage={f.coverage} /></div>
              <Meter value={(f.coverage ?? 0) * 100} />
            </div>
            {f.confirmationRequired?.length > 0 && (
              <div className="rounded border border-amber/20 bg-amber/5 p-1.5 text-[9.5px] text-amber/90">
                {f.confirmationRequired.map((c: string) => <div key={c}>• {c}</div>)}
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Component contribution" sub="signed points per family (correlation-capped)">
          <div className="space-y-1.5">
            {(f.quality ?? []).map((q: J) => (
              <div key={q.key} className="flex items-start gap-2 text-[10px]">
                <span className="w-20 shrink-0 truncate text-txt-dim sm:w-24">{q.label}</span>
                {q.value == null ? (
                  <span className="flex-1 text-[9px] text-amber">{q.availability.replaceAll("_", " ")} — {q.reason}</span>
                ) : (
                  <>
                    <div className="relative h-1.5 min-w-[40px] flex-1 rounded-full bg-panel2">
                      <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                      <div className={`absolute inset-y-0 rounded-full ${q.value >= 0 ? "bg-green" : "bg-red"}`}
                        style={{ left: q.value >= 0 ? "50%" : `${50 - Math.min(Math.abs(q.contribution) * 5, 50)}%`, width: `${Math.min(Math.abs(q.contribution) * 5, 50)}%` }} />
                    </div>
                    <span className={`tnum w-10 text-right ${clsColor(q.contribution)}`}>{q.contribution.toFixed(1)}</span>
                  </>
                )}
                <span className={`w-12 shrink-0 text-right text-[8.5px] ${q.availability === "LIVE" ? "text-green" : q.availability === "UNAVAILABLE" ? "text-grey" : "text-amber"}`}>
                  {q.availability.replaceAll("_", " ")}
                </span>
              </div>
            ))}

          </div>
        </Panel>

        <Panel title={`FMPI history — ${symbol} ${tf}`} sub="one instrument, one timeframe: no cross-symbol leakage">
          {seriesOk?.smoothedPoints?.length ? (
            <Sparkline points={seriesOk.smoothedPoints.map((p: J) => p.value)} width={Math.min(width - 72, 340)} height={isMobile ? 90 : 120} color={f.value >= 0 ? "#16c784" : "#ea3943"} />
          ) : seriesOk?.points?.length ? (
            <Sparkline points={seriesOk.points.map((p: J) => p.value)} width={Math.min(width - 72, 340)} height={isMobile ? 90 : 120} color={f.value >= 0 ? "#16c784" : "#ea3943"} />
          ) : (
            <span className="text-[11px] text-grey">{seriesOk?.note ?? "Building history from live observations…"}</span>
          )}
          <div className="mt-1 flex justify-between text-[9px] text-grey"><span>−100</span><span>0</span><span>+100</span></div>
        </Panel>
      </div>

      <Panel title="Why is FMPI bullish / bearish?" sub="generated from actual component values">
        <div className="grid gap-2 md:grid-cols-3">
          <div>
            <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-wider text-green">Bullish evidence</div>
            {(f.bullish ?? []).length ? (f.bullish ?? []).map((t: string) => <div key={t} className="py-0.5 text-[10px] text-txt-dim">• {t}</div>) : <div className="text-[10px] text-grey">none</div>}
          </div>
          <div>
            <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-wider text-red">Bearish evidence</div>
            {(f.bearish ?? []).length ? (f.bearish ?? []).map((t: string) => <div key={t} className="py-0.5 text-[10px] text-txt-dim">• {t}</div>) : <div className="text-[10px] text-grey">none</div>}
          </div>
          <div>
            <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-wider text-amber">Conflicting / missing</div>
            {(f.conflicting ?? []).slice(0, 6).map((t: string) => <div key={t} className="py-0.5 text-[10px] text-txt-dim">• {t}</div>)}
          </div>
        </div>
        {(f.transitions ?? []).length > 0 && (
          <div className="mt-2 border-t border-border pt-1.5">
            <div className="mb-1 text-[9.5px] uppercase tracking-wider text-grey">Classification transitions</div>
            {(f.transitions ?? []).slice().reverse().map((t: J, i: number) => (
              <div key={i} className="text-[9.5px] text-txt-dim">{istTime(t.ts)} · {t.from.replaceAll("_", " ")} → <b className={clsColor(t.to.includes("BULLISH") ? 1 : -1)}>{t.to.replaceAll("_", " ")}</b> · {t.reason}</div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="FMPI universe (5m)" sub="sorted by absolute pressure" pad={false}>
        <div className="grid gap-0 md:grid-cols-2">
          {(ovOk?.strongFmpi ?? []).map((r: J) => (
            <button key={r.symbol} onClick={() => openWorkspace(r.symbol)} className="flex items-center justify-between border-b border-border/60 px-3 py-1.5 text-left hover:bg-panel2">
              <span className="text-[11.5px] font-semibold">{r.symbol}</span>
              <span className="flex items-center gap-2">
                <span className={`tnum text-[11.5px] font-bold ${clsColor(r.fmpi)}`}>{r.fmpi?.toFixed(1)}</span>
                <ClassChip v={r.classification} />
              </span>
            </button>
          ))}
        </div>
      </Panel>
      <p className="text-[9.5px] text-grey">
        FMPI is a proprietary composite (underlying · options premia · futures · OI flow · volume · structure · VWAP/EMA), normalized against the instrument’s own volatility.
        It is not RSI; there are no fixed overbought/oversold thresholds and a score is never a probability.
      </p>
    </div>
  );
}
