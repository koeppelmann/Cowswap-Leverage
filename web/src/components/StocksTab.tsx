'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { STOCKS, CATEGORIES, assetKind, allSectors, findStock, marketCapB, marketCapRank, hasMarketCap, searchStocks, type Stock, type AssetKind } from '../lib/stocks';
import { fetchStockPrices, type StockPrice } from '../lib/stockPrice';
import { fetchMarketCaps, capOf } from '../lib/marketCap';
import { fetchReturns, metricValue, type PerfMetric } from '../lib/returns';
import { cachedTokenPrice, mapPool, type TokenQuote } from '../lib/stockQuote';
import { getWatchlist, toggleWatch } from '../lib/watchlist';
import { Sparkline } from './Sparkline';
import { StockDetail } from './StockDetail';

const fmt = (n: number, dp = 2) => n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const catColor: Record<AssetKind, string> = { equity: 'var(--rwa-eq)', etf: 'var(--rwa-etf)', gold: 'var(--rwa-gold)', treasury: 'var(--rwa-tsy)' };
const refKey = (a: Stock) => (a.refSymbol ?? a.ticker).toUpperCase();
const PERF_METRICS: { k: PerfMetric; label: string }[] = [
  { k: '1d', label: '24h' }, { k: '1m', label: '1M' }, { k: '3m', label: '3M' }, { k: '1y', label: '1Y' }, { k: '5y', label: '5Y' }, { k: 'risk', label: 'Sharpe 5Y' }, { k: 'vol', label: 'Volatility' },
];

type SortKey = 'asset' | 'ref' | 'chg' | 'versions' | 'mcap' | 'premium';
type Best = { q: TokenQuote; token: Stock['tokens'][number] } | null;
// Default direction when a column is first clicked (name/premium ascend, rest descend).
const defaultDir = (k: SortKey): 'asc' | 'desc' => (k === 'asset' || k === 'premium' ? 'asc' : 'desc');
const capStr = (b: number) => {
  if (b >= 1000) return `$${(b / 1000).toFixed(1)}T`;
  if (b >= 1) return `$${Math.round(b)}B`;
  if (b >= 0.001) return `$${Math.round(b * 1000)}M`; // sub-$1B → millions (was rounding to $0B)
  return b > 0 ? '<$1M' : '—';
};
// Live market cap: real shares outstanding (Yahoo, cached) × live price. Falls back
// to the hardcoded seed only until the real figure loads, so big names don't flash
// as "…"; gold/treasuries have no cap.
const fmtCap = (a: Stock, price: number | null): string => {
  const k = assetKind(a);
  if (k === 'gold' || k === 'treasury') return '—';
  const info = capOf(refKey(a));
  if (info) {
    // Equities track live (shares × price); ETFs use reported AUM (netAssets).
    const b = k === 'equity' && info.sharesB != null && price ? info.sharesB * price : info.capB;
    return b != null ? capStr(b) : '—';
  }
  const seed = marketCapB(a.ticker, k, price); // pre-load bootstrap
  return seed != null ? capStr(seed) : hasMarketCap(a.ticker, k) ? '…' : '…';
};
/** Cap in $B for sorting: real Yahoo cap if loaded, else the seed rank as bootstrap. */
const capRankOf = (a: Stock): number | null => capOf(refKey(a))?.capB ?? (marketCapRank(a.ticker, assetKind(a)) || null);

// Module-level stores so the overview's fetched reference prices and on-chain premiums
// survive unmount/remount (navigating to a stock page and back). The component seeds its
// state from these on mount → last-known values show instantly, then refresh in the
// background. (Market caps already persist via the module-level capOf cache.)
const priceStore = new Map<string, StockPrice>();
const bestStore = new Map<string, Best>();

export function StocksTab({ tabs, onOpenAsset }: { tabs?: ReactNode; onOpenAsset?: (ticker: string) => void }) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<AssetKind | 'all'>('all');
  const [sector, setSector] = useState('All');
  const [sortKey, setSortKey] = useState<SortKey>('mcap');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [onlyWatch, setOnlyWatch] = useState(false);
  const [watch, setWatch] = useState<string[]>([]);
  const [prices, setPrices] = useState<Record<string, StockPrice>>(() => Object.fromEntries(priceStore));
  const [best, setBest] = useState<Record<string, Best>>(() => Object.fromEntries(bestStore));
  const [selected, setSelected] = useState<string | null>(null);
  const [capVer, setCapVer] = useState(0); // bumped as real market caps load, to re-sort/render
  const [perfMetric, setPerfMetric] = useState<PerfMetric>('1d'); // overview performance column
  const [retVer, setRetVer] = useState(0); // bumped as multi-timeframe returns load
  // The catalog is 500+ tokens, so data (prices + on-chain quotes) is fetched only
  // for the rows currently rendered; "Load more" reveals + fetches the next page.
  const PAGE = 60;
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => { setWatch(getWatchlist()); }, []);
  // Reset the page when the filter/sort changes so we always fetch from the top.
  useEffect(() => { setLimit(PAGE); }, [query, cat, sector, sortKey, sortDir, onlyWatch]);

  // Latest reference prices, read by the quote fan-out without re-triggering it.
  const pricesRef = useRef(prices);
  useEffect(() => { pricesRef.current = prices; }, [prices]);

  const sectors = useMemo(() => ['All', ...allSectors()], []);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: STOCKS.length };
    for (const a of STOCKS) { const k = assetKind(a); c[k] = (c[k] ?? 0) + 1; }
    return c;
  }, []);

  // Base the market-status pill on a real equity/ETF (futures like gold report
  // phase 'open' unconditionally and would wrongly show "US market open").
  const marketOpen = useMemo(() => Object.values(prices).find((p) => p && p.phase !== 'open')?.marketOpen ?? false, [prices]);
  const goldSpot = prices['GC=F']?.price ?? null;

  // Filtered membership (independent of sort) — also the symbol set we fetch caps for.
  const filtered = useMemo(() => {
    let out: Stock[] = query.trim() ? searchStocks(query) : [...STOCKS];
    if (cat !== 'all') out = out.filter((a) => assetKind(a) === cat);
    if (sector !== 'All') out = out.filter((s) => s.sector === sector);
    if (onlyWatch) out = out.filter((s) => watch.includes(s.ticker));
    return out;
  }, [query, cat, sector, onlyWatch, watch]);

  const list = useMemo(() => {
    const out = [...filtered];
    // Sortable by any column. Numeric columns push unknown values (no price/quote
    // yet) to the bottom regardless of direction so loading rows don't jump around.
    const valOf = (s: Stock): number | string | null => {
      switch (sortKey) {
        case 'asset': return s.ticker;
        case 'ref': return prices[refKey(s)]?.price ?? null;
        case 'chg': return perfMetric === '1d' ? (prices[refKey(s)]?.changePct ?? null) : metricValue(refKey(s), perfMetric);
        case 'versions': return s.tokens.length;
        case 'mcap': return capRankOf(s); // real Yahoo cap, seed as bootstrap
        case 'premium': return best[s.ticker]?.q.premiumPct ?? null;
      }
    };
    out.sort((a, b) => {
      const va = valOf(a), vb = valOf(b);
      if (typeof va === 'string' || typeof vb === 'string') {
        const c = String(va).localeCompare(String(vb));
        return (sortDir === 'asc' ? c : -c) || a.ticker.localeCompare(b.ticker);
      }
      if (va == null && vb == null) return a.ticker.localeCompare(b.ticker);
      if (va == null) return 1; // unknown last
      if (vb == null) return -1;
      return (sortDir === 'asc' ? va - vb : vb - va) || a.ticker.localeCompare(b.ticker);
    });
    return out;
    // capVer/retVer: re-sort as real caps / returns arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortKey, sortDir, prices, best, capVer, perfMetric, retVer]);

  // Real market caps (shares + cap) for the whole filtered set, so the cap sort and
  // cap column reflect actual company size rather than a hardcoded list. Batched,
  // pooled and cached; bumps capVer so the view settles as data arrives.
  const capSymsKey = useMemo(() => [...new Set(filtered.filter((a) => assetKind(a) !== 'treasury').map(refKey))].sort().join(','), [filtered]);

  // Only the rendered page fetches data (the catalog is 500+ tokens).
  const visible = useMemo(() => list.slice(0, limit), [list, limit]);
  const visibleKey = useMemo(() => visible.map((a) => a.ticker).join(','), [visible]);

  // Multi-timeframe returns for the visible rows, only when a non-1D metric is picked.
  useEffect(() => {
    if (perfMetric === '1d') return;
    let live = true;
    const syms = [...new Set(visible.map(refKey))];
    if (syms.length) fetchReturns(syms, () => { if (live) setRetVer((v) => v + 1); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, perfMetric]);

  // Market caps: visible page first (instant correct top rows), then background the full
  // filtered set so cap-sorting the whole catalog works. fetchMarketCaps is cached, so
  // the second call only fetches what the first didn't.
  useEffect(() => {
    let live = true;
    const all = capSymsKey ? capSymsKey.split(',') : [];
    if (!all.length) return;
    const bump = () => { if (live) setCapVer((v) => v + 1); };
    const vis = [...new Set(visible.map(refKey))].filter((s) => all.includes(s));
    fetchMarketCaps(vis, bump).then(() => { if (live && all.length > vis.length) fetchMarketCaps(all, bump); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capSymsKey, visibleKey]);

  // Reference prices for the visible rows (+ gold spot for the header).
  useEffect(() => {
    let live = true;
    const syms = [...new Set([...visible.filter((a) => assetKind(a) !== 'treasury').map(refKey), 'GC=F'])];
    const load = async () => { const p = await fetchStockPrices(syms); for (const [k, v] of Object.entries(p)) priceStore.set(k, v); if (live) setPrices((prev) => ({ ...prev, ...p })); };
    load(); const iv = setInterval(load, 30000);
    return () => { live = false; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  // On-chain best price for the visible rows (bounded concurrency, reads prices via ref).
  useEffect(() => {
    let live = true;
    const run = () => mapPool(visible, 3, async (a) => {
      if (assetKind(a) === 'treasury') { bestStore.set(a.ticker, null); if (live) setBest((prev) => ({ ...prev, [a.ticker]: null })); return; }
      const ref = pricesRef.current[refKey(a)]?.price ?? null;
      const quotes = await Promise.all(a.tokens.map((t) => cachedTokenPrice(t, ref)));
      let b: Best = null;
      a.tokens.forEach((t, i) => { const q = quotes[i]; if (q.price != null && (!b || q.price < b.q.price!)) b = { q, token: t }; });
      bestStore.set(a.ticker, b); // persist across navigation
      if (live) setBest((prev) => ({ ...prev, [a.ticker]: b }));
    });
    // Refresh on a slow cadence — on-chain premiums move slowly and each tick re-quotes
    // every visible version, so a tight interval was the main source of CoW quote load.
    run(); const iv = setInterval(run, 300000);
    return () => { live = false; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  const doWatch = (t: string) => setWatch(toggleWatch(t));
  const clickHeader = (k: SortKey) => { if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setSortKey(k); setSortDir(defaultDir(k)); } };
  const th = (k: SortKey, label: string, cls = '') => (
    <th className={`${cls} sortable ${sortKey === k ? 'sorted' : ''}`} onClick={() => clickHeader(k)}>{label}{sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</th>
  );
  const sel = selected ? findStock(selected) : undefined;

  return (
    <div className="rwa">
      {tabs}
      <div className="rwa-board">
        {/* header */}
        <div className="rwa-hd">
          <div>
            <h2>Tokenized real-world assets</h2>
            <p>Every on-chain version of a stock, ETF, gold bar or T-bill — priced live through CoW, compared to the real reference, best-execution routed.</p>
          </div>
          <div className="rwa-mkt">
            <span className={`rwa-pill ${marketOpen ? 'live' : 'closed'}`}><span className="led" /> {marketOpen ? 'US market open' : 'US market closed'} · tokens 24/7</span>
            {goldSpot != null && <div className="rwa-stat"><div className="k">Gold spot</div><div className="v tnum">${fmt(goldSpot, 0)}/oz</div></div>}
          </div>
        </div>

        {/* categories */}
        <div className="rwa-seg">
          <button className={`rwa-cat ${cat === 'all' ? 'on' : ''}`} onClick={() => setCat('all')}><span className="sw" style={{ background: 'var(--muted)' }} /> All <span className="n">{counts.all}</span></button>
          {CATEGORIES.map((c) => counts[c.key] ? (
            <button key={c.key} className={`rwa-cat ${cat === c.key ? 'on' : ''}`} onClick={() => setCat(c.key)}><span className="sw" style={{ background: catColor[c.key] }} /> {c.label} <span className="n">{counts[c.key]}</span></button>
          ) : null)}
        </div>

        {/* toolbar */}
        <div className="rwa-tools">
          <div className="rwa-search">🔍 <input placeholder="Search ticker, company, ISIN or 0x token address — AAPL, Tesla, Gold, 0x4cbf…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <select value={sector} onChange={(e) => setSector(e.target.value)}>{sectors.map((s) => <option key={s} value={s}>{s === 'All' ? 'All sectors' : s}</option>)}</select>
          <button className={`rwa-chip ${onlyWatch ? 'on' : ''}`} onClick={() => setOnlyWatch((v) => !v)}>★ Watchlist{watch.length ? ` (${watch.length})` : ''}</button>
        </div>

        {/* split: table + detail */}
        <div className={`rwa-split ${sel ? 'has-detail' : ''}`}>
          <div className="rwa-left">
            <table className="rwa-tbl">
              <thead><tr>
                {th('asset', 'Asset', 'l')}{th('ref', 'Reference')}
                <th className={`sortable ${sortKey === 'chg' ? 'sorted' : ''}`} onClick={() => clickHeader('chg')}>
                  <select className="rwa-perf-sel" value={perfMetric} onClick={(e) => e.stopPropagation()} onChange={(e) => { const m = e.target.value as PerfMetric; setPerfMetric(m); setSortKey('chg'); setSortDir(m === 'vol' ? 'asc' : 'desc'); }}>
                    {PERF_METRICS.map((m) => <option key={m.k} value={m.k}>{m.label}</option>)}
                  </select>
                  {sortKey === 'chg' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
                <th className="l s7">7-day</th>{th('versions', 'Versions')}{th('mcap', cat === 'etf' ? 'AUM' : 'Market cap', 'bo')}{th('premium', 'Premium')}
              </tr></thead>
              <tbody>
                {visible.map((a) => {
                  const k = assetKind(a);
                  const p = prices[refKey(a)];
                  const up = (p?.changePct ?? 0) >= 0;
                  const b = best[a.ticker];
                  const watched = watch.includes(a.ticker);
                  const isTsy = k === 'treasury';
                  return (
                    <tr key={a.ticker} className={selected === a.ticker ? 'sel' : ''} onClick={() => onOpenAsset ? onOpenAsset(a.ticker) : setSelected(a.ticker)}>
                      <td className="l">
                        <div className="rwa-asset">
                          <span className="rwa-stripe" style={{ background: catColor[k] }} />
                          <button className={`rwa-star ${watched ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); doWatch(a.ticker); }}>{watched ? '★' : '☆'}</button>
                          <span className="rwa-logo" data-k={k}>{a.ticker.slice(0, 4)}</span>
                          <span className="rwa-nm"><b>{a.ticker}</b><i>{a.name}</i></span>
                        </div>
                      </td>
                      <td className="tnum">{p ? `$${fmt(p.price)}` : isTsy ? '—' : '·'}</td>
                      {perfMetric === '1d'
                        ? <td className={`tnum ${up ? 'up' : 'down'}`}>{p ? pct(p.changePct) : '·'}</td>
                        : (() => {
                            const v = metricValue(refKey(a), perfMetric);
                            if (v == null) return <td className="tnum flat">·</td>;
                            if (perfMetric === 'vol') return <td className="tnum" style={{ color: 'var(--muted)' }}>{v.toFixed(0)}%</td>;
                            if (perfMetric === 'risk') return <td className={`tnum ${v >= 0 ? 'up' : 'down'}`}>{v.toFixed(2)}</td>;
                            return <td className={`tnum ${v >= 0 ? 'up' : 'down'}`}>{pct(v)}</td>;
                          })()}
                      <td className="l s7">{p?.closes?.length ? <Sparkline data={p.closes} up={up} width={78} height={24} /> : null}</td>
                      <td><span className="rwa-vc">{a.tokens.length}</span></td>
                      <td className="tnum bo">{fmtCap(a, p?.price ?? null)}</td>
                      <td className={`tnum ${b?.q.premiumPct == null ? 'flat' : b.q.premiumPct > 0.05 ? 'prem-pos' : b.q.premiumPct < -0.05 ? 'prem-neg' : 'flat'}`}>
                        {b?.q.premiumPct != null ? pct(b.q.premiumPct) : '—'}
                      </td>
                    </tr>
                  );
                })}
                {!list.length && <tr><td colSpan={7} className="l" style={{ padding: 24, color: 'var(--muted)' }}>No assets match “{query}”.</td></tr>}
              </tbody>
            </table>
            {list.length > limit && (
              <div className="rwa-more">
                <button onClick={() => setLimit((n) => n + PAGE)}>Load more — showing {limit} of {list.length}</button>
              </div>
            )}
          </div>

          {sel && (
            <div className="rwa-right">
              <StockDetail key={sel.ticker} asset={sel} price={assetKind(sel) === 'treasury' ? null : prices[refKey(sel)] ?? null} onClose={() => setSelected(null)} />
            </div>
          )}
        </div>

        <p className="rwa-foot">Reference prices from public market data (delayed). On-chain prices are live CoW quotes vs USDC, normalized to the reference unit. Tokenized RWA are issued by third parties (Backed, Ondo, Paxos, Tether, CACHE…) — availability, transfer eligibility and redemption terms vary by issuer and jurisdiction.</p>
      </div>
    </div>
  );
}
