import { render, screen } from '@testing-library/react';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { MultiTimeSeries } from './MultiTimeSeries.tsx';

const PROFILE_TYPE = 'process_cpu:cpu:nanoseconds:cpu:nanoseconds';

const ONE_SERIES = [
  {
    label: 'web',
    points: [
      { timestamp: 1_700_000_000_000, value: 1 },
      { timestamp: 1_700_000_050_000, value: 5 },
    ],
  },
];

describe('MultiTimeSeries loading placeholder', () => {
  it('shows the loading indicator instead of the chart while loading with no series yet', () => {
    render(
      <MultiTimeSeries
        series={[]}
        profileTypeId={PROFILE_TYPE}
        startMs={1_700_000_000_000}
        endMs={1_700_000_100_000}
        loading
      />,
    );
    assert.ok(
      screen.getByText('Loading…'),
      'expected the Loading placeholder while loading with no series yet',
    );
  });

  it('keeps rendering the chart, not the loading indicator, when series are already present', () => {
    const { container } = render(
      <MultiTimeSeries
        series={ONE_SERIES}
        profileTypeId={PROFILE_TYPE}
        startMs={1_700_000_000_000}
        endMs={1_700_000_100_000}
        loading
      />,
    );
    assert.ok(
      container.querySelector('.timeseries-svg'),
      'the chart must keep rendering over existing series even while a refresh is in flight',
    );
    assert.ok(
      !screen.queryByText('Loading…'),
      'the loading placeholder must not replace a chart that already has series',
    );
  });
});

describe('MultiTimeSeries reload dim', () => {
  it('dims the chart container while a fetch is in flight over series already on screen', () => {
    const { container } = render(
      <MultiTimeSeries
        series={ONE_SERIES}
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
      'expected the chart container to carry the reload-dim active class while loading over existing series',
    );
  });

  it('does not dim the chart container once the fetch has settled', () => {
    const { container } = render(
      <MultiTimeSeries
        series={ONE_SERIES}
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
});
