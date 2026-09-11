import { NextResponse } from 'next/server';
import { CACHE } from '../../../lib/httpCache';

export const runtime = 'nodejs';

// Reference price for tokenized-equity premium/discount. Proxies Yahoo's public
// chart endpoint (no key), server-side to dodge CORS + rate limits, with a short
// in-memory cache. Returns BOTH the regular-session price and the current
// extended-hours (pre/after-market) price — tokenized equities trade 24/7 and
// track the live fair value, so the extended price is the honest comparison.

export type MarketPhase = 'pre' | 'regular' | 'post' | 'closed' | 'open';

type Quote = {
  symbol: string; name: string; currency: string;
  regularPrice: number; regularChangePct: number; prevClose: number;
  extendedPrice: number | null; extendedChangePct: number | null; extendedLabel: string | null;
  /** best current fair value = extendedPrice ?? regularPrice (what a token should track). */
  livePrice: number; changePct: number;
  phase: MarketPhase; marketOpen: boolean;
  /** unix seconds of the next regular open, when not currently in regular hours. */
  resumeAt: number | null;
  closes: number[];
  // Reference stats from the chart meta (undefined for symbols that omit them).
  dayLow: number | null; dayHigh: number | null;
  week52Low: number | null; week52High: number | null;
  volume: number | null;
  // legacy alias (older callers): live price + its change.
  price: number;
};

const cache = new Map<string, { at: number; data: Quote }>();
const TTL = 30_000;
const H = 3600;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// New-York wall-clock parts of a UTC instant (DST-correct via Intl).
function etParts(utcSec: number) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
  const p: Record<string, string> = {};
  for (const { type, value } of f.formatToParts(new Date(utcSec * 1000))) p[type] = value;
  return p;
}
// UTC instant for a given ET wall-clock time, resolving the ET offset at that date.
function etWallToUtc(y: number, mo: number, da: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, da, h, mi) / 1000;
  const p = etParts(guess);
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000;
  return guess - (asIfUtc - guess); // subtract the ET→UTC offset
}

/** US-equity phase + next regular open (DST-correct, America/New_York). */
function equityPhase(nowSec: number): { phase: MarketPhase; resumeAt: number | null } {
  const p = etParts(nowSec);
  const dow = DOW.indexOf(p.weekday);
  const secs = +p.hour * H + +p.minute * 60 + +p.second;
  const weekend = dow === 0 || dow === 6;
  let phase: MarketPhase = 'closed';
  if (!weekend) {
    if (secs >= 4 * H && secs < 9.5 * H) phase = 'pre';
    else if (secs >= 9.5 * H && secs < 16 * H) phase = 'regular';
    else if (secs >= 16 * H && secs < 20 * H) phase = 'post';
  }
  let resumeAt: number | null = null;
  if (phase !== 'regular') {
    for (let k = 0; k <= 8; k++) {
      const dp = etParts(nowSec + k * 86400);
      if (dp.weekday === 'Sun' || dp.weekday === 'Sat') continue;
      const openUtc = etWallToUtc(+dp.year, +dp.month, +dp.day, 9, 30);
      if (openUtc > nowSec) { resumeAt = openUtc; break; }
    }
  }
  return { phase, resumeAt };
}

export async function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get('symbol')?.toUpperCase().trim();
  // Allow '=' and '^' for futures/index symbols (e.g. gold spot 'GC=F').
  if (!symbol || !/^[A-Z0-9.\-=^]{1,12}$/.test(symbol)) return NextResponse.json({ error: 'bad symbol' }, { status: 400 });

  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL) return NextResponse.json(hit.data, { headers: CACHE.price });

  const yahooSymbol = symbol.replace(/\./g, '-'); // BRK.B → BRK-B
  const isFutures = symbol.includes('=') || symbol.startsWith('^');

  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=5m&range=1d&includePrePost=true`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store',
    });
    if (!r.ok) return NextResponse.json({ error: 'upstream ' + r.status }, { status: 502 });
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const m = res?.meta;
    if (!m?.regularMarketPrice) return NextResponse.json({ error: 'no price' }, { status: 404 });

    const regularPrice = m.regularMarketPrice as number;
    const prevClose = (m.chartPreviousClose ?? m.previousClose ?? regularPrice) as number;
    const ts: number[] = res.timestamp ?? [];
    const closesAll: (number | null)[] = res.indicators?.quote?.[0]?.close ?? [];
    const closes: number[] = closesAll.filter((c: number | null): c is number => c != null);
    // Latest traded price + its timestamp (the last non-null close).
    let latestPrice = regularPrice, latestTs = 0;
    for (let i = closesAll.length - 1; i >= 0; i--) { if (closesAll[i] != null) { latestPrice = closesAll[i] as number; latestTs = ts[i] ?? 0; break; } }

    const nowSec = Math.floor(Date.now() / 1000);
    const { phase, resumeAt } = isFutures ? { phase: 'open' as MarketPhase, resumeAt: null } : equityPhase(nowSec);

    // Extended-hours price: the latest traded print when we're outside regular
    // hours, it meaningfully differs from the regular close, AND it is recent (a
    // pre/after-market print) — not a stale Friday close shown live over a weekend.
    const fresh = latestTs > 0 && nowSec - latestTs < 12 * H;
    let extendedPrice: number | null = null;
    let extendedLabel: string | null = null;
    if (!isFutures && phase !== 'regular' && fresh && Math.abs(latestPrice - regularPrice) / regularPrice > 0.0005) {
      extendedPrice = latestPrice;
      extendedLabel = phase === 'pre' ? 'Pre-market' : 'After-hours';
    }

    const livePrice = extendedPrice ?? regularPrice;
    const data: Quote = {
      symbol, name: m.longName || m.shortName || symbol, currency: m.currency || 'USD',
      regularPrice, regularChangePct: prevClose ? ((regularPrice - prevClose) / prevClose) * 100 : 0, prevClose,
      extendedPrice, extendedChangePct: extendedPrice ? ((extendedPrice - regularPrice) / regularPrice) * 100 : null, extendedLabel,
      livePrice, changePct: prevClose ? ((livePrice - prevClose) / prevClose) * 100 : 0,
      phase, marketOpen: phase === 'regular' || phase === 'open', resumeAt,
      closes: closes.slice(-96),
      dayLow: (m.regularMarketDayLow ?? null) as number | null, dayHigh: (m.regularMarketDayHigh ?? null) as number | null,
      week52Low: (m.fiftyTwoWeekLow ?? null) as number | null, week52High: (m.fiftyTwoWeekHigh ?? null) as number | null,
      volume: (m.regularMarketVolume ?? null) as number | null,
      price: livePrice,
    };
    if (cache.size > 300) cache.delete(cache.keys().next().value as string); // bound memory vs arbitrary symbols
    cache.set(symbol, { at: Date.now(), data });
    return NextResponse.json(data, { headers: CACHE.price });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
