import { render, screen } from '@testing-library/react';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { LoadingMeta } from './LoadingMeta.tsx';

describe('LoadingMeta', () => {
  it('shows the "Loading…" text', () => {
    render(<LoadingMeta />);
    assert.ok(screen.getByText('Loading…'));
  });

  it('renders a spinning icon alongside the text, sharing Loading’s spin idiom', () => {
    // Same `loading-spin` class Loading (Loading.tsx) uses — not a
    // duplicated animation — so the two read as one idiom at two sizes and
    // both respect the same prefers-reduced-motion rule (Loading.css).
    const { container } = render(<LoadingMeta />);
    assert.ok(
      container.querySelector('.loading-spin'),
      'expected a spinning icon next to the text',
    );
  });
});
