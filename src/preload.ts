// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type AgentRunResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: string };

// Expose a minimal, safe API to the renderer. The renderer never sees the API
// key or the AI SDK — it only sends messages and receives answers over IPC.
const agentAPI = {
  run: (messages: ChatMessage[]): Promise<AgentRunResult> =>
    ipcRenderer.invoke('agent:run', messages),
  model: (): Promise<string> => ipcRenderer.invoke('agent:model'),
};

contextBridge.exposeInMainWorld('agent', agentAPI);

export type AgentAPI = typeof agentAPI;
