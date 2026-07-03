/**
 * Vercel AI SDK agent — runs in Electron's MAIN process (Node.js).
 *
 * Keeping the agent here (rather than in the renderer) means the API key never
 * reaches the web/renderer context, and the agent's tools can use real Node.js
 * APIs. The renderer talks to this module over IPC (see main.ts / preload.ts).
 *
 * Provider: Google Gemini via @ai-sdk/google. The API key is read from the
 * environment (loaded from .env in main.ts via `dotenv`).
 */
import os from 'node:os';
import { ToolLoopAgent, tool, stepCountIs } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';

/** A chat message as sent from the renderer. */
export type ChatMessage = { role: 'user' | 'assistant'; content: string };

// Model is configurable via env; defaults to a current, agentic Gemini model.
const MODEL_ID = process.env.AGENT_MODEL ?? 'gemini-3.1-pro';

// Accept any of the common Google key names for convenience; the AI SDK's
// Google provider natively expects GOOGLE_GENERATIVE_AI_API_KEY.
function resolveApiKey(): string | undefined {
  return (
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY
  );
}

// Build the agent lazily so a missing API key doesn't crash app startup, and so
// the key is read *after* dotenv has populated the environment. The error is
// raised only when the user actually sends a message.
let agent: ToolLoopAgent | null = null;

function getAgent(): ToolLoopAgent {
  if (agent) return agent;

  const google = createGoogleGenerativeAI({ apiKey: resolveApiKey() });

  agent = new ToolLoopAgent({
    model: google(MODEL_ID),
    system:
      'You are a helpful assistant embedded in the EASY-HOST desktop app. ' +
      'Be concise. Use the provided tools when they can answer the question.',
    // These tools execute in the main process, so they have real Node access.
    tools: {
      getCurrentTime: tool({
        description: "Get the user's current local date and time.",
        inputSchema: z.object({}),
        execute: async () => ({ now: new Date().toString() }),
      }),
      getSystemInfo: tool({
        description:
          'Get information about the machine running this desktop app.',
        inputSchema: z.object({}),
        execute: async () => ({
          platform: os.platform(),
          arch: os.arch(),
          release: os.release(),
          hostname: os.hostname(),
          cpus: os.cpus().length,
          totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
        }),
      }),
    },
    // Stop the agentic loop once it produces a final text answer (or after 10 steps).
    stopWhen: stepCountIs(10),
  });

  return agent;
}

/**
 * Run the agent over a chat history and return its final text answer.
 * Throws on failure (e.g. missing API key) — callers surface the message.
 */
export async function runAgent(
  messages: ChatMessage[],
): Promise<{ text: string; model: string }> {
  if (!resolveApiKey()) {
    throw new Error(
      'No Google API key found. Add GOOGLE_GENERATIVE_AI_API_KEY to your .env file and restart the app.',
    );
  }

  const result = await getAgent().generate({ messages });
  return { text: result.text, model: MODEL_ID };
}

export const agentModel = MODEL_ID;
