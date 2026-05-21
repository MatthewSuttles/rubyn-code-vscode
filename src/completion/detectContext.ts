/**
 * Pure-function trigger detector for query-method completion. Extracted from
 * QueryMethodCompletionProvider so it can be table-tested without the VS Code
 * host.
 *
 * Approach:
 *   1. Walk leftward from the cursor to the nearest unmatched `(`.
 *   2. Walk back through the receiver expression preceding that `(`, allowing
 *      balanced parens (so `User.includes(:posts).where(` works).
 *   3. Pull the leftmost CamelCase identifier out of the receiver — that's
 *      the model.
 *
 * This is regex-shaped and intentionally fuzzy; it misses some chains (string
 * literals containing parens, multi-line method calls split across `do…end`
 * blocks). Phase 3 replaces this with Prism.
 */

export const QUERY_METHODS = new Set([
  'where',
  'order',
  'select',
  'group',
  'pluck',
  'find_by',
  'reorder',
  'having',
]);

export type CursorContext =
  | 'bare-symbol'
  | 'rocket-key'
  | 'shorthand-key'
  | 'open';

export interface ContextMatch {
  model: string;
  method: string;
  partialToken: string;
  partialStart: number;
  partialEnd: number;
  cursorContext: CursorContext;
}

const MAX_LOOKBACK = 4000;

export function detectContext(text: string, offset: number): ContextMatch | null {
  const openParenIdx = findUnmatchedOpenParen(text, offset);
  if (openParenIdx === -1) return null;

  const callSite = extractCallSite(text, openParenIdx);
  if (!callSite) return null;
  if (!QUERY_METHODS.has(callSite.method)) return null;

  const model = extractModel(callSite.receiver);
  if (!model) return null;

  const partial = findPartialToken(text, offset);
  const cursorContext = detectCursorContext(text, partial.start, partial.end);

  return {
    model,
    method: callSite.method,
    partialToken: text.slice(partial.start, partial.end),
    partialStart: partial.start,
    partialEnd: partial.end,
    cursorContext,
  };
}

function findUnmatchedOpenParen(text: string, offset: number): number {
  let depth = 0;
  const lowerBound = Math.max(0, offset - MAX_LOOKBACK);
  for (let i = offset - 1; i >= lowerBound; i -= 1) {
    const c = text[i];
    if (c === ')') depth += 1;
    else if (c === '(') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

interface CallSite {
  receiver: string;
  method: string;
}

/**
 * Given the position of an open paren, walk back through the immediately
 * preceding `.method` and the receiver expression that fed it. The receiver
 * may itself contain balanced parens (chained method calls with args).
 */
function extractCallSite(text: string, openParenIdx: number): CallSite | null {
  let i = openParenIdx;
  // Skip whitespace between method name and `(`.
  while (i > 0 && /\s/.test(text[i - 1])) i -= 1;
  // Walk the method name leftward (\w chars, last char is the dispatch name).
  const methodEnd = i;
  while (i > 0 && /\w/.test(text[i - 1])) i -= 1;
  const methodStart = i;
  if (methodEnd === methodStart) return null;
  const method = text.slice(methodStart, methodEnd);

  if (text[i - 1] !== '.') return null;
  i -= 1; // step past the `.`

  // Walk receiver: identifier chars, dots, colons (for ::), and balanced
  // parenthesized arg lists. Stop on whitespace or punctuation outside parens.
  const receiverEnd = i;
  const lowerBound = Math.max(0, openParenIdx - MAX_LOOKBACK);
  let depth = 0;
  while (i > lowerBound) {
    const c = text[i - 1];
    if (depth > 0) {
      if (c === '(') depth -= 1;
      else if (c === ')') depth += 1;
      i -= 1;
      continue;
    }
    if (c === ')') {
      depth += 1;
      i -= 1;
      continue;
    }
    if (/[A-Za-z0-9_.:]/.test(c)) {
      i -= 1;
      continue;
    }
    break;
  }
  const receiver = text.slice(i, receiverEnd);
  if (!receiver) return null;
  return { receiver, method };
}

function extractModel(receiver: string): string | null {
  const m = /([A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*)/.exec(receiver);
  return m ? m[1] : null;
}

function findPartialToken(
  text: string,
  offset: number,
): { start: number; end: number } {
  let start = offset;
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start -= 1;
  let end = offset;
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end += 1;
  return { start, end };
}

function detectCursorContext(
  text: string,
  start: number,
  end: number,
): CursorContext {
  const charBefore = start > 0 ? text[start - 1] : '';
  const afterToken = text.slice(end, end + 6);

  if (charBefore === ':' && text[start - 2] !== ':') {
    if (/^\s*=>/.test(afterToken)) return 'rocket-key';
    return 'bare-symbol';
  }
  if (afterToken[0] === ':' && afterToken[1] !== ':') {
    return 'shorthand-key';
  }
  return 'open';
}
