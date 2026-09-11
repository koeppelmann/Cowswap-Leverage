'use client';

import { useEffect, useRef, useState } from 'react';
import { formatUnits, parseUnits, type Address } from 'viem';
import { useAccount, useChainId, usePublicClient, useReadContract, useSwitchChain, useWalletClient } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { erc20Abi } from '../lib/abi';
import { fetchQuote } from '../lib/quote';
import { cowSwap } from '../lib/cowSwap';
import { COUNTER_ASSETS, counterUsdPrice, cachedTokenPrice, ondoMultiplier, NOTIONAL_USD, type CounterAsset, type QuoteSide, type TokenQuote } from '../lib/stockQuote';
import { cowBuyUrl, cowSellUrl } from '../lib/cowLinks';
import { assetKind, type Stock, type StockToken } from '../lib/stocks';
import type { StockPrice } from '../lib/stockPrice';
import { Sparkline } from './Sparkline';

const fmt = (n: number, dp = 2) => n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

function fmtResume(resumeAt: number | null): string {
  if (!resumeAt) return '';
  let d = resumeAt - Date.now() / 1000;
  if (d < 0) return '';
  const days = Math.floor(d / 86400); d -= days * 86400;
  const h = Math.floor(d / 3600); const m = Math.floor((d % 3600) / 60);
  const rel = days > 0 ? `${days}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  const t = new Date(resumeAt * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return `regular opens ${t} · in ${rel}`;
}

type Enriched = { token: StockToken; q: TokenQuote };

export function StockDetail({ asset, price, onClose, compact }: { asset: Stock; price: StockPrice | null; onClose?: () => void; compact?: boolean }) {
  const kind = assetKind(asset);
  const isTsy = kind === 'treasury';
  const unitSuffix = asset.unit ? `/${asset.unit}` : '';
  const live = price?.livePrice ?? price?.price ?? null; // fair value now (extended-aware)
  const regular = price?.regularPrice ?? null;
  const extLabel = price?.extendedPrice != null ? price.extendedLabel : null;
  const liveWord = extLabel ? extLabel.toLowerCase() : asset.unit ? 'spot' : 'market';

  // Read `live` via a ref so the 30s reference-price tick doesn't tear down and
  // recreate the quote interval; the effect only (re)runs on asset change or when
  // the reference first becomes available.
  // Buy/Sell drives the whole panel: version prices are quoted on the side (and at
  // the notional) you'd actually trade, so the headline is achievable — the ask
  // when buying, the bid when selling.
  const [side, setSide] = useState<QuoteSide>('buy');
  const liveRef = useRef(live);
  useEffect(() => { liveRef.current = live; }, [live]);
  const hasLive = live != null;
  const [rows, setRows] = useState<Enriched[]>(asset.tokens.map((token) => ({ token, q: { price: null, premiumPct: null } })));
  useEffect(() => {
    if (isTsy) return;
    let alive = true;
    const load = async () => {
      const qs = await Promise.all(asset.tokens.map((t) => cachedTokenPrice(t, liveRef.current, side)));
      if (alive) setRows(asset.tokens.map((token, i) => ({ token, q: qs[i] })));
    };
    load(); const iv = setInterval(load, 120000);
    return () => { alive = false; clearInterval(iv); };
  }, [asset, isTsy, hasLive, side]);

  const priced = rows.filter((r) => r.q.price != null);
  // Best execution is side-aware: cheapest ask when buying, highest bid when selling.
  const best = priced.length ? priced.reduce((a, b) => (side === 'buy' ? (b.q.price! < a.q.price! ? b : a) : (b.q.price! > a.q.price! ? b : a))) : null;

  const [sel, setSel] = useState<StockToken | null>(asset.tokens[0] ?? null);
  const userPicked = useRef(false);
  useEffect(() => { if (!userPicked.current && best) setSel(best.token); }, [best?.token.address]);
  const pickToken = (t: StockToken) => { userPicked.current = true; setSel(t); };

  const marketOpen = price?.marketOpen ?? false;
  const statusTone = marketOpen ? 'live' : extLabel ? 'ext' : 'closed';
  const statusText = marketOpen
    ? (kind === 'gold' ? 'Trading · 24h' : 'US market open')
    : `${extLabel ?? 'US market closed'}${price?.resumeAt ? ` · ${fmtResume(price.resumeAt)}` : ''}`;

  return (
    <div className="rwa-detail">
      {!compact && (
        <>
          <div className="rwa-d-top">
            <span className="rwa-badge-k" data-k={kind}>{kind === 'gold' ? 'Gold' : kind === 'etf' ? 'ETF' : kind === 'treasury' ? 'Treasury' : 'Equity'}</span>
            {onClose && <button className="rwa-close" onClick={onClose} aria-label="Close">✕</button>}
          </div>
          <div className="rwa-d-hd">
            <span className="rwa-logo lg" data-k={kind}>{asset.ticker.slice(0, 4)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="rwa-d-tk">{asset.ticker === 'GOLD' ? 'Gold · XAU' : asset.ticker}</div>
              <div className="rwa-d-nm">{asset.name}</div>
            </div>
          </div>
        </>
      )}

      {!isTsy && (
        <>
          {!compact && (
            <div className="rwa-d-price tnum">
              {live != null ? `$${fmt(live)}` : '—'}
              <span className="u">{asset.unit ? `spot${unitSuffix}` : extLabel ?? 'live'}{price ? ` · ${pct(price.changePct)}` : ''}</span>
            </div>
          )}
          {/* regular vs extended breakdown */}
          {price && extLabel && regular != null && (
            <div className="rwa-d-sub">
              <span><i>{extLabel}</i> ${fmt(price.extendedPrice!)} <b className={price.extendedChangePct! >= 0 ? 'g' : 'r'}>{pct(price.extendedChangePct!)}</b> <em>since close</em></span>
              <span><i>Regular close</i> ${fmt(regular)} <b className={price.regularChangePct >= 0 ? 'g' : 'r'}>{pct(price.regularChangePct)}</b> <em>on the day</em></span>
            </div>
          )}
          <div className={`rwa-status ${statusTone}`}><span className="led" /> {statusText}</div>
          {!compact && price?.closes?.length ? <div className="rwa-d-spark"><Sparkline data={price.closes} up={(price.changePct ?? 0) >= 0} width={360} height={44} /></div> : null}
        </>
      )}

      <div className="rwa-vhead">
        <span>{asset.tokens.length} on-chain version{asset.tokens.length === 1 ? '' : 's'}</span>
        {!isTsy && <span>{side === 'buy' ? 'to buy' : 'to sell'}{asset.unit ? ` / ${asset.unit}` : ''} · premium</span>}
      </div>

      {isTsy ? (
        <div className="rwa-tsy-note">
          {asset.tokens.map((t) => (
            <div key={t.address} className="rwa-ver static">
              <div className="li"><span className="rwa-logo sm" data-k={kind}>{t.symbol.slice(0, 3)}</span><div><div className="sym">{t.symbol}</div><div className="iss">{t.issuer}</div></div></div>
              <span className="rwa-noliq">primary issuance</span>
            </div>
          ))}
          <p className="hint" style={{ marginTop: 8 }}>Yield-bearing RWA settled via the issuer (mint / redeem). Secondary on-chain liquidity is thin or permissioned — not routed here yet.</p>
        </div>
      ) : (
        <>
          {rows.map(({ token, q }) => {
            return (
              <button key={token.address} className={`rwa-ver sm ${sel?.address === token.address ? 'on' : ''}`} onClick={() => pickToken(token)}>
                <div className="li">
                  <span className="rwa-logo sm" data-k={kind}>{token.symbol.slice(0, 3)}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="sym">{token.symbol}{best?.token.address === token.address && priced.length > 1 && <span className="rwa-best">best price</span>}</div>
                    <div className="iss">{token.issuer}{token.tags?.[0] ? ` · ${token.tags[0]}` : ''}</div>
                  </div>
                </div>
                <div className="rt">
                  {q.price != null ? <>
                    <div className="vp tnum">${fmt(q.price)}</div>
                    {q.premiumPct != null && <div className={`vprem tnum ${(side === 'buy' ? q.premiumPct < 0 : q.premiumPct > 0) ? 'down' : 'up'}`}>{q.premiumPct > 0 ? '▲' : '▼'} {pct(q.premiumPct)} vs {liveWord}</div>}
                  </> : <span className="rwa-noliq">no CoW liquidity</span>}
                </div>
              </button>
            );
          })}

          {sel && <TradePanel token={sel} asset={asset} side={side} setSide={setSide} livePrice={live} regularPrice={regular} liveWord={liveWord} hasExtended={!!extLabel} />}

          {!isTsy && (
            <details className="rwa-disc">
              <summary>How pricing works</summary>
              <p>Prices are the <b>live CoW market rate with the network fee excluded</b>{asset.unit ? ', normalized to $/oz' : ''}, so versions compare cleanly at any size. CoW nets a ~fixed per-order fee, so smaller trades pay more per {asset.unit ?? 'share'} — the ticket shows your true all-in price once you enter an amount.</p>
              {!asset.unit && asset.tokens.some((t) => t.issuer === 'Ondo' || t.issuer.startsWith('Backed')) && (
                <p><b>Dividends.</b> Backed xStocks track the raw price (payouts arrive as extra tokens); Ondo tokens are total-return (payouts accrue into each token). Ondo prices are shown <b>per share</b> — the on-chain shares-per-token multiplier is divided out — so every version's premium is comparable to the raw reference.</p>
              )}
            </details>
          )}
        </>
      )}
    </div>
  );
}

// ── buy/sell one token version via CoW, against any counter-asset ──
function TradePanel({ token, asset, side, setSide, livePrice, regularPrice, liveWord, hasExtended }: {
  token: StockToken; asset: Stock; side: QuoteSide; setSide: (s: QuoteSide) => void; livePrice: number | null; regularPrice: number | null; liveWord: string; hasExtended: boolean;
}) {
  const { address } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const eth = usePublicClient({ chainId: mainnet.id });
  const [counter, setCounter] = useState<CounterAsset>(COUNTER_ASSETS[0]);
  const [amt, setAmt] = useState('');
  const [slip, setSlip] = useState('0.5');
  const [preview, setPreview] = useState<bigint | null>(null);
  const [fee, setFee] = useState<bigint | null>(null);
  const [counterUsd, setCounterUsd] = useState<number | null>(1);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showMultNote, setShowMultNote] = useState(false);

  // Ondo shares-per-token multiplier (M): 1 token ≈ M underlying shares. Same cached
  // on-chain source the version prices use, so the ticket and the list agree.
  const isOndo = token.issuer === 'Ondo';
  const [mult, setMult] = useState(1);
  const [multPaused, setMultPaused] = useState(false);
  useEffect(() => {
    let alive = true;
    ondoMultiplier(token).then(({ m, paused }) => { if (alive) { setMult(m); setMultPaused(paused); } });
    return () => { alive = false; };
  }, [isOndo, token.address]);

  const slipNum = parseFloat(slip);
  const slipBps = Number.isFinite(slipNum) && slipNum >= 0 ? Math.round(Math.min(slipNum, 50) * 100) : 50;

  const buying = side === 'buy';
  const inTok = buying ? counter : { symbol: token.symbol, address: token.address, decimals: token.decimals };
  const outTok = buying ? { symbol: token.symbol, address: token.address, decimals: token.decimals } : counter;
  const inAmount = amt ? (() => { try { return parseUnits(amt, inTok.decimals); } catch { return null; } })() : null;

  // USD price of the counter-asset (1 for stables; live quote otherwise).
  useEffect(() => {
    let alive = true;
    if (counter.stable) { setCounterUsd(1); return; }
    setCounterUsd(null);
    counterUsdPrice(counter).then((v) => { if (alive) setCounterUsd(v); });
    return () => { alive = false; };
  }, [counter.address, counter.stable]);

  const { data: inBalRaw } = useReadContract({ address: inTok.address as Address, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined, chainId: mainnet.id, query: { enabled: !!address, refetchInterval: 15000 } });
  const inBal = (inBalRaw as bigint | undefined) ?? 0n;

  const key = `${side}:${token.address}:${counter.address}:${inAmount?.toString()}`;
  useEffect(() => {
    let alive = true; setPreview(null); setFee(null);
    if (!inAmount || inAmount <= 0n) return;
    fetchQuote({ chainId: mainnet.id, sellToken: inTok.address as Address, buyToken: outTok.address as Address, from: address ?? '0x0000000000000000000000000000000000000001', sellAmount: inAmount })
      .then((q) => { if (alive) { setPreview(q.buyAmount); setFee(q.feeAmount); } }).catch(() => { if (alive) { setPreview(null); setFee(null); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, address]);

  const est = preview != null ? formatUnits(preview, outTok.decimals) : '';

  // Size-dependent effective price: the actual per-unit price for THIS trade size
  // (includes price impact), in USD, with premium vs live and regular.
  // Normalize the executed price to the reference's unit so the premium is honest:
  // gold → $/oz (unitsPerToken), Ondo → $/share (÷ M, since the token embeds M shares).
  const unitsPerToken = token.unitsPerToken && token.unitsPerToken > 0 ? token.unitsPerToken : 1;
  const divisor = unitsPerToken * (mult > 0 ? mult : 1);
  const showMult = isOndo && Math.abs(mult - 1) >= 0.0005; // ≥0.05% — worth explaining
  const effUnit = asset.unit ? `/${asset.unit}` : showMult ? '/share' : '';
  let eff: { price: number; perToken: number; premLive: number | null; premReg: number | null } | null = null;
  if (preview != null && counterUsd != null && inAmount && inAmount > 0n) {
    const tokenAmt = buying ? Number(est) : Number(amt);
    const usd = buying ? Number(amt) * counterUsd : Number(est) * counterUsd;
    if (tokenAmt > 0 && usd > 0) {
      const perShare = usd / tokenAmt / divisor;
      const perToken = usd / tokenAmt / unitsPerToken;
      eff = {
        price: perShare,
        perToken,
        premLive: livePrice ? ((perShare - livePrice) / livePrice) * 100 : null,
        premReg: regularPrice ? ((perShare - regularPrice) / regularPrice) * 100 : null,
      };
    }
  }

  // The CoW settlement fee for THIS exact trade, in USD and as bps of size. It's
  // ~fixed per order, so its bps cost falls as the trade grows — this is why the
  // reference price above (fee-excluded) reads better than a small trade's all-in.
  const tradeUsd = counterUsd != null && inAmount && inAmount > 0n ? (buying ? Number(amt) * counterUsd : Number(est) * counterUsd) : null;
  const feeUsd = fee != null && counterUsd != null
    ? (buying ? Number(formatUnits(fee, counter.decimals)) * (counter.stable ? 1 : counterUsd) : Number(formatUnits(fee, token.decimals)) * (livePrice != null ? livePrice * divisor : 0))
    : null;

  async function doTrade() {
    if (!walletClient || !eth || !address || !inAmount) return;
    if (chainId !== mainnet.id) { switchChain({ chainId: mainnet.id }); return; }
    setBusy(true); setErr(null);
    try {
      await cowSwap({
        publicClient: eth, walletClient, owner: address,
        sellToken: inTok.address as Address, buyToken: outTok.address as Address,
        sellAmount: inAmount, slippageBps: slipBps, onStatus: setStatus,
      });
      setStatus(`✅ ${buying ? 'Buy' : 'Sell'} order placed — settling on CoW.`);
      setAmt('');
    } catch (e) { setErr((e as Error).message); setStatus(null); } finally { setBusy(false); }
  }

  let cta = buying ? `Buy ${token.symbol}` : `Sell ${token.symbol}`; let disabled = false;
  if (!address) { cta = 'Connect wallet'; disabled = true; }
  else if (!inAmount || inAmount <= 0n) { cta = 'Enter an amount'; disabled = true; }
  else if (inBal < inAmount) { cta = `Insufficient ${inTok.symbol}`; disabled = true; }
  else if (busy) { cta = status ?? 'Working…'; disabled = true; }
  else if (chainId !== mainnet.id) { cta = 'Switch to Ethereum'; }

  const counterSelect = (
    <select className="rwa-counter" value={counter.symbol} onClick={(e) => e.stopPropagation()} onChange={(e) => { const c = COUNTER_ASSETS.find((x) => x.symbol === e.target.value); if (c) { setCounter(c); setAmt(''); } }}>
      {COUNTER_ASSETS.map((c) => <option key={c.symbol} value={c.symbol}>{c.symbol}</option>)}
    </select>
  );
  const tokenPill = <span className="pill">{token.symbol}</span>;

  return (
    <div className="rwa-ticket">
      <div className="rwa-side">
        <button className={buying ? 'on' : ''} onClick={() => { setSide('buy'); setAmt(''); }}>Buy</button>
        <button className={!buying ? 'on' : ''} onClick={() => { setSide('sell'); setAmt(''); }}>Sell</button>
      </div>
      <div className="rwa-fld">
        <div className="lab"><span>{buying ? 'Pay with' : 'Sell'}</span>{address && <span>Balance {Number(formatUnits(inBal, inTok.decimals)).toLocaleString('en-US', { maximumFractionDigits: 4 })}{inBal > 0n ? <button className="mx" onClick={() => setAmt(formatUnits(inBal, inTok.decimals))}>MAX</button> : null}</span>}</div>
        <div className="row"><input className="amt" inputMode="decimal" placeholder="0" value={amt} onChange={(e) => setAmt(e.target.value)} />{buying ? counterSelect : tokenPill}</div>
      </div>
      <div className="rwa-fld">
        <div className="lab"><span>Receive (estimated)</span></div>
        <div className="row"><input className="amt" placeholder="0" disabled value={est ? Number(est).toLocaleString('en-US', { maximumFractionDigits: 6 }) : ''} />{buying ? tokenPill : counterSelect}</div>
      </div>

      {/* Primary CTA sits directly under the amount — no derived lines pushing it down. */}
      {status && <p className="hint" style={{ color: 'var(--good)' }}>{status}</p>}
      {err && <p className="errors">{err}</p>}
      <button className="rwa-cta" disabled={disabled} onClick={doTrade}>{cta}</button>
      <a className="rwa-cow-link" href={buying ? cowBuyUrl(token.address, counter.address, amt) : cowSellUrl(token.address, counter.address, amt)} target="_blank" rel="noopener noreferrer">
        {buying ? 'Buy' : 'Sell'} {token.symbol} on CoW Swap ↗
      </a>

      {/* Derived detail — one number in the summary, the rest a tap away. */}
      <details className="rwa-details">
        <summary>Price details{eff ? <> · <b className="tnum">${fmt(eff.price)}{effUnit}</b>{eff.premLive != null && <span className={`tnum ${(buying ? eff.premLive < 0 : eff.premLive > 0) ? 'g' : 'r'}`}> {pct(eff.premLive)}</span>}</> : <span className="mut"> — enter an amount</span>}</summary>
        {eff && (
          <div className="rwa-eff">
            <span>Effective <b className="tnum">${fmt(eff.price)}{effUnit}</b> for this size
              {showMult && <> · <span className="rwa-eff-tok tnum">${fmt(eff.perToken)}/token</span>
                <button type="button" className="rwa-info" onClick={() => setShowMultNote((v) => !v)} aria-expanded={showMultNote} aria-label="Why do I receive fewer tokens?">i</button></>}
            </span>
            <span className="tnum">
              {eff.premLive != null && <em className={(buying ? eff.premLive < 0 : eff.premLive > 0) ? 'g' : 'r'}>{pct(eff.premLive)} vs {liveWord}</em>}
            </span>
          </div>
        )}
        {feeUsd != null && feeUsd > 0 && tradeUsd && tradeUsd > 0 && (
          <div className="rwa-fee">Network fee ≈ <b className="tnum">${fmt(feeUsd)}</b> <span className="tnum">· {Math.round((feeUsd / tradeUsd) * 1e4)} bps</span> of this trade <span className="mut">— ~fixed per order, so larger trades pay less per {asset.unit ?? 'share'}.</span></div>
        )}
        {showMult && showMultNote && (
          <p className="rwa-mult-note">
            1 {token.symbol} ≈ <b>{fmt(mult, 4)}</b> {asset.ticker} shares. Ondo tokens are total-return: reinvested dividends accrue into each token, so one token is worth <b>{fmt((mult - 1) * 100)}%</b> more than a single share — you receive proportionally fewer tokens for the same dollars. The <b>$/share</b> figure is what compares to the live quote.{multPaused ? ' Multiplier updates are paused (corporate action in progress), so this may be momentarily stale.' : ''}
          </p>
        )}
        <div className="rwa-slip"><label>Max slippage %</label><input inputMode="decimal" value={slip} onChange={(e) => setSlip(e.target.value)} /></div>
      </details>
      <p className="hint" style={{ marginTop: 8 }}>MEV-protected CoW order, settled on Ethereum. Pay with any listed asset; gasless approval via permit where supported.</p>
    </div>
  );
}
