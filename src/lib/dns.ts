/**
 * Compute the DNS A-record NAME a registrar expects for a given domain, so the
 * in-form DNS guide can show the exact record to add. Bare domains use "@";
 * subdomains use the labels in front of the registrable domain.
 */
export type DnsRecordName = {
  /** The record NAME field: "@" for a bare domain, else the subdomain label(s). */
  name: string;
  /** True when the input is a bare/registrable domain (example.com). */
  bare: boolean;
};

export function computeDnsRecordName(domainRaw: string): DnsRecordName {
  const domain = domainRaw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
  const parts = domain.split('.').filter(Boolean);
  // Nothing meaningful typed yet, or a bare "example.com" (2 labels).
  if (parts.length <= 2) return { name: '@', bare: true };
  // app.example.com → "app"; a.b.example.com → "a.b".
  return { name: parts.slice(0, parts.length - 2).join('.'), bare: false };
}
