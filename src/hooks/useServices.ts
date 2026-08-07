import { useEffect, useState } from 'react';
import { fetchServices, type Service } from '@api/client';
import type { TimeRange } from '../time';

export function useServices({
  range,
  tenantID,
  enabled = true,
}: {
  range: TimeRange;
  tenantID?: string;
  enabled?: boolean;
}): { services: Service[]; servicesLoading: boolean; error: string | null } {
  const [services, setServices] = useState<Service[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { start, end } = range;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function load() {
      setServicesLoading(true);
      try {
        const s = await fetchServices(start, end);
        if (cancelled) return;
        setServices(s);
        setError(null);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setServicesLoading(false);
      }
    }
    load();

    return () => {
      cancelled = true;
    };
  }, [enabled, start, end, tenantID]);

  return { services, servicesLoading, error };
}
