import { formatUnits, parseUnits, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import { fetchQuote } from './quote';
import type { StockToken } from './stocks';

export type QuoteSide = 'buy' | 'sell';
/** Notional the indicative version price is quoted at. $10k sits past the knee of
 *  the size/price curve — the ~fixed CoW per-order fee is ~1bp here (vs ~12bps at
 *  $1k) and liquid RWA show no measurable price impact — so it reflects the best
 *  achievable price for a realistic sizable trade. (We also divide the fee out; at
 *  $10k that's a rounding detail, but it keeps the reference exactly at NAV.) */
export const NOTIONAL_USD = 10000;

// On-chain price discovery for tokenized stocks: quote each token version on CoW
// against USDC to get its live USD price, then compare to the real stock price
// (premium/discount). Low-liquidity tokens simply return null (no on-chain market).

export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const; // 6 decimals
const QUOTE_FROM = '0x0000000000000000000000000000000000000001' as Address;

/** Counter-assets a user can pay with / receive (beyond USDC). Stables are ~$1;
 *  others get a live USD quote so the effective trade price stays in dollars. */
export type CounterAsset = { symbol: string; address: Address; decimals: number; stable: boolean };
export const COUNTER_ASSETS: CounterAsset[] = [
  { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, stable: true },
  { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, stable: true },
  { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, stable: true },
  { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, stable: false },
  { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8, stable: false },
];

/** Live USD price of one counter-asset (1 for stables; a cached CoW quote else). */
export async function counterUsdPrice(a: CounterAsset): Promise<number | null> {
  if (a.stable) return 1;
  return fetchRawPrice({ address: a.address, decimals: a.decimals });
}

// Ondo shares-per-token multiplier (M): 1 token ≈ M underlying shares. Read from
// the shared SyntheticSharesOracle via /api/ondo-multiplier (server-side, cached);
// AssetNotFound() ⇒ M = 1.0. Cached + de-duped here so quoting many versions costs
// at most one request per token per TTL.
export type OndoMult = { m: number; paused: boolean };
const multCache = new Map<string, { at: number; v: OndoMult }>();
const multFlight = new Map<string, Promise<OndoMult>>();
const MULT_TTL = 10 * 60_000;

export async function ondoMultiplier(token: Pick<StockToken, 'issuer' | 'address'>): Promise<OndoMult> {
  if (token.issuer !== 'Ondo') return { m: 1, paused: false };
  const key = token.address.toLowerCase();
  const hit = multCache.get(key);
  if (hit && Date.now() - hit.at < MULT_TTL) return hit.v;
  const running = multFlight.get(key);
  if (running) return running;
  const p = (async (): Promise<OndoMult> => {
    try {
      const r = await fetch(`/api/ondo-multiplier?token=${key}`);
      const j = await r.json();
      const e = j?.[key];
      const v: OndoMult = e && typeof e.m === 'number' && e.m > 0 ? { m: e.m, paused: !!e.paused } : { m: 1, paused: false };
      multCache.set(key, { at: Date.now(), v });
      return v;
    } catch {
      return { m: 1, paused: false }; // don't cache a transient failure
    } finally {
      multFlight.delete(key);
    }
  })();
  multFlight.set(key, p);
  return p;
}

export type TokenQuote = {
  /** Comparable USD price of one reference-unit (per share, or per troy oz for
   *  gold — normalized by unitsPerToken). null = no on-chain liquidity. */
  price: number | null;
  /** Raw USD price of one whole token as traded (before unit normalization). */
  rawPrice?: number | null;
  /** premium(+)/discount(−) vs the reference price, in %. */
  premiumPct: number | null;
};

/** Derive the comparable quote from a raw token→USDC price and the current
 *  reference. `unitsPerToken` says how many reference-units one token is (1
 *  share, 1 troy oz, or 1/31.1035 oz for a gram-denominated gold token), so every
 *  version compares on one scale. Kept separate from fetching so a later-arriving
 *  reference price is always applied (the sanity band + premium recompute). */
function deriveQuote(token: StockToken, rawPrice: number | null, referencePrice: number | null, multiplier = 1): TokenQuote {
  if (rawPrice == null || !isFinite(rawPrice) || rawPrice <= 0) return { price: null, rawPrice: null, premiumPct: null };
  // Normalize to one reference-unit so the premium is honest: unitsPerToken handles
  // gold (per troy oz), and the Ondo multiplier M handles total-return tokens (the
  // token embeds M shares, so its price is M× the share price by construction —
  // that is dividend accrual, not a premium). Dividing both out gives per-share.
  const units = (token.unitsPerToken && token.unitsPerToken > 0 ? token.unitsPerToken : 1) * (multiplier > 0 ? multiplier : 1);
  const price = rawPrice / units; // per reference-unit (per share / per oz)
  // RWA are pegged ~1:1 to NAV. A quote wildly off the reference means a broken /
  // no-real-liquidity market (CoW can return dust for illiquid tokens) — treat as
  // "no liquidity" so it never wins best-execution.
  if (referencePrice && (price < referencePrice * 0.5 || price > referencePrice * 2)) {
    return { price: null, rawPrice: null, premiumPct: null };
  }
  const premiumPct = referencePrice ? ((price - referencePrice) / referencePrice) * 100 : null;
  return { price, rawPrice, premiumPct };
}

/** Live on-chain price of one token version (sell 1 whole token → USDC), normalized. */
export async function tokenOnchainPrice(token: StockToken, referencePrice: number | null): Promise<TokenQuote> {
  const [raw, { m }] = await Promise.all([fetchRawPrice(token), ondoMultiplier(token)]);
  return deriveQuote(token, raw, referencePrice, m);
}

// Shared 60s cache + in-flight de-dupe of the raw (reference-independent) token
// price, so the table and detail don't re-quote the same token and a changing
// reference price is always re-applied via deriveQuote.
const rawCache = new Map<string, { at: number; raw: number }>();
const rawFlight = new Map<string, Promise<number | null>>();
const QTTL = 180_000; // 3 min — indicative prices tolerate staleness; cuts CoW quote volume

async function rawOnce(token: { address: Address; decimals: number }, retry: boolean): Promise<number | null> {
  try {
    const oneToken = 10n ** BigInt(token.decimals);
    const q = await fetchQuote({ chainId: mainnet.id, sellToken: token.address, buyToken: USDC, from: QUOTE_FROM, sellAmount: oneToken });
    const raw = Number(q.buyAmount) / 1e6; // USDC has 6 decimals
    if (isFinite(raw) && raw > 0) { rawCache.set(token.address.toLowerCase(), { at: Date.now(), raw }); return raw; }
    return null;
  } catch (e) {
    // Distinguish a genuine no-liquidity result from a transient failure (CoW
    // rate-limits when the table quotes many tokens at once). Retry the transient
    // case once so real markets don't flash "thin liquidity".
    const msg = String((e as Error)?.message || '').toLowerCase();
    const genuine = /liquid|no route|not enough|too small|unsupported|sell amount/.test(msg);
    if (retry && !genuine) {
      await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 600)));
      return rawOnce(token, false);
    }
    return null;
  }
}

async function fetchRawPrice(token: { address: Address; decimals: number }): Promise<number | null> {
  const key = token.address.toLowerCase();
  const hit = rawCache.get(key);
  if (hit && Date.now() - hit.at < QTTL) return hit.raw;
  const running = rawFlight.get(key);
  if (running) return running;
  const p = rawOnce(token, true).finally(() => { rawFlight.delete(key); });
  rawFlight.set(key, p);
  return p;
}

// Sided indicative price: what you actually pay per token BUYING ~$NOTIONAL_USD
// (the ask), or receive per token SELLING ~$NOTIONAL_USD worth (the bid). This is
// the achievable price for a realistic trade, not a 1-token mid on the wrong side.
const sidedCache = new Map<string, { at: number; v: number }>();
const sidedFlight = new Map<string, Promise<number | null>>();

async function sidedOnce(token: StockToken, side: QuoteSide, ref: number | null, retry: boolean): Promise<number | null> {
  try {
    // Indicative price = the fee-EXCLUDED market rate. CoW nets a roughly fixed
    // per-order fee (~$1.2 gas) out of the trade, which at a $1k notional is ~12bps
    // of drag and shrinks as size grows. That fixed cost is a transaction fee, not
    // the token's price — so for the reference/premium we divide it out (using the
    // quote's fee-net leg), giving the ~NAV price a large trade would get, at any
    // size and without over-quoting thin tokens into price impact. The ticket below
    // shows the user's true all-in price at their actual size.
    let perToken: number;
    if (side === 'buy') {
      const sellAmount = parseUnits(String(NOTIONAL_USD), 6); // USDC in (before fee)
      const q = await fetchQuote({ chainId: mainnet.id, sellToken: USDC as Address, buyToken: token.address, from: QUOTE_FROM, sellAmount });
      const tokensOut = Number(formatUnits(q.buyAmount, token.decimals));
      const netUsd = Number(formatUnits(q.sellAmount, 6)); // USDC actually swapped (net of fee)
      if (!(tokensOut > 0) || !(netUsd > 0)) return null;
      perToken = netUsd / tokensOut;
    } else {
      // Size ~$NOTIONAL worth of the token. One whole token is worth ref × unitsPerToken
      // (ref is per reference-unit, e.g. per oz, while a gram token is 1/31.1 oz).
      const units = token.unitsPerToken && token.unitsPerToken > 0 ? token.unitsPerToken : 1;
      const perTokenUsd = ref && ref > 0 ? ref * units : null;
      let tokenAmt = perTokenUsd ? NOTIONAL_USD / perTokenUsd : 1;
      let sellAmount = parseUnits(tokenAmt.toFixed(token.decimals), token.decimals);
      if (sellAmount <= 0n) { tokenAmt = 1; sellAmount = parseUnits('1', token.decimals); } // guard tiny/rounded sizes
      const q = await fetchQuote({ chainId: mainnet.id, sellToken: token.address, buyToken: USDC as Address, from: QUOTE_FROM, sellAmount });
      const usdcOut = Number(q.buyAmount) / 1e6;
      const netTokens = Number(formatUnits(q.sellAmount, token.decimals)); // tokens actually swapped (net of fee)
      if (!(usdcOut > 0)) return null;
      perToken = usdcOut / (netTokens > 0 ? netTokens : tokenAmt); // USD per whole token, fee-excluded
    }
    sidedCache.set(`${token.address.toLowerCase()}:${side}`, { at: Date.now(), v: perToken });
    return perToken;
  } catch (e) {
    const msg = String((e as Error)?.message || '').toLowerCase();
    const genuine = /liquid|no route|not enough|too small|unsupported|sell amount/.test(msg);
    if (retry && !genuine) { await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 600))); return sidedOnce(token, side, ref, false); }
    return null;
  }
}

async function fetchSidedRaw(token: StockToken, side: QuoteSide, ref: number | null): Promise<number | null> {
  const key = `${token.address.toLowerCase()}:${side}`;
  const hit = sidedCache.get(key);
  if (hit && Date.now() - hit.at < QTTL) return hit.v;
  const running = sidedFlight.get(key);
  if (running) return running;
  const p = sidedOnce(token, side, ref, true).finally(() => { sidedFlight.delete(key); });
  sidedFlight.set(key, p);
  return p;
}

/** Comparable price of a version for a realistic trade in `side` (default buy). */
export async function cachedTokenPrice(token: StockToken, referencePrice: number | null, side: QuoteSide = 'buy'): Promise<TokenQuote> {
  const [raw, { m }] = await Promise.all([fetchSidedRaw(token, side, referencePrice), ondoMultiplier(token)]);
  return deriveQuote(token, raw, referencePrice, m);
}

/** Run async work over items with bounded concurrency (keeps CoW quote load sane). */
export async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
