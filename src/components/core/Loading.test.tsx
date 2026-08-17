import { render, screen } from '@testing-library/react';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { Loading } from './Loading.tsx';

describe('Loading', () => {
  it('exposes an implicit polite live region (role="status") so its message is announced', () => {
    // FINDING 4: this component mounts and unmounts conditionally wherever
    // it's used (a fetch starting/settling), so without live-region
    // semantics a screen reader gets no announcement for any of those
    // transitions. `role="status"` (polite), not `role="alert"`
    // (assertive) — a loading state is routine and expected, unlike
    // ErrorBanner's failure (see its comment in ComparisonPane.tsx).
    render(<Loading />);
    assert.ok(screen.getByRole('status'));
  });

  it('still shows the caller-provided message inside the live region', () => {
    render(<Loading message="Loading services…" />);
    const status = screen.getByRole('status');
    assert.match(status.textContent ?? '', /Loading services…/);
  });
});
