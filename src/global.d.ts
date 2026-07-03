import type { AgentAPI } from './preload';

declare global {
  interface Window {
    /** Bridge to the Vercel AI SDK agent running in the main process. */
    agent: AgentAPI;
  }
}

export {};
