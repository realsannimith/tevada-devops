/**
 * SQL code editor — a CodeMirror 6 editor mirroring the Outerbase Studio query
 * editor: real SQL syntax highlighting, line numbers, a matching dark/light
 * theme, and schema-aware autocomplete. Used by the Database Editor's query
 * panel (see DatabaseEditorView.tsx).
 *
 * The theme is derived from the app's own CSS design tokens (var(--…)) so it
 * always matches the FCode surface, and switches with the app's light/dark mode
 * via next-themes — same approach Outerbase takes.
 */
import { useMemo } from 'react';
import { useTheme } from 'next-themes';
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror';
import { createTheme } from '@uiw/codemirror-themes';
import { tags as t } from '@lezer/highlight';
import {
  MySQL as MySQLDialect,
  PostgreSQL as PostgresDialect,
  sql,
  type SQLNamespace,
} from '@codemirror/lang-sql';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** Selects the SQL dialect for highlighting + completion. */
  engine: string;
  /** Table names for autocomplete. */
  tables?: string[];
  /** ⌘↵ / Ctrl↵ handler. */
  onRun?: () => void;
  placeholder?: string;
};

function useEditorTheme() {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== 'light';
  return useMemo(
    () =>
      createTheme({
        theme: dark ? 'dark' : 'light',
        settings: {
          // Bind to the app's design tokens so the editor is part of the surface.
          background: 'var(--background)',
          foreground: 'var(--foreground)',
          caret: 'var(--primary)',
          selection: dark ? 'rgba(51,156,255,0.22)' : 'rgba(1,105,204,0.18)',
          selectionMatch: dark ? 'rgba(51,156,255,0.16)' : 'rgba(1,105,204,0.12)',
          lineHighlight: 'var(--accent)',
          gutterBackground: 'transparent',
          gutterForeground: 'var(--muted-foreground)',
          gutterBorder: 'transparent',
          fontFamily:
            'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
        },
        styles: [
          { tag: [t.keyword, t.operatorKeyword, t.modifier], color: dark ? '#4aa8ff' : '#0169cc' },
          { tag: [t.string, t.special(t.string)], color: dark ? '#e5915a' : '#c2410c' },
          { tag: [t.number, t.bool, t.null], color: dark ? '#e6c15a' : '#b45309' },
          { tag: [t.comment, t.lineComment, t.blockComment], color: dark ? '#6f8f6f' : '#3f7a3f' },
          { tag: [t.typeName, t.definition(t.typeName)], color: dark ? '#5ec7a8' : '#0f766e' },
          { tag: [t.function(t.variableName), t.function(t.propertyName)], color: dark ? '#c792ea' : '#7c3aed' },
          { tag: [t.name, t.propertyName], color: 'var(--foreground)' },
          { tag: [t.punctuation, t.separator], color: 'var(--muted-foreground)' },
        ],
      }),
    [dark],
  );
}

export function SqlCodeEditor({ value, onChange, engine, tables, onRun, placeholder }: Props) {
  const theme = useEditorTheme();

  const extensions = useMemo<Extension[]>(() => {
    const dialect = engine === 'postgresql' ? PostgresDialect : MySQLDialect;
    const schema: SQLNamespace | undefined = tables?.length
      ? Object.fromEntries(tables.map((name): [string, string[]] => [name, []]))
      : undefined;
    const runKeymap = Prec.highest(
      keymap.of([
        {
          key: 'Mod-Enter',
          run: () => {
            onRun?.();
            return true;
          },
        },
      ]),
    );
    return [
      sql({ dialect, schema, upperCaseKeywords: true }),
      runKeymap,
      EditorView.lineWrapping,
    ];
  }, [engine, tables, onRun]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={theme}
      extensions={extensions}
      placeholder={placeholder}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        foldGutter: false,
        autocompletion: true,
        bracketMatching: true,
        closeBrackets: true,
        indentOnInput: true,
        highlightSelectionMatches: true,
      }}
      style={{ fontSize: '12.5px' }}
    />
  );
}
