/**
 * Table-driven tests for detectContext — the trigger-detection heart of
 * query-method completion. Covers ≥30 cursor positions across the three
 * documented cursor contexts plus negative / edge cases.
 *
 * Each `text` uses `|` to mark the cursor; the test rig strips it before
 * passing the text + computed offset into detectContext.
 */

import { describe, it, expect } from 'vitest';
import { detectContext, ContextMatch } from '../../../src/completion/detectContext';

interface Case {
  name: string;
  text: string;
  expect: Partial<ContextMatch> | null;
}

function run(text: string): {
  result: ReturnType<typeof detectContext>;
  cleanText: string;
} {
  const offset = text.indexOf('|');
  if (offset === -1) throw new Error(`No cursor marker in: ${text}`);
  const cleanText = text.slice(0, offset) + text.slice(offset + 1);
  return { result: detectContext(cleanText, offset), cleanText };
}

const POSITIVE_CASES: Case[] = [
  // ---- where with bare-symbol arguments ----
  {
    name: 'where(:|) — open right after colon',
    text: 'User.where(:|)',
    expect: { model: 'User', method: 'where', cursorContext: 'bare-symbol' },
  },
  {
    name: 'where(:nam|) — partial bare symbol',
    text: 'User.where(:nam|)',
    expect: { model: 'User', method: 'where', cursorContext: 'bare-symbol', partialToken: 'nam' },
  },
  {
    name: 'where(:name|, :email) — middle bare symbol',
    text: 'User.where(:name|, :email)',
    expect: { model: 'User', method: 'where', cursorContext: 'bare-symbol', partialToken: 'name' },
  },
  {
    name: 'order(:|)',
    text: 'User.order(:|)',
    expect: { model: 'User', method: 'order', cursorContext: 'bare-symbol' },
  },
  {
    name: 'select(:|)',
    text: 'User.select(:|)',
    expect: { model: 'User', method: 'select', cursorContext: 'bare-symbol' },
  },
  {
    name: 'group(:|)',
    text: 'User.group(:|)',
    expect: { model: 'User', method: 'group', cursorContext: 'bare-symbol' },
  },
  {
    name: 'pluck(:|)',
    text: 'User.pluck(:|)',
    expect: { model: 'User', method: 'pluck', cursorContext: 'bare-symbol' },
  },
  {
    name: 'reorder(:|)',
    text: 'User.reorder(:|)',
    expect: { model: 'User', method: 'reorder', cursorContext: 'bare-symbol' },
  },
  {
    name: 'having(:|)',
    text: 'User.having(:|)',
    expect: { model: 'User', method: 'having', cursorContext: 'bare-symbol' },
  },
  {
    name: 'find_by(:|)',
    text: 'User.find_by(:|)',
    expect: { model: 'User', method: 'find_by', cursorContext: 'bare-symbol' },
  },

  // ---- rocket-style hash keys ----
  {
    name: 'where(:nam| => 1) — rocket key',
    text: 'User.where(:nam| => 1)',
    expect: { model: 'User', method: 'where', cursorContext: 'rocket-key', partialToken: 'nam' },
  },
  {
    name: 'where(:name|=>1) — rocket key, no spaces',
    text: 'User.where(:name|=>1)',
    expect: { model: 'User', method: 'where', cursorContext: 'rocket-key' },
  },

  // ---- shorthand hash keys ----
  {
    name: 'where(nam|:) — shorthand key, partial',
    text: 'User.where(nam|: 1)',
    expect: { model: 'User', method: 'where', cursorContext: 'shorthand-key', partialToken: 'nam' },
  },
  {
    name: 'where(name|: 1)',
    text: 'User.where(name|: 1)',
    expect: { model: 'User', method: 'where', cursorContext: 'shorthand-key' },
  },
  {
    name: 'find_by(emai|: "x")',
    text: 'User.find_by(emai|: "x")',
    expect: { model: 'User', method: 'find_by', cursorContext: 'shorthand-key' },
  },

  // ---- open / uncommitted position ----
  {
    name: 'where(|) — empty, no commitment',
    text: 'User.where(|)',
    expect: { model: 'User', method: 'where', cursorContext: 'open', partialToken: '' },
  },
  {
    name: 'where(nam|) — open partial (no `:`)',
    text: 'User.where(nam|)',
    expect: { model: 'User', method: 'where', cursorContext: 'open', partialToken: 'nam' },
  },
  {
    name: 'where(name: 1, em|) — after first pair',
    text: 'User.where(name: 1, em|)',
    expect: { model: 'User', method: 'where', cursorContext: 'open', partialToken: 'em' },
  },

  // ---- chained receivers ----
  {
    name: 'User.active.where(:|) — through a scope',
    text: 'User.active.where(:|)',
    expect: { model: 'User', method: 'where', cursorContext: 'bare-symbol' },
  },
  {
    name: 'User.includes(:posts).where(:|)',
    text: 'User.includes(:posts).where(:|)',
    expect: { model: 'User', method: 'where', cursorContext: 'bare-symbol' },
  },
  {
    name: 'User.joins(:posts).order(:|)',
    text: 'User.joins(:posts).order(:|)',
    expect: { model: 'User', method: 'order', cursorContext: 'bare-symbol' },
  },

  // ---- snake_case and namespaced models ----
  {
    name: 'OrderItem.where(:|)',
    text: 'OrderItem.where(:|)',
    expect: { model: 'OrderItem', method: 'where', cursorContext: 'bare-symbol' },
  },
  {
    name: 'Admin::User.where(:|) — namespaced constant preserved as model',
    text: 'Admin::User.where(:|)',
    expect: { model: 'Admin::User', method: 'where', cursorContext: 'bare-symbol' },
  },
  {
    name: 'User.where("active = ?", true).where(:|) — chain after a string arg',
    text: 'User.where("active = ?", true).where(:|)',
    expect: { model: 'User', method: 'where', cursorContext: 'bare-symbol' },
  },

  // ---- multi-line ----
  {
    name: 'multi-line where(...) with cursor on a later line',
    text: 'User.where(\n  name: "x",\n  emai|\n)',
    expect: { model: 'User', method: 'where', cursorContext: 'open', partialToken: 'emai' },
  },
];

const NEGATIVE_CASES: Case[] = [
  {
    name: 'not a query method',
    text: 'User.create(:|)',
    expect: null,
  },
  {
    name: 'unrelated method on chain',
    text: 'User.active.count(:|)',
    expect: null,
  },
  {
    name: 'cursor outside any parens',
    text: 'User.where(:name) |',
    expect: null,
  },
  {
    name: 'lowercase receiver — not a model constant',
    text: 'user.where(:|)',
    expect: null,
  },
  {
    name: 'plain function call (no receiver)',
    text: 'where(:|)',
    expect: null,
  },
];

describe('detectContext — positive cases', () => {
  for (const c of POSITIVE_CASES) {
    it(c.name, () => {
      const { result } = run(c.text);
      expect(result).not.toBeNull();
      if (c.expect) {
        for (const [key, value] of Object.entries(c.expect)) {
          expect(result![key as keyof ContextMatch]).toBe(value);
        }
      }
    });
  }
});

describe('detectContext — negative cases', () => {
  for (const c of NEGATIVE_CASES) {
    it(c.name, () => {
      const { result } = run(c.text);
      expect(result).toBeNull();
    });
  }
});

describe('detectContext — partial-token offsets', () => {
  it('partialStart/partialEnd bracket the partial token only', () => {
    const text = 'User.where(:nam';
    const result = detectContext(text, text.length);
    expect(result).not.toBeNull();
    expect(text.slice(result!.partialStart, result!.partialEnd)).toBe('nam');
  });

  it('partial range is empty when cursor sits right after `:`', () => {
    const text = 'User.where(:';
    const result = detectContext(text, text.length);
    expect(result).not.toBeNull();
    expect(result!.partialStart).toBe(result!.partialEnd);
    expect(result!.partialToken).toBe('');
  });
});

describe('detectContext — count', () => {
  it('runs at least 30 positive + negative scenarios', () => {
    expect(POSITIVE_CASES.length + NEGATIVE_CASES.length).toBeGreaterThanOrEqual(30);
  });
});
