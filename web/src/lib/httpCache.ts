// Cache-Control presets for cacheable GET API routes. The browser (and any CDN Cache
// Rule the operator adds) serves cached responses instantly and revalidates in the
// background via stale-while-revalidate — so repeat navigation is snappy. `s-maxage`
// is set for when an edge Cache Rule is enabled; browsers use `max-age`. Only apply to
// successful, non-personalized responses.
export const cc = (maxAge: number, swr: number): Record<string, string> => ({
  'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${swr}`,
});

export const CACHE = {
  profile: cc(86400, 604800),   // company/fund blurbs — effectively static
  meta: cc(21600, 86400),       // xStocks metadata — 6h
  caps: cc(1800, 21600),        // market cap / AUM — 30m fresh, 6h stale-ok
  returns: cc(3600, 21600),     // multi-timeframe returns — 1h
  chart: cc(600, 3600),         // price/NAV history — 10m
  multiplier: cc(600, 3600),    // Ondo shares multiplier — 10m
  price: cc(30, 300),           // reference price — 30s fresh, 5m stale-ok
} as const;
