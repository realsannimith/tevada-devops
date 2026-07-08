import { describe, expect, it } from 'vitest';
import { buildProviderOptions, buildTodoReminder, createModel } from './agent';
import { PROVIDER_IDS, DEFAULT_MODEL } from '@/shared/providers';
import type { TodoItem } from '@/shared/ipc-types';

describe('buildTodoReminder', () => {
  it('is empty when there are no todos (fresh conversation)', () => {
    expect(buildTodoReminder(undefined)).toBe('');
    expect(buildTodoReminder([])).toBe('');
  });

  it('lists every task with a status mark so a continue turn keeps them all', () => {
    const todos: TodoItem[] = [
      { text: 'Install nginx', status: 'completed' },
      { text: 'Configure TLS', status: 'in_progress' },
      { text: 'Verify HTTPS', status: 'pending' },
    ];
    const out = buildTodoReminder(todos);
    expect(out).toContain('[x] Install nginx');
    expect(out).toContain('[~] Configure TLS');
    expect(out).toContain('[ ] Verify HTTPS');
    // The instruction that prevents dropping/restarting earlier tasks.
    expect(out).toMatch(/include ALL of these items/i);
    expect(out).toMatch(/REPLACES the whole list/i);
  });

  it('preserves task order', () => {
    const out = buildTodoReminder([
      { text: 'First', status: 'completed' },
      { text: 'Second', status: 'pending' },
    ]);
    expect(out.indexOf('First')).toBeLessThan(out.indexOf('Second'));
  });
});

describe('createModel', () => {
  it('builds a model for every provider in the catalog', () => {
    for (const provider of PROVIDER_IDS) {
      const model = createModel({
        provider,
        modelId: DEFAULT_MODEL[provider] || 'some-model',
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
        effort: 'medium',
        thinking: true,
      });
      expect(model, provider).toBeTruthy();
      // LanguageModel is `string | LanguageModelV*` — createModel always
      // returns a provider instance, never a bare id string.
      expect(typeof model, provider).toBe('object');
      const modelId = (model as { modelId: string }).modelId;
      expect(modelId, provider).toBe(DEFAULT_MODEL[provider] || 'some-model');
    }
  });
});

describe('buildProviderOptions', () => {
  const base = { apiKey: 'k', baseUrl: 'https://example.com/v1' } as const;

  it('maps effort and thinking per provider', () => {
    expect(
      buildProviderOptions({ ...base, provider: 'anthropic', modelId: 'claude-sonnet-5', effort: 'xhigh', thinking: true }),
    ).toEqual({ anthropic: { effort: 'xhigh', thinking: { type: 'adaptive' } } });
    expect(
      buildProviderOptions({ ...base, provider: 'openai', modelId: 'gpt-5.4', effort: 'max', thinking: true }),
    ).toEqual({ openai: { reasoningEffort: 'xhigh' } });
    expect(
      buildProviderOptions({ ...base, provider: 'google', modelId: 'gemini-3.5-flash', effort: 'high', thinking: true }),
    ).toEqual({ google: { thinkingConfig: { thinkingLevel: 'high' } } });
    expect(
      buildProviderOptions({ ...base, provider: 'google', modelId: 'gemini-2.5-flash', effort: 'medium', thinking: true }),
    ).toEqual({ google: { thinkingConfig: { thinkingBudget: 8192 } } });
    expect(
      buildProviderOptions({ ...base, provider: 'openrouter', modelId: 'anthropic/claude-sonnet-5', effort: 'max', thinking: true }),
    ).toEqual({ openrouter: { reasoningEffort: 'high' } });
    // Codex: ChatGPT backend needs store:false + encrypted reasoning round-trip.
    expect(
      buildProviderOptions({ ...base, provider: 'codex', modelId: 'gpt-5.5', effort: 'high', thinking: true }),
    ).toEqual({
      openai: {
        store: false,
        include: ['reasoning.encrypted_content'],
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
      },
    });
  });

  it('turns thinking off safely per provider', () => {
    // Fable-tier: thinking is always on — must NOT send an explicit disabled.
    expect(
      buildProviderOptions({ ...base, provider: 'anthropic', modelId: 'claude-fable-5', effort: 'medium', thinking: false }),
    ).toEqual({ anthropic: { effort: 'medium' } });
    expect(
      buildProviderOptions({ ...base, provider: 'anthropic', modelId: 'claude-sonnet-5', effort: 'medium', thinking: false }),
    ).toEqual({ anthropic: { effort: 'medium', thinking: { type: 'disabled' } } });
    expect(
      buildProviderOptions({ ...base, provider: 'openai', modelId: 'gpt-5.4', effort: 'medium', thinking: false }),
    ).toEqual({ openai: { reasoningEffort: 'minimal' } });
    // 2.5 Pro cannot disable thinking entirely — its minimum budget is 128.
    expect(
      buildProviderOptions({ ...base, provider: 'google', modelId: 'gemini-2.5-pro', effort: 'medium', thinking: false }),
    ).toEqual({ google: { thinkingConfig: { thinkingBudget: 128 } } });
    expect(
      buildProviderOptions({ ...base, provider: 'openrouter', modelId: 'openai/gpt-5.5', effort: 'medium', thinking: false }),
    ).toEqual({});
  });
});
