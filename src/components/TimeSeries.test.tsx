import { act, fireEvent, render, screen } from '@testing-library/react';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';
import { TimeSeries } from './TimeSeries.tsx';

// jsdom has no ResizeObserver (see AGENTS.md's "Verifying a change");
// TimeSeries uses it to size the canvas backing store off the chart
// container's width. Unlike the SingleView smoke test's no-op stub, the
// drag math below (`xToTime`) actually divides by that width, so these
// tests need a real, caller-controlled value rather than 0.
let stubbedWidth = 100;
// The real observer re-fires on every resize; the component's effect only
// ever constructs one, so stashing its callback lets a test simulate a
// resize (a sidebar opening, a window drag) after mount.
let lastResizeCallback:
  ((entries: { contentRect: { width: number } }[]) => void) | null = null;
class StubResizeObserver {
  #cb: (entries: { contentRect: { width: number } }[]) => void;
  constructor(cb: (entries: { contentRect: { width: number } }[]) => void) {
    this.#cb = cb;
    lastResizeCallback = cb;
  }
  observe() {
    this.#cb([{ contentRect: { width: stubbedWidth } }]);
  }
  unobserve() {}
  disconnect() {}
}

// Simulates the ResizeObserver firing again after mount with a new width.
function triggerResize(width: number) {
  stubbedWidth = width;
  act(() => {
    lastResizeCallback?.([{ contentRect: { width } }]);
  });
}

// jsdom's canvas has no layout box (getBoundingClientRect is always
// zero-sized), which `localX` divides pixel offsets by; stub it to a fixed
// width matching the ResizeObserver stub above.
function stubCanvasGeometry(canvas: HTMLCanvasElement, width: number) {
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      width,
      height: 100,
      left: 0,
      top: 0,
      right: width,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON() {},
    }),
  });
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  // jsdom's canvas has no setPointerCapture/releasePointerCapture at all;
  // the drag handlers call the former on pointerdown.
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

const PROFILE_TYPE = 'process_cpu:cpu:nanoseconds:cpu:nanoseconds';

function renderChart(props: {
  timeRange?: string;
  startMs: number;
  endMs: number;
}) {
  const onRangeSelect = vi.fn();
  const { container, rerender } = render(
    <TimeSeries
      data={[]}
      timeRange={props.timeRange ?? 'now-1h'}
      profileTypeId={PROFILE_TYPE}
      startMs={props.startMs}
      endMs={props.endMs}
      onRangeSelect={onRangeSelect}
    />,
  );
  const canvas = container.querySelector('canvas');
  assert.ok(canvas, 'canvas did not render');
  stubCanvasGeometry(canvas, stubbedWidth);
  return { onRangeSelect, canvas, rerender };
}

describe('TimeSeries drag-to-select', () => {
  it('does not select a range when both drag endpoints round to the same millisecond', () => {
    // A 1ms-wide window (three brush-zooms deep) with a 100px-wide chart:
    // every pixel maps to a fraction of a millisecond, so a 10px drag — well
    // past the 4px click-filter — still rounds both ends to millisecond 0.
    // Firing onRangeSelect here would send from === until.
    stubbedWidth = 100;
    const { onRangeSelect, canvas } = renderChart({ startMs: 0, endMs: 1 });

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 10 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 10 });

    assert.equal(
      onRangeSelect.mock.calls.length,
      0,
      'onRangeSelect must not fire for a degenerate (fromMs === untilMs) range',
    );
  });

  it('drops an in-progress drag when the resolved window moves under an unchanged timeRange string', () => {
    // A relative range's raw `timeRange` string ("now-1h") stays
    // byte-identical across an auto-refresh tick; only the resolved
    // startMs/endMs move. If the drag survives that, pointer-up converts the
    // old pixel coordinates through the new window and reports a selection
    // the user never dragged.
    stubbedWidth = 100;
    const { onRangeSelect, canvas, rerender } = renderChart({
      timeRange: 'now-1h',
      startMs: 1_700_000_000_000,
      endMs: 1_700_000_100_000, // 100s window at 100px => 1s/px
    });

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 50 });

    // Same timeRange string, but the resolved window advanced (an
    // auto-refresh tick) while the drag was in flight.
    rerender(
      <TimeSeries
        data={[]}
        timeRange="now-1h"
        profileTypeId={PROFILE_TYPE}
        startMs={1_700_000_060_000}
        endMs={1_700_000_160_000}
        onRangeSelect={onRangeSelect}
      />,
    );

    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 50 });

    assert.equal(
      onRangeSelect.mock.calls.length,
      0,
      'onRangeSelect must not fire from pixels dragged against a window that has since moved',
    );
  });

  it('drops an in-progress drag when the observed chart width changes', () => {
    // Same reasoning as the window-move case above: pointer-up converts the
    // drag's stored pixels through `pxToMs`, which divides by `width`. A
    // chart that shrinks mid-drag (a sidebar opening, a pane resize) changes
    // that mapping just as much as the time window moving does.
    stubbedWidth = 100;
    const { onRangeSelect, canvas } = renderChart({
      timeRange: 'now-1h',
      startMs: 1_700_000_000_000,
      endMs: 1_700_000_100_000,
    });

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 60 });

    triggerResize(50);

    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 60 });

    assert.equal(
      onRangeSelect.mock.calls.length,
      0,
      'onRangeSelect must not fire from pixels dragged against a width that has since changed',
    );
  });
});

describe('TimeSeries loading placeholder', () => {
  it('shows the loading indicator instead of a canvas while loading with no data yet', () => {
    stubbedWidth = 100;
    const { container } = render(
      <TimeSeries
        data={[]}
        timeRange="now-1h"
        profileTypeId={PROFILE_TYPE}
        startMs={1_700_000_000_000}
        endMs={1_700_000_100_000}
        loading
      />,
    );
    assert.ok(
      screen.getByText('Loading…'),
      'expected the Loading placeholder while loading with no data',
    );
    assert.ok(
      !container.querySelector('canvas'),
      'no canvas should be drawn while the loading placeholder is shown',
    );
  });

  it('keeps rendering the chart, not the loading indicator, when data is already present', () => {
    stubbedWidth = 100;
    const { container } = render(
      <TimeSeries
        data={[{ timestamp: 1_700_000_050_000, value: 5 }]}
        timeRange="now-1h"
        profileTypeId={PROFILE_TYPE}
        startMs={1_700_000_000_000}
        endMs={1_700_000_100_000}
        loading
      />,
    );
    assert.ok(
      container.querySelector('canvas'),
      'the chart must keep rendering over existing data even while a refresh is in flight',
    );
    assert.ok(
      !screen.queryByText('Loading…'),
      'the loading placeholder must not replace a chart that already has data',
    );
  });
});

describe('TimeSeries reload dim', () => {
  it('dims the chart container while a fetch is in flight over data already on screen', () => {
    stubbedWidth = 100;
    const { container } = render(
      <TimeSeries
        data={[{ timestamp: 1_700_000_050_000, value: 5 }]}
        timeRange="now-1h"
        profileTypeId={PROFILE_TYPE}
        startMs={1_700_000_000_000}
        endMs={1_700_000_100_000}
        loading
      />,
    );
    const chart = container.querySelector('.timeseries-chart');
    assert.ok(chart, 'expected the chart container to render');
    assert.ok(
      chart.classList.contains('reload-dim') &&
        chart.classList.contains('active'),
      'expected the chart container to carry the reload-dim active class while loading over existing data',
    );
  });

  it('does not dim the chart container once the fetch has settled', () => {
    stubbedWidth = 100;
    const { container } = render(
      <TimeSeries
        data={[{ timestamp: 1_700_000_050_000, value: 5 }]}
        timeRange="now-1h"
        profileTypeId={PROFILE_TYPE}
        startMs={1_700_000_000_000}
        endMs={1_700_000_100_000}
        loading={false}
      />,
    );
    const chart = container.querySelector('.timeseries-chart');
    assert.ok(chart, 'expected the chart container to render');
    assert.ok(
      !chart.classList.contains('active'),
      'the chart container must not carry the active dim class once loading is false',
    );
  });

  it('does not dim the loading placeholder itself (loading with no data yet)', () => {
    stubbedWidth = 100;
    const { container } = render(
      <TimeSeries
        data={[]}
        timeRange="now-1h"
        profileTypeId={PROFILE_TYPE}
        startMs={1_700_000_000_000}
        endMs={1_700_000_100_000}
        loading
      />,
    );
    const chart = container.querySelector('.timeseries-chart');
    assert.ok(chart, 'expected the chart container to render');
    assert.ok(
      !chart.classList.contains('active'),
      'the placeholder-showing container must not carry the active dim class',
    );
  });
});

describe('TimeSeries hover crosshair', () => {
  // jsdom's canvas has no real 2D context (getContext returns null without
  // installing the `canvas` package), so the component's draw effect is
  // normally a no-op in this suite. Stub just enough of the context to tell
  // whether the hover crosshair's stroke ran: gridlines draw exactly one
  // `stroke()` every pass, and with `data: []` the crosshair's own
  // `stroke()` is the only thing that can add a second — the nearest-point
  // marker and readout box are behind `data.length > 0` and never reached.
  function stubCanvasContext() {
    const strokeCalls: true[] = [];
    const ctx = {
      setTransform: () => {},
      clearRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => strokeCalls.push(true),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
    return strokeCalls;
  }

  it('keeps the hover crosshair when the resolved window moves under an unchanged timeRange string', () => {
    stubbedWidth = 100;
    const strokeCalls = stubCanvasContext();
    const { canvas, rerender } = renderChart({
      timeRange: 'now-1h',
      startMs: 1_700_000_000_000,
      endMs: 1_700_000_100_000,
    });

    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 50 });
    assert.ok(
      strokeCalls.length > 1,
      'expected the hover crosshair to add a stroke beyond the gridlines',
    );

    strokeCalls.length = 0;
    // Same timeRange string, but the resolved window advanced (an
    // auto-refresh tick) while the pointer sits still reading a value.
    rerender(
      <TimeSeries
        data={[]}
        timeRange="now-1h"
        profileTypeId={PROFILE_TYPE}
        startMs={1_700_000_060_000}
        endMs={1_700_000_160_000}
        onRangeSelect={vi.fn()}
      />,
    );

    assert.ok(
      strokeCalls.length > 1,
      'hover crosshair must survive resolved bounds moving under an unchanged timeRange string',
    );
  });
});
