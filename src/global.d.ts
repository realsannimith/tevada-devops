import type { EasyHostAPI } from './preload';

declare global {
  interface Window {
    /** Bridge to the main-process server manager & DevOps agent. */
    easyhost: EasyHostAPI;
  }
}

export {};
