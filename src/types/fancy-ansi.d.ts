/**
 * Types for fancy-ansi (ANSI escape codes -> HTML, used by the live log panel).
 *
 * The package ships real .d.ts files but declares no `types` entry in its
 * package.json, so TypeScript's `moduleResolution: "node"` can't find them.
 * Rather than move the whole project to `bundler` resolution for one dependency,
 * we declare the sliver of the API we actually use.
 */
declare module 'fancy-ansi' {
  export class FancyAnsi {
    /** Convert a string containing ANSI SGR codes to HTML. HTML-escapes the
     *  text content, so the output is safe to inject as markup. */
    toHtml(text: string): string;
  }
}
