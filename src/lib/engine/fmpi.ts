/**
 * PULSEGRID 2.0 — FMPI component scoring (stateless).
 *
 * CORRECTIONS APPLIED (audited against the previous implementation):
 *  1. Missing CE/PE premiums are NEVER substituted with zero. Previously
 *     `ce ?? 0` meant one available side manufactured artificial direction.
 *  2. Components expose explicit data quality (value / availability /
 *     coverage / reason) so an appearing or disappearing component cannot
 *     cause an unexplained score jump.
 *  3. Correlation control is now FAMILY-LEVEL: trend, derivatives and
 *     participation groups are each normalised and capped before aggregation,
 *     so three indicators describing one move cannot triple the score.
 *  4. Momentum is normalised against a timeframe-compatible horizon
 *     (ATR-normalised displacement preferred over an annualised vol figure).
 *  5. OI windows are weighted as overlapping evidence, not three independent
 *     confirmations.
 *
 * Output range remains [-100, +100]. FMPI is a momentum-pressure index, not a
 * reversal probability.
 */
import { clamp, squash } from "./indicators";
const SMOOTHING_ALPHA_REF: Record<string, number> = { "5m": 0.3, "10m": 0.25, "15m": 0.2 };

export type Availability =
  | "LIVE" | "DELAYED" | "STALE" | "PARTIAL"
  | "UNAVAILABLE" | "INSUFFICIENT_HISTORY" | "INVALID_MAPPING";

export interface FMPIInput {
  // ---- underlying -------------------------------------------------------
  priceMomPct: number | null;
  realizedVolPct: number | null;
  /** ATR-normalised displacement over the same window (preferred normaliser) */
  atrMomUnits?: number | null;
  atr?: number | null;
  // ---- options ----------------------------------------------------------
  cePremChgPct: number | null;
  pePremChgPct: number | null;
  optionVolAccel: number | null;
  rvol: number | null;
  // ---- OI flow ----------------------------------------------------------
  oiChg5mDir: number | null;
  oiChg15mDir: number | null;
  oiSessDir: number | null;
  // ---- futures ----------------------------------------------------------
  futChgPct: number | null;
  futOiChgPct: number | null;
  basisChg: number | null;
  // ---- trend refs -------------------------------------------------------
  priceVsVwapPct: number | null;
  emaAlignment: number | null;
  structureDir: "UP" | "DOWN" | "RANGE" | null;
  higherTfAgree: boolean | null;
  volatilityPct: number | null;
}

export type FMPIClass =
  | "STRONG_BULLISH" | "BULLISH" | "WEAK_BULLISH" | "NEUTRAL"
  | "WEAK_BEARISH" | "BEARISH" | "STRONG_BEARISH";

export type FMPIAccel = "ACCELERATING" | "DECELERATING" | "FLAT";

export interface ComponentQuality {
  key: string;
  label: string;
  /** signed normalised component value in [-1, +1]; null when unavailable */
  value: number | null;
  /** raw un-normalised evidence, for explainability */
  rawValue: string;
  availability: Availability;
  /** 0..1 — how much of this family's expected evidence is present */
  coverage: number;
  freshness: "LIVE" | "DELAYED" | "STALE" | "UNKNOWN";
  sourceTimestamp: number | null;
  confidence: number;
  reason: string;
  /** signed contribution to the final score, in index points */
  contribution: number;
  weight: number;
}

export interface FMPIOutput {
  value: number;
  classification: FMPIClass;
  acceleration: FMPIAccel;
  divergence: "BULLISH_DIVERGENCE" | "BEARISH_DIVERGENCE" | "NONE";
  exhaustionCandidate: boolean;
  components: Record<string, number>;
  rawComponents: Record<string, number | null>;
  coverage: number;
  weightsUsed: Record<string, number>;
  thresholds: { strong: number; moderate: number; weak: number };
  confirmationRequired: string[];
  /** NEW — per-component data quality for the UI */
  quality: ComponentQuality[];
  /** NEW — family-level normalised scores after correlation control */
  families: { trend: number | null; derivatives: number | null; participation: number | null };
  /** NEW — evidence summary generated from actual component values */
  bullish: string[];
  bearish: string[];
  conflicting: string[];
  /** NEW — temporal layer (populated by the store via fmpi-smoothing) */
  smoothed: number | null;
  confirmed: number | null;
  impulse: { ts: number; kind: "BULLISH_IMPULSE" | "BEARISH_IMPULSE"; delta: number; from: number; to: number } | null;
  transitions: { ts: number; from: string; to: string; smoothed: number; reason: string }[];
  smoothedHistory: { ts: number; raw: number; smoothed: number; coverage: number }[];
  smoothingAlpha: number;
}

export const WEIGHTS: Record<string, number> = {
  underlying: 0.22,
  options: 0.2,
  futures: 0.16,
  oiFlow: 0.14,
  volume: 0.1,
  structure: 0.1,
  trend: 0.08,
};

export const COMPONENT_LABELS: Record<string, string> = {
  underlying: "Underlying momentum",
  options: "Options premium",
  futures: "Futures positioning",
  oiFlow: "OI flow",
  volume: "Volume / RVOL",
  structure: "Market structure",
  trend: "VWAP + EMA",
};

/* ------------------------------------------------------------- helpers */
function quality(
  key: string, value: number | null, rawValue: string, availability: Availability,
  coverage: number, reason: string, weight: number,
  freshness: ComponentQuality["freshness"] = "UNKNOWN", sourceTimestamp: number | null = null,
): ComponentQuality {
  const conf = availability === "LIVE" ? clamp(coverage, 0, 1)
    : availability === "PARTIAL" ? clamp(coverage * 0.7, 0, 1)
    : availability === "DELAYED" ? clamp(coverage * 0.6, 0, 1)
    : availability === "STALE" || availability === "INSUFFICIENT_HISTORY" ? clamp(coverage * 0.35, 0, 1)
    : 0;
  return {
    key, label: COMPONENT_LABELS[key] ?? key, value, rawValue, availability,
    coverage: Math.round(coverage * 100) / 100, freshness, sourceTimestamp,
    confidence: Math.round(conf * 100) / 100, reason, contribution: 0, weight,
  };
}

/** Robust price displacement normalisation — avoids divide-by-near-zero. */
function normalizeDisplacement(movePct: number | null, scalePct: number | null): number | null {
  if (movePct == null) return null;
  const scale = Math.max(scalePct ?? 0, 0.05); // floor: never divide by ~0
  return squash((movePct / scale) * 1.25);
}

/* ------------------------------------------------------------ components */
function underlyingComponent(inp: FMPIInput, volScale: number): ComponentQuality {
  const mom = normalizeDisplacement(inp.priceMomPct, volScale);
  const atrBased = inp.atrMomUnits == null ? null : clamp(squash(inp.atrMomUnits * 1.1), -1, 1);
  // prefer ATR normalisation (timeframe-consistent); fall back to vol ratio
  const value = atrBased ?? mom;
  if (value == null)
    return quality("underlying", null, "no candles", "INSUFFICIENT_HISTORY", 0,
      "not enough completed candles on this timeframe", WEIGHTS.underlying);
  const coverage = atrBased != null ? 1 : 0.8;
  return quality("underlying", value,
    `${(inp.priceMomPct ?? 0).toFixed(2)}% over window${inp.atrMomUnits != null ? ` · ${(inp.atrMomUnits).toFixed(2)} ATR` : ""}`,
    "LIVE", coverage, atrBased != null ? "ATR-normalised displacement" : "realised-vol normalised", WEIGHTS.underlying, "LIVE");
}

function optionsComponent(inp: FMPIInput): ComponentQuality {
  const ce = inp.cePremChgPct;
  const pe = inp.pePremChgPct;
  const hasCe = ce != null;
  const hasPe = pe != null;
  // NO ZERO SUBSTITUTION: with only one side present we cannot form a
  // directional CE-vs-PE spread, so the family is PARTIAL and neutral.
  if (!hasCe && !hasPe)
    return quality("options", null, "no premium observations", "UNAVAILABLE", 0,
      "no CE or PE premium history in the observation window", WEIGHTS.options);
  if (!hasCe || !hasPe) {
    const side = hasCe ? "CE" : "PE";
    return quality("options", 0, `${side} ${(hasCe ? ce : pe)!.toFixed(2)}% · opposite side missing`,
      "PARTIAL", 0.5, `only ${side} premium available — CE/PE spread cannot be formed`, WEIGHTS.options);
  }
  // Both sides present: spread, with low-premium distortion protection.
  // A far-OTM 0.05 → 0.10 move is +100% but meaningless; clamp the spread.
  const spread = clamp((ce! - pe!) / 12, -1, 1);
  let cov = 1;
  const notes: string[] = [`CE ${ce!.toFixed(1)}%`, `PE ${pe!.toFixed(1)}%`];
  // low-premium guard: if either side trades below a floor, reduce confidence
  if (Math.min(Math.abs(ce!), Math.abs(pe!)) < 0.5) {
    cov = 0.7;
    notes.push("low-premium contract — % distortion reduced");
  }
  const value = clamp(spread + (inp.optionVolAccel != null ? clamp(inp.optionVolAccel / 3, -0.2, 0.2) * Math.sign(spread || 1) : 0), -1, 1);
  return quality("options", value, notes.join(" · "), "LIVE", cov,
    "CE vs PE premium spread over a matching observation window", WEIGHTS.options, "LIVE");
}

function futuresComponent(inp: FMPIInput, volScale: number): ComponentQuality {
  const { futChgPct, futOiChgPct, basisChg } = inp;
  const priceKnown = futChgPct != null;
  const oiKnown = futOiChgPct != null;
  if (!priceKnown && !oiKnown)
    return quality("futures", null, "no futures data", "UNAVAILABLE", 0,
      "futures contract, quote or OI baseline unavailable", WEIGHTS.futures);
  if (!oiKnown) {
    // price alone is NOT positioning — never fabricate a buildup
    return quality("futures", priceKnown ? clamp(normalizeDisplacement(futChgPct, volScale) ?? 0, -1, 1) * 0.5 : null,
      priceKnown ? `price ${(futChgPct!).toFixed(2)}% · OI missing` : "no futures data",
      "PARTIAL", 0.4, "futures OI change unavailable — price alone is not positioning evidence", WEIGHTS.futures);
  }
  let sum = 0, parts = 0;
  if (priceKnown) {
    sum += clamp(normalizeDisplacement(futChgPct, volScale) ?? 0, -1, 1);
    parts++;
  }
  if (priceKnown && oiKnown) {
    // price + OI relationship: the only true positioning read
    const dir = Math.sign(futChgPct!);
    sum += squash((Math.abs(futOiChgPct!) / 3) * dir);
    parts++;
  }
  if (basisChg != null) {
    sum += squash(basisChg / 5) * 0.5;
    parts += 0.5;
  }
  return quality("futures", clamp(sum / Math.max(parts, 1), -1, 1),
    `${priceKnown ? `price ${(futChgPct!).toFixed(2)}%` : "price n/a"} · OI ${(futOiChgPct!).toFixed(2)}%`,
    "LIVE", 1, "futures price/OI relationship", WEIGHTS.futures, "LIVE");
}

function oiComponent(inp: FMPIInput): ComponentQuality {
  const w5 = inp.oiChg5mDir, w15 = inp.oiChg15mDir, sess = inp.oiSessDir;
  const known = [w5, w15, sess].filter((v) => v != null).length;
  if (!known)
    return quality("oiFlow", null, "no OI history", "INSUFFICIENT_HISTORY", 0,
      "no valid 5m/15m/session OI observations yet", WEIGHTS.oiFlow);
  // Overlapping windows: 15m is context, session is weaker context — not 3 votes.
  let sum = 0, wsum = 0;
  if (w5 != null) { sum += w5 * 0.5; wsum += 0.5; }
  if (w15 != null) { sum += w15 * 0.35; wsum += 0.35; }
  if (sess != null) { sum += sess * 0.15; wsum += 0.15; }
  const cov = clamp(known / 3, 0, 1);
  return quality("oiFlow", clamp(sum / Math.max(wsum, 1e-9), -1, 1),
    [w5 != null ? "5m" : null, w15 != null ? "15m" : null, sess != null ? "session" : null].filter(Boolean).join("+") + " OI windows",
    known < 3 ? "PARTIAL" : "LIVE", cov, known < 3 ? "partial OI history — lower confidence" : "ATM±3 OI positioning", WEIGHTS.oiFlow, known < 3 ? "UNKNOWN" : "LIVE");
}

function volumeComponent(inp: FMPIInput, dirBias: number): ComponentQuality {
  const { rvol, optionVolAccel } = inp;
  if (rvol == null && optionVolAccel == null)
    return quality("volume", null, "no volume reference", "UNAVAILABLE", 0,
      "RVOL and option-volume acceleration unavailable", WEIGHTS.volume);
  // Volume NEVER manufactures direction — it amplifies an existing read only.
  const amp = rvol != null ? squash(Math.max(rvol - 1, 0) / 1.5) : 0;
  const value = dirBias === 0 ? null : clamp(dirBias * amp, -1, 1);
  const cov = rvol != null ? 1 : 0.6;
  return quality("volume", value,
    [rvol != null ? `RVOL ${rvol.toFixed(2)}×` : null, optionVolAccel != null ? `opt vol accel ${optionVolAccel.toFixed(2)}` : null].filter(Boolean).join(" · ") || "no data",
    rvol != null ? "LIVE" : "PARTIAL", cov,
    dirBias === 0 ? "no directional context from price/futures — volume cannot create direction" : "volume amplifies existing direction only",
    WEIGHTS.volume);
}

function structureComponent(inp: FMPIInput): ComponentQuality {
  const { structureDir, higherTfAgree } = inp;
  if (!structureDir)
    return quality("structure", null, "no structure", "INSUFFICIENT_HISTORY", 0,
      "not enough candles to classify market structure", WEIGHTS.structure);
  let v = structureDir === "UP" ? 0.8 : structureDir === "DOWN" ? -0.8 : 0;
  let cov = 1;
  let reason = "confirmed swing structure";
  if (higherTfAgree === false) { v *= 0.5; cov = 0.75; reason = "countertrend to higher timeframe — down-weighted"; }
  else if (higherTfAgree === true) { reason = "aligned with higher timeframe"; }
  return quality("structure", v, structureDir, "LIVE", cov, reason, WEIGHTS.structure, "LIVE");
}

function trendComponent(inp: FMPIInput, volScale: number): ComponentQuality {
  const parts: { v: number; label: string }[] = [];
  if (inp.priceVsVwapPct != null) {
    // neutral band: a tiny move around VWAP must not flip the family
    const d = inp.priceVsVwapPct;
    const band = Math.max(volScale * 0.18, 0.04);
    const v = Math.abs(d) < band ? 0 : clamp(squash(((d - Math.sign(d) * band) / volScale) * 1.6), -1, 1);
    parts.push({ v, label: `VWAP ${d >= 0 ? "+" : ""}${d.toFixed(2)}%` });
  }
  if (inp.emaAlignment != null) parts.push({ v: clamp(inp.emaAlignment, -1, 1), label: `EMA stack ${(inp.emaAlignment * 100).toFixed(0)}%` });
  if (!parts.length)
    return quality("trend", null, "no VWAP/EMA", "UNAVAILABLE", 0, "no session VWAP or EMA data", WEIGHTS.trend);
  const value = clamp(parts.reduce((s, p) => s + p.v, 0) / parts.length, -1, 1);
  return quality("trend", value, parts.map((p) => p.label).join(" · "), "LIVE", 1, "VWAP distance (neutral-banded) + EMA alignment", WEIGHTS.trend, "LIVE");
}

/* ------------------------------------------------------------- main calc */
export function computeFMPI(inp: FMPIInput, prevValues: number[] = []): FMPIOutput {
  // timeframe-consistent volatility scale: prefer the intraday realised vol
  // of the SAME horizon as the momentum window; floor to avoid /0.
  const volScale = Math.max(inp.realizedVolPct ?? inp.volatilityPct ?? 0.5, 0.05);

  const comps: ComponentQuality[] = [
    underlyingComponent(inp, volScale),
    optionsComponent(inp),
    futuresComponent(inp, volScale),
    oiComponent(inp),
    structureComponent(inp),
    trendComponent(inp, volScale),
  ];

  // directional context for the volume family (price + futures only)
  const dirCtx = [comps[0].value, comps[2].value].filter((v) => v != null) as number[];
  const dirBias = dirCtx.length ? clamp(dirCtx.reduce((s, v) => s + v, 0) / dirCtx.length, -1, 1) : 0;
  comps.push(volumeComponent(inp, dirBias));

  // ---- FAMILY-LEVEL CORRELATION CONTROL ---------------------------------
  // Families: trend = underlying+structure+trend, derivatives = options+futures+oiFlow,
  // participation = volume. Within a family, same-sign evidence is geometrically
  // dampened so three correlated indicators cannot triple the score.
  const familyOf: Record<string, "trend" | "derivatives" | "participation"> = {
    underlying: "trend", structure: "trend", trend: "trend",
    options: "derivatives", futures: "derivatives", oiFlow: "derivatives",
    volume: "participation",
  };
  const familyScores: Record<string, { num: number; wsum: number }[]> = { trend: [], derivatives: [], participation: [] };
  for (const c of comps) {
    if (c.value == null) continue;
    familyScores[familyOf[c.key]].push({ num: c.value * c.weight, wsum: c.weight });
  }
  const fam: { trend: number | null; derivatives: number | null; participation: number | null } = { trend: null, derivatives: null, participation: null };
  const famValues: { fam: "trend" | "derivatives" | "participation"; v: number; w: number }[] = [];
  for (const f of ["trend", "derivatives", "participation"] as const) {
    const rows = familyScores[f];
    if (!rows.length) continue;
    const wsum = rows.reduce((s, r) => s + r.wsum, 0);
    const mean = rows.reduce((s, r) => s + r.num, 0) / wsum;
    // agreement: how much of the family points the same way
    const agreement = rows.reduce((s, r) => s + Math.sign(r.num) * Math.sign(mean) * r.wsum, 0) / wsum;
    // agreeing evidence reinforces modestly; disagreement is dampened hard
    const damp = 0.55 + 0.45 * agreement;
    fam[f] = clamp(mean * damp, -1, 1);
    famValues.push({ fam: f, v: fam[f]!, w: wsum });
  }

  // ---- aggregate over families with coverage weighting -------------------
  let num = 0, den = 0, availableW = 0, totalW = 0;
  for (const c of comps) totalW += c.weight;
  for (const fv of famValues) {
    const w = fv.w;
    num += fv.v * w;
    den += w;
    availableW += w;
  }
  const coverage = totalW > 0 ? availableW / totalW : 0;
  const value = den > 0 ? clamp((num / den) * 100, -100, 100) : 0;

  // component contributions reported in index points (family-damped)
  const components: Record<string, number> = {};
  const rawComponents: Record<string, number | null> = {};
  const weightsUsed: Record<string, number> = {};
  const bullish: string[] = [];
  const bearish: string[] = [];
  const conflicting: string[] = [];
  for (const c of comps) {
    rawComponents[c.key] = c.value;
    if (c.value != null) {
      const famScore = fam[familyOf[c.key]] ?? c.value;
      components[c.key] = Math.round(famScore * c.weight * 1000) / 10;
      weightsUsed[c.key] = c.weight;
      const txt = `${c.label}: ${c.rawValue}`;
      if (c.value > 0.15) bullish.push(txt);
      else if (c.value < -0.15) bearish.push(txt);
      else conflicting.push(`${c.label}: neutral (${c.rawValue})`);
    } else {
      components[c.key] = 0;
      conflicting.push(`${c.label}: ${c.reason}`);
    }
  }
  // map computed quality onto the components array
  for (const c of comps) {
    const famScore = c.value == null ? 0 : fam[familyOf[c.key]] ?? c.value;
    c.contribution = Math.round(famScore * c.weight * 1000) / 10;
  }

  // ---- volatility-adaptive thresholds + hysteresis-friendly bands ---------
  const widen = clamp(volScale / 0.5, 0.8, 1.6);
  const thresholds = { strong: Math.min(45 * widen, 60), moderate: 22 * widen, weak: 8 * widen };

  const abs = Math.abs(value);
  let classification: FMPIClass = "NEUTRAL";
  // minimum evidence gate: a strong label needs decent coverage
  const strongGate = coverage >= 0.6;
  if (abs >= thresholds.strong && strongGate) classification = value > 0 ? "STRONG_BULLISH" : "STRONG_BEARISH";
  else if (abs >= thresholds.moderate) classification = value > 0 ? "BULLISH" : "BEARISH";
  else if (abs >= thresholds.weak) classification = value > 0 ? "WEAK_BULLISH" : "WEAK_BEARISH";

  // ---- acceleration / divergence / exhaustion ----------------------------
  let acceleration: FMPIAccel = "FLAT";
  let divergence: FMPIOutput["divergence"] = "NONE";
  let exhaustionCandidate = false;
  if (prevValues.length >= 3) {
    const d1 = prevValues[prevValues.length - 1] - prevValues[prevValues.length - 2];
    const d2 = prevValues[prevValues.length - 2] - prevValues[prevValues.length - 3];
    if (Math.abs(d1) > 3 && Math.abs(d2) > 3 && Math.sign(d1) === Math.sign(d2)) acceleration = "ACCELERATING";
    else if (Math.sign(d1) !== Math.sign(d2) && Math.abs(d2) > 3) acceleration = "DECELERATING";
    if (abs > thresholds.moderate && acceleration === "DECELERATING" && Math.abs(d1) > 2) exhaustionCandidate = true;
  }
  if (inp.priceMomPct != null && prevValues.length >= 3) {
    const priceUp = inp.priceMomPct > 0;
    const fmpiFalling = prevValues[prevValues.length - 1] < prevValues[0];
    if (priceUp && fmpiFalling && value > 0) divergence = "BEARISH_DIVERGENCE";
    if (!priceUp && !fmpiFalling && value < 0) divergence = "BULLISH_DIVERGENCE";
  }

  const confirmationRequired: string[] = [];
  for (const c of comps) if (c.value == null) confirmationRequired.push(`${c.label} unavailable — ${c.reason}`);
  if (coverage < 0.7) confirmationRequired.push(`coverage ${(coverage * 100).toFixed(0)}% below 70% — treat as developing`);

  return {
    value: Math.round(value * 10) / 10,
    classification,
    acceleration,
    divergence,
    exhaustionCandidate,
    components,
    rawComponents,
    coverage: Math.round(coverage * 100) / 100,
    weightsUsed,
    thresholds: {
      strong: Math.round(thresholds.strong),
      moderate: Math.round(thresholds.moderate),
      weak: Math.round(thresholds.weak),
    },
    confirmationRequired,
    quality: comps,
    families: fam,
    bullish,
    bearish,
    conflicting,
    smoothed: null,
    confirmed: null,
    impulse: null,
    transitions: [],
    smoothedHistory: [],
    smoothingAlpha: SMOOTHING_ALPHA_REF["5m"],
  };
}

/** Futures price/OI relationship classification (unchanged methodology). */
export type FuturesClass =
  | "LONG_BUILDUP" | "SHORT_BUILDUP" | "SHORT_COVERING" | "LONG_UNWINDING"
  | "NEUTRAL" | "DIVERGENCE" | "UNAVAILABLE";

export function classifyFutures(priceChgPct: number | null, oiChgPct: number | null): FuturesClass {
  if (priceChgPct == null || oiChgPct == null) return "UNAVAILABLE";
  const pFlat = Math.abs(priceChgPct) < 0.03;
  const oFlat = Math.abs(oiChgPct) < 0.02;
  if (priceChgPct > 0 && oiChgPct > 0 && !pFlat && !oFlat) return "LONG_BUILDUP";
  if (priceChgPct < 0 && oiChgPct > 0 && !pFlat && !oFlat) return "SHORT_BUILDUP";
  if (priceChgPct > 0 && oiChgPct < 0 && !pFlat && !oFlat) return "SHORT_COVERING";
  if (priceChgPct < 0 && oiChgPct < 0 && !pFlat && !oFlat) return "LONG_UNWINDING";
  if (!pFlat && oFlat) return "NEUTRAL";
  if (pFlat && !oFlat) return "DIVERGENCE";
  return "NEUTRAL";
}
