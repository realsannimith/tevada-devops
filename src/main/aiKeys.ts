/**
 * Per-provider API key storage — a thin wrapper over the encrypted secret
 * store (secrets.ts). Keys are set from the Settings UI, stored encrypted at
 * rest, and resolved here (main process only) right before an agent run.
 *
 * There is deliberately NO environment-variable / `.env` fallback: provider
 * API keys must live in the OS keychain, never in a plaintext file. Codex is
 * the exception — it uses a ChatGPT-subscription OAuth token, resolved
 * separately via codexAuth.resolveCodexAuth().
 */
import { AiKeyStatus } from '../shared/ipc-types';
import { PROVIDER_IDS, ProviderId } from '../shared/providers';
import { deleteRawSecret, hasRawSecret, loadRawSecret, saveRawSecret } from './secrets';

const secretId = (p: ProviderId) => `apikey-${p}`;

export function setProviderKey(p: ProviderId, key: string): void {
  saveRawSecret(secretId(p), key.trim());
}

export function clearProviderKey(p: ProviderId): void {
  deleteRawSecret(secretId(p));
}

export function keyStatus(): AiKeyStatus {
  const status = {} as AiKeyStatus;
  for (const p of PROVIDER_IDS) {
    status[p] = { stored: hasRawSecret(secretId(p)) };
  }
  return status;
}

/** Keys come only from the encrypted store — nothing is read from the env. */
export function resolveApiKey(p: ProviderId): string | undefined {
  return hasRawSecret(secretId(p)) ? loadRawSecret(secretId(p)) : undefined;
}
