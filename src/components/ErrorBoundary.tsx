import { Component, type ErrorInfo, type ReactNode } from 'react';

// Catches render-time throws in a subtree (e.g. malformed profile data hitting
// the flame graph) so one broken panel doesn't blank the whole app.
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="app-error">
            Something went wrong rendering this view. Try a different query or
            time range.
          </div>
        )
      );
    }
    return this.props.children;
  }
}
