import { NextResponse } from 'next/server';
import { CACHE } from '../../../lib/httpCache';

export const runtime = 'nodejs';

// Historical price series for the full-screen asset chart. Proxies Yahoo's public
// chart endpoint (no key) for a set of timeframes, server-side, with a per-range
// in-memory cache.

export type ChartRange = '1w' | '1m' | '3m' | '1y' | '5y' | 'max';

// Short ranges use intraday intervals so they're not coarser than 1W (a 1-month
// daily series is only ~22 points). Intraday data has no dividend-adjusted close,
// so the Total-return toggle only surfaces on 1Y/5Y — where dividends matter.
const RANGES: Record<ChartRange, { range: string; interval: string; ttl: number }> = {
  '1w': { range: '5d', interval: '15m', ttl: 60_000 },
  '1m': { range: '1mo', interval: '60m', ttl: 300_000 },
  '3m': { range: '3mo', interval: '60m', ttl: 300_000 },
  '1y': { range: '1y', interval: '1d', ttl: 600_000 },
  '5y': { range: '5y', interval: '1wk', ttl: 3_600_000 },
  // All-time: monthly bars keep decades of history light; distributions still bucket in.
  'max': { range: 'max', interval: '1mo', ttl: 6 * 3_600_000 },
};

type Series = {
  t: number[]; c: number[]; ac: number[] | null; changePct: number; adjChangePct: number | null; currency: string;
  // Additive total return (price + cumulative cash distributions) + the ex-date steps.
  tr: number[] | null; divIdx: number[]; divAmt: number[]; trChangePct: number | null;
};
const cache = new Map<string, { at: number; data: Series }>();

export async function GET(req: Request) {
  const u = new URL(req.url);
  const symbol = u.searchParams.get('symbol')?.toUpperCase().trim();
  const range = (u.searchParams.get('range') || '1m') as ChartRange;
  if (!symbol || !/^[A-Z0-9.\-=^]{1,12}$/.test(symbol)) return NextResponse.json({ error: 'bad symbol' }, { status: 400 });
  const cfg = RANGES[range];
  if (!cfg) return NextResponse.json({ error: 'bad range' }, { status: 400 });

  const key = `${symbol}:${range}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cfg.ttl) return NextResponse.json(hit.data, { headers: CACHE.chart });

  const yahooSymbol = symbol.replace(/\./g, '-'); // BRK.B → BRK-B
  try {
    // `range=max` returns a capped/degraded series (few bars, most recent dividends
    // dropped). Explicit period1/period2 from inception returns the complete history.
    const span = range === 'max' ? `period1=0&period2=${Math.floor(Date.now() / 1000)}` : `range=${cfg.range}`;
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${cfg.interval}&${span}&events=div,split`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store',
    });
    if (!r.ok) return NextResponse.json({ error: 'upstream ' + r.status }, { status: 502 });
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const ts: number[] = res?.timestamp ?? [];
    const closesRaw: (number | null)[] = res?.indicators?.quote?.[0]?.close ?? [];
    // Dividend/split-adjusted close (total return). Present for daily/weekly ranges.
    const adjRaw: (number | null)[] = res?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const hasAdj = adjRaw.length === closesRaw.length && adjRaw.some((x) => x != null);
    const t: number[] = []; const c: number[] = []; const ac: number[] = [];
    for (let i = 0; i < closesRaw.length; i++) {
      if (closesRaw[i] != null && ts[i] != null) {
        t.push(ts[i]); c.push(closesRaw[i] as number);
        if (hasAdj) ac.push((adjRaw[i] ?? closesRaw[i]) as number);
      }
    }
    if (c.length < 2) return NextResponse.json({ error: 'no data' }, { status: 404 });
    const changePct = ((c[c.length - 1] - c[0]) / c[0]) * 100;
    const adjChangePct = hasAdj && ac.length >= 2 ? ((ac[ac.length - 1] - ac[0]) / ac[0]) * 100 : null;

    // Distribution steps: total return shown as CASH per share (price + cumulative
    // distributions), so each payout is a visible step in the price↔TR gap on its
    // ex-date. Amounts come straight from Yahoo's dividend events (authoritative),
    // split-adjusted into the same space as the split-adjusted `close`, and matched to
    // samples by calendar day (so a weekly 5Y bar buckets the divs in its week).
    const divEvents = Object.values((res?.events?.dividends ?? {}) as Record<string, { amount: number; date: number }>);
    const splitEvents = Object.values((res?.events?.splits ?? {}) as Record<string, { date: number; numerator: number; denominator: number }>);
    const dayOf = (x: number) => Math.floor(x / 86400);
    const t0day = dayOf(t[0]);
    const stepAt = new Map<number, number>();
    for (const d of divEvents) {
      if (!(d.amount > 0) || dayOf(d.date) <= t0day) continue; // exclude events at/before the window start so tr[0] = c[0]
      let factor = 1;
      for (const s of splitEvents) if (s.date > d.date && s.numerator > 0 && s.denominator > 0) factor *= s.numerator / s.denominator;
      const dday = dayOf(d.date);
      const idx = t.findIndex((x) => dayOf(x) >= dday); // first sample on/after the ex-date
      if (idx >= 1) stepAt.set(idx, (stepAt.get(idx) ?? 0) + d.amount / factor);
    }
    // Mark only MATERIAL distributions as dots (≥0.05% of the ex-date price). A stock
    // like NVDA pays a token dividend that, split-adjusted to today's basis, rounds to
    // $0.00 and would otherwise litter the chart with dozens of "$0.00" dots. The
    // total-return line still sums every distribution — only the markers are filtered.
    const MARK_MIN = 0.0005;
    const divIdx: number[] = []; const divAmt: number[] = [];
    const tr: number[] = new Array(c.length); let running = 0; let anyDist = false;
    for (let i = 0; i < c.length; i++) {
      const step = stepAt.get(i);
      if (step) { anyDist = true; running += step; if (c[i] > 0 && step / c[i] >= MARK_MIN) { divIdx.push(i); divAmt.push(step); } }
      tr[i] = c[i] + running;
    }
    const hasDist = anyDist; // show the TR line whenever any distribution exists, even if no dot is material
    const trChangePct = hasDist ? ((tr[tr.length - 1] - tr[0]) / tr[0]) * 100 : null;

    const data: Series = { t, c, ac: hasAdj ? ac : null, changePct, adjChangePct, currency: res?.meta?.currency || 'USD', tr: hasDist ? tr : null, divIdx, divAmt, trChangePct };
    if (cache.size > 400) cache.delete(cache.keys().next().value as string); // bound memory vs arbitrary symbols
    cache.set(key, { at: Date.now(), data });
    return NextResponse.json(data, { headers: CACHE.chart });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
