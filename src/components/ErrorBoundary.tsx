import { Component, type ReactNode } from 'react';
import { storageRemove } from '../lib/storage';

/** Keeps one broken view (bad data, storage, API shape change) from blanking the whole app. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card p-5 mt-6 text-sm" role="alert">
        <div className="font-semibold">This view failed to render.</div>
        <div className="text-ink-2 mt-1">{this.state.error.message}</div>
        <div className="flex gap-2 mt-3">
          <button type="button" className="chip" onClick={() => this.setState({ error: null })}>Try again</button>
          <button
            type="button"
            className="chip"
            onClick={() => {
              storageRemove('pw-trips');
              try {
                indexedDB.deleteDatabase('powderwatch');
              } catch {
                /* storage blocked: nothing was cached */
              }
              window.location.reload();
            }}
          >
            Clear saved trips and cache
          </button>
        </div>
      </div>
    );
  }
}
