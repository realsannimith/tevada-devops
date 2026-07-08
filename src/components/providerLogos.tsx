/**
 * Official brand marks for the "Add server" provider picker. Each path is the
 * canonical single-color logo (viewBox 0 0 24 24) rendered in the brand's
 * official colour on a white tile — self-contained inline SVG, since the
 * renderer is offline / CSP-locked and can't load remote assets.
 */
import { ServerIcon } from '@/lib/icons';
import { cn } from '@/lib/utils';

type Brand = { title: string; color: string; path: string };

// Official logos + brand hex (source: canonical brand SVGs / Simple Icons).
const BRANDS: Record<string, Brand> = {
  digitalocean: {
    title: 'DigitalOcean',
    color: '#0080FF',
    path: 'M12.04 0C5.408-.02.005 5.37.005 11.992h4.638c0-4.923 4.882-8.731 10.064-6.855a6.95 6.95 0 014.147 4.148c1.889 5.177-1.924 10.055-6.84 10.064v-4.61H7.391v4.623h4.61V24c7.86 0 13.967-7.588 11.397-15.83-1.115-3.59-3.985-6.446-7.575-7.575A12.8 12.8 0 0012.039 0zM7.39 19.362H3.828v3.564H7.39zm-3.563 0v-2.978H.85v2.978z',
  },
  aws: {
    title: 'Amazon EC2',
    color: '#FF9900',
    path: 'M6.429 17.571h10.714V6.857H6.429v10.714ZM18 6.857h1.714v.857H18V9.43h1.714v.857H18v1.285h1.714v.858H18v1.714h1.714V15H18v1.714h1.714v.857H18v.059a.8.8 0 0 1-.799.799h-.058v1.714h-.857v-1.714H14.57v1.714h-.857v-1.714H12.43v1.714h-.858v-1.714H9.857v1.714H9v-1.714H7.286v1.714h-.857v-1.714H6.37a.8.8 0 0 1-.799-.8v-.058H4.286v-.857H5.57V15H4.286v-.857H5.57v-1.714H4.286v-.858H5.57v-1.285H4.286v-.857H5.57V7.714H4.286v-.857H5.57V6.8a.8.8 0 0 1 .8-.799h.058V4.286h.857V6H9V4.286h.857V6h1.714V4.286h.858V6h1.285V4.286h.857V6h1.715V4.286h.857V6h.058a.8.8 0 0 1 .799.799v.058ZM12.429 23.09a.054.054 0 0 1-.054.053H.91a.053.053 0 0 1-.053-.053V11.625c0-.03.024-.054.053-.054h2.52v-.857H.91a.911.911 0 0 0-.91.91V23.09c0 .502.408.91.91.91h11.465a.91.91 0 0 0 .91-.91V21h-.856ZM24 .91v11.465a.91.91 0 0 1-.91.91h-2.52v-.856h2.519a.054.054 0 0 0 .053-.054V.91a.053.053 0 0 0-.053-.053H11.625a.053.053 0 0 0-.054.053v2.52h-.857V.91c0-.502.409-.91.91-.91H23.09a.91.91 0 0 1 .91.91Z',
  },
  linode: {
    title: 'Linode / Akamai',
    color: '#00A95C',
    path: 'M22.006 10.684a.15.15 0 0 0-.07-.15l-3.261-1.821a.14.14 0 0 0-.14 0l-2.771 1.69a.17.17 0 0 0-.07.13v1.451l-1.13-.74a.14.14 0 0 0-.15 0l-1.62 1-.071-1.64a.19.19 0 0 0-.07-.12l-1.65-1.09 1.51-.781a.16.16 0 0 0 .08-.14l-.27-6.272a.16.16 0 0 0-.08-.13L8 0h-.1L2.08 1.81A.16.16 0 0 0 2 2l1.27 6.233a.22.22 0 0 0 0 .08l1.83 1.38-1.26.6a.16.16 0 0 0-.08.17l1 4.702a.18.18 0 0 0 0 .07L6 16.375l-.8.49a.15.15 0 0 0-.06.16l.75 3.642a.11.11 0 0 0 0 .07l3.002 3.221a.14.14 0 0 0 .2 0l3.921-3.121a.16.16 0 0 0 .06-.12l-.07-2.12 1.32 1.1a.14.14 0 0 0 .18 0l3.142-2.511a.24.24 0 0 0 .06-.11l.09-1.57 1 .67a.14.14 0 0 0 .17 0l2.571-2.001a.14.14 0 0 0 .05-.1zm-9.623.15l.07 1.57.12 2.781-4.231 2.871-.66-4.532zm-.35-8.423l.25 5.912-5.002 2.59-.9-6.321zM3.54 8.123L2.33 2.26l3.74 2.32.931 6.203-1.58-1.2zM5 15.055l-.88-4.261 3.281 2.74.6 4.382-1.68-1.62zm1.14 5.512l-.65-3.141 2.892 2.85.47 3.162zm3.002 3l-.49-3.33 4.001-2.871.14 3.28zm3.861-5.36v-1.081a.16.16 0 0 0-.05-.11l-1.13-.92 1-.7a.14.14 0 0 0 .06-.12v-.261l1.39 1.06v3.211zm4.442-1.201l-2.861 2.28v-3.22l3.07-2.201zm1.29-1.21l-.9-.631.09-1.59a.11.11 0 0 0 0-.06.1.1 0 0 0 0-.05l-1.93-1.27v-1.391l3 1.89zm2.55-1.861l-2.28 1.81.26-3.06 2.431-1.681z',
  },
  vultr: {
    title: 'Vultr',
    color: '#007BFC',
    path: 'M8.36 2.172A1.194 1.194 0 007.348 1.6H1.2A1.2 1.2 0 000 2.8a1.211 1.211 0 00.182.64l11.6 18.4a1.206 1.206 0 002.035 0l3.075-4.874a1.229 1.229 0 00.182-.64 1.211 1.211 0 00-.182-.642zm10.349 8.68a1.206 1.206 0 002.035 0L21.8 9.178l2.017-3.2a1.211 1.211 0 00.183-.64 1.229 1.229 0 00-.183-.64l-1.6-2.526a1.206 1.206 0 00-1.016-.571h-6.148a1.2 1.2 0 00-1.201 1.2 1.143 1.143 0 00.188.64z',
  },
  hetzner: {
    title: 'Hetzner Cloud',
    color: '#D50C2D',
    path: 'M0 0v24h24V0H0zm4.602 4.025h2.244c.509 0 .716.215.716.717v5.64h8.883v-5.64c0-.509.215-.717.717-.717h2.229c.5 0 .71.23.724.717v14.516c0 .509-.215.717-.717.717h-2.23c-.51 0-.717-.215-.717-.717v-5.735H7.562v5.735c0 .516-.215.717-.716.717H4.602c-.51 0-.717-.208-.717-.717V4.742c0-.509.207-.717.717-.717z',
  },
};

function Tile({
  children,
  className,
  title,
  bg = '#ffffff',
}: {
  children: React.ReactNode;
  className?: string;
  title: string;
  bg?: string;
}) {
  return (
    <span
      aria-label={title}
      title={title}
      className={cn(
        'inline-flex size-[18px] shrink-0 items-center justify-center overflow-hidden rounded-[5px] ring-1 ring-black/10 dark:ring-white/10',
        className,
      )}
      style={{ background: bg }}
    >
      {children}
    </span>
  );
}

export function ProviderLogo({ id }: { id: string }) {
  const brand = BRANDS[id];

  if (!brand) {
    // Other / self-hosted — neutral server glyph on a surface tile.
    return (
      <Tile title="Other / self-hosted" bg="var(--secondary)" className="text-muted-foreground">
        <ServerIcon className="size-3" aria-hidden />
      </Tile>
    );
  }

  return (
    <Tile title={brand.title} bg="#ffffff">
      <svg viewBox="0 0 24 24" className="size-[13px]" aria-hidden>
        <path d={brand.path} fill={brand.color} />
      </svg>
    </Tile>
  );
}
