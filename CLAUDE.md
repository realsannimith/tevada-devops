# CLAUDE.md

Read **AGENTS.md** first — it is the source of truth for this repo.

## Running the app

When the user asks to run or preview UI changes, use the Electron dev app:

```bash
cd "Tevada DevOps" && bun run electron:dev
```

## Design (mandatory for UI work)

All renderer UI must match the **FCode / Codex design system** documented in
`AGENTS.md` § UI Design System.

Before shipping UI:

1. Check `src/index.css` for tokens and component classes (`.composer`, `.chat-surface-divider`, `.surface-panel`, `.skill-chip`, `.glass`).
2. Mirror patterns from `src/components/ChatPanel.tsx` (chat) and `src/components/WizardsView.tsx` (split wizard + agent feed).
3. Reuse `AgentFeed` and `src/components/chat/chatTypography.ts` for any agent transcript.

**Never** introduce a separate visual language (Material blue buttons, Bootstrap forms,
thick pane borders, `bg-card` main columns).

Reference implementation in sibling repo: `../FCode/design.md`, `../FCode/apps/web/src/index.css`.
