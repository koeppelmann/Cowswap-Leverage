// Client access to the reference stock price (/api/stock-price → Yahoo). Small
// in-flight de-dupe + short cache so a list of stocks doesn't hammer the route.

export type MarketPhase = 'pre' | 'regular' | 'post' | 'closed' | 'open';

export type StockPrice = {
  symbol: string; name: string; currency: string;
  /** best current fair value = extended price if outside regular hours, else regular. */
  price: number; changePct: number;
  regularPrice: number; regularChangePct: number; prevClose: number;
  extendedPrice: number | null; extendedChangePct: number | null; extendedLabel: string | null;
  livePrice: number;
  phase: MarketPhase; marketOpen: boolean; resumeAt: number | null;
  closes: number[];
  dayLow?: number | null; dayHigh?: number | null;
  week52Low?: number | null; week52High?: number | null;
  volume?: number | null;
};

const cache = new Map<string, { at: number; data: StockPrice | null }>();
const inflight = new Map<string, Promise<StockPrice | null>>();
const TTL = 30_000;

export async function fetchStockPrice(symbol: string): Promise<StockPrice | null> {
  const key = symbol.toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      const r = await fetch(`/api/stock-price?symbol=${encodeURIComponent(key)}`);
      const data = r.ok ? (await r.json()) as StockPrice : null;
      // Only cache successful results; a transient upstream failure must not pin
      // the price to '—' for the whole TTL — let the next call retry immediately.
      if (data) cache.set(key, { at: Date.now(), data });
      return data;
    } catch { return null; }
    finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

/** Fetch many symbols in parallel (deduped/cached). */
export async function fetchStockPrices(symbols: string[]): Promise<Record<string, StockPrice>> {
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const results = await Promise.all(uniq.map(fetchStockPrice));
  const out: Record<string, StockPrice> = {};
  uniq.forEach((s, i) => { if (results[i]) out[s] = results[i]!; });
  return out;
}
