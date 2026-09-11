'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type Series = { t: number[]; c: number[]; ac: number[] | null; changePct: number; adjChangePct: number | null; currency: string; tr: number[] | null; divIdx: number[]; divAmt: number[]; trChangePct: number | null };
const RANGES = [['1w', '1W'], ['1m', '1M'], ['3m', '3M'], ['1y', '1Y'], ['5y', '5Y'], ['max', 'MAX']] as const;
type Range = typeof RANGES[number][0];

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Full-size interactive price chart with timeframe tabs (1W…5Y), a hover readout,
 *  and a Price ⇄ Total-return (dividend-adjusted) toggle. */
export function AssetChart({ symbol, refPrice, onHover, onMeta }: { symbol: string; refPrice?: number | null; onHover?: (v: number | null) => void; onMeta?: (m: { changePct: number; label: string; cagr: number | null }) => void }) {
  const [range, setRange] = useState<Range>('1m');
  const [adjusted, setAdjusted] = useState(false);
  const [data, setData] = useState<Series | null>(null);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<number | null>(null);
  const [w, setW] = useState(720);
  const box = useRef<HTMLDivElement>(null);
  const H = 300, padL = 8, padR = 58, padB = 22, padT = 8;

  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver((es) => { for (const e of es) setW(Math.max(320, e.contentRect.width)); });
    ro.observe(el); return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let live = true; setLoading(true);
    fetch(`/api/stock-chart?symbol=${encodeURIComponent(symbol)}&range=${range}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (live) { setData(d && d.c ? d : null); setLoading(false); } })
      .catch(() => { if (live) { setData(null); setLoading(false); } });
    return () => { live = false; };
  }, [symbol, range]);

  // "Total return" here = price + cumulative cash distributions (so payouts show as
  // discrete steps). Available only when the window contains distributions.
  const showAdj = adjusted && !!data?.tr;
  const changePct = showAdj ? (data!.trChangePct ?? data!.changePct) : (data?.changePct ?? 0);
  const label = RANGES.find(([r]) => r === range)?.[1] ?? range;
  // Average annualized return (CAGR) for multi-year windows (5Y, MAX).
  const years = data && data.t.length >= 2 ? (data.t[data.t.length - 1] - data.t[0]) / (365.25 * 86400) : 0;
  const cagr = (range === '5y' || range === 'max') && years >= 1.5 && changePct > -100 ? (Math.pow(1 + changePct / 100, 1 / years) - 1) * 100 : null;

  useEffect(() => {
    if (data) onMeta?.({ changePct, label, cagr });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, adjusted, range]);

  const geo = useMemo(() => {
    if (!data) return null;
    let primary: number[] | null;
    let raw: number[] | null = null; // faint price underlay, total-return mode only
    if (showAdj && data.tr) {
      // Additive total return: price + cumulative cash distributions. Already anchored
      // at the raw start (cumDiv[0]=0 ⇒ tr[0]=c[0]); the gap above `raw` staircases up
      // by each payout on its ex-date.
      primary = data.tr;
      raw = data.c;
    } else {
      primary = data.c ?? null;
    }
    if (!primary || primary.length < 2) return null;
    // Append the live price to the PRICE line only. The total-return line legitimately
    // ends above raw, so appending today's raw price there would drag its endpoint back
    // down (the second half of the reported bug).
    const appendLive = !showAdj && refPrice != null && isFinite(refPrice) && Math.abs(refPrice - primary[primary.length - 1]) / primary[primary.length - 1] < 0.15;
    const c = appendLive ? [...primary, refPrice] : primary;
    const t = appendLive ? [...data.t, Math.floor(Date.now() / 1000)] : data.t;
    // Autoscale over both series so the raw underlay never clips.
    const span = raw ? c.concat(raw.filter((v) => isFinite(v))) : c;
    const min = Math.min(...span), max = Math.max(...span), rng = max - min || 1;
    const x0 = padL, x1 = w - padR, y0 = padT, y1 = H - padB;
    const X = (i: number) => x0 + (i / (c.length - 1)) * (x1 - x0);
    const Y = (v: number) => y1 - ((v - min) / rng) * (y1 - y0);
    const pts = c.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
    const rawPts = raw ? raw.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`) : null;
    return { c, t, raw, rawPts, min, max, x0, x1, y0, y1, X, Y, pts };
  }, [data, w, showAdj, refPrice]);

  const up = changePct >= 0;
  const color = up ? 'var(--good)' : 'var(--bad)';

  function onMove(e: React.MouseEvent) {
    if (!geo) return;
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * w;
    const frac = Math.max(0, Math.min(1, (px - geo.x0) / (geo.x1 - geo.x0)));
    const i = Math.round(frac * (geo.c.length - 1));
    setHover(i); onHover?.(geo.c[i]);
  }
  function onLeave() { setHover(null); onHover?.(null); }

  const dateFmt = (sec: number) => new Date(sec * 1000).toLocaleDateString(undefined, range === 'max' ? { year: 'numeric' } : range === '5y' || range === '1y' ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' });
  // The hover readout always shows the exact day (the axis labels stay coarse).
  const fullDate = (sec: number) => new Date(sec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });

  return (
    <div className="asset-chart">
      <div className="asset-chart-head">
        {data?.tr ? (
          <div className="asset-chart-mode">
            <button className={!adjusted ? 'on' : ''} onClick={() => setAdjusted(false)}>Price</button>
            <button className={adjusted ? 'on' : ''} onClick={() => setAdjusted(true)} title="Price + cumulative cash distributions (not reinvested)">Total return</button>
          </div>
        ) : <span />}
        <div className="asset-chart-tabs">
          {RANGES.map(([r, lbl]) => <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{lbl}</button>)}
        </div>
      </div>
      <div ref={box} className="asset-chart-box" style={{ height: H }}>
        {geo ? (
          <svg width={w} height={H} onMouseMove={onMove} onMouseLeave={onLeave} style={{ display: 'block' }}>
            <defs>
              <linearGradient id={`ac-${symbol}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.20" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 0.25, 0.5, 0.75, 1].map((f) => {
              const v = geo.max - f * (geo.max - geo.min); const y = geo.y0 + f * (geo.y1 - geo.y0);
              return <g key={f}>
                <line x1={geo.x0} x2={geo.x1} y1={y} y2={y} stroke="var(--border)" strokeWidth="1" />
                <text x={w - padR + 6} y={y + 4} fontSize="11" fill="var(--muted)">{fmt(v)}</text>
              </g>;
            })}
            {!showAdj && refPrice != null && refPrice >= geo.min && refPrice <= geo.max && (
              <line x1={geo.x0} x2={geo.x1} y1={geo.Y(refPrice)} y2={geo.Y(refPrice)} stroke="var(--accent)" strokeWidth="1" strokeDasharray="3 3" opacity="0.55" />
            )}
            {[0, 0.5, 1].map((f) => {
              const i = Math.round(f * (geo.c.length - 1));
              return <text key={f} x={geo.X(i)} y={H - 6} fontSize="11" fill="var(--muted)" textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}>{dateFmt(geo.t[i])}</text>;
            })}
            <path d={`M${geo.pts[0]} L${geo.pts.join(' L')} L${geo.X(geo.c.length - 1)},${geo.y1} L${geo.x0},${geo.y1} Z`} fill={`url(#ac-${symbol})`} />
            {geo.rawPts && (
              <polyline points={geo.rawPts.join(' ')} fill="none" stroke="var(--muted)" strokeWidth="1.2" strokeDasharray="4 3" opacity="0.55" strokeLinejoin="round" />
            )}
            <polyline points={geo.pts.join(' ')} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
            {/* Distribution markers on the price line — where it notches down on each ex-date. */}
            {showAdj && geo.raw && data?.divIdx?.map((idx, k) => (
              <g key={idx} style={{ cursor: 'pointer' }}>
                {/* large invisible hit-area so the marker is easy to hover */}
                <circle cx={geo.X(idx)} cy={geo.Y(geo.raw![idx])} r="11" fill="transparent" onMouseEnter={() => setHover(idx)}>
                  <title>Distribution ${fmt(data.divAmt[k])}/share · {fullDate(geo.t[idx])}</title>
                </circle>
                <circle cx={geo.X(idx)} cy={geo.Y(geo.raw![idx])} r="3.8" fill="var(--muted)" stroke="var(--card)" strokeWidth="1.5" pointerEvents="none" />
              </g>
            ))}
            {geo.rawPts && (
              <g transform={`translate(${geo.x0 + 4}, ${geo.y0 + 11})`} fontSize="10.5">
                <line x1="0" y1="-3.5" x2="15" y2="-3.5" stroke={color} strokeWidth="2" />
                <text x="19" y="0" fill="var(--muted)">Total return</text>
                <line x1="96" y1="-3.5" x2="111" y2="-3.5" stroke="var(--muted)" strokeWidth="1.2" strokeDasharray="4 3" />
                <text x="115" y="0" fill="var(--muted)">Price</text>
                <circle cx="150" cy="-3.5" r="2.7" fill="var(--muted)" stroke="var(--card)" strokeWidth="1" />
                <text x="157" y="0" fill="var(--muted)">Distribution</text>
              </g>
            )}
            {hover != null && (() => {
              const dAt = showAdj && data?.divIdx ? data.divIdx.indexOf(hover) : -1;
              const lines: { text: string; bold?: boolean }[] = [{ text: `$${fmt(geo.c[hover])}${geo.raw ? ' TR' : ''}`, bold: true }];
              if (geo.raw) lines.push({ text: `price $${fmt(geo.raw[hover])}` });
              if (dAt >= 0) lines.push({ text: `＋distribution $${fmt(data!.divAmt[dAt])}` });
              lines.push({ text: fullDate(geo.t[hover]) });
              const boxH = 8 + lines.length * 13;
              return (
                <g>
                  <line x1={geo.X(hover)} x2={geo.X(hover)} y1={geo.y0} y2={geo.y1} stroke="var(--muted)" strokeWidth="1" opacity="0.4" />
                  {geo.raw && <circle cx={geo.X(hover)} cy={geo.Y(geo.raw[hover])} r="3" fill="var(--muted)" stroke="var(--card)" strokeWidth="1.5" />}
                  <circle cx={geo.X(hover)} cy={geo.Y(geo.c[hover])} r="4" fill={color} stroke="var(--card)" strokeWidth="2" />
                  <g transform={`translate(${Math.min(Math.max(geo.X(hover), 56), w - padR - 56)}, 15)`}>
                    <rect x="-56" y="-13" width="112" height={boxH} rx="6" fill="var(--text)" opacity="0.93" />
                    {lines.map((l, k) => <text key={k} x="0" y={-1 + k * 13} fontSize={l.bold ? 11.5 : 9.5} fill="var(--card)" textAnchor="middle" fontWeight={l.bold ? 700 : 400} opacity={l.bold ? 1 : 0.85}>{l.text}</text>)}
                  </g>
                </g>
              );
            })()}
          </svg>
        ) : (
          <div className="asset-chart-empty">{loading ? 'Loading chart…' : 'No chart data.'}</div>
        )}
      </div>
      {showAdj && <p className="asset-chart-note">Total return — price plus cumulative cash distributions (held as cash, not reinvested). The gap above the dashed price line is the cash paid per share so far; each dot is a distribution on its ex-date, where the price notches down and the gap steps up.{data?.adjChangePct != null && data?.trChangePct != null ? ` Reinvested, the return would be +${data.adjChangePct.toFixed(2)}% vs +${data.trChangePct.toFixed(2)}% here.` : ''}</p>}
    </div>
  );
}

export { RANGES as CHART_RANGES };
