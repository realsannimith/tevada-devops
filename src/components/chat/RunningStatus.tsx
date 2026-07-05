import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Codex-style animated braille "dots" spinner — a dense cluster of dots that
 * cycles in place, reading as a small terminal-style loading glyph rather than
 * a spinning ring. Only mounted while a run is live, so the interval is cheap.
 */
const BRAILLE_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'] as const;

export function BrailleSpinner({ className }: { className?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = window.setInterval(
      () => setFrame((f) => (f + 1) % BRAILLE_FRAMES.length),
      90,
    );
    return () => window.clearInterval(id);
  }, []);
  return (
    <span
      aria-hidden
      className={cn('font-mono text-sm leading-none', className)}
    >
      {BRAILLE_FRAMES[frame]}
    </span>
  );
}

