import { NextResponse } from 'next/server';
import { CACHE } from '../../../lib/httpCache';

export const runtime = 'nodejs';

// Real market cap + shares outstanding (and ETF net assets / AUM) from Yahoo's quote
// API, so the overview ranks by actual size instead of a hardcoded list. Yahoo gates
// this behind a cookie+crumb (cached, refreshed on auth failure) and — critically —
// drops symbols from the response when several requests hit it concurrently sharing a
// crumb. So we SERIALIZE the upstream calls and retry any symbols left missing, and we
// never cache a miss for long (a transient null must not stick for hours).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const TTL = 6 * 3600_000;        // real data — fundamentals move slowly
const NULL_TTL = 10 * 60_000;    // a miss — retry soon

type Entry = { marketCap: number | null; shares: number | null; netAssets: number | null };
const cache = new Map<string, { at: number; v: Entry }>();
const hasData = (v: Entry) => v.marketCap != null || v.netAssets != null || v.shares != null;

let crumb = '';
let cookie = '';
let crumbLock: Promise<void> | null = null;
async function ensureCrumb(force = false): Promise<void> {
  if (crumb && cookie && !force) return;
  if (crumbLock) return crumbLock;
  crumbLock = (async () => {
    const r = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
    const sc = (r.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? (r.headers.get('set-cookie') ? [r.headers.get('set-cookie') as string] : []);
    cookie = sc.map((c) => c.split(';')[0]).join('; ');
    crumb = (await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, cookie } }).then((x) => x.text())).trim();
  })().finally(() => { crumbLock = null; });
  return crumbLock;
}

// Serialize every upstream call — concurrent quote requests sharing a crumb make Yahoo
// return partial results, which is exactly what produced disappearing market caps.
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

async function yahooQuote(symbols: string[]): Promise<Record<string, Entry>> {
  await ensureCrumb();
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(',')}&crumb=${encodeURIComponent(crumb)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, cookie }, cache: 'no-store' });
  if (!r.ok) throw new Error('http ' + r.status);
  const j = await r.json();
  const res: Record<string, unknown>[] = j?.quoteResponse?.result ?? [];
  const out: Record<string, Entry> = {};
  for (const q of res) {
    const sym = String(q.symbol ?? '').toUpperCase();
    if (!sym) continue;
    out[sym] = {
      marketCap: typeof q.marketCap === 'number' ? q.marketCap : null,
      shares: typeof q.sharesOutstanding === 'number' ? q.sharesOutstanding : null,
      netAssets: typeof q.netAssets === 'number' ? q.netAssets : (typeof q.totalAssets === 'number' ? q.totalAssets : null),
    };
  }
  return out;
}

async function fetchQuotes(symbols: string[]): Promise<Record<string, Entry>> {
  return serialize(async () => {
    let out: Record<string, Entry> = {};
    try { out = await yahooQuote(symbols); }
    catch { await ensureCrumb(true); try { out = await yahooQuote(symbols); } catch { /* give up this pass */ } }
    // Retry whatever Yahoo left out (a partial response), once.
    const missing = symbols.filter((s) => !out[s]);
    if (missing.length && missing.length < symbols.length) {
      try { Object.assign(out, await yahooQuote(missing)); } catch { /* leave missing */ }
    }
    return out;
  });
}

export async function GET(req: Request) {
  const raw = (new URL(req.url).searchParams.get('symbols') || '').trim();
  if (!raw) return NextResponse.json({ error: 'no symbols' }, { status: 400 });
  const symbols = Array.from(new Set(raw.split(',').map((s) => s.toUpperCase().trim()).filter((s) => /^[A-Z0-9.\-=^]{1,12}$/.test(s)))).slice(0, 60);
  if (!symbols.length) return NextResponse.json({ error: 'bad symbols' }, { status: 400 });

  const now = Date.now();
  const out: Record<string, Entry> = {};
  const missing: string[] = [];
  for (const s of symbols) {
    const hit = cache.get(s);
    if (hit && now - hit.at < (hasData(hit.v) ? TTL : NULL_TTL)) out[s] = hit.v;
    else missing.push(s);
  }
  if (missing.length) {
    const fresh = await fetchQuotes(missing);
    for (const s of missing) {
      const v = fresh[s] ?? { marketCap: null, shares: null, netAssets: null };
      cache.set(s, { at: now, v }); // successes live 6h, misses 10min (see read above)
      out[s] = v;
    }
  }
  if (cache.size > 2000) { for (const k of Array.from(cache.keys()).slice(0, 500)) cache.delete(k); }
  return NextResponse.json(out, { headers: CACHE.caps });
}
