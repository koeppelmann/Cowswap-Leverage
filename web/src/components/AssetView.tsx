'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { assetKind, findStock, marketCapB, type AssetKind, type Stock, type StockToken } from '../lib/stocks';
import { fetchStockPrice, type StockPrice } from '../lib/stockPrice';
import { fetchMarketCaps, capOf, type CapInfo } from '../lib/marketCap';
import { AssetChart } from './AssetChart';
import { StockDetail } from './StockDetail';

const fmt = (n: number, dp = 2) => n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const fmtVol = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : `${n}`;
const capStr = (b: number) => b >= 1000 ? `$${(b / 1000).toFixed(1)}T` : b >= 1 ? `$${Math.round(b)}B` : b >= 0.001 ? `$${Math.round(b * 1000)}M` : b > 0 ? '<$1M' : '—';

const CopyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
);

/** Key reference stats — fills the space beside the ticket with verifiable numbers. */
function StatsStrip({ asset, kind, price, capInfo }: { asset: Stock; kind: AssetKind; price: StockPrice | null; capInfo: CapInfo | null }) {
  const live = price?.livePrice ?? price?.price ?? null;
  const cap = capInfo ? (kind === 'equity' && capInfo.sharesB != null && live ? capInfo.sharesB * live : capInfo.capB) : marketCapB(asset.ticker, kind, live);
  const stats: [string, string][] = [];
  if (cap != null) stats.push([kind === 'etf' ? 'AUM' : 'Market cap', capStr(cap)]);
  if (price?.dayLow != null && price?.dayHigh != null) stats.push(['Day range', `$${fmt(price.dayLow)} – $${fmt(price.dayHigh)}`]);
  if (price?.week52Low != null && price?.week52High != null) stats.push(['52-week range', `$${fmt(price.week52Low)} – $${fmt(price.week52High)}`]);
  if (price?.volume != null) stats.push(['Volume', fmtVol(price.volume)]);
  if (price?.prevClose != null) stats.push(['Prev close', `$${fmt(price.prevClose)}`]);
  if (!stats.length) return null;
  return (
    <div className="asset-stats">
      {stats.map(([k, v]) => <div key={k} className="stat"><div className="k">{k}</div><div className="v tnum">{v}</div></div>)}
    </div>
  );
}

type XMeta = { symbol: string; name: string; description: string | null; about: string | null; underlyingSymbol: string | null; isin: string | null; tradingHoursMode: string | null; isTradingHalted: boolean; openNow: boolean | null; logo: string | null };

const isHeading = (l: string) => l.length < 28 && !/[.:!?]$/.test(l);

/** Official Backed/xStocks metadata: the full product prose (scraped from Backed's
 *  product page) plus ISIN, 24/5 trading mode, and halt status. */
function XStocksInfo({ symbol }: { symbol: string }) {
  const [m, setM] = useState<XMeta | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true; setM(null); setOpen(false);
    fetch(`/api/xstock-meta?symbol=${encodeURIComponent(symbol)}`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d?.symbol) setM(d); }).catch(() => {});
    return () => { alive = false; };
  }, [symbol]);
  if (!m) return null;
  const hours = m.tradingHoursMode === 'TwentyFourFive' ? '24/5 on-chain' : m.tradingHoursMode;
  const lines = (m.about ?? m.description ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <div className="asset-xmeta">
      <h4>Backed xStocks <a href="https://xstocks.com" target="_blank" rel="noopener noreferrer">official ↗</a></h4>
      {lines.length > 0 && (
        <div className={`xmeta-about ${open ? 'open' : ''}`}>
          {lines.map((l, i) => isHeading(l) ? <h5 key={i} className="xmeta-h">{l}</h5> : <p key={i} className="xmeta-desc">{l}</p>)}
        </div>
      )}
      {lines.length > 2 && <button className="xmeta-more" onClick={() => setOpen((v) => !v)}>{open ? 'Show less' : 'Read more'}</button>}
      <div className="xmeta-facts">
        {m.isin && <span className="xmeta-fact"><b>ISIN</b> {m.isin}</span>}
        {m.underlyingSymbol && <span className="xmeta-fact"><b>Underlying</b> {m.underlyingSymbol}</span>}
        {hours && <span className="xmeta-fact">{hours}</span>}
        <span className={`xmeta-fact ${m.isTradingHalted ? 'halt' : 'ok'}`}>{m.isTradingHalted ? 'Trading halted' : 'Trading active'}</span>
      </div>
    </div>
  );
}

type Profile = { summary: string | null; sector: string | null; industry: string | null; website: string | null };

/** Company/fund blurb from Yahoo — the "About" for assets with no Backed/xStocks page
 *  (e.g. Ondo-only stocks like ANET). */
function CompanyProfile({ symbol }: { symbol: string }) {
  const [p, setP] = useState<Profile | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true; setP(null); setOpen(false);
    fetch(`/api/stock-profile?symbol=${encodeURIComponent(symbol)}`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d?.summary) setP(d); }).catch(() => {});
    return () => { alive = false; };
  }, [symbol]);
  if (!p?.summary) return null;
  const host = p.website ? p.website.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
  return (
    <div className="asset-xmeta">
      <h4>About {p.website ? <a href={p.website} target="_blank" rel="noopener noreferrer">{host} ↗</a> : <span>via Yahoo Finance</span>}</h4>
      <div className={`xmeta-about ${open ? 'open' : ''}`}>
        <p className="xmeta-desc">{p.summary}</p>
      </div>
      <button className="xmeta-more" onClick={() => setOpen((v) => !v)}>{open ? 'Show less' : 'Read more'}</button>
      <div className="xmeta-facts">
        {p.sector && <span className="xmeta-fact"><b>Sector</b> {p.sector}</span>}
        {p.industry && <span className="xmeta-fact"><b>Industry</b> {p.industry}</span>}
      </div>
    </div>
  );
}

/** Every on-chain version's contract address, copyable + linked to Etherscan. */
function Contracts({ tokens }: { tokens: StockToken[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (addr: string) => {
    try { await navigator.clipboard.writeText(addr); setCopied(addr); setTimeout(() => setCopied((c) => (c === addr ? null : c)), 1200); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="asset-contracts">
      <h4>On-chain contracts</h4>
      {tokens.map((t) => (
        <div key={t.address} className="contract">
          <span className="c-sym">{t.symbol}</span>
          <span className="c-iss">{t.issuer}</span>
          <span className="c-addr tnum">{t.address.slice(0, 9)}…{t.address.slice(-6)}</span>
          <button className="c-ic" onClick={() => copy(t.address)} title={copied === t.address ? 'Copied!' : 'Copy address'} aria-label="Copy address">{copied === t.address ? '✓' : <CopyIcon />}</button>
          <a className="c-ic" href={`https://etherscan.io/token/${t.address}`} target="_blank" rel="noopener noreferrer" title="View on Etherscan" aria-label="View on Etherscan">↗</a>
        </div>
      ))}
    </div>
  );
}

/** Full-screen single-asset page: big multi-timeframe chart + version comparison
 *  and trade panel. Used by the standalone RWA routes. */
export function AssetView({ ticker, backHref = '/' }: { ticker: string; backHref?: string }) {
  const asset = findStock(ticker);
  const kind = asset ? assetKind(asset) : 'equity';
  const isTsy = kind === 'treasury';
  const refSym = asset ? (asset.refSymbol ?? asset.ticker) : ticker;
  const [price, setPrice] = useState<StockPrice | null>(null);
  const [meta, setMeta] = useState<{ changePct: number; label: string; cagr: number | null } | null>(null);
  const [hoverV, setHoverV] = useState<number | null>(null);
  const [capInfo, setCapInfo] = useState<CapInfo | null>(null);

  useEffect(() => {
    if (!asset || isTsy) return;
    let live = true;
    const load = () => fetchStockPrice(refSym).then((p) => { if (live) setPrice(p); });
    load(); const iv = setInterval(load, 30000);
    return () => { live = false; clearInterval(iv); };
  }, [asset, refSym, isTsy]);

  useEffect(() => {
    if (!asset || isTsy) return;
    let live = true; setCapInfo(null);
    fetchMarketCaps([refSym]).then(() => { if (live) setCapInfo(capOf(refSym) ?? null); });
    return () => { live = false; };
  }, [asset, refSym, isTsy]);


  const issuers = useMemo(() => asset ? [...new Set(asset.tokens.map((t) => t.issuer))] : [], [asset]);

  if (!asset) return (
    <div className="asset-view"><Link className="rwa-back" href={backHref}>← All assets</Link><p className="hint" style={{ marginTop: 20 }}>Asset “{ticker}” not found.</p></div>
  );

  const live = price?.livePrice ?? null;
  const shown = hoverV ?? live; // chart hover overrides the headline price

  return (
    <div className="asset-view">
      <Link className="rwa-back" href={backHref}>← All assets</Link>

      <div className="asset-view-hd">
        <span className="rwa-logo lg" data-k={kind}>{asset.ticker.slice(0, 4)}</span>
        <div>
          <div className="asset-view-tk">{asset.ticker === 'GOLD' ? 'Gold · XAU' : asset.ticker} <span>{asset.name}</span></div>
          <div className="asset-issuers">
            <span className="iss-cat" data-k={kind}>{kind === 'gold' ? 'GOLD' : kind === 'etf' ? 'ETF' : kind === 'treasury' ? 'TREASURY' : 'STOCKS'}</span>
            {issuers.map((i) => <span key={i} className="iss-chip">{i}</span>)}
          </div>
        </div>
      </div>

      <div className="asset-view-grid">
        <div className="asset-view-left">
          <div className="asset-price-row">
            <div className="asset-price tnum">{shown != null ? `$${fmt(shown)}` : '—'}</div>
            {meta && <div className={`asset-change ${meta.changePct >= 0 ? 'up' : 'down'}`}>{pct(meta.changePct)} · {meta.label}{meta.cagr != null ? <span className="asset-cagr"> · {pct(meta.cagr)}/yr</span> : ''}</div>}
            {price?.extendedPrice != null && price.extendedLabel && (
              <div className="asset-ext">{price.extendedLabel} · regular close ${fmt(price.regularPrice)}</div>
            )}
          </div>
          <AssetChart symbol={refSym} refPrice={live} onHover={setHoverV} onMeta={setMeta} />
          {!isTsy && <StatsStrip asset={asset} kind={kind} price={price} capInfo={capInfo} />}
          {(() => {
            const xs = asset.tokens.find((t) => t.issuer === 'Backed xStocks');
            if (xs) return <XStocksInfo symbol={xs.symbol} />;
            if (kind === 'equity' || kind === 'etf') return <CompanyProfile symbol={refSym} />; // Ondo-only stocks → Yahoo blurb
            return null;
          })()}
          <Contracts tokens={asset.tokens} />
        </div>

        <div className="asset-view-right">
          <div className="asset-exchange-hd">Exchange</div>
          <StockDetail asset={asset} price={price} compact />
        </div>
      </div>
    </div>
  );
}
