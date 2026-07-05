import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';

export const SIDEBAR_GLYPH = {
  leading: 'size-[15px] shrink-0',
  chrome: 'size-3.5 shrink-0',
  chromeLu: 'size-3 shrink-0',
  meta: 'size-3 shrink-0',
  chevron: 'size-3 shrink-0',
  compact: 'size-[11px] shrink-0',
  badge: 'size-2.5 shrink-0',
} as const;

export type SidebarGlyphVariant = keyof typeof SIDEBAR_GLYPH;

export function sidebarGlyphClass(variant: SidebarGlyphVariant, className?: string) {
  return cn(SIDEBAR_GLYPH[variant], className);
}

export function SidebarGlyph({
  icon: Icon,
  variant,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  variant: SidebarGlyphVariant;
  className?: string;
}) {
  return <Icon className={sidebarGlyphClass(variant, className)} aria-hidden />;
}
