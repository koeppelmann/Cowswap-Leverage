// Per-browser stock watchlist (localStorage), keyed by ticker.
const KEY = 'stocks-watchlist';

export function getWatchlist(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    // Guard against a corrupted/older non-array value: JSON.parse would succeed
    // and downstream .includes/.filter would throw and break the tab.
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch { return []; }
}
export function toggleWatch(ticker: string): string[] {
  const cur = getWatchlist();
  const next = cur.includes(ticker) ? cur.filter((t) => t !== ticker) : [...cur, ticker];
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}
