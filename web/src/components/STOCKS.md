# RWA tab (tokenized real-world assets)

A full-page terminal to trade tokenized real-world assets on Ethereum mainnet
through CoW Protocol. Search any asset; see every on-chain version of it across
issuers; compare each version's live CoW price against the real reference; and
buy/sell the best-priced version with an MEV-protected, gasless-approval order.

Design mockup: https://claude.ai/code/artifact/1fa7388c-dba0-4b71-880e-ed841a15c1ae

## Layout

Full-width board (`.container.wide`, 1240px) with a two-pane terminal:
- **Left** — a sortable asset table with a category color-stripe per row,
  reference price, 24h change, 7-day sparkline, version count, best on-chain
  price and premium/discount. Search + category segmented control + sector /
  sort / watchlist toolbar above it.
- **Right** — a sticky detail rail: asset header, chart, every on-chain version
  (issuer, live price, premium, best-price badge, no-liquidity state), a
  best-execution callout, and a buy/sell trade ticket.
- Responsive: below 920px the detail replaces the table (drawer-style).

## Registry (`lib/stocks.data.ts`, auto-generated)

52 assets / 81 tokens, **every address verified on-chain** (`symbol()`/
`decimals()`) + CoW-liquidity-checked before inclusion. Regenerate by running
`scratchpad/gen_stocks.py` (pristine base) then `scratchpad/gen_v2.py` (merges
Ondo + gold + treasuries; idempotent).

- **Equities & ETFs** — Backed xStocks (primary), **Ondo Global Markets** (`…on`,
  23 tokens), and legacy Backed bTokens. **24 assets show 2–3 versions side by
  side** (e.g. NVDA = NVDAx + NVDAon + bNVDA; META = METAx + METAon — where
  Ondo is often the only liquid one).
- **Gold** — one asset (`Gold · XAU`) with PAXG, XAUt (per troy oz) and CGT, KAU
  (per gram). `unitsPerToken` normalizes every bar to **$/troy-oz** so they
  compare on one line; reference is gold spot (`GC=F`).
- **Treasuries** — USDY, USDM, OUSG shown for breadth (primary-issuance / thin
  or permissioned secondary liquidity; not routed for trading).

## How prices work

- **Reference** (`/api/stock-price`) — Yahoo public chart endpoint (no key,
  `includePrePost`), 30s cache. Returns the regular close **and** the live
  extended-hours (pre/after-market) price, the market phase, and the next
  regular-open time (DST-correct via Intl `America/New_York`). Equities/ETFs by
  ticker; gold by `GC=F`; treasuries have no reference.
- **On-chain** (`lib/stockQuote.ts`) — a CoW quote of `sell 1 token → USDC`,
  divided by `unitsPerToken` for the comparable per-unit price, then premium vs
  the **live** price (extended-aware) and vs the regular close. A 0.5×–2× sanity
  band rejects dust/broken quotes. The reference-independent raw price is cached
  (60s) and re-derived so a late reference is always applied; quoted with bounded
  concurrency + a transient-failure retry to survive CoW rate-limits.
- **Trade** (`lib/cowSwap.ts`) — production CoW order against any counter-asset
  (USDC/USDT/DAI/WETH/WBTC), gasless EIP-2612 permit where supported, EIP-712
  signing, MEV-protected. The ticket shows a **size-dependent effective price**
  (actual price impact for the entered amount) with premium vs live and close.

## Roadmap
- Price alerts on premium/discount crossings (token↔NAV arbitrage signal).
- Limit / TWAP on RWA (reuse existing infra) for large orders vs thin liquidity.
- Portfolio view with P&L vs cost basis and vs NAV.
- Route treasuries/permissioned RWA via a "primary issuance" (mint/redeem) flow.
- Ingest the full ~700-token Backed & Ondo catalogs from their APIs at build time.
