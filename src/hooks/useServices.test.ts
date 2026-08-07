import { act, renderHook, waitFor } from '@testing-library/react';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';
import { fetchServices, type Service } from '@api/client';
import { useServices } from './useServices.ts';

vi.mock('@api/client', () => ({ fetchServices: vi.fn() }));

const servicesOf = vi.mocked(fetchServices);

const RANGE = { start: 1_000, end: 2_000 };
const WEB: Service = { name: 'web', profileTypes: ['a:cpu:c:d:e'] };
const API: Service = { name: 'api', profileTypes: ['a:cpu:c:d:e'] };

function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

beforeEach(() => servicesOf.mockResolvedValue([WEB]));

describe('useServices', () => {
  it('loads the services for the range', async () => {
    const { result } = renderHook(() => useServices({ range: RANGE }));
    assert.equal(result.current.servicesLoading, true);
    await waitFor(() => assert.equal(result.current.servicesLoading, false));
    assert.deepEqual(result.current.services, [WEB]);
    assert.deepEqual(servicesOf.mock.calls[0], [RANGE.start, RANGE.end]);
  });

  // Rejections are always queued with a *Once variant: replacing a mock's
  // standing implementation with a rejecting one makes vitest 4 report the
  // rejection as unhandled even where the caller catches it.
  it('surfaces a failure', async () => {
    servicesOf.mockRejectedValueOnce(new Error('service list unavailable'));
    const { result } = renderHook(() => useServices({ range: RANGE }));
    await waitFor(() =>
      assert.equal(result.current.error, 'service list unavailable'),
    );
    assert.equal(result.current.servicesLoading, false);
  });

  it('clears a previous error once a load succeeds', async () => {
    servicesOf.mockRejectedValueOnce(new Error('down'));
    servicesOf.mockResolvedValueOnce([WEB]);
    const { result, rerender } = renderHook(
      ({ tenantID }) => useServices({ range: RANGE, tenantID }),
      { initialProps: { tenantID: 'team-a' } },
    );
    await waitFor(() => assert.equal(result.current.error, 'down'));
    rerender({ tenantID: 'team-b' });
    await waitFor(() => assert.equal(result.current.error, null));
    assert.deepEqual(result.current.services, [WEB]);
  });

  it('does not fetch while disabled', () => {
    renderHook(() => useServices({ range: RANGE, enabled: false }));
    assert.equal(servicesOf.mock.calls.length, 0);
  });

  it('reloads when the range or the tenant changes', async () => {
    const { rerender } = renderHook(
      ({ range, tenantID }) => useServices({ range, tenantID }),
      { initialProps: { range: RANGE, tenantID: 'team-a' } },
    );
    await waitFor(() => assert.equal(servicesOf.mock.calls.length, 1));
    rerender({ range: { start: 5_000, end: 6_000 }, tenantID: 'team-a' });
    await waitFor(() => assert.equal(servicesOf.mock.calls.length, 2));
    rerender({ range: { start: 5_000, end: 6_000 }, tenantID: 'team-b' });
    await waitFor(() => assert.equal(servicesOf.mock.calls.length, 3));
  });

  it('ignores a superseded response that lands late', async () => {
    const first = deferred<Service[]>();
    servicesOf.mockReturnValueOnce(first.promise);
    servicesOf.mockResolvedValueOnce([API]);

    const { result, rerender } = renderHook(
      ({ tenantID }) => useServices({ range: RANGE, tenantID }),
      { initialProps: { tenantID: 'team-a' } },
    );
    await waitFor(() => assert.equal(servicesOf.mock.calls.length, 1));
    rerender({ tenantID: 'team-b' });
    await waitFor(() => assert.deepEqual(result.current.services, [API]));

    await act(async () => {
      first.settle([WEB]);
      await first.promise;
    });
    assert.deepEqual(result.current.services, [API]);
  });

  it('ignores a response that lands after unmount', async () => {
    const pending = deferred<Service[]>();
    servicesOf.mockReturnValue(pending.promise);
    const { unmount } = renderHook(() => useServices({ range: RANGE }));
    await waitFor(() => assert.equal(servicesOf.mock.calls.length, 1));
    unmount();
    // Setting state here would warn and, with a slow list, leak the tenant
    // that was current when the request went out.
    await act(async () => {
      pending.settle([WEB]);
      await pending.promise;
    });
  });
});
