import { useId } from 'react';

// RM Restaurant brand mark: gold chef hat over the "RM" monogram. `full` adds the RESTAURANT wordmark (uses currentColor).
export function RmLogo({ variant = 'full', className = '' }: { variant?: 'full' | 'mark'; className?: string }) {
  const id = useId();
  const full = variant === 'full';
  return <svg viewBox={full ? '0 0 120 104' : '14 4 92 80'} role="img" aria-label="RM Restaurant" className={className}>
    <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#f3dd9b" /><stop offset="55%" stopColor="#d4a935" /><stop offset="100%" stopColor="#8f6a17" /></linearGradient></defs>
    <g fill="none" stroke={`url(#${id})`} strokeWidth="3.5" strokeLinejoin="round">
      <path d="M40 38c-9 1-15-6-13-14 2-7 10-10 16-7 2-8 12-12 19-8 5 3 7 8 6 12 8-3 16 2 16 10 0 7-6 11-13 10" />
      <path d="M40 38h40v9a3 3 0 0 1-3 3H43a3 3 0 0 1-3-3z" />
    </g>
    <text x="60" y="80" textAnchor="middle" fontFamily="Georgia, 'Times New Roman', serif" fontWeight="700" fontSize="44" fill={`url(#${id})`}>RM</text>
    {full && <text x="60" y="98" textAnchor="middle" fontFamily="Arial, sans-serif" fontWeight="700" fontSize="11" letterSpacing="3" fill="currentColor">RESTAURANT</text>}
  </svg>;
}
