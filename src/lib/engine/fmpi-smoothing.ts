/**
 * PULSEGRID 2.0 — FMPI temporal state: smoothing, hysteresis, impulse.
 *
 * Separate module so the pure component scoring in fmpi.ts stays stateless.
 *
 * Design:
 *  - Independent state per (symbol|timeframe). 5m/10m/15m never share history.
 *  - Every observation carries its REAL timestamp; elapsed time drives decay,
 *    so uneven polling spacing cannot distort smoothing or acceleration.
 *  - Raw and smoothed histories are kept separately.
 *  - Hysteresis uses separate entry/exit thresholds plus a neutral band so a
 *    move from +31 → +29 cannot flip the classification.
 *  - Impulse detection works on the RAW series so a genuine reversal is never
 *    hidden by smoothing.
 *  - Session-aware: a new IST session resets state so yesterday's smoothing
 *    cannot contaminate today.
 */
import { clamp } from "./indicators";

export type FMPIClass =
  | "STRONG_BULLISH" | "BULLISH" | "WEAK_BULLISH" | "NEUTRAL"
  | "WEAK_BEARISH" | "BEARISH" | "STRONG_BEARISH";

/** Initial alphas — tuning candidates validated by replay, not guarantees. */
export const SMOOTHING_ALPHA: Record<"5m" | "10m" | "15m" | string, number> = {
  "5m": 0.3,
  "10m": 0.25,
  "15m": 0.2,
};

const HISTORY_MAX = 120;
/** ms of silence after which an observation is considered a gap, not a tick */
const OBS_GAP_MS = 90_000;
/** duplicate-sample suppression window */
const DUP_WINDOW_MS = 1_500;

export interface FMPIObservation {
  ts: number;
  raw: number;
  coverage: number;
  /** true when this observation came from a COMPLETED candle */
  completed: boolean;
}

export interface SmoothedPoint {
  ts: number;
  raw: number;
  smoothed: number;
  coverage: number;
}

export interface FMPITransition {
  ts: number;
  from: FMPIClass;
  to: FMPIClass;
  smoothed: number;
  reason: string;
}

export interface FMPIImpulse {
  ts: number;
  kind: "BULLISH_IMPULSE" | "BEARISH_IMPULSE";
  delta: number;
  from: number;
  to: number;
}

export interface FMPIState {
  key: string;
  tf: string;
  symbol: string;
  sessionDate: string;
  alpha: number;
  smoothed: number | null;
  /** last confirmed FMPI (completed candle) */
  confirmed: number | null;
  confirmedTs: number | null;
  lastTs: number | null;
  rawHistory: FMPIObservation[];
  smoothedHistory: SmoothedPoint[];
  transitions: FMPITransition[];
  impulses: FMPIImpulse[];
  classification: FMPIClass;
}

const g = globalThis as typeof globalThis & { __pulseFmpiState?: Map<string, FMPIState> };
const states: Map<string, FMPIState> = g.__pulseFmpiState ?? (g.__pulseFmpiState = new Map());

export function stateKey(symbol: string, tf: string): string {
  return `${symbol}|${tf}`;
}

/** IST session date for a timestamp — state resets at the session boundary. */
export function sessionOf(ts: number): string {
  return new Date(ts + (5 * 60 + 30) * 60 * 1000).toISOString().slice(0, 10);
}

export function resetFMPIState(symbol: string, tf: string): void {
  states.delete(stateKey(symbol, tf));
}

export function getState(symbol: string, tf: string, now = Date.now()): FMPIState {
  const key = stateKey(symbol, tf);
  let st = states.get(key);
  const session = sessionOf(now);
  if (!st) {
    st = {
      key, tf, symbol, sessionDate: session,
      alpha: SMOOTHING_ALPHA[tf] ?? 0.3,
      smoothed: null, confirmed: null, confirmedTs: null, lastTs: null,
      rawHistory: [], smoothedHistory: [], transitions: [], impulses: [],
      classification: "NEUTRAL",
    };
    states.set(key, st);
  } else if (st.sessionDate !== session) {
    // new session: clear temporal state so old smoothing cannot bleed forward
    st.sessionDate = session;
    st.smoothed = null;
    st.confirmed = null;
    st.confirmedTs = null;
    st.rawHistory = [];
    st.smoothedHistory = [];
    st.transitions = [];
    st.impulses = [];
    st.classification = "NEUTRAL";
  }
  return st;
}

/**
 * EMA smoothing over timestamped observations. Uses elapsed time so an
 * observation arriving after a long gap adapts instead of being treated as
 * an equally-spaced sample.
 */
function emaStep(prev: number | null, next: number, alpha: number, dtMs: number): number {
  if (prev == null) return next;
  // scale alpha by how much time actually elapsed relative to a nominal bar
  const nominal = 60_000; // 1 minute of information decay
  const k = clamp(alpha * clamp(dtMs / nominal, 0.25, 4), 0.02, 0.95);
  return prev + k * (next - prev);
}

/**
 * Push a raw FMPI observation and derive the full temporal view.
 * Returns null when the sample is a duplicate inside the suppression window.
 */
export function updateFMPISmoothingState(
  symbol: string,
  tf: string,
  obs: FMPIObservation,
  thresholds: { strong: number; moderate: number; weak: number },
  now = Date.now(),
): { state: FMPIState; smoothed: number; impulse: FMPIImpulse | null; transition: FMPITransition | null } | null {
  const st = getState(symbol, tf, now);
  // duplicate suppression: same value inside a very short window
  const lastRaw = st.rawHistory[st.rawHistory.length - 1];
  if (lastRaw && obs.ts - lastRaw.ts < DUP_WINDOW_MS && Math.abs(obs.raw - lastRaw.raw) < 0.05) return null;

  const dt = lastRaw ? Math.min(Math.max(obs.ts - lastRaw.ts, 250), OBS_GAP_MS) : 60_000;
  const gap = lastRaw ? obs.ts - lastRaw.ts > OBS_GAP_MS : false;
  st.smoothed = gap ? obs.raw : emaStep(st.smoothed, obs.raw, st.alpha, dt);

  st.rawHistory.push({ ts: obs.ts, raw: obs.raw, coverage: obs.coverage, completed: obs.completed });
  if (st.rawHistory.length > HISTORY_MAX) st.rawHistory.splice(0, st.rawHistory.length - HISTORY_MAX);
  st.smoothedHistory.push({ ts: obs.ts, raw: obs.raw, smoothed: st.smoothed, coverage: obs.coverage });
  if (st.smoothedHistory.length > HISTORY_MAX) st.smoothedHistory.splice(0, st.smoothedHistory.length - HISTORY_MAX);
  st.lastTs = obs.ts;

  // ---- impulse on the RAW series (immediate, un-smoothed) ----------------
  let impulse: FMPIImpulse | null = null;
  if (lastRaw) {
    const delta = obs.raw - lastRaw.raw;
    const scale = Math.max(thresholds.moderate * 0.6, 12);
    if (Math.abs(delta) >= scale) {
      impulse = {
        ts: obs.ts,
        kind: delta > 0 ? "BULLISH_IMPULSE" : "BEARISH_IMPULSE",
        delta: Math.round(delta * 10) / 10,
        from: lastRaw.raw,
        to: obs.raw,
      };
      st.impulses.push(impulse);
      if (st.impulses.length > 30) st.impulses.shift();
    }
  }

  // ---- hysteresis classification on the SMOOTHED value -------------------
  const s = st.smoothed;
  const cls = classifySmoothedFMPI(s, st.classification, thresholds);
  let transition: FMPITransition | null = null;
  if (cls !== st.classification) {
    transition = {
      ts: obs.ts,
      from: st.classification,
      to: cls,
      smoothed: Math.round(s * 10) / 10,
      reason: transitionReason(st.classification, cls, s, thresholds),
    };
    st.transitions.push(transition);
    if (st.transitions.length > 40) st.transitions.shift();
    st.classification = cls;
  }

  // ---- confirmed value: only COMPLETED-candle observations overwrite it ---
  if (obs.completed) {
    st.confirmed = obs.raw;
    st.confirmedTs = obs.ts;
  }

  return { state: st, smoothed: st.smoothed, impulse, transition };
}

function transitionReason(from: FMPIClass, to: FMPIClass, s: number, th: { strong: number; moderate: number; weak: number }): string {
  if (from === "NEUTRAL") return `smoothed FMPI moved out of the neutral band to ${s.toFixed(1)}`;
  if (to === "NEUTRAL") return `smoothed FMPI fell back inside the neutral band (${s.toFixed(1)})`;
  const dir = to.includes("BULLISH") ? "bullish" : "bearish";
  const strength = to.includes("STRONG") ? "strong " : "";
  return `smoothed FMPI crossed the ${strength}${dir} entry threshold (${s.toFixed(1)})`;
}

/**
 * Hysteresis classification: entry and exit thresholds differ, and a neutral
 * band prevents flip-flopping around zero. The previously-held class biases
 * the exit boundary so a 2-point wobble cannot change the label.
 */
export function classifySmoothedFMPI(
  s: number | null,
  previous: FMPIClass,
  th: { strong: number; moderate: number; weak: number },
): FMPIClass {
  if (s == null) return "NEUTRAL";
  const wasBull = previous.includes("BULLISH");
  const wasBear = previous.includes("BEARISH");
  // exit boundary is tighter than entry (hysteresis)
  const exitMod = th.moderate * 0.7;
  const exitWeak = th.weak * 0.6;

  if (s >= th.strong) return "STRONG_BULLISH";
  if (s <= -th.strong) return "STRONG_BEARISH";
  if (wasBull) {
    if (s >= exitMod) return "BULLISH";            // no demotion inside the exit band
    if (s >= exitWeak) return "WEAK_BULLISH";
    if (s <= -th.moderate) return "BEARISH";
    return "NEUTRAL";
  }
  if (wasBear) {
    if (s <= -exitMod) return "BEARISH";
    if (s <= -exitWeak) return "WEAK_BEARISH";
    if (s >= th.moderate) return "BULLISH";
    return "NEUTRAL";
  }
  // neutral → entry thresholds apply
  if (s >= th.moderate) return "BULLISH";
  if (s <= -th.moderate) return "BEARISH";
  if (s >= th.weak) return "WEAK_BULLISH";
  if (s <= -th.weak) return "WEAK_BEARISH";
  return "NEUTRAL";
}

/** Acceleration from fixed-time-aligned observations (not uneven polls). */
export function accelerationFrom(
  history: SmoothedPoint[],
  windowMs = 300_000,
): "ACCELERATING" | "DECELERATING" | "FLAT" | null {
  if (!history.length) return null;
  const last = history[history.length - 1];
  const cutoff = last.ts - windowMs;
  const window = history.filter((p) => p.ts >= cutoff);
  if (window.length < 2) return null;
  const first = window[0];
  const delta = last.smoothed - first.smoothed;
  // magnitude of change over the window decides; sign of the level is irrelevant
  if (Math.abs(delta) < 3) return "FLAT";
  // accelerating = the recent half moved further than the earlier half
  const mid = window[Math.floor(window.length / 2)];
  const earlyDelta = mid.smoothed - first.smoothed;
  const lateDelta = last.smoothed - mid.smoothed;
  if (Math.abs(lateDelta) > Math.abs(earlyDelta) * 1.15) return "ACCELERATING";
  if (Math.abs(lateDelta) < Math.abs(earlyDelta) * 0.6) return "DECELERATING";
  return "FLAT";
}

/** Bounded memory across the whole process. */
export function pruneFMPIStates(maxAgeMs = 6 * 3600_000): number {
  const cutoff = Date.now() - maxAgeMs;
  let n = 0;
  for (const [k, st] of states) {
    if (st.lastTs && st.lastTs < cutoff) {
      states.delete(k);
      n++;
    }
  }
  return n;
}

export function fmpiStateSize(): number {
  return states.size;
}

/** Test seam. */
export function __resetAllFMPIStates(): void {
  states.clear();
}
