/**
 * Turn the renderer's text messages + the current turn's attachments into the
 * multimodal messages the model actually receives. Images become vision input;
 * text files are inlined into the prompt so the agent can read (and deploy)
 * them. Only the LAST user message carries attachments — historical turns stay
 * text-only so we never re-send large images every request.
 */
import type { ModelMessage, UserContent } from 'ai';
import type { ChatAttachment, SteerItem } from '../shared/ipc-types';

export type TextMessage = { role: 'user' | 'assistant'; content: string };

/** Split a data URL into its base64 payload and media type. */
export function splitDataUrl(dataUrl: string): {
  base64: string;
  mediaType?: string;
} {
  const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return { base64: dataUrl };
  return { base64: m[2] ?? '', mediaType: m[1] || undefined };
}

/** Build the model `content` for a user turn: text (+ inlined text files) plus
 *  one image part per attached image. Returns a plain string when there are no
 *  usable attachments, so simple turns stay simple. */
export function buildUserContent(
  text: string,
  attachments: ChatAttachment[],
): UserContent {
  const images = attachments.filter((a) => a.kind === 'image' && a.dataUrl);
  const files = attachments.filter((a) => a.kind === 'text' && a.text);
  if (images.length === 0 && files.length === 0) return text;

  let textBlock = text;
  for (const f of files) {
    textBlock += `\n\n--- Attached file: ${f.name} ---\n${f.text}`;
  }

  const parts: UserContent = [];
  if (textBlock.trim()) parts.push({ type: 'text', text: textBlock });
  for (const img of images) {
    const { base64, mediaType } = splitDataUrl(img.dataUrl as string);
    parts.push({
      type: 'image',
      image: base64,
      mediaType: mediaType || img.mediaType,
    });
  }
  return parts;
}

/**
 * Fold pending steer messages into the running step's message list as fresh
 * user turns (each with its own multimodal content). Used by the agent's
 * prepareStep hook so a steer redirects the run at the next reasoning step.
 */
export function injectSteerMessages(
  stepMessages: ModelMessage[],
  steers: SteerItem[],
): ModelMessage[] {
  if (steers.length === 0) return stepMessages;
  const injected: ModelMessage[] = steers.map((s) => ({
    role: 'user',
    content: buildUserContent(s.text, s.attachments ?? []),
  }));
  return [...stepMessages, ...injected];
}

/**
 * Map the renderer's plain text messages to ModelMessages, folding the turn's
 * attachments into the last user message as multimodal content.
 */
export function buildModelMessages(
  messages: TextMessage[],
  attachments: ChatAttachment[] = [],
): ModelMessage[] {
  const out: ModelMessage[] = messages.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: m.content }
      : { role: 'assistant', content: m.content },
  );
  if (attachments.length === 0) return out;

  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i];
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      out[i] = { role: 'user', content: buildUserContent(text, attachments) };
      break;
    }
  }
  return out;
}
