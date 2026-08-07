import { render, screen } from '@testing-library/react';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary.tsx';

function Boom(): React.ReactNode {
  throw new Error('malformed profile');
}

beforeEach(() => {
  // React prints the caught error, and the boundary logs it on purpose.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ErrorBoundary', () => {
  it('renders its children while nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>the flame graph</p>
      </ErrorBoundary>,
    );
    assert.ok(screen.getByText('the flame graph'));
  });

  it('replaces a throwing subtree with an explanation', () => {
    // One panel with bad data must not blank the whole app.
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    assert.match(document.body.textContent ?? '', /Something went wrong/);
    assert.match(document.body.textContent ?? '', /different query or time/);
  });

  it('uses the fallback it was given', () => {
    render(
      <ErrorBoundary fallback={<p>no profile here</p>}>
        <Boom />
      </ErrorBoundary>,
    );
    assert.ok(screen.getByText('no profile here'));
  });

  it('logs the failure for whoever has to debug it', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    const logged = vi
      .mocked(console.error)
      .mock.calls.flat()
      .map(String)
      .join(' ');
    assert.match(logged, /malformed profile/);
  });
});
