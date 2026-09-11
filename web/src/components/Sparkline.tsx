'use client';

import { useId } from 'react';

/** Tiny inline-SVG sparkline for an intraday price series. Colored by direction. */
export function Sparkline({ data, width = 96, height = 28, up }: { data: number[]; width?: number; height?: number; up?: boolean }) {
  // Unique per instance so two sparklines never share a gradient id (invalid SVG).
  // Sanitize the colons useId() emits so url(#id) stays valid.
  const id = 'sg' + useId().replace(/[^a-zA-Z0-9]/g, '');
  if (!data || data.length < 2) return <svg width={width} height={height} aria-hidden />;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const y = (v: number) => height - 2 - ((v - min) / range) * (height - 4);
  const pts = data.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`);
  const rising = up ?? data[data.length - 1] >= data[0];
  const color = rising ? 'var(--good, #1f855a)' : 'var(--bad, #c0392b)';
  const area = `M0,${height} L${pts.join(' L')} L${width},${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: 'block' }} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
