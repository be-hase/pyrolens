import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import tinycolor from 'tinycolor2';
import { profileTypeUnit, type Point } from '@api/client';
import type { TimeRange } from '../time';
import {
  axisTicks,
  formatTickTime,
  fractionToY,
  niceMax,
  PLOT_PAD_BOTTOM,
  PLOT_PAD_TOP,
  tickStepMs,
  timeToX,
  toDisplayValue,
  valueToY,
  xToTime,
  yAxisFormatter,
  type PlotBox,
} from './timeseries-utils';
import './TimeSeries.css';

// Canvas geometry in CSS pixels. Value 0 sits at PLOT_H - PAD_BOTTOM and the
// axis maximum at PAD_TOP; the y-axis labels use the same mapping.
const PLOT_H = 100;
const PAD_TOP = PLOT_PAD_TOP;
const PAD_BOTTOM = PLOT_PAD_BOTTOM;
const BOX: PlotBox = {
  height: PLOT_H,
  padTop: PAD_TOP,
  padBottom: PAD_BOTTOM,
};
const Y_FRACTIONS = [0, 0.5, 1];
const MIN_DRAG_PX = 4;

interface DragState {
  originX: number;
  currentX: number;
}

const cssColor = (
  styles: CSSStyleDeclaration,
  name: string,
  fallback: string,
) => styles.getPropertyValue(name).trim() || fallback;

const alpha = (color: string, a: number) =>
  tinycolor(color).setAlpha(a).toRgbString();

const pad2 = (n: number) => String(n).padStart(2, '0');

// Single-series timeline: accent line over a translucent fill, horizontal
// gridlines with y labels on the left, time ticks below, hover crosshair,
// and drag-to-select for zooming (or, with `selection`, a persistent
// highlighted sub-range as in the comparison panes).
export function TimeSeries({
  data,
  timeRange,
  profileTypeId,
  startMs,
  endMs,
  selection,
  onRangeSelect,
}: {
  /** Timeline points: `timestamp` unix ms, `value` in the profile's unit. */
  data: Point[];
  /** URL `from` expression; a change re-anchors the chart. */
  timeRange: string;
  profileTypeId: string;
  startMs: number;
  endMs: number;
  /** Persistent highlighted sub-range (comparison panes). */
  selection?: TimeRange;
  /** Called with unix-ms bounds after a drag selection. */
  onRangeSelect?: (startMs: number, endMs: number) => void;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [themeTick, setThemeTick] = useState(0);

  // Drop transient pointer state when the time anchor changes (render-time
  // adjustment, same pattern as the views' query-draft buffers).
  const [prevTimeRange, setPrevTimeRange] = useState(timeRange);
  if (prevTimeRange !== timeRange) {
    setPrevTimeRange(timeRange);
    setDrag(null);
    setHoverX(null);
  }

  const durationMs = Math.max(1, endMs - startMs);
  const unit = profileTypeUnit(profileTypeId);

  const displayMax = useMemo(
    () =>
      niceMax(
        data.reduce((m, p) => Math.max(m, toDisplayValue(p.value, unit)), 0),
      ),
    [data, unit],
  );
  const fmt = yAxisFormatter(displayMax);

  const stepMs = tickStepMs(durationMs);
  const ticks = useMemo(
    () => axisTicks(startMs, durationMs, stepMs),
    [startMs, durationMs, stepMs],
  );

  // Keep the canvas backing store in sync with the rendered chart width.
  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      setWidth(entries[0].contentRect.width);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Canvases don't react to CSS variables, so redraw on theme flips.
  useEffect(() => {
    const obs = new MutationObserver(() => setThemeTick((t) => t + 1));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => obs.disconnect();
  }, []);

  const selStart = selection?.start;
  const selEnd = selection?.end;

  useEffect(() => {
    void themeTick; // theme change invalidates the resolved colors below
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(PLOT_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, PLOT_H);

    const styles = getComputedStyle(canvas);
    const primary = cssColor(styles, '--color-primary', '#f97316');
    const selectColor = cssColor(styles, '--chart-selection', '#6f95d0');
    const gridColor = cssColor(
      styles,
      '--border-medium',
      'rgba(255, 255, 255, 0.12)',
    );
    const crossColor = cssColor(
      styles,
      '--border-strong',
      'rgba(255, 255, 255, 0.22)',
    );

    const x = (ts: number) => timeToX(ts, startMs, durationMs, width);
    const y = (v: number) => valueToY(v, displayMax, BOX);
    const clampX = (px: number) => Math.max(0, Math.min(width, px));

    // Gridlines.
    ctx.lineWidth = 1;
    ctx.strokeStyle = gridColor;
    ctx.beginPath();
    for (const frac of Y_FRACTIONS) {
      const gy = Math.round(fractionToY(frac, BOX)) + 0.5;
      ctx.moveTo(0, gy);
      ctx.lineTo(width, gy);
    }
    for (const ts of ticks) {
      const gx = Math.round(x(ts)) + 0.5;
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, PLOT_H);
    }
    ctx.stroke();

    // Area fill + line.
    const pts = data.map((p) => ({
      x: x(p.timestamp),
      y: y(toDisplayValue(p.value, unit)),
    }));
    if (pts.length > 1) {
      const baseline = PLOT_H - PAD_BOTTOM;
      const grad = ctx.createLinearGradient(0, PAD_TOP, 0, baseline);
      grad.addColorStop(0, alpha(primary, 0.35));
      grad.addColorStop(1, alpha(primary, 0.04));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, baseline);
      for (const p of pts) ctx.lineTo(p.x, p.y);
      ctx.lineTo(pts[pts.length - 1].x, baseline);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = primary;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.stroke();
    } else if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = primary;
      ctx.fill();
    }

    // Selection overlay: an in-progress drag wins over the persistent range.
    const sel = drag
      ? {
          a: Math.min(drag.originX, drag.currentX),
          b: Math.max(drag.originX, drag.currentX),
        }
      : selStart !== undefined && selEnd !== undefined
        ? { a: clampX(x(selStart)), b: clampX(x(selEnd)) }
        : null;
    if (sel && sel.b > sel.a) {
      ctx.fillStyle = alpha(selectColor, 0.16);
      ctx.fillRect(sel.a, 0, sel.b - sel.a, PLOT_H);
      ctx.strokeStyle = alpha(selectColor, 0.9);
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const ex of [sel.a, sel.b]) {
        ctx.moveTo(ex, 0);
        ctx.lineTo(ex, PLOT_H);
      }
      ctx.stroke();
    }

    // Hover crosshair with nearest-point marker and readout.
    if (hoverX !== null && !drag) {
      const hx = Math.round(hoverX) + 0.5;
      ctx.strokeStyle = crossColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, PLOT_H);
      ctx.stroke();

      if (data.length > 0) {
        const ts = startMs + (hoverX / width) * durationMs;
        let nearest = data[0];
        for (const p of data) {
          if (Math.abs(p.timestamp - ts) < Math.abs(nearest.timestamp - ts)) {
            nearest = p;
          }
        }
        const dv = toDisplayValue(nearest.value, unit);
        ctx.beginPath();
        ctx.arc(x(nearest.timestamp), y(dv), 3, 0, Math.PI * 2);
        ctx.fillStyle = primary;
        ctx.fill();

        const d = new Date(nearest.timestamp);
        const label = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(
          d.getSeconds(),
        )} · ${yAxisFormatter(displayMax)(dv)}`;
        ctx.font = `11px ${cssColor(styles, '--font-mono', 'monospace')}`;
        const boxW = ctx.measureText(label).width + 12;
        const boxH = 20;
        const boxX = hoverX + 8 + boxW > width ? hoverX - 8 - boxW : hoverX + 8;
        ctx.beginPath();
        ctx.roundRect(boxX, 4, boxW, boxH, 3);
        ctx.fillStyle = cssColor(styles, '--bg-elevated', '#2f2f2f');
        ctx.fill();
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = cssColor(styles, '--text-primary', '#d6d6d6');
        ctx.textBaseline = 'middle';
        ctx.fillText(label, boxX + 6, 4 + boxH / 2);
      }
    }
  }, [
    data,
    unit,
    startMs,
    durationMs,
    displayMax,
    ticks,
    width,
    hoverX,
    drag,
    selStart,
    selEnd,
    themeTick,
  ]);

  const localX = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  };

  const pxToMs = (px: number) => xToTime(px, startMs, durationMs, width);

  return (
    <div className="timeseries">
      <div className="timeseries-y-axis">
        {Y_FRACTIONS.map((frac) => (
          <span
            key={frac}
            className="timeseries-y-label"
            style={{ top: fractionToY(frac, BOX) }}
          >
            {fmt(frac * displayMax)}
          </span>
        ))}
      </div>
      <div ref={chartRef} className="timeseries-chart">
        <canvas
          ref={canvasRef}
          className="timeseries-canvas"
          onPointerDown={(e) => {
            if (e.button !== 0 || !onRangeSelect) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const px = localX(e);
            setDrag({ originX: px, currentX: px });
          }}
          onPointerMove={(e) => {
            const px = localX(e);
            setHoverX(px);
            setDrag((d) => (d ? { ...d, currentX: px } : d));
          }}
          onPointerUp={() => {
            if (!drag) return;
            setDrag(null);
            const a = Math.min(drag.originX, drag.currentX);
            const b = Math.max(drag.originX, drag.currentX);
            if (b - a >= MIN_DRAG_PX) onRangeSelect?.(pxToMs(a), pxToMs(b));
          }}
          onPointerLeave={() => setHoverX(null)}
          onPointerCancel={() => setDrag(null)}
          onLostPointerCapture={() => setDrag(null)}
        />
        <div className="timeseries-x-axis">
          {ticks.map((ts) => {
            const pct = ((ts - startMs) / durationMs) * 100;
            return (
              <span
                key={ts}
                className="timeseries-x-label"
                style={{
                  left: `${pct}%`,
                  transform:
                    pct <= 0
                      ? 'none'
                      : pct >= 100
                        ? 'translateX(-100%)'
                        : 'translateX(-50%)',
                }}
              >
                {formatTickTime(ts, stepMs)}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
