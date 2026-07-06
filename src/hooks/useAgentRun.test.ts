import { describe, expect, it } from 'vitest';
import { applyTodos } from './useAgentRun';
import type { ChatHistoryItem, TodoItem } from '@/shared/ipc-types';

const text = (id: string): ChatHistoryItem => ({
  kind: 'text',
  id,
  role: 'assistant',
  content: 'hi',
});

const TODOS_A: TodoItem[] = [
  { text: 'Install nginx', status: 'in_progress' },
  { text: 'Configure TLS', status: 'pending' },
];

describe('applyTodos', () => {
  it('appends a single todos card the first time', () => {
    const out = applyTodos([text('a')], TODOS_A);
    expect(out).toHaveLength(2);
    const card = out[1];
    expect(card.kind).toBe('todos');
    if (card.kind === 'todos') {
      expect(card.todos).toEqual(TODOS_A);
      expect(card.id).toMatch(/^todo_/);
    }
  });

  it('updates the existing card in place, keeping its position and id', () => {
    const first = applyTodos([text('a'), text('b')], TODOS_A);
    const card = first.find((i) => i.kind === 'todos');
    const originalId = card && card.kind === 'todos' ? card.id : '';

    const updated: TodoItem[] = [
      { text: 'Install nginx', status: 'completed' },
      { text: 'Configure TLS', status: 'in_progress' },
    ];
    const second = applyTodos(first, updated);

    // No new card was appended — still exactly one todos item.
    expect(second.filter((i) => i.kind === 'todos')).toHaveLength(1);
    // Same slot as before (index 2, after the two text items).
    expect(second[2].kind).toBe('todos');
    const after = second[2];
    if (after.kind === 'todos') {
      expect(after.id).toBe(originalId); // stable id → stable React key
      expect(after.todos).toEqual(updated);
    }
  });

  it('does not mutate the input feed array', () => {
    const feed = [text('a')];
    const out = applyTodos(feed, TODOS_A);
    expect(feed).toHaveLength(1);
    expect(out).not.toBe(feed);
  });
});
