import type { Address } from 'viem';
import { USDC } from './stockQuote';

// Deep-link into the CoW Swap UI with the pair (and optionally the amount)
// pre-filled, so a user can also trade the exact token on swap.cow.fi.
const BASE = 'https://swap.cow.fi/#/1/swap';

// CoW Swap reads a human-unit `sellAmount` query param on the swap route.
function suffix(sellAmount?: string | number): string {
  const n = sellAmount != null ? Number(sellAmount) : NaN;
  return Number.isFinite(n) && n > 0 ? `?sellAmount=${n}` : '';
}

/** Buy `token` with `counter` (default USDC): CoW opens counter → token, selling
 *  `sellAmount` of the counter. */
export function cowBuyUrl(token: Address, counter: Address = USDC as Address, sellAmount?: string | number): string {
  return `${BASE}/${counter}/${token}${suffix(sellAmount)}`;
}
/** Sell `token` for `counter` (default USDC), selling `sellAmount` of the token. */
export function cowSellUrl(token: Address, counter: Address = USDC as Address, sellAmount?: string | number): string {
  return `${BASE}/${token}/${counter}${suffix(sellAmount)}`;
}
