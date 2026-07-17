import { describe, expect, it } from 'vitest';
import { buildDeployTranscript } from './templateDeployTranscript';

describe('buildDeployTranscript', () => {
  it('persists credential names without persisting their secret values', () => {
    const transcript = buildDeployTranscript({
      steps: { verify: { status: 'done', detail: '2 services running' } },
      log: ['$ docker compose up -d'],
      error: null,
      summary: {
        appName: 'demo-a1b2c3',
        appDir: '/opt/easyhost/apps/demo-a1b2c3',
        urls: [],
        services: [{ name: 'web', state: 'running' }],
        credentials: [{ key: 'ADMIN_PASSWORD', value: 'super-secret-value' }],
      },
    });

    expect(transcript).toContain('ADMIN_PASSWORD');
    expect(transcript).not.toContain('super-secret-value');
  });
});
