// Live market cap + shares outstanding for the reference symbols, from Yahoo via
// /api/market-cap. Cached + de-duped so the overview can rank the whole catalog by
// real company size (cap = shares × live price) instead of a hardcoded list.

export type CapInfo = { capB: number | null; sharesB: number | null };

const cache = new Map<string, CapInfo>();
const inflight = new Map<string, Promise<void>>();

async function loadBatch(symbols: string[]): Promise<void> {
  try {
    const r = await fetch(`/api/market-cap?symbols=${encodeURIComponent(symbols.join(','))}`);
    if (!r.ok) return; // don't cache a failure — let it retry
    const j = (await r.json()) as Record<string, { marketCap: number | null; shares: number | null; netAssets: number | null }>;
    for (const s of symbols) {
      const e = j[s];
      // ETFs report netAssets (AUM) and no marketCap; stocks the reverse. Prefer AUM
      // when present so a fund shows its AUM, not shares×price.
      const cap = e ? (e.netAssets ?? e.marketCap) : null;
      const sharesB = e?.shares != null ? e.shares / 1e9 : null;
      const capB = cap != null ? cap / 1e9 : null;
      // Only cache real data — a null (transient miss) must not stick, so it retries.
      if (capB != null || sharesB != null) cache.set(s, { capB, sharesB });
    }
  } catch { /* transient — leave uncached so it retries */ }
}

/** Fetch caps for these symbols (batched by 50, ≤4 batches at once, cached). Calls
 *  `onProgress` after each batch settles so the UI can update incrementally. Safe to
 *  call repeatedly — only new symbols hit the API. */
export async function fetchMarketCaps(symbols: string[], onProgress?: () => void): Promise<void> {
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const need = uniq.filter((s) => !cache.has(s) && !inflight.has(s));
  const chunks: string[][] = [];
  for (let i = 0; i < need.length; i += 50) chunks.push(need.slice(i, i + 50));

  // Reserve each chunk's symbols with a deferred promise so concurrent callers dedupe,
  // but only actually start ≤4 loadBatch requests at a time.
  const deferred = chunks.map((chunk) => {
    let resolve!: () => void;
    const p = new Promise<void>((r) => { resolve = r; });
    for (const s of chunk) inflight.set(s, p);
    return { chunk, resolve };
  });
  let next = 0;
  const workers = Array.from({ length: Math.min(4, deferred.length) }, async () => {
    while (next < deferred.length) {
      const { chunk, resolve } = deferred[next++];
      await loadBatch(chunk);
      for (const s of chunk) inflight.delete(s);
      resolve();
      onProgress?.();
    }
  });
  await Promise.all(workers);
  // Also await any batches already in flight from a prior call for these symbols.
  await Promise.all(uniq.map((s) => inflight.get(s)).filter(Boolean) as Promise<void>[]);
}

/** Cached cap info for a symbol (undefined until fetched). */
export function capOf(symbol: string): CapInfo | undefined {
  return cache.get(symbol.toUpperCase());
}
