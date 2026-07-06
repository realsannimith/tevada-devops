/**
 * In-app SSH key generation. Generates an ed25519 keypair entirely in the main
 * process so the user never needs a terminal or ssh-keygen. The PUBLIC key is
 * returned to the renderer to display (safe to show — it's what you paste into
 * DigitalOcean etc.). The PRIVATE key is kept in a short-lived in-memory stash
 * keyed by an opaque `keyRef`; it only ever leaves main by being written into the
 * encrypted secret store when the user saves the server (see ipc.ts).
 */
import crypto from 'node:crypto';
import { parsePrivateKey } from 'sshpk';

export type GeneratedKey = { keyRef: string; publicKey: string };

type Pending = { privateKeyOpenSSH: string; expires: number };

const STASH_TTL_MS = 15 * 60 * 1000; // 15 minutes
const pending = new Map<string, Pending>();

function sweep() {
  const now = Date.now();
  for (const [ref, p] of pending) if (p.expires < now) pending.delete(ref);
}

/**
 * Generate an ed25519 keypair. Returns the OpenSSH public key and a keyRef that
 * `consumePendingKey` can later exchange for the private key.
 */
export function generateKeyPair(comment: string): GeneratedKey {
  sweep();
  const { privateKey } = crypto.generateKeyPairSync('ed25519', {});
  const pkcs8 = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const key = parsePrivateKey(pkcs8, 'pkcs8');
  key.comment = comment || 'tevada-devops';

  const publicKey = key.toPublic().toString('ssh');
  const privateKeyOpenSSH = key.toString('openssh');

  const keyRef = `key_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  pending.set(keyRef, {
    privateKeyOpenSSH,
    expires: Date.now() + STASH_TTL_MS,
  });
  return { keyRef, publicKey };
}

/** Exchange a keyRef for its private key (one-time). Returns undefined if unknown/expired. */
export function consumePendingKey(keyRef: string): string | undefined {
  sweep();
  const p = pending.get(keyRef);
  if (!p) return undefined;
  pending.delete(keyRef);
  return p.privateKeyOpenSSH;
}
