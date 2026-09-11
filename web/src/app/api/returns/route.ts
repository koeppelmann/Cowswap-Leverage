import { NextResponse } from 'next/server';
import { CACHE } from '../../../lib/httpCache';

export const runtime = 'nodejs';

// Multi-timeframe performance for the overview's selectable metric. One weekly 5y
// history per symbol (server-side; the response is just the computed numbers), from
// which we derive point-to-point price returns (1M/3M/1Y/5Y), annualized volatility,
// and a risk-adjusted score (1Y return ÷ annualized vol — Sharpe-like). Cached hard:
// these move slowly, and 60 visible symbols would otherwise be 60 chart fetches.

type Ret = { m1: number | null; m3: number | null; y1: number | null; y5: number | null; vol: number | null; risk: number | null };
const cache = new Map<string, { at: number; v: Ret | null }>();
const TTL = 6 * 3600_000;

const RF = 4.5;          // risk-free rate (%), for the Sharpe numerator
const MIN_VOL_WK = 52;   // ≥1y of weekly returns before a volatility number
const MIN_SHARPE_WK = 104; // ≥2y before a Sharpe (estimates are noisy below this)

async function fetchOne(symbol: string): Promise<Ret | null> {
  const y = symbol.replace(/\./g, '-');
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(y)}?interval=1wk&range=5y`, { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' });
  if (!r.ok) throw new Error('http ' + r.status);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  const ts: number[] = res?.timestamp ?? [];
  const rawC: (number | null)[] = res?.indicators?.quote?.[0]?.close ?? [];
  const rawAc: (number | null)[] = res?.indicators?.adjclose?.[0]?.adjclose ?? [];
  // Aligned close (for price point-to-point returns) + adjusted close (dividend+split,
  // for the risk-adjusted total-return metric). Only keep bars with a valid close.
  const t: number[] = []; const c: number[] = []; const ac: number[] = [];
  for (let i = 0; i < rawC.length; i++) if (rawC[i] != null && ts[i] != null) { t.push(ts[i]); c.push(rawC[i] as number); ac.push((rawAc[i] ?? rawC[i]) as number); }
  if (c.length < 3) return null;
  const last = c[c.length - 1], lastT = t[t.length - 1];
  // Price return over ~D days: the sample closest to (now - D), searching back from end.
  const retDaysAgo = (days: number): number | null => {
    const target = lastT - days * 86400;
    let best = -1, bestGap = Infinity;
    for (let i = c.length - 1; i >= 0; i--) { const g = Math.abs(t[i] - target); if (g < bestGap) { bestGap = g; best = i; } if (t[i] < target - 14 * 86400) break; }
    if (best < 0 || best === c.length - 1 || !(c[best] > 0)) return null;
    if (bestGap > days * 86400 * 0.5 + 10 * 86400) return null;
    return (last / c[best] - 1) * 100;
  };
  const m1 = retDaysAgo(30), m3 = retDaysAgo(91), y1 = retDaysAgo(365);
  const y5 = c[0] > 0 ? (last / c[0] - 1) * 100 : null;

  // Risk metrics from weekly LOG total-returns over the full window. Log returns give a
  // geometric (variance-drag-free) numerator — arithmetic mean would flatter high-vol
  // names. Compute across consecutive valid adjusted closes; a gap week is skipped, not
  // interpolated (an interpolated jumbo return would blow up σ).
  const lr: number[] = [];
  for (let i = 1; i < ac.length; i++) { const a = ac[i - 1], b = ac[i]; if (a > 0 && b > 0) lr.push(Math.log(b / a)); }
  let vol: number | null = null, risk: number | null = null;
  if (lr.length >= MIN_VOL_WK) {
    const mean = lr.reduce((s, x) => s + x, 0) / lr.length;
    const varr = lr.reduce((s, x) => s + (x - mean) ** 2, 0) / (lr.length - 1);
    const sd = Math.sqrt(varr);
    vol = sd * Math.sqrt(52) * 100; // annualized volatility (%)
    if (lr.length >= MIN_SHARPE_WK && vol > 0.5) {
      const cagr = (Math.exp(mean * 52) - 1) * 100; // geometric annualized total return (%)
      risk = (cagr - RF) / vol;                     // Sharpe ratio
    }
  }
  return { m1, m3, y1, y5, vol, risk };
}

export async function GET(req: Request) {
  const raw = (new URL(req.url).searchParams.get('symbols') || '').trim();
  if (!raw) return NextResponse.json({ error: 'no symbols' }, { status: 400 });
  const symbols = Array.from(new Set(raw.split(',').map((s) => s.toUpperCase().trim()).filter((s) => /^[A-Z0-9.\-=^]{1,12}$/.test(s)))).slice(0, 40);
  if (!symbols.length) return NextResponse.json({ error: 'bad symbols' }, { status: 400 });

  const now = Date.now();
  const out: Record<string, Ret | null> = {};
  const missing: string[] = [];
  for (const s of symbols) { const hit = cache.get(s); if (hit && now - hit.at < TTL) out[s] = hit.v; else missing.push(s); }

  // Pool the per-symbol Yahoo fetches (≤4 at a time) to stay under rate limits.
  let next = 0;
  const workers = Array.from({ length: Math.min(4, missing.length) }, async () => {
    while (next < missing.length) {
      const s = missing[next++];
      try { const v = await fetchOne(s); cache.set(s, { at: now, v }); out[s] = v; }
      catch { out[s] = null; } // transient — don't cache the failure
    }
  });
  await Promise.all(workers);
  if (cache.size > 2000) { for (const k of Array.from(cache.keys()).slice(0, 500)) cache.delete(k); }
  return NextResponse.json(out, { headers: CACHE.returns });
}
