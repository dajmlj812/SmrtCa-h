import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  err: Error | null;
}

/**
 * 0.19.4 — top-level React error boundary.
 *
 * Catches uncaught render-tree errors, posts a sanitized report to
 * the server's /api/errors endpoint, and renders a friendly message
 * with a Reload button so the user isn't stuck on a blank page.
 *
 * Report fields are kept small + non-sensitive (message + stack +
 * route + UA). No form values, no transaction data — we never
 * want PII leaving the user's browser via an error report.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    // Fire-and-forget — the error boundary's job is to keep the UI
    // alive, not to block on the report. If the post fails (network
    // down, sink unreachable), we still want the friendly message.
    try {
      void fetch('/api/errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          message: err.message,
          stack: err.stack,
          route: window.location.pathname,
          userAgent: navigator.userAgent,
          extra: {
            // React adds a componentStack — keep it short.
            componentStack: info.componentStack?.slice(0, 1500),
          },
        }),
      });
    } catch {
      // Swallow — the boundary mustn't itself throw.
    }
  }

  reset = (): void => {
    this.setState({ err: null });
  };

  render(): ReactNode {
    if (this.state.err === null) return this.props.children;
    return (
      <div className="error-boundary-fallback">
        <div className="card">
          <h2>Something went wrong</h2>
          <p className="muted">
            The error has been reported. You can try reloading the page or
            navigating away from this view.
          </p>
          <details className="muted small">
            <summary>Technical details</summary>
            <pre className="error-boundary-stack">{this.state.err.message}</pre>
          </details>
          <div className="modal-footer">
            <button
              type="button"
              className="btn secondary"
              onClick={this.reset}
            >
              Try again
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
