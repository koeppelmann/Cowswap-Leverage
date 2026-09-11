import { NextResponse } from 'next/server';
import { CACHE } from '../../../lib/httpCache';

export const runtime = 'nodejs';

// Company/fund profile blurb from Yahoo's quoteSummary (assetProfile). Used for the
// "About" section of assets that have no Backed/xStocks product page — e.g. Ondo-only
// stocks. Yahoo gates this behind a cookie+crumb (cached, refreshed on auth failure).
// Descriptions are static, so cache hard.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const TTL = 24 * 3600_000;

type Profile = { summary: string | null; sector: string | null; industry: string | null; website: string | null };
const cache = new Map<string, { at: number; v: Profile | null }>();

let crumb = '', cookie = '', crumbLock: Promise<void> | null = null;
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

async function fetchProfile(symbol: string, retry = true): Promise<Profile | null> {
  await ensureCrumb();
  const y = symbol.replace(/\./g, '-');
  const r = await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(y)}?modules=assetProfile&crumb=${encodeURIComponent(crumb)}`, { headers: { 'User-Agent': UA, cookie }, cache: 'no-store' });
  if (r.status === 401 && retry) { await ensureCrumb(true); return fetchProfile(symbol, false); }
  if (!r.ok) throw new Error('http ' + r.status);
  const p = (await r.json())?.quoteSummary?.result?.[0]?.assetProfile;
  if (!p) return null;
  return { summary: p.longBusinessSummary ?? null, sector: p.sector ?? null, industry: p.industry ?? null, website: p.website ?? null };
}

export async function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get('symbol')?.toUpperCase().trim();
  if (!symbol || !/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return NextResponse.json({ error: 'bad symbol' }, { status: 400 });

  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL) return hit.v ? NextResponse.json(hit.v, { headers: CACHE.profile }) : NextResponse.json({ error: 'no profile' }, { status: 404 });

  try {
    const v = await fetchProfile(symbol);
    cache.set(symbol, { at: Date.now(), v });
    return v?.summary ? NextResponse.json(v, { headers: CACHE.profile }) : NextResponse.json({ error: 'no profile' }, { status: 404 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
