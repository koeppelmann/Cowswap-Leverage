import type { Address } from 'viem';

/**
 * Registry of tokenized US equities tradeable on Ethereum mainnet. A single stock
 * (by its market ticker) can have several on-chain representations from different
 * issuers (Backed, Dinari, Swarm, …); we quote every version on CoW and compare
 * them against the real stock price (premium/discount).
 *
 * `ticker` is the Yahoo symbol used for the reference price. Addresses are the
 * ERC-20s on Ethereum mainnet (chainId 1). Populated + on-chain-verified in
 * stocks.data.ts.
 */

export type AssetKind = 'equity' | 'etf' | 'gold' | 'treasury';

export type StockToken = {
  issuer: string;      // 'Backed xStocks' | 'Ondo' | 'Backed (legacy)' | 'Paxos' | …
  symbol: string;      // on-chain token symbol, e.g. 'bNVDA'
  address: Address;    // ERC-20 on Ethereum mainnet
  decimals: number;
  /** How many reference-units one whole token represents (default 1). For gold,
   *  the underlying is priced per troy ounce: a 1-oz token = 1, a 1-gram token
   *  = 1/31.1035. Used to normalize every version onto one comparable scale. */
  unitsPerToken?: number;
  /** short capability tags, e.g. ['24/7', 'redeemable'] */
  tags?: string[];
  /** issuer/product page */
  url?: string;
};

export type Stock = {
  ticker: string;      // market ticker / display key, e.g. 'NVDA', 'GOLD'
  name: string;        // 'NVIDIA Corporation'
  isin?: string;       // underlying ISIN
  sector?: string;     // 'Technology' | 'Financials' | …
  kind?: AssetKind;    // equity (default) | etf | gold | treasury
  /** Yahoo symbol for the reference price, if different from ticker (e.g. gold
   *  uses 'GC=F'). Undefined for treasuries with no public reference. */
  refSymbol?: string;
  /** reference unit label for the detail view, e.g. 'share' (default) or 'oz'. */
  unit?: string;
  tokens: StockToken[];
};

/** The kind of an asset, defaulting to equity. */
export function assetKind(s: Stock): AssetKind { return s.kind ?? 'equity'; }

// Shares outstanding in billions (relatively stable, updated ~yearly). Live market
// cap = shares × the live price, so the displayed cap stays accurate as the price
// moves — no hardcoded, quickly-stale cap figures. Prices load in one batch, so the
// market-cap sort settles once rather than reshuffling per-row like premium did.
const SHARES_B: Record<string, number> = {
  NVDA: 24.4, AAPL: 14.8, MSFT: 7.43, GOOGL: 12.2, AMZN: 10.6, META: 2.52, AVGO: 4.72,
  TSLA: 3.22, 'BRK.B': 2.16, JPM: 2.75, V: 1.92, MA: 0.905, NFLX: 0.425, XOM: 4.28,
  UNH: 0.905, ORCL: 2.81, JNJ: 2.4, BAC: 7.55, KO: 4.31, CVX: 1.78, AMD: 1.62, CRM: 0.955,
  MCD: 0.715, PEP: 1.37, DIS: 1.79, QCOM: 1.09, UBER: 2.09, PFE: 5.68, ARM: 1.05, MU: 1.12,
  ABNB: 0.62, HOOD: 0.88, MSTR: 0.284, NKE: 1.48, INTC: 4.35, COIN: 0.255, PYPL: 0.97,
  PLTR: 2.37, CRCL: 0.245, SMCI: 0.597, GME: 0.447, WMT: 8.0,
  SPCX: 13.18, // multi-class; implied from headline market cap ÷ price (single-class shares outstanding understates it)
};
// ETF AUM in USD billions (there's no per-share "market cap" for a fund).
const ETF_AUM_B: Record<string, number> = { SPY: 630, VOO: 560, VTI: 450, QQQ: 320, VUG: 170, GLD: 92, IWM: 66, XLE: 40, IEMG: 30, SLV: 18, SMH: 25, SOXX: 15, TQQQ: 26, TBLL: 6, BITX: 3 };

// Static approximate market cap (USD billions) for the notable names — used only
// to RANK the default market-cap sort so it's stable and doesn't need a price for
// every one of the 500+ listed tokens. Display uses the live shares × price below.
const SEED_CAP_B: Record<string, number> = {
  NVDA: 5450, AAPL: 4550, GOOGL: 4100, MSFT: 3650, AMZN: 2750, SPCX: 1875, AVGO: 1700, META: 1450, TSLA: 1120,
  'BRK.B': 1080, WMT: 800, JPM: 800, V: 620, MA: 530, NFLX: 510, XOM: 480, UNH: 470, BAC: 470,
  ORCL: 450, JNJ: 430, PLTR: 420, KO: 290, CVX: 290, AMD: 280, CRM: 250, MCD: 210, PEP: 200, DIS: 200,
  QCOM: 180, UBER: 180, PFE: 150, ARM: 150, MU: 130, ABNB: 120, HOOD: 120, MSTR: 110, NKE: 110,
  INTC: 100, COIN: 85, PYPL: 75, CRCL: 40, SMCI: 25, GME: 12,
};

/** Live market cap / AUM in USD billions: equities = shares × price (falls back to
 *  the static seed until price loads), ETFs = AUM; commodities/treasuries have none. */
export function marketCapB(ticker: string, kind: AssetKind, price: number | null): number | null {
  if (kind === 'etf') return ETF_AUM_B[ticker] ?? null;
  if (kind !== 'equity') return null;
  const s = SHARES_B[ticker];
  if (s && price) return s * price;
  return SEED_CAP_B[ticker] ?? null;
}
/** Static rank for the market-cap sort (no price needed, so it's stable across 500+ rows). */
export function marketCapRank(ticker: string, kind: AssetKind): number {
  if (kind === 'etf') return ETF_AUM_B[ticker] ?? 0;
  if (kind === 'equity') return SEED_CAP_B[ticker] ?? 0;
  return 0;
}
/** Whether a market cap is expected for this ticker (equity/ETF), for loading state. */
export function hasMarketCap(ticker: string, kind: AssetKind): boolean {
  return kind === 'etf' ? ETF_AUM_B[ticker] != null : kind === 'equity' && (SHARES_B[ticker] != null || SEED_CAP_B[ticker] != null);
}

export const CATEGORIES: { key: AssetKind; label: string }[] = [
  { key: 'equity', label: 'Equities' },
  { key: 'etf', label: 'ETFs' },
  { key: 'gold', label: 'Gold' },
];

export { STOCKS } from './stocks.data';
import { STOCKS } from './stocks.data';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Search by ticker, company name, ISIN, or a token symbol. Ranked: exact ticker
 *  first, then ticker/symbol prefix, then name/ISIN substring. */
export function searchStocks(query: string): Stock[] {
  const q = query.trim();
  if (!q) return STOCKS;
  // Address search: match a token's contract address (exact or 0x-prefix) across
  // every on-chain version — so any of the ~1,000 token addresses is findable.
  if (/^0x[0-9a-fA-F]{2,}$/.test(q)) {
    const lc = q.toLowerCase();
    return STOCKS.filter((s) => s.tokens.some((t) => {
      const a = t.address.toLowerCase();
      return a === lc || (lc.length >= 6 && a.startsWith(lc));
    }));
  }
  const nq = norm(q);
  const scored = STOCKS.map((s) => {
    const ticker = norm(s.ticker);
    const name = norm(s.name);
    const isin = s.isin ? norm(s.isin) : '';
    const symbols = s.tokens.map((t) => norm(t.symbol));
    let score = 0;
    if (ticker === nq || isin === nq) score = 100;
    else if (ticker.startsWith(nq)) score = 80;
    else if (symbols.some((sy) => sy === nq)) score = 75;
    else if (symbols.some((sy) => sy.includes(nq))) score = 60;
    else if (name.includes(nq)) score = 50;
    else if (isin.includes(nq)) score = 40;
    return { s, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.s.ticker.localeCompare(b.s.ticker));
  return scored.map((x) => x.s);
}

export function findStock(ticker: string): Stock | undefined {
  return STOCKS.find((s) => s.ticker.toUpperCase() === ticker.toUpperCase());
}

export function allSectors(): string[] {
  return [...new Set(STOCKS.map((s) => s.sector).filter(Boolean) as string[])].sort();
}
