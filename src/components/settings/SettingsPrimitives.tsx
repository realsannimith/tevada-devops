/**
 * FCode-style settings primitives (mirrors FCode's SettingsPanelPrimitives):
 * a small muted section label above a flat, outline-only card whose rows are
 * hairline-divided — label + description on the left, control on the right.
 * Cards are deliberately transparent and shadow-less (edges from hairlines,
 * not drop shadows), unlike `.surface-panel` which is a raised control.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5 not-first:mt-4">
      <h2 className="px-2 py-1 text-xs font-normal text-muted-foreground/60">
        {title}
      </h2>
      <SettingsCard>{children}</SettingsCard>
    </section>
  );
}

export function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-transparent divide-y divide-border">
      {children}
    </div>
  );
}

export function SettingsRow({
  title,
  description,
  status,
  control,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** Small extra status line under the description (e.g. "key saved"). */
  status?: ReactNode;
  /** Right-aligned control (switch, select, buttons). */
  control?: ReactNode;
  /** Full-width expandable content below the title/control line. */
  children?: ReactNode;
}) {
  return (
    <div className="px-3 py-2.5" data-slot="settings-row">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 className="text-xs font-medium tracking-[-0.015em] text-ink">
            {title}
          </h3>
          {description ? (
            <p className="text-xs text-muted-foreground">{description}</p>
          ) : null}
          {status ? (
            <div className="pt-1 text-[11px] text-muted-foreground">{status}</div>
          ) : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** Divider for sub-forms inside a row's expandable `children` area. */
export function SettingsRowDivider({ className }: { className?: string }) {
  return <div className={cn('mt-3 border-t border-border pt-3', className)} />;
}
