/**
 * A Button that always routes its action through a confirmation dialog. Use for
 * any destructive / irreversible control (delete, remove, disconnect) so the
 * user gets a "are you sure?" gate before the action fires — matching the
 * AlertDialog pattern used for chat/project/server deletion elsewhere.
 *
 * All Button props pass through, so a call site looks exactly like the plain
 * Button it replaces plus the confirm copy:
 *
 *   <ConfirmButton
 *     variant="outline" size="sm" disabled={busy}
 *     confirmTitle="Disconnect Google Drive?"
 *     confirmDescription="Backups stop until you reconnect."
 *     confirmLabel="Disconnect"
 *     onConfirm={disconnect}
 *   >
 *     Disconnect
 *   </ConfirmButton>
 */
import { useState, type ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type ConfirmButtonProps = Omit<ComponentProps<typeof Button>, 'onClick'> & {
  /** Heading of the confirmation dialog, e.g. "Disconnect Google Drive?". */
  confirmTitle: string;
  /** Body text explaining the consequence. */
  confirmDescription: string;
  /** Label of the confirming action button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Runs only after the user confirms. */
  onConfirm: () => void | Promise<void>;
};

export function ConfirmButton({
  confirmTitle,
  confirmDescription,
  confirmLabel = 'Confirm',
  onConfirm,
  children,
  ...buttonProps
}: ConfirmButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button {...buttonProps} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{confirmDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setOpen(false);
                void onConfirm();
              }}
            >
              {confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
