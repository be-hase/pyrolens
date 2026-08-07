// Categorical palette for multi-series charts. Values resolve to the
// light/dark steps defined in theme.css; assign slots in fixed order and
// never cycle past the eighth series — fold extras into "Other" instead.
export const SERIES_COLORS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
];
