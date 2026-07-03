/**
 * This file is automatically loaded by Vite and runs in the "renderer" context.
 * It mounts the React application into the DOM.
 *
 * https://electronjs.org/docs/tutorial/process-model
 */

import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
