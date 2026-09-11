import { NextResponse } from 'next/server';
import { CACHE } from '../../../lib/httpCache';

export const runtime = 'nodejs';

// Official Backed/xStocks metadata for a token symbol (e.g. NVDAx), from the public
// xStocks API. The `description` field is just the product name ("NVIDIA xStock"),
// but the same record carries the official underlying ISIN, 24/5 trading-hours mode,
// trading-halt flag, and logo — none of which we have elsewhere. Cached server-side.

type Meta = {
  symbol: string; name: string; description: string | null;
  /** Full product prose (investment objective + benefits + company blurb), scraped
   *  from the Backed product page — the JSON API's `description` is just the name. */
  about: string | null;
  underlyingSymbol: string | null; isin: string | null;
  tradingHoursMode: string | null; isTradingHalted: boolean; openNow: boolean | null;
  logo: string | null;
};

const cache = new Map<string, { at: number; data: Meta | null }>();
const TTL = 6 * 3600_000; // 6h — product metadata/prose is effectively static

// The rich description lives only on the Backed product page (Webflow CMS), keyed by
// a name-derived slug ("Alphabet xStock" → "alphabet-xstock"). Scrape the rich-text
// block and flatten it to paragraphs. Best-effort — returns null if the page/shape
// changes, so the JSON metadata still resolves.
function slugFromName(name: string): string {
  return name.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, '-');
}
async function fetchAbout(name: string): Promise<string | null> {
  try {
    const r = await fetch(`https://assets.backed.fi/products/${slugFromName(name)}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/class="product-description w-richtext"[^>]*>([\s\S]*?)<\/div>/);
    if (!m) return null;
    const txt = m[1]
      .replace(/<\/(p|h2|h3|h4|li)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/‍/g, '')
      .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    return txt.length > 20 ? txt.slice(0, 4000) : null;
  } catch { return null; }
}

export async function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get('symbol')?.trim();
  if (!symbol || !/^[A-Za-z0-9.]{1,12}$/.test(symbol)) return NextResponse.json({ error: 'bad symbol' }, { status: 400 });

  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL) return hit.data ? NextResponse.json(hit.data, { headers: CACHE.meta }) : NextResponse.json({ error: 'not found' }, { status: 404 });

  try {
    const r = await fetch(`https://api.xstocks.fi/api/v2/public/assets/${encodeURIComponent(symbol)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', accept: 'application/json' }, cache: 'no-store',
    });
    if (!r.ok) { cache.set(symbol, { at: Date.now(), data: null }); return NextResponse.json({ error: 'upstream ' + r.status }, { status: r.status === 404 ? 404 : 502 }); }
    const j = await r.json();
    const o = j?.data ?? j;
    if (!o?.symbol) { cache.set(symbol, { at: Date.now(), data: null }); return NextResponse.json({ error: 'not found' }, { status: 404 }); }
    const t = o.trading ?? {};
    const name = o.name ?? o.symbol;
    const about = await fetchAbout(name);
    const data: Meta = {
      symbol: o.symbol, name, description: o.description ?? null, about,
      underlyingSymbol: o.underlyingSymbol ?? o.underlying?.symbol ?? null,
      isin: o.underlyingIsin ?? o.underlying?.isin ?? o.isin ?? null,
      tradingHoursMode: t.tradingHoursMode ?? null,
      isTradingHalted: !!(o.isTradingHalted ?? t.isTradingHalted),
      openNow: typeof t.openNow === 'boolean' ? t.openNow : null,
      logo: o.logo ?? null,
    };
    if (cache.size > 400) cache.delete(cache.keys().next().value as string);
    cache.set(symbol, { at: Date.now(), data });
    return NextResponse.json(data, { headers: CACHE.meta });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
