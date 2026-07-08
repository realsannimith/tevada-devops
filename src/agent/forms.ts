/**
 * Builders for the agent's interactive chat forms (generative UI). The field
 * definitions live HERE in code, not in the model's tool arguments — that keeps
 * the agent tool schemas flat (Gemini function-calling constraint) and lets us
 * design each form well rather than trusting the model to invent fields.
 */
import { AgentFormSpec, FormField } from '../shared/ipc-types';

export function buildDomainForm(opts: {
  appName?: string;
  suggestedPort?: number;
  /** This server's public IP — powers the in-form DNS A-record guide. */
  serverIp?: string;
}): Omit<AgentFormSpec, 'formId'> {
  const who = opts.appName ? `“${opts.appName}”` : 'your service';
  const fields: FormField[] = [
    {
      key: 'domain',
      label: 'Domain',
      type: 'text',
      placeholder: 'app.example.com',
      required: true,
      help: 'The domain (or subdomain) you want to point at this service. You must already own it and be able to edit its DNS.',
    },
    {
      key: 'port',
      label: 'Service port',
      type: 'number',
      placeholder: '8000',
      defaultValue:
        opts.suggestedPort != null ? String(opts.suggestedPort) : undefined,
      required: true,
      // The agent detects this from the running service and fills it in; the
      // user only touches it in the rare case detection was wrong.
      help:
        opts.suggestedPort != null
          ? `Detected automatically — ${opts.appName ?? 'your service'} is listening on port ${opts.suggestedPort}. You usually don’t need to change this.`
          : 'The local port your service listens on — traffic to the domain is forwarded here.',
    },
    {
      key: 'www',
      label: 'Also serve the www. version',
      type: 'toggle',
      defaultValue: 'false',
      help: 'Handle both example.com and www.example.com.',
    },
    {
      key: 'https',
      label: 'Enable HTTPS (free Let’s Encrypt certificate)',
      type: 'toggle',
      defaultValue: 'true',
      help: 'Strongly recommended. Requires the domain’s DNS to already point at this server.',
    },
    {
      key: 'email',
      label: 'Email for certificate renewal notices',
      type: 'text',
      placeholder: 'you@example.com',
      help: 'Required by Let’s Encrypt when HTTPS is on — used only for expiry warnings.',
    },
  ];
  return {
    title: `Set up a domain for ${who}`,
    description:
      'Point your own domain at this service. Make sure its DNS A-record already points at this server’s IP before enabling HTTPS.',
    submitLabel: 'Set up domain',
    fields,
    dnsGuide: { serverIp: opts.serverIp ?? '', domainField: 'domain', wwwField: 'www' },
  };
}

export const BACKUP_ENGINES = [
  'postgresql',
  'mysql',
  'mariadb',
  'mongodb',
  'redis',
] as const;

export const BACKUP_SCHEDULES = [
  'Every hour',
  'Every day (03:00)',
  'Every week (Sun 03:00)',
] as const;

export function buildDatabaseBackupForm(opts: {
  /** Engine the agent detected running on the server — pre-selects the field. */
  detectedEngine?: string;
  /** Database name the agent detected (e.g. from a saved credential). */
  suggestedDatabase?: string;
}): Omit<AgentFormSpec, 'formId'> {
  const engine = BACKUP_ENGINES.includes(
    opts.detectedEngine as (typeof BACKUP_ENGINES)[number],
  )
    ? opts.detectedEngine
    : undefined;
  const fields: FormField[] = [
    {
      key: 'engine',
      label: 'Database engine',
      type: 'select',
      options: [...BACKUP_ENGINES],
      defaultValue: engine,
      required: true,
      // Same convention as the domain form's port: the agent detects it and the
      // user only touches it if detection was wrong.
      help: engine
        ? `Detected automatically — ${engine} is running on this server. You usually don’t need to change this.`
        : 'The database you want backed up.',
    },
    {
      key: 'database',
      label: 'Database name',
      type: 'text',
      placeholder: 'all databases',
      defaultValue: opts.suggestedDatabase,
      help: 'Leave empty to back up every database on the server (recommended). Not used for Redis.',
    },
    {
      key: 'schedule',
      label: 'How often',
      type: 'select',
      options: [...BACKUP_SCHEDULES],
      defaultValue: 'Every day (03:00)',
      required: true,
      help: 'Backups run automatically on this schedule (server time).',
    },
    {
      key: 'retentionDays',
      label: 'Keep backups for (days)',
      type: 'number',
      defaultValue: '7',
      required: true,
      help: 'Older backups are deleted automatically to save disk space.',
    },
    {
      key: 'offsite',
      label: 'Also copy backups to S3-compatible storage',
      type: 'toggle',
      defaultValue: 'false',
      help: 'Strongly recommended — a copy off this server survives even if the server itself is lost. You’ll be asked for the storage details next.',
    },
  ];
  return {
    title: `Set up automatic backups for ${engine ?? 'your database'}`,
    description:
      'Schedule automatic database backups on this server. Backups are compressed, rotated, and can optionally be copied off-site.',
    submitLabel: 'Set up backups',
    fields,
  };
}

export type S3FormPurpose = 'image-uploads' | 'backups';

export const S3_PROVIDERS = [
  'AWS S3',
  'Cloudflare R2',
  'DigitalOcean Spaces',
  'Backblaze B2',
  'MinIO / other S3-compatible',
] as const;

export function buildS3StorageForm(opts: {
  purpose: S3FormPurpose;
  appName?: string;
}): Omit<AgentFormSpec, 'formId'> {
  const forUploads = opts.purpose === 'image-uploads';
  const who = opts.appName ? `“${opts.appName}”` : 'your app';
  const fields: FormField[] = [
    {
      key: 'provider',
      label: 'Storage provider',
      type: 'select',
      options: [...S3_PROVIDERS],
      defaultValue: 'AWS S3',
      required: true,
      help: 'Where the bucket lives. All of these speak the same S3 protocol.',
    },
    {
      key: 'bucket',
      label: 'Bucket name',
      type: 'text',
      placeholder: forUploads ? 'my-app-images' : 'my-app-backups',
      required: true,
      help: 'The bucket must already exist — create it in your provider’s console first.',
    },
    {
      key: 'region',
      label: 'Region',
      type: 'text',
      placeholder: 'us-east-1',
      help: 'The bucket’s region from your provider’s console. Use “auto” for Cloudflare R2.',
    },
    {
      key: 'endpoint',
      label: 'Endpoint URL',
      type: 'text',
      placeholder: 'https://…',
      help: 'Only for non-AWS providers (R2, Spaces, B2, MinIO) — the S3 endpoint URL from your provider’s console. Leave empty for AWS.',
    },
    {
      key: 'accessKeyId',
      label: 'Access key ID',
      type: 'text',
      placeholder: 'AKIA…',
      required: true,
      help: 'From your provider’s console (an API token / access key pair with read-write access to the bucket).',
    },
    {
      key: 'secretAccessKey',
      label: 'Secret access key',
      type: 'password',
      required: true,
      help: 'Stored on the server in a root-only file. It is never shown again, so keep your own copy.',
    },
  ];
  if (forUploads) {
    fields.push({
      key: 'publicRead',
      label: 'Uploaded images are publicly viewable',
      type: 'toggle',
      defaultValue: 'true',
      help: 'Turn on when visitors load these images directly (product photos, avatars). Turn off for private files.',
    });
  }
  return {
    title: forUploads
      ? `Connect S3 storage for ${who}’s image uploads`
      : 'Connect S3 storage for off-site backups',
    description: forUploads
      ? 'Store uploaded images in an S3-compatible bucket instead of on the server’s disk — uploads survive redeploys and never fill the disk.'
      : 'Copy database backups to an S3-compatible bucket so they survive even if this server is lost.',
    submitLabel: 'Connect storage',
    fields,
  };
}
