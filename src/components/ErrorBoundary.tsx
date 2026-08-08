import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /**
   * A change here is a new attempt: the fallback is dropped and the subtree
   * renders again. Without it the first bad profile latched the fallback for
   * as long as the view stayed mounted.
   *
   * Note what this can and cannot reach. The controls that write URL params
   * are rendered *inside* the boundary, so they are gone the moment the
   * fallback replaces the subtree — the recovery path is Back/Forward (which
   * moves the params from outside the tree) or another view, not editing the
   * query. The fallback text says so.
   */
  resetKey?: string;
}

interface State {
  error: Error | null;
  key?: string;
}

// Catches render-time throws in a subtree (e.g. malformed profile data hitting
// the flame graph) so one broken panel doesn't blank the whole app.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    if (props.resetKey === state.key) return null;
    return { error: null, key: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="app-error">
            Something went wrong rendering this view. Go back to the previous
            query, pick another view, or reload the page.
          </div>
        )
      );
    }
    return this.props.children;
  }
}
