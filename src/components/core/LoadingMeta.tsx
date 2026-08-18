import { Icon } from './Icon';
import './Loading.css';
import './LoadingMeta.css';

// The small "Loading…" a panel's meta slot shows while its own fetch is in
// flight. Panel's header-right slot has no room for the full Loading
// placeholder (that one lives in the body, swapped in only when there's
// nothing to show yet, and only during a user-caused reload — see
// urlState.ts's `useTickNavigation` doctrine); the meta keeps firing on
// every reload, ticks included, since it's the one indicator that must
// survive a tick. A bare string there used to be easy to miss on a busy
// screen, so this pairs it with a small spinning icon — sharing the same
// `loading-spin` class (and its prefers-reduced-motion handling) that
// Loading's own, larger icon uses, rather than a second animation
// definition. Stays dumb like Loading/Empty: no logic, callers decide when
// to render it.
export function LoadingMeta() {
  return (
    <span className="loading-meta">
      <Icon name="refresh" size={12} className="loading-spin" />
      Loading…
    </span>
  );
}
