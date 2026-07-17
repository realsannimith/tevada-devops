import type {
  TemplateDeployStepId,
  TemplateDeployStepStatus,
  TemplateDeploySummary,
} from '@/shared/ipc-types';

export const TEMPLATE_DEPLOY_STEPS: Array<{
  id: TemplateDeployStepId;
  label: string;
}> = [
  { id: 'connect', label: 'Connect to server' },
  { id: 'docker', label: 'Docker runtime' },
  { id: 'files', label: 'Write app files' },
  { id: 'start', label: 'Start containers' },
  { id: 'verify', label: 'Verify services' },
  { id: 'expose', label: 'Publish web ports' },
];

export type TemplateDeployTranscriptInput = {
  steps: Partial<
    Record<TemplateDeployStepId, { status: TemplateDeployStepStatus; detail?: string }>
  >;
  log: string[];
  summary: TemplateDeploySummary | null;
  error: string | null;
};

/** Build the persisted History record. Credential names are useful context,
 * but their values deliberately remain only in memory and in the protected
 * remote .env file. */
export function buildDeployTranscript(
  deploy: TemplateDeployTranscriptInput,
): string {
  const lines: string[] = [];
  for (const step of TEMPLATE_DEPLOY_STEPS) {
    const state = deploy.steps[step.id];
    if (!state) continue;
    const mark =
      state.status === 'done'
        ? '✓'
        : state.status === 'failed'
          ? '✗'
          : state.status === 'skipped'
            ? '–'
            : '…';
    lines.push(
      `- ${mark} ${step.label}${state.detail ? ` — ${state.detail}` : ''}`,
    );
  }
  if (deploy.log.length > 0) {
    lines.push('', '```', ...deploy.log.slice(-120), '```');
  }
  if (deploy.error) lines.push('', `**Failed:** ${deploy.error}`);
  const summary = deploy.summary;
  if (summary) {
    lines.push('', `**Deployed to** \`${summary.appDir}\``);
    if (summary.urls.length > 0) {
      lines.push('', '**Open:**');
      for (const url of summary.urls) {
        lines.push(`- ${url.serviceName}: ${url.url}`);
      }
    }
    if (summary.credentials.length > 0) {
      lines.push(
        '',
        '**Generated credentials:** values were shown when the deploy finished and remain only in the protected server `.env` file.',
      );
      for (const credential of summary.credentials) {
        lines.push(`- ${credential.key}`);
      }
    }
  }
  return lines.join('\n');
}
