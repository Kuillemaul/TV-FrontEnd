import { useApi } from '../lib/api';

/**
 * 24-hour trend inside a stat tile: one series, so no legend; a 2px line in the accent
 * colour with a faint area, an end dot, and min/max as text (not colour) underneath.
 */
export function Sparkline({ entity, unit }: { entity: string; unit?: string }) {
  const { data } = useApi<{ points: Array<[number, number]> }>(`/api/lab/history?entity=${encodeURIComponent(entity)}&hours=24`, 5 * 60_000);
  const pts = data?.points ?? [];
  if (pts.length < 2) return <div className="spark spark-empty" />;

  const W = 200;
  const H = 44;
  const values = pts.map(([, v]) => v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const t0 = pts[0][0];
  const tSpan = pts[pts.length - 1][0] - t0 || 1;
  const xy = pts.map(([t, v]) => [((t - t0) / tSpan) * W, H - 3 - ((v - min) / span) * (H - 8)] as const);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const area = `${line}L${W},${H}L0,${H}Z`;
  const [ex, ey] = xy[xy.length - 1];
  const fmt = (v: number) => `${Math.round(v * 10) / 10}${unit === '%' ? '%' : ''}`;

  return (
    <div className="spark">
      <div className="spark-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`24 hour trend, low ${fmt(min)}, high ${fmt(max)}`}>
          <path d={area} className="spark-area" />
          <path d={line} className="spark-line" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="spark-dot" style={{ left: `${(ex / W) * 100}%`, top: `${(ey / H) * 100}%` }} />
      </div>
      <div className="spark-scale">
        <span>24 h · low {fmt(min)}</span>
        <span>high {fmt(max)}</span>
      </div>
    </div>
  );
}
