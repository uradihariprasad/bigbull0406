"use client";

/**
 * PULSEGRID 2.0 — frontend data layer.
 * The UI only renders typed API/SSE responses; it never computes
 * authoritative trading intelligence.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type J = Record<string, any>;

export interface QuoteCell {
  ltp: number;
  chgPct: number;
  volume: number;
  freshness: string;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  vwap: number;
}
export type QuotesMap = Record<string, QuoteCell>;

// Quotes reference shared with useApi for stale-AUTH fast-retry
let _quotesRef: { current: Record<string, unknown> } = { current: {} };

export function useApi<T = J>(path: string | null, refreshMs = 0): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let sequence = 0;
    setLoading(true);

    /**
     * Requests are SERIAL, not setInterval-driven. A slow S/R request can no
     * longer overlap the next poll and then overwrite a newer response when it
     * finishes out of order (the main source of "levels jump back").
     */
    const load = async (initial = false) => {
      const seq = ++sequence;
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch(path, { cache: "no-store", signal: controller.signal });
        if (!res.ok) throw new Error(`${res.status}`);
        const j = (await res.json()) as T;
        if (alive && seq === sequence) {
          setData(j);
          setError(null);
          setLoading(false);
        }
        // If the backend returned AUTH but the SSE stream already has quotes,
        // it's a stale cached gate. Schedule an aggressive re-fetch to clear it.
        const jAny = j as Record<string, unknown>;
        if (jAny?.available === false && jAny?.code === "AUTH" && Object.keys(_quotesRef.current ?? {}).length > 0) {
          if (alive && refreshMs > 0) {
            // next attempt in 400ms instead of waiting the full poll interval
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void load(false), 400);
            return;
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError" && alive && seq === sequence) {
          setError((e as Error).message);
          setLoading(false);
        }
      } finally {
        if (alive && refreshMs > 0) timer = setTimeout(() => void load(false), refreshMs);
      }
      void initial;
    };
    void load(true);

    return () => {
      alive = false;
      sequence++;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [path, refreshMs, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, refresh };
}

/* ---------------------------------------------------------------- SSE --- */
export function usePulseStream() {
  const [quotes, setQuotes] = useState<QuotesMap>({});
  const [meta, setMeta] = useState<{ provider: string; marketPhase: string; ts: number }>({ provider: "…", marketPhase: "…", ts: 0 });
  const [connected, setConnected] = useState(false);
  const [lastAlert, setLastAlert] = useState<J | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const connect = () => {
      if (closed) return;
      const es = new EventSource("/api/stream");
      esRef.current = es;
      es.addEventListener("hello", () => setConnected(true));
      es.addEventListener("quotes", (ev) => {
        try {
          const p = JSON.parse((ev as MessageEvent).data);
          setQuotes(p.quotes ?? {});
          setMeta({ provider: p.provider, marketPhase: p.marketPhase, ts: p.ts });
        } catch {
          /* ignore malformed frame */
        }
      });
      es.addEventListener("alert", (ev) => {
        try {
          setLastAlert(JSON.parse((ev as MessageEvent).data));
        } catch {
          /* ignore */
        }
      });
      es.addEventListener("ping", () => setConnected(true));
      es.onerror = () => {
        setConnected(false);
        es.close();
        retry = setTimeout(connect, 4000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      esRef.current?.close();
    };
  }, []);

  return { quotes, meta, connected, lastAlert };
}

/* ------------------------------------------------------------ viewport -- */
/** Reactive breakpoint helper so charts/tables size correctly on phones. */
export function useBreakpoint(): { isMobile: boolean; isTablet: boolean; width: number } {
  const [w, setW] = useState(1440);
  useEffect(() => {
    const f = () => setW(window.innerWidth);
    f();
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return { isMobile: w < 640, isTablet: w >= 640 && w < 1024, width: w };
}

/* --------------------------------------------------------------- context - */
export interface AppState {
  /** true once live market data is actually flowing */
  dataLive: boolean;
  reloadTick: number;
  symbol: string;
  setSymbol: (s: string) => void;
  tf: string;
  setTf: (t: string) => void;
  expiry: string | null;
  setExpiry: (e: string | null) => void;
  workspaceSymbol: string | null;
  openWorkspace: (s: string) => void;
  closeWorkspace: () => void;
  quotes: QuotesMap;
  provider: string;
  marketPhase: string;
  streamConnected: boolean;
  lastAlert: J | null;
}

const AppCtx = createContext<AppState | null>(null);

export function PulseProvider({ children }: { children: ReactNode }) {
  const [symbol, setSymbol] = useState("NIFTY");
  const [tf, setTf] = useState("5m");
  const [expiry, setExpiry] = useState<string | null>(null);
  const [workspaceSymbol, setWorkspaceSymbol] = useState<string | null>(null);
  const { quotes, meta, connected, lastAlert } = usePulseStream();
  const [dataLive, setDataLive] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  /**
   * Track whether live data is flowing.
   *
   * NOTE: this deliberately does NOT reload the page. An earlier version
   * reloaded on the empty→data transition, but after each reload the flag
   * reset and the next data arrival reloaded again — an endless loop that
   * made the app look permanently empty. Modules refresh themselves through
   * `useApi(refreshMs)`, so a reload was never necessary.
   */
  useEffect(() => {
    _quotesRef.current = quotes;
    const hasData = Object.keys(quotes).length > 0;
    setDataLive((prev) => {
      if (prev !== hasData) setReloadTick((n) => n + 1);
      return hasData;
    });
  }, [quotes]);

  const value = useMemo<AppState>(
    () => ({
      dataLive,
      reloadTick,
      symbol,
      setSymbol,
      tf,
      setTf,
      expiry,
      setExpiry,
      workspaceSymbol,
      openWorkspace: setWorkspaceSymbol,
      closeWorkspace: () => setWorkspaceSymbol(null),
      quotes,
      provider: meta.provider,
      marketPhase: meta.marketPhase,
      streamConnected: connected,
      lastAlert,
    }),
    [dataLive, reloadTick, symbol, tf, expiry, workspaceSymbol, quotes, meta, connected, lastAlert],
  );
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp outside provider");
  return ctx;
}

/* -------------------------------------------------------------- url helper */
/**
 * Build an API URL with CORRECTLY ENCODED query params. Every value is passed
 * through encodeURIComponent so symbols containing "&" (M&M, GVT&D), spaces or
 * hyphens keep their exact identity instead of splitting the query string.
 */
export function apiUrl(path: string, params: Record<string, string | number | null | undefined> = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") continue;
    qs.set(k, String(v));
  }
  const q = qs.toString();
  return q ? `${path}?${q}` : path;
}

/* ------------------------------------------------------------- formatters */
export const fmt = (n: number | null | undefined, dp = 2): string =>
  n == null || Number.isNaN(n) ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: dp, minimumFractionDigits: dp });

export const fmtPct = (n: number | null | undefined): string =>
  n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;

export const fmtInt = (n: number | null | undefined): string => {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
};

export const fmtChg = (n: number | null | undefined): string => {
  if (n == null) return "N/A";
  return `${n > 0 ? "+" : n < 0 ? "-" : ""}${fmtInt(Math.abs(n))}`;
};

export function istTime(ts?: number): string {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
}

export function clsColor(v: number | null | undefined): string {
  if (v == null) return "text-grey";
  return v > 0 ? "text-green" : v < 0 ? "text-red" : "text-txt-dim";
}

export const freshnessColor: Record<string, string> = {
  LIVE: "text-green",
  DELAYED: "text-amber",
  HISTORICAL: "text-grey",
  STALE: "text-amber",
  UNAVAILABLE: "text-red",
};
