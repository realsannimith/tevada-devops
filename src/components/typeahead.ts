/**
 * Predictive local echo (typeahead) for xterm.js — the technique that makes
 * Mosh, Termius, and VS Code Remote feel instant despite network latency.
 *
 * When you type, we draw the character IMMEDIATELY as a dimmed "prediction"
 * overlaid on the terminal, then send the real keystroke to the server. When the
 * server's echo arrives, we reconcile: predictions the server has caught up to
 * are removed (the real, solid character takes their place), and anything the
 * server did that we didn't predict clears the overlay entirely.
 *
 * Crucially, predictions live in a DOM overlay layered ON TOP of the terminal —
 * we never write into xterm's authoritative buffer. So a wrong prediction can at
 * worst flash a dim glyph that then disappears; it can never corrupt the screen.
 */
import type { Terminal } from '@xterm/xterm';

// A 'char' glyph predicts an insertion; a 'blank' glyph predicts a backspace
// (it paints the terminal background over the character being deleted).
type Glyph = { el: HTMLSpanElement; col: number; row: number; kind: 'char' | 'blank' };

// Server prompts that don't echo what you type — suppress predictions here so we
// never paint password characters on screen.
const NO_ECHO_PROMPT = /(password|passphrase)[^:]*:\s*$/i;

// A "plain" echo is a pure run of printable ASCII (the normal case for typing).
// Anything else (escapes, control chars, newlines) means the server moved the
// cursor or repainted, so our column model is invalid and we clear predictions.
const PLAIN_ECHO = /^[\x20-\x7e]+$/;

export class TypeaheadController {
  enabled = true;
  private glyphs: Glyph[] = [];
  private overlay: HTMLDivElement;
  private noEcho = false;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  // How many of OUR predictions the server has confirmed on the current line.
  // This is the safe budget for backspace prediction: we only blank out cells
  // we previously predicted and saw echoed, so we can never hide prompt text.
  private confirmedRun = 0;

  constructor(
    private term: Terminal,
    private host: HTMLElement,
    private background: string,
  ) {
    this.overlay = document.createElement('div');
    Object.assign(this.overlay.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '5',
    } as CSSStyleDeclaration);
    host.appendChild(this.overlay);
  }

  /** Route user keystrokes through here; it predicts, then always forwards. */
  handleInput(data: string, send: (d: string) => void): void {
    send(data);
    if (!this.enabled) return;

    // Only predict on the normal screen — never inside vim/htop/less (alt-screen).
    if (this.term.buffer.active.type !== 'normal' || this.noEcho) {
      this.clear();
      return;
    }

    if (data === '\x7f' || data === '\b') {
      const last = this.glyphs[this.glyphs.length - 1];
      if (last?.kind === 'char') {
        // Retract a still-pending insertion prediction.
        this.glyphs.pop();
        last.el.remove();
      } else if (this.confirmedRun > 0) {
        // Predict deletion of a confirmed character by painting background
        // over it. Bounded by confirmedRun so we never blank prompt text.
        const cell = last
          ? { col: last.col - 1, row: last.row }
          : {
              col: this.term.buffer.active.cursorX - 1,
              row: this.term.buffer.active.cursorY,
            };
        if (cell.col >= 0) {
          this.addGlyph(' ', cell.col, cell.row, 'blank');
          this.confirmedRun--;
        }
      }
      this.arm();
      return;
    }

    // A single printable character is the only thing we predict.
    if (data.length === 1 && data >= '\x20' && data <= '\x7e') {
      const cur = this.nextCell();
      if (cur.col >= this.term.cols) {
        this.clear(); // avoid line-wrap prediction complexity
        return;
      }
      this.addGlyph(data, cur.col, cur.row, 'char');
      this.arm();
      return;
    }

    // Enter, escapes, control keys, pastes — stop predicting; the server decides.
    this.clear();
  }

  /** Call AFTER writing server data to xterm, so cursor position is current. */
  handleServerData(data: string): void {
    if (!this.enabled) return;

    if (NO_ECHO_PROMPT.test(data)) {
      this.noEcho = true;
      this.clear();
      return;
    }
    if (this.noEcho && /[\r\n]/.test(data)) this.noEcho = false;

    if (!PLAIN_ECHO.test(data)) {
      // Server repainted / moved the cursor — our column model AND the
      // backspace budget are stale, even if no predictions are pending.
      this.clear();
      return;
    }

    if (this.glyphs.length === 0) return;

    // Partial confirmation: drop predictions the real cursor has reached or
    // passed; keep the ones still ahead of it (reduces flicker on fast typing).
    const col = this.term.buffer.active.cursorX;
    const row = this.term.buffer.active.cursorY;
    this.glyphs = this.glyphs.filter((g) => {
      const passed = g.row < row || (g.row === row && g.col < col);
      if (passed) {
        g.el.remove();
        // Each confirmed insertion grows the backspace-prediction budget.
        if (g.kind === 'char') this.confirmedRun++;
      }
      return !passed;
    });
  }

  /** Where the next predicted glyph goes. */
  private nextCell(): { col: number; row: number } {
    const last = this.glyphs[this.glyphs.length - 1];
    // After a char the cursor is one past it; a blank (predicted backspace)
    // leaves the cursor ON that cell, so the next char overwrites it.
    if (last) {
      return { col: last.kind === 'char' ? last.col + 1 : last.col, row: last.row };
    }
    return {
      col: this.term.buffer.active.cursorX,
      row: this.term.buffer.active.cursorY,
    };
  }

  private cellSize(): { w: number; h: number; left: number; top: number } {
    const screen = this.term.element?.querySelector(
      '.xterm-screen',
    ) as HTMLElement | null;
    if (!screen) return { w: 0, h: 0, left: 0, top: 0 };
    const sRect = screen.getBoundingClientRect();
    const hRect = this.host.getBoundingClientRect();
    return {
      w: screen.clientWidth / this.term.cols,
      h: screen.clientHeight / this.term.rows,
      left: sRect.left - hRect.left,
      top: sRect.top - hRect.top,
    };
  }

  private addGlyph(
    char: string,
    col: number,
    row: number,
    kind: 'char' | 'blank',
  ): void {
    const { w, h, left, top } = this.cellSize();
    if (w === 0) return;
    const el = document.createElement('span');
    el.textContent = char;
    const opts = this.term.options;
    Object.assign(el.style, {
      position: 'absolute',
      left: `${left + col * w}px`,
      top: `${top + row * h}px`,
      width: `${w}px`,
      height: `${h}px`,
      lineHeight: `${h}px`,
      fontFamily: String(opts.fontFamily ?? 'monospace'),
      fontSize: `${opts.fontSize ?? 13}px`,
      color: 'rgba(228,228,231,0.6)',
      background: this.background,
      textAlign: 'center',
      overflow: 'hidden',
    } as CSSStyleDeclaration);
    this.overlay.appendChild(el);
    this.glyphs.push({ el, col, row, kind });
  }

  /** Predictions that are never confirmed (e.g. no-echo contexts) self-expire. */
  private arm(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.clear(), 800);
  }

  clear(): void {
    for (const g of this.glyphs) g.el.remove();
    this.glyphs = [];
    this.confirmedRun = 0;
    if (this.expiry) {
      clearTimeout(this.expiry);
      this.expiry = null;
    }
  }

  dispose(): void {
    this.clear();
    this.overlay.remove();
  }
}
