import { useRef, useState } from 'react';
import { Button } from '@components/core/Button';
import './TenantDialog.css';

// Blocking modal shown when the Pyroscope instance is multitenant and no
// tenant is selected yet. Not dismissible: a tenant must be chosen before
// any query can be issued.
export function TenantDialog({
  initial,
  onSubmit,
}: {
  initial?: string;
  onSubmit: (tenant: string) => void;
}) {
  const [value, setValue] = useState(initial ?? '');
  const dialogRef = useRef<HTMLDivElement>(null);

  // Minimal focus trap: keep Tab cycling through the dialog's controls.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
      'input, button, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    // The dialog blocks the app, but a click on the backdrop would otherwise
    // blur the input and drop focus to <body>; from there Tab walks into the
    // NavBar behind the overlay, where every control queries without a
    // tenant. Preventing the default keeps focus where the trap can see it.
    <div className="tenant-backdrop" onMouseDown={(e) => e.preventDefault()}>
      <div
        ref={dialogRef}
        className="tenant-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Enter a Tenant ID"
        onKeyDown={trapTab}
      >
        <h2 className="tenant-dialog-title">Enter a Tenant ID</h2>
        <p className="tenant-dialog-body">
          This Pyroscope server runs with multitenancy enabled, so a tenant ID
          (sent as <code>X-Scope-OrgID</code>) is required before any profiling
          data can be queried.
        </p>
        <p className="tenant-dialog-hint">
          Data ingested before multitenancy was turned on lives under the{' '}
          <code>anonymous</code> tenant.
        </p>
        <form
          className="tenant-dialog-form"
          onSubmit={(e) => {
            e.preventDefault();
            const tenant = value.trim();
            if (tenant) onSubmit(tenant);
          }}
        >
          <input
            className="tenant-dialog-input"
            type="text"
            aria-label="Tenant ID"
            placeholder="e.g. anonymous"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          <Button type="submit">Submit</Button>
        </form>
      </div>
    </div>
  );
}
