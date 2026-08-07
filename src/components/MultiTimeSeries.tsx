import { useMemo, useRef, useState } from 'react';
import { Empty } from '@components/core/Empty';
import { profileTypeUnit } from '@api/client';
import {
  toDisplayValue,
  niceMax,
  yAxisFormatter,
  tickStepMs,
  formatTickTime,
} from './timeseries-utils';
import { SERIES_COLORS } from './seriesColors';
import './TimeSeries.css';
import './MultiTimeSeries.css';

export interface NamedSeries {
  label: string;
  points: { value: number; timestamp: number }[];
}

// One line per label value (Tag Explorer breakdown). Series identity is
// color + the legend below; the companion table repeats every value, so
// low-contrast light-mode hues stay readable ("relief" rule).
export function MultiTimeSeries({
  series,
  profileTypeId,
  startMs,
  endMs,
}: {
  series: NamedSeries[];
  profileTypeId: string;
  startMs: number;
  endMs: number;
}) {
  const W = 800;
  const H = 140;
  const durationMs = endMs - startMs;

  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverFrac, setHoverFrac] = useState<number | null>(null);

  const max = useMemo(
    () => Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.value))),
    [series],
  );

  if (series.length === 0 || durationMs <= 0) return <Empty />;

  const unit = profileTypeUnit(profileTypeId);
  // One shared scale for lines AND axis labels, in display units, so a peak
  // drawn at a gridline reads as that gridline's value.
  const displayMax = niceMax(toDisplayValue(max, unit));
  const x = (ts: number) => ((ts - startMs) / durationMs) * W;
  const y = (v: number) =>
    H - 4 - (toDisplayValue(v, unit) / displayMax) * (H - 14);

  const paths = series.map((s) =>
    s.points.length
      ? `M ${x(s.points[0].timestamp).toFixed(1)},${y(s.points[0].value).toFixed(1)} ` +
        s.points
          .slice(1)
          .map((p) => `L ${x(p.timestamp).toFixed(1)},${y(p.value).toFixed(1)}`)
          .join(' ')
      : '',
  );

  const stepMs = tickStepMs(durationMs);
  const ticks: { x: number; label: string }[] = [];
  const firstTick = Math.ceil(startMs / stepMs) * stepMs;
  for (let ts = firstTick; ts <= endMs; ts += stepMs) {
    ticks.push({ x: x(ts), label: formatTickTime(ts, stepMs) });
  }

  const fmt = yAxisFormatter(displayMax);
  const yTicks = [0, 0.5, 1].map((v) => ({
    y: H - 4 - v * (H - 14),
    label: fmt(v * displayMax),
  }));

  // Values at the hovered timestamp, ranked descending, for the tooltip.
  const hover = (() => {
    if (hoverFrac == null) return null;
    const cursorTs = startMs + hoverFrac * durationMs;
    // Snap to the sample timestamp nearest the cursor across all series,
    // then read every series at that same instant, so the tooltip header
    // and its rows agree even when series have gaps.
    let ts: number | null = null;
    for (const s of series) {
      for (const p of s.points) {
        if (
          ts === null ||
          Math.abs(p.timestamp - cursorTs) < Math.abs(ts - cursorTs)
        ) {
          ts = p.timestamp;
        }
      }
    }
    if (ts === null) return null;
    const at = ts;
    const rows = series
      .map((s, i) => {
        const pt = s.points.find((p) => p.timestamp === at);
        return pt
          ? { label: s.label, value: pt.value, color: SERIES_COLORS[i] }
          : null;
      })
      .filter((r) => r !== null)
      .sort((a, b) => b.value - a.value);
    return { ts: at, rows };
  })();

  return (
    <div className="multi-timeseries">
      <div className="timeseries">
        <div className="timeseries-y-axis">
          {yTicks.map(({ y: top, label }) => (
            <span key={label} className="timeseries-y-label" style={{ top }}>
              {label}
            </span>
          ))}
        </div>
        <div className="timeseries-chart">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            width="100%"
            height={H}
            className="timeseries-svg"
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setHoverFrac(
                Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
              );
            }}
            onMouseLeave={() => setHoverFrac(null)}
          >
            {yTicks.map(({ y: ty }) => (
              <line
                key={ty}
                x1={0}
                y1={ty.toFixed(1)}
                x2={W}
                y2={ty.toFixed(1)}
                stroke="var(--border-medium)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {ticks.map(({ x: tx }) => (
              <line
                key={tx}
                x1={tx.toFixed(1)}
                y1={0}
                x2={tx.toFixed(1)}
                y2={H}
                stroke="var(--border-medium)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {paths.map((d, i) =>
              d ? (
                <path
                  key={series[i].label}
                  d={d}
                  fill="none"
                  stroke={SERIES_COLORS[i]}
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null,
            )}
            {hover && (
              <line
                x1={x(hover.ts)}
                y1={0}
                x2={x(hover.ts)}
                y2={H}
                stroke="var(--border-strong)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: 'none' }}
              />
            )}
          </svg>
          <div className="timeseries-x-axis">
            {ticks.map(({ x: tx, label }) => (
              <span
                key={tx}
                className="timeseries-x-label"
                style={{
                  left: `${(tx / W) * 100}%`,
                  transform:
                    tx <= 0
                      ? 'none'
                      : tx >= W
                        ? 'translateX(-100%)'
                        : 'translateX(-50%)',
                }}
              >
                {label}
              </span>
            ))}
          </div>
          {hover && hover.rows.length > 0 && (
            <div
              className="multi-timeseries-tooltip"
              style={{
                left: `${Math.min(78, (x(hover.ts) / W) * 100)}%`,
              }}
            >
              <div className="multi-timeseries-tooltip-time">
                {(() => {
                  const d = new Date(hover.ts);
                  const p2 = (n: number) => String(n).padStart(2, '0');
                  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
                })()}
              </div>
              {hover.rows.map((r) => (
                <div key={r.label} className="multi-timeseries-tooltip-row">
                  <span
                    className="multi-timeseries-chip"
                    style={{ background: r.color }}
                  />
                  <span className="multi-timeseries-tooltip-label">
                    {r.label}
                  </span>
                  <span className="multi-timeseries-tooltip-value">
                    {fmt(toDisplayValue(r.value, unit))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="multi-timeseries-legend">
        {series.map((s, i) => (
          <span key={s.label} className="multi-timeseries-legend-item">
            <span
              className="multi-timeseries-chip"
              style={{ background: SERIES_COLORS[i] }}
            />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
