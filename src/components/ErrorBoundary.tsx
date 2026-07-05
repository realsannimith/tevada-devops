/**
 * Last-resort error boundary. Without one, any uncaught render error unmounts
 * the entire React tree and the window goes blank ("white screen") with the only
 * clue buried in devtools. This catches the error and shows what happened plus a
 * reload button, so the app never dies silently.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

type State = { error: Error | null };

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] render error:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background p-8 text-foreground">
        <div className="w-full max-w-md space-y-4">
          <div>
            <h1 className="text-sm font-semibold tracking-[-0.015em] text-ink">
              Something went wrong
            </h1>
            <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
              The app hit an unexpected error while rendering. Reloading usually
              fixes it — your servers, chat history and settings are safe.
            </p>
          </div>
          <pre className="max-h-48 overflow-auto rounded-md border border-border bg-secondary p-3 font-mono text-[11px] whitespace-pre-wrap text-destructive">
            {error.message || String(error)}
          </pre>
          <Button
            variant="prominent"
            className="rounded-full"
            onClick={() => window.location.reload()}
          >
            Reload app
          </Button>
        </div>
      </div>
    );
  }
}
