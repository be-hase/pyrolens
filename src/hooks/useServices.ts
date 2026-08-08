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
}): { services: Service[]; servicesLoading: boolean; error: string | null } {
  const { start, end } = range;
  const { data, fetching, fetchError } = useFetched(
    [] as Service[],
    enabled,
    (signal) => fetchServices(start, end, signal),
    [start, end, tenantID],
  );

  return {
    services: data,
    servicesLoading: enabled && fetching,
    error: enabled ? fetchError : null,
  };
}
