// Multi-timeframe performance (1M/3M/1Y/5Y), volatility and a risk-adjusted score
// for the overview's selectable metric. Batched + cached (6h server-side) so switching
// the metric doesn't hammer CoW/Yahoo.

export type RetInfo = { m1: number | null; m3: number | null; y1: number | null; y5: number | null; vol: number | null; risk: number | null };
export type PerfMetric = '1d' | '1m' | '3m' | '1y' | '5y' | 'risk' | 'vol';

const cache = new Map<string, RetInfo>();
const inflight = new Map<string, Promise<void>>();

async function loadBatch(symbols: string[]): Promise<void> {
  try {
    const r = await fetch(`/api/returns?symbols=${encodeURIComponent(symbols.join(','))}`);
    if (!r.ok) return; // don't cache a failure — let it retry
    const j = (await r.json()) as Record<string, RetInfo | null>;
    for (const s of symbols) { const e = j[s]; if (e) cache.set(s, e); }
  } catch { /* transient — leave uncached */ }
}

/** Fetch returns for these symbols (batched by 30, ≤3 batches at once, cached). */
export async function fetchReturns(symbols: string[], onProgress?: () => void): Promise<void> {
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const need = uniq.filter((s) => !cache.has(s) && !inflight.has(s));
  const chunks: string[][] = [];
  for (let i = 0; i < need.length; i += 30) chunks.push(need.slice(i, i + 30));
  const deferred = chunks.map((chunk) => { let resolve!: () => void; const p = new Promise<void>((r) => { resolve = r; }); for (const s of chunk) inflight.set(s, p); return { chunk, resolve }; });
  let next = 0;
  const workers = Array.from({ length: Math.min(3, deferred.length) }, async () => {
    while (next < deferred.length) { const { chunk, resolve } = deferred[next++]; await loadBatch(chunk); for (const s of chunk) inflight.delete(s); resolve(); onProgress?.(); }
  });
  await Promise.all(workers);
  await Promise.all(uniq.map((s) => inflight.get(s)).filter(Boolean) as Promise<void>[]);
}

export function returnsOf(symbol: string): RetInfo | undefined { return cache.get(symbol.toUpperCase()); }

/** The numeric value of a metric for a symbol (1d comes from the live price elsewhere). */
export function metricValue(symbol: string, m: Exclude<PerfMetric, '1d'>): number | null {
  const r = cache.get(symbol.toUpperCase());
  if (!r) return null;
  return m === '1m' ? r.m1 : m === '3m' ? r.m3 : m === '1y' ? r.y1 : m === '5y' ? r.y5 : m === 'vol' ? r.vol : r.risk;
}
