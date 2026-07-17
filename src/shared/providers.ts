/**
 * AI provider catalog shared by main, preload, and renderer. Which provider is
 * active (and its model / base URL) lives in AppSettings; the API keys
 * themselves live in the encrypted secret store and never reach the renderer.
 *
 * Model lists are curated (no live fetching) — the "Custom…" option in the
 * model picker covers anything not listed.
 */

export type ProviderId =
  | 'google'
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'xai'
  | 'groq'
  | 'openai-compatible'
  | 'codex';

export type ProviderMeta = {
  id: ProviderId;
  label: string;
  keyPlaceholder: string;
  /** Where to create an API key (shown as a "Get an API key" link). */
  keyUrl?: string;
  /** Provider needs a user-supplied base URL (OpenAI-compatible endpoints). */
  needsBaseUrl?: boolean;
  /**
   * Provider authenticates with a ChatGPT/OpenAI *subscription* (OAuth login)
   * instead of an API key — the AI Provider panel hides the key row and points
   * the user at the dedicated sign-in section. See src/main/codexAuth.ts.
   */
  subscriptionAuth?: boolean;
};

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'google',
    label: 'Google Gemini',
    keyPlaceholder: 'AIza…',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    keyPlaceholder: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    keyPlaceholder: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'codex',
    label: 'Codex (ChatGPT subscription)',
    keyPlaceholder: '',
    subscriptionAuth: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyPlaceholder: 'sk-or-…',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    keyPlaceholder: 'xai-…',
    keyUrl: 'https://console.x.ai',
  },
  {
    id: 'groq',
    label: 'Groq',
    keyPlaceholder: 'gsk_…',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible (custom)',
    keyPlaceholder: 'API key',
    needsBaseUrl: true,
  },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as string[]).includes(value);
}

export function providerLabel(id: ProviderId): string {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

export type ModelOption = { id: string; label: string };

/**
 * Curated model ids, verified against each provider's official docs
 * (July 2026): ai.google.dev/gemini-api/docs/models, the Anthropic models
 * catalog, developers.openai.com/api/docs/models, the live
 * openrouter.ai/api/v1/models response, docs.x.ai/docs/models, and
 * console.groq.com/docs/models (all listed slugs support tool calling).
 * Note the id conventions differ: Anthropic native uses dashes
 * (claude-opus-4-8) while OpenRouter uses dots (anthropic/claude-opus-4.8).
 * xAI and Groq are called through their OpenAI-compatible endpoints, so the
 * ids are the provider-native slugs (grok-4.3, moonshotai/kimi-k2.7-instruct).
 */
export const PROVIDER_MODELS: Record<ProviderId, ModelOption[]> = {
  google: [
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)' },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  anthropic: [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { id: 'claude-fable-5', label: 'Claude Fable 5' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  // GPT-5.6 family shipped 2026-07-09: `gpt-5.6` is the API alias for the
  // flagship gpt-5.6-sol; Terra and Luna are the cheaper/faster tiers.
  openai: [
    { id: 'gpt-5.6', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  ],
  openrouter: [
    { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8' },
    { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
    { id: 'openai/gpt-5.6', label: 'GPT-5.6 Sol' },
    { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
    { id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { id: 'x-ai/grok-4.3', label: 'Grok 4.3' },
    { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { id: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code' },
    { id: 'qwen/qwen3.7-max', label: 'Qwen3.7 Max' },
    { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick' },
  ],
  // Verified against docs.x.ai/developers/models (July 2026). The dash-style
  // grok-4-* generation and grok-code-fast-1 were retired 2026-05-15.
  xai: [
    { id: 'grok-4.3', label: 'Grok 4.3' },
    { id: 'grok-build-0.1', label: 'Grok Build 0.1 (Coding)' },
    { id: 'grok-4.20-0309-reasoning', label: 'Grok 4.20 (Reasoning)' },
    { id: 'grok-4.20-0309-non-reasoning', label: 'Grok 4.20 (Non-Reasoning)' },
  ],
  // Verified against console.groq.com/docs/models (July 2026). Kimi K2, old
  // Qwen3-32B, and Llama 4 Scout are deprecated/shut down there — gpt-oss-120b
  // is Groq's official migration target and their best tool-calling model.
  groq: [
    { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
    { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
    { id: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B (Preview)' },
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
  ],
  // Endpoint-specific — always a free-text model id.
  'openai-compatible': [],
  // Codex runs through the ChatGPT backend Responses API (chatgpt.com/backend-api/
  // codex) with the subscription token, so these are the codex model slugs, not
  // the api.openai.com ones. Mirrors FCode's Codex model list.
  codex: [
    { id: 'gpt-5.6', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  ],
};

export const DEFAULT_MODEL: Record<ProviderId, string> = {
  google: 'gemini-3.5-flash',
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.6',
  openrouter: 'anthropic/claude-sonnet-5',
  xai: 'grok-4.3',
  groq: 'openai/gpt-oss-120b',
  'openai-compatible': '',
  codex: 'gpt-5.6',
};

/** Sentinel value for the "Custom…" item in the model select. */
export const CUSTOM_MODEL_VALUE = '__custom__';

/** Short display label for a model id (curated label, else the raw id). */
export function modelLabel(provider: ProviderId, modelId: string): string {
  return (
    PROVIDER_MODELS[provider].find((m) => m.id === modelId)?.label ?? modelId
  );
}

// ---------------------------------------------------------------------------
// Reasoning effort — one app-level scale, translated per provider at run time
// (Anthropic `effort`, OpenAI `reasoningEffort`, Gemini `thinkingConfig`,
// OpenRouter/compatible `reasoning_effort`). See agent.ts buildProviderOptions.
// ---------------------------------------------------------------------------

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: { id: EffortLevel; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
  { id: 'max', label: 'Max' },
];

export function effortLabel(effort: EffortLevel): string {
  return EFFORT_LEVELS.find((e) => e.id === effort)?.label ?? effort;
}
