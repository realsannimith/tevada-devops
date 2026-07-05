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
      </ErrorBoundary>
    </ThemeProvider>
  </StrictMode>,
);
