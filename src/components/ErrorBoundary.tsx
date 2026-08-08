import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /**
   * A change here is a new attempt: the fallback is dropped and the subtree
   * renders again. Without it the first bad profile latches the fallback for
   * as long as the view is mounted — including the query bar and time range
   * picker the fallback tells the user to change, which live inside it.
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
            Something went wrong rendering this view. Try a different query or
            time range.
          </div>
        )
      );
    }
    return this.props.children;
  }
}
