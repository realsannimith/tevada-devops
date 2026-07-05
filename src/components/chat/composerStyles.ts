/** Composer layout tokens aligned with FCode `composerPickerStyles.ts`. */

export const COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME =
  'font-sans text-xs leading-relaxed';

export const COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME =
  'placeholder:text-muted-foreground/55';

export const COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME = 'min-h-[1lh]';

export const COMPOSER_EDITOR_PADDING_CLASS_NAME = [
  'relative',
  'pl-3 pr-3.5 pt-2 pb-2',
].join(' ');

export const COMPOSER_INPUT_ROW_CLASS_NAME = 'flex items-center gap-1.5';

export const COMPOSER_EDITOR_CLASS_NAME = [
  'block max-h-[200px] w-full min-w-0 flex-1 resize-none overflow-y-auto',
  'border-0 bg-transparent shadow-none',
  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
  COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
  COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
  'text-foreground focus-visible:outline-none focus-visible:ring-0',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ');

export const COMPOSER_FOOTER_ROW_CLASS_NAME =
  'flex items-center justify-between pl-1.5 pr-2 pb-1.5';

/**
 * Footer picker "floating button" — mirrors FCode's `chrome-outline` composer
 * picker (bordered transparent chip: leading icon · label · chevron, hover fills
 * with the secondary surface). Chevron nudged to size-3/muted via last-child.
 */
export const COMPOSER_FOOTER_PICKER_TRIGGER_CLASS_NAME = [
  'h-7 w-auto min-w-0 shrink-0 justify-start gap-1.5 rounded-lg px-2',
  'border border-border bg-transparent shadow-none',
  'text-[11px] font-normal text-foreground',
  'transition-colors hover:bg-secondary aria-expanded:bg-secondary',
  'focus-visible:border-border focus-visible:ring-0',
  'dark:bg-transparent dark:hover:bg-secondary',
  '[&>svg:last-child]:size-3 [&>svg:last-child]:text-muted-foreground/60',
].join(' ');

export const COMPOSER_COLUMN_FRAME_CLASS_NAME = 'mx-auto w-full max-w-[46rem]';
