import { Icon } from './Icon';
import './Loading.css';

// Placeholder shown where a chart or flame graph would render while its
// fetch is still in flight. A silent panel during a slow query reads as
// broken, not busy: the panel meta's own "Loading…" text is small enough to
// miss, and the Comparison panes have no meta slot free for it at all (the
// pane title occupies that spot), so the chart area itself has to carry a
// visible signal. Mirrors Empty's layout so swapping between the two states
// doesn't jump the panel's size. Stays dumb like Empty: no logic, callers
// pick the wording.
export function Loading({ message = 'Loading…' }: { message?: string }) {
  return (
    // `role="status"` (an implicit polite live region), not `role="alert"` —
    // ErrorBanner (ComparisonPane.tsx) uses alert because a failure needs an
    // interrupting announcement; a loading state is routine and expected, so
    // it only needs to be discoverable once assistive tech gets to it, the
    // same distinction that "polite" vs "assertive" makes for any live
    // region. This component mounts and unmounts conditionally (the same
    // reason ErrorBanner's role announces at all — a node present since
    // first paint announces nothing), so every appearance is a real
    // transition worth surfacing.
    <div className="loading" role="status">
      <div className="loading-message">
        <Icon name="refresh" size={18} className="loading-spin" />
        <span>{message}</span>
      </div>
    </div>
  );
}
