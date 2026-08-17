import { fetchServices, type Service } from '@api/client';
import type { TimeRange } from '../time';
import { useFetched } from './useFetched';

export function useServices({
  range,
  tenantID,
  enabled = true,
}: {
  range: TimeRange;
  tenantID?: string;
  enabled?: boolean;
}): {
  services: Service[];
  servicesLoading: boolean;
  /**
   * True once the services fetch has completed at least once (success or
   * error) since mount — see useFetched's header. Views use this, not
   * `servicesLoading`, to gate a startup-only placeholder: `servicesLoading`
   * pulses true again on every relative-range auto-refresh tick, and a gate
   * built on it would flip an already-settled, honestly empty conclusion
   * (a zero-services tenant, an explicitly cleared query) back into a
   * spinner on every one of those ticks.
   */
  servicesSettled: boolean;
  error: string | null;
} {
  const { start, end } = range;
  const { data, fetching, fetchError, settled } = useFetched(
    [] as Service[],
    enabled,
    (signal) => fetchServices(start, end, signal),
    [start, end, tenantID],
  );

  return {
    services: data,
    servicesLoading: enabled && fetching,
    servicesSettled: settled,
    error: enabled ? fetchError : null,
  };
}
