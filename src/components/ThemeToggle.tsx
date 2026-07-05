import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SidebarGlyph } from '@/components/sidebarGlyphs';
import { DeviceLaptopIcon, MoonIcon, SunIcon } from '@/lib/icons';
import { cn } from '@/lib/utils';
import { useTheme } from 'next-themes';

type Mode = 'light' | 'dark' | 'system';

const OPTIONS = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: DeviceLaptopIcon },
] as const satisfies ReadonlyArray<{
  value: Mode;
  label: string;
  icon: typeof SunIcon;
}>;

export function ThemeSegmentedControl() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const value = (mounted ? theme : 'system') as Mode;

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="inline-flex w-full items-center gap-1"
    >
      {OPTIONS.map((option) => {
        const isActive = option.value === value;
        return (
          <Button
            key={option.value}
            role="radio"
            aria-checked={isActive}
            size="sm"
            variant={isActive ? 'secondary' : 'ghost'}
            className={cn('flex-1', !isActive && 'text-muted-foreground')}
            onClick={() => setTheme(option.value)}
          >
            <SidebarGlyph icon={option.icon} variant="leading" />
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

export function ThemeToggleButton() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const mode = (mounted ? theme : 'system') as Mode;

  const next: Record<Mode, Mode> = {
    system: 'light',
    light: 'dark',
    dark: 'system',
  };
  const active = OPTIONS.find((o) => o.value === mode) ?? OPTIONS[2];

  return (
    <button
      onClick={() => setTheme(next[mode])}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={`Appearance: ${active.label} (click to change)`}
    >
      <SidebarGlyph icon={active.icon} variant="leading" />
    </button>
  );
}

function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
