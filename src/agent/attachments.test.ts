import { describe, expect, it } from 'vitest';
import {
  buildModelMessages,
  buildUserContent,
  injectSteerMessages,
  splitDataUrl,
} from './attachments';
import type { ChatAttachment } from '@/shared/ipc-types';

const image: ChatAttachment = {
  id: 'i1',
  name: 'error.png',
  mediaType: 'image/png',
  kind: 'image',
  size: 100,
  dataUrl: 'data:image/png;base64,AAAA',
};
const file: ChatAttachment = {
  id: 'f1',
  name: 'docker-compose.yml',
  mediaType: 'text/yaml',
  kind: 'text',
  size: 40,
  text: 'services:\n  web:\n    image: nginx',
};

describe('splitDataUrl', () => {
  it('extracts base64 and media type', () => {
    expect(splitDataUrl('data:image/png;base64,AAAA')).toEqual({
      base64: 'AAAA',
      mediaType: 'image/png',
    });
  });
  it('falls back to the raw string when not a data URL', () => {
    expect(splitDataUrl('AAAA')).toEqual({ base64: 'AAAA' });
  });
});

describe('buildUserContent', () => {
  it('returns a plain string when there are no attachments', () => {
    expect(buildUserContent('hello', [])).toBe('hello');
  });

  it('inlines text files into the text block', () => {
    const content = buildUserContent('deploy this', [file]);
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string; text?: string }>;
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('deploy this');
    expect(parts[0].text).toContain('Attached file: docker-compose.yml');
    expect(parts[0].text).toContain('image: nginx');
  });

  it('adds one image part per image, with base64 + media type', () => {
    const content = buildUserContent('what is this error?', [image]);
    const parts = content as Array<{
      type: string;
      image?: string;
      mediaType?: string;
    }>;
    expect(parts.some((p) => p.type === 'text')).toBe(true);
    const img = parts.find((p) => p.type === 'image');
    expect(img?.image).toBe('AAAA');
    expect(img?.mediaType).toBe('image/png');
  });

  it('handles attachments with empty text (image only, no message)', () => {
    const content = buildUserContent('', [image]);
    const parts = content as Array<{ type: string }>;
    // No empty text part — just the image.
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('image');
  });
});

describe('buildModelMessages', () => {
  const msgs = [
    { role: 'user' as const, content: 'first' },
    { role: 'assistant' as const, content: 'reply' },
    { role: 'user' as const, content: 'look at this' },
  ];

  it('leaves messages as plain strings when there are no attachments', () => {
    const out = buildModelMessages(msgs);
    expect(out.every((m) => typeof m.content === 'string')).toBe(true);
  });

  it('folds attachments into the LAST user message only', () => {
    const out = buildModelMessages(msgs, [image]);
    expect(typeof out[0].content).toBe('string'); // earlier user turn untouched
    expect(Array.isArray(out[2].content)).toBe(true); // last user turn is multimodal
  });
});

describe('injectSteerMessages', () => {
  const base = [
    { role: 'user' as const, content: 'do a deploy' },
    { role: 'assistant' as const, content: 'starting…' },
  ];

  it('returns the messages unchanged when there is nothing to steer', () => {
    expect(injectSteerMessages(base, [])).toBe(base);
  });

  it('appends each steer as a new user message after the current step messages', () => {
    const out = injectSteerMessages(base, [
      { text: 'actually use port 8080' },
      { text: 'and enable HTTPS' },
    ]);
    expect(out).toHaveLength(4);
    expect(out[2]).toMatchObject({ role: 'user', content: 'actually use port 8080' });
    expect(out[3]).toMatchObject({ role: 'user', content: 'and enable HTTPS' });
    // The originals are preserved and come first.
    expect(out.slice(0, 2)).toEqual(base);
  });

  it('carries a steer image as multimodal content', () => {
    const out = injectSteerMessages(base, [{ text: 'like this', attachments: [image] }]);
    expect(Array.isArray(out[2].content)).toBe(true);
  });
});
