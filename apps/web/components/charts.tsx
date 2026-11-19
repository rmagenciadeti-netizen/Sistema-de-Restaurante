'use client';

import { useId } from 'react';

// Dependency-free SVG charts in the RM identity (primary color on the theme surface). They only render the values they receive.

export const chartPalette = ['rgb(var(--b-500))', 'rgb(var(--s-900))', 'rgb(var(--b-300))', 'rgb(var(--s-600))', 'rgb(var(--b-700))', 'rgb(var(--s-400))'];

export function AreaChart({ points, format, label }: { points: { label: string; value: number }[]; format: (value: number) => string; label: string }) {
  const gradient = useId();
  const width = 600; const height = 200; const pad = { left: 8, right: 8, top: 16, bottom: 8 };
  const peak = Math.max(1, ...points.map(point => point.value));
  const step = points.length > 1 ? (width - pad.left - pad.right) / (points.length - 1) : 0;
  const coords = points.map((point, index) => ({ x: pad.left + index * step, y: pad.top + (1 - point.value / peak) * (height - pad.top - pad.bottom) }));
  const line = coords.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const area = coords.length > 0 ? `${line} L${coords[coords.length - 1].x.toFixed(1)},${height - pad.bottom} L${coords[0].x.toFixed(1)},${height - pad.bottom} Z` : '';
  return <figure>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="h-44 w-full">
      <defs><linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="rgb(var(--b-500))" stopOpacity="0.45" /><stop offset="100%" stopColor="rgb(var(--b-500))" stopOpacity="0.02" /></linearGradient></defs>
      {[0.25, 0.5, 0.75].map(fraction => <line key={fraction} x1={pad.left} x2={width - pad.right} y1={pad.top + fraction * (height - pad.top - pad.bottom)} y2={pad.top + fraction * (height - pad.top - pad.bottom)} stroke="rgb(var(--s-200))" strokeDasharray="4 4" />)}
      {area && <path d={area} fill={`url(#${gradient})`} />}
      {line && <path className="rm-chart-glow" d={line} fill="none" stroke="rgb(var(--b-400))" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
      {coords.map((point, index) => <circle key={points[index].label} cx={point.x} cy={point.y} r="4" fill="var(--panel)" stroke="rgb(var(--b-400))" strokeWidth="2"><title>{`${points[index].label}: ${format(points[index].value)}`}</title></circle>)}
    </svg>
    <figcaption className="mt-1 flex justify-between gap-1 text-[10px] uppercase tracking-wide text-slate-500">{points.map(point => <span key={point.label} className="min-w-0 flex-1 truncate text-center">{point.label}</span>)}</figcaption>
  </figure>;
}

export function DonutChart({ slices, format, centerLabel }: { slices: { label: string; value: number }[]; format: (value: number) => string; centerLabel: string }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const radius = 42; const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return <div className="flex flex-wrap items-center gap-6">
    <svg viewBox="0 0 120 120" role="img" aria-label={centerLabel} className="h-36 w-36 shrink-0 -rotate-90">
      <circle cx="60" cy="60" r={radius} fill="none" stroke="rgb(var(--s-100))" strokeWidth="16" />
      {total > 0 && slices.map((slice, index) => {
        const length = (slice.value / total) * circumference;
        const segment = <circle className="rm-chart-glow" key={slice.label} cx="60" cy="60" r={radius} fill="none" stroke={chartPalette[index % chartPalette.length]} strokeWidth="16" strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-offset}><title>{`${slice.label}: ${format(slice.value)}`}</title></circle>;
        offset += length;
        return segment;
      })}
    </svg>
    <ul className="min-w-0 flex-1 space-y-2 text-sm">
      {slices.map((slice, index) => <li key={slice.label} className="flex items-center gap-2">
        <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full border border-black/10" style={{ background: chartPalette[index % chartPalette.length] }} />
        <span className="min-w-0 flex-1 truncate">{slice.label}</span>
        <span className="font-semibold">{total > 0 ? `${Math.round((slice.value / total) * 100)}%` : '—'}</span>
        <span className="hidden text-xs text-slate-500 sm:inline">{format(slice.value)}</span>
      </li>)}
    </ul>
  </div>;
}
