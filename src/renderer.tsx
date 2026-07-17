/**
 * This file is automatically loaded by Vite and runs in the "renderer" context.
 * It mounts the React application into the DOM.
 *
 * https://electronjs.org/docs/tutorial/process-model
 */

import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'next-themes';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Toaster } from './components/ui/sonner';

// A file dropped anywhere the UI doesn't handle would make Chromium navigate
// to it, unloading the app. Swallow unhandled drags at the window; drop zones
// (e.g. the chat panel) still receive their events first.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    {/*
     * Codex/FCode appearance model: `.dark` toggled on <html>, System-first.
     * next-themes writes the class our design tokens key off and follows the
     * OS `prefers-color-scheme` while the user stays on "system".
     */}
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="easyhost:theme"
    >
      <ErrorBoundary>
        <App />
        <Toaster />
      </ErrorBoundary>
    </ThemeProvider>
  </StrictMode>,
);
