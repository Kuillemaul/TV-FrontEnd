import { useId } from 'react';

/** Hearth's logo: a fire on a TV screen. Same drawing as web/public/logo.svg and the boot splash. */
export function Logo({ size = '2.4rem', className }: { size?: string; className?: string }) {
  // Gradient ids must be unique per copy on the page.
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <linearGradient id={`${id}f`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="100">
          <stop offset="0" stopColor="#7b8cff" />
          <stop offset="1" stopColor="#b48cff" />
        </linearGradient>
        <linearGradient id={`${id}h`} gradientUnits="userSpaceOnUse" x1="0" y1="90" x2="0" y2="8">
          <stop offset="0" stopColor="#ff6a3d" />
          <stop offset=".6" stopColor="#ff9f43" />
          <stop offset="1" stopColor="#ffc861" />
        </linearGradient>
      </defs>
      <rect x="8" y="12" width="84" height="62" rx="14" fill="none" stroke={`url(#${id}f)`} strokeWidth="8" />
      <path d="M34 88h32" stroke={`url(#${id}f)`} strokeWidth="8" strokeLinecap="round" />
      <g transform="translate(30 24) scale(.4)">
        <path fill={`url(#${id}h)`} d="M53 8C61 24 78 36 78 58 78 76 66 90 50 90 34 90 22 78 22 60 22 50 27 42 33 36 33 46 37 52 42 55 40 40 45 22 53 8Z" />
        <path fill="#ffe3a3" d="M51 48C57 57 64 63 64 72 64 80 58 86 50 86 42 86 36 80 36 73 36 66 41 61 45 56 46 61 48 63 50 64 49 59 49 53 51 48Z" />
      </g>
    </svg>
  );
}
