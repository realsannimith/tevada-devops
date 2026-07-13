import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// Bare relative paths (NO leading slash). These become CSS mask url()s that
// resolve against the document base (index.html). In dev that's the Vite
// server root; in the packaged app the renderer loads over file:// and a
// leading-slash path would resolve to the FILESYSTEM root instead, so the mask
// would silently fail to load and the icon would render invisible. Relative
// paths resolve to the renderer output dir (where public/ assets are copied)
// in both. Safe because the app has no <base> tag and no path-based routing,
// so the document URL never moves away from index.html.
const CENTRAL_ICON_BASE_PATHS = {
  reversed: 'central-icons-reversed',
  fill: 'central-icons-fill',
} as const;

export type CentralIconVariant = keyof typeof CENTRAL_ICON_BASE_PATHS;
const DEFAULT_CENTRAL_ICON_VARIANT: CentralIconVariant = 'reversed';
const SVG_SUFFIX = '.svg';
const CENTRAL_ICON_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type CentralIconProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  name: string;
  label?: string | undefined;
  variant?: CentralIconVariant | undefined;
};

export function getCentralIconUrl(
  name: string,
  variant: CentralIconVariant = DEFAULT_CENTRAL_ICON_VARIANT,
): string | null {
  const normalizedName = name.endsWith(SVG_SUFFIX) ? name.slice(0, -SVG_SUFFIX.length) : name;

  if (!CENTRAL_ICON_NAME_PATTERN.test(normalizedName)) {
    return null;
  }

  return `${CENTRAL_ICON_BASE_PATHS[variant]}/${encodeURIComponent(normalizedName)}${SVG_SUFFIX}`;
}

const CENTRAL_ICON_BASE_CLASS = 'inline-block size-4 shrink-0 bg-current';
export const CENTRAL_ICON_SLOT = 'central-icon';

function centralIconMaskValue(iconUrl: string): string {
  return `url("${iconUrl}") center / contain no-repeat`;
}

export const CentralIcon = forwardRef<HTMLSpanElement, CentralIconProps>(function CentralIcon(
  { name, label, variant, className, style, ...props },
  ref,
) {
  const iconUrl = getCentralIconUrl(name, variant);

  if (!iconUrl) {
    return null;
  }

  const maskValue = centralIconMaskValue(iconUrl);
  const maskStyle = {
    WebkitMask: maskValue,
    mask: maskValue,
    ...style,
  } satisfies CSSProperties;

  return (
    <span
      {...props}
      ref={ref}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-slot={CENTRAL_ICON_SLOT}
      className={cn(CENTRAL_ICON_BASE_CLASS, className)}
      style={maskStyle}
    />
  );
});
