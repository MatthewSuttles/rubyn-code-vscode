/**
 * Given a cursor position immediately after a `.` in a Ruby file, decide what
 * kind of receiver the user is dispatching on: a model class, an instance
 * of a model, an `ActiveRecord::Relation`, or unknown.
 *
 * The resolver is the brain of AssociationCompletionProvider. It walks the
 * call chain leftward from the cursor and reduces the type one step at a
 * time, using ModelIndex to ground association and scope lookups. When the
 * chain root is a local variable or ivar, the resolver falls back to:
 *   1. an assignment scan inside the enclosing `def`
 *   2. controller-conventional ivar binding (`@user` in UsersController)
 *
 * On any failure it returns `unknown` — the design contract is "never guess,"
 * because a wrong receiver type results in nonsense completions that erode
 * trust faster than no completions at all.
 */

import * as vscode from 'vscode';
import { ModelIndex } from '../rails/ModelIndex';

export type ReceiverType =
  | { kind: 'class'; modelName: string }
  | { kind: 'instance'; modelName: string }
  | { kind: 'relation'; modelName: string }
  | { kind: 'unknown' };

/** Standard AR class/relation methods that return a relation. */
export const RELATION_METHODS = new Set([
  'where',
  'order',
  'select',
  'group',
  'having',
  'pluck',
  'reorder',
  'distinct',
  'includes',
  'joins',
  'left_joins',
  'left_outer_joins',
  'preload',
  'eager_load',
  'references',
  'limit',
  'offset',
  'all',
  'none',
  'unscope',
  'lock',
  'readonly',
  'merge',
  'or',
]);

/** AR methods that return a single instance (or build one). */
export const INSTANCE_RETURNING_METHODS = new Set([
  'find',
  'find_by',
  'find_by!',
  'first',
  'last',
  'take',
  'take!',
  'find_or_initialize_by',
  'find_or_create_by',
  'find_or_create_by!',
  'create',
  'create!',
  'build',
  'new',
]);

interface ParsedChain {
  root: string;
  steps: string[];
}

export class ReceiverTypeResolver {
  constructor(private readonly index: ModelIndex) {}

  resolveAt(
    doc: vscode.TextDocument,
    pos: vscode.Position,
  ): ReceiverType {
    const text = doc.getText();
    const offset = doc.offsetAt(pos);
    if (text[offset - 1] !== '.') return { kind: 'unknown' };

    const chainStart = findChainStart(text, offset - 1);
    const chainText = text.slice(chainStart, offset - 1);
    const chain = parseChain(chainText);
    if (!chain) return { kind: 'unknown' };

    let type = this.resolveRoot(chain.root, text, offset, doc);
    for (const step of chain.steps) {
      type = this.transform(type, step);
      if (type.kind === 'unknown') return type;
    }
    return type;
  }

  private resolveRoot(
    root: string,
    text: string,
    cursorOffset: number,
    doc: vscode.TextDocument,
  ): ReceiverType {
    // Constant — look up directly.
    if (/^[A-Z]/.test(root)) {
      return this.index.byName(root)
        ? { kind: 'class', modelName: root }
        : { kind: 'unknown' };
    }

    // Variable (@ivar or local). Look for assignment in the enclosing def.
    const rhs = findAssignmentRhs(text, cursorOffset, root);
    if (rhs) {
      const inferred = this.inferRhsType(rhs);
      if (inferred.kind !== 'unknown') return inferred;
    }

    // Ivar without an assignment — try controller convention.
    if (root.startsWith('@')) {
      const conv = this.controllerIvarConvention(doc, root);
      if (conv) return conv;
    }

    return { kind: 'unknown' };
  }

  /**
   * Walk a chain like `User.where(...).first` and reduce to a ReceiverType.
   * Reuses the same chain parser as the cursor-side resolution path so RHS
   * type inference matches whatever the main code path would have produced.
   */
  private inferRhsType(rhs: string): ReceiverType {
    const parsed = parseChain(rhs.trim());
    if (!parsed) return { kind: 'unknown' };
    let type: ReceiverType;
    if (/^[A-Z]/.test(parsed.root)) {
      type = this.index.byName(parsed.root)
        ? { kind: 'class', modelName: parsed.root }
        : { kind: 'unknown' };
    } else {
      return { kind: 'unknown' };
    }
    for (const step of parsed.steps) {
      type = this.transform(type, step);
      if (type.kind === 'unknown') return type;
    }
    return type;
  }

  private transform(type: ReceiverType, step: string): ReceiverType {
    if (type.kind === 'unknown') return type;
    const model = this.index.byName(type.modelName);

    if (type.kind === 'class') {
      if (model) {
        if (model.scopes.some((s) => s.name === step)) {
          return { kind: 'relation', modelName: type.modelName };
        }
        if (model.classMethods.some((m) => m.name === step)) {
          // Class methods often return relations — best-effort, treat as
          // relation since `.where` chains keep working.
          return { kind: 'relation', modelName: type.modelName };
        }
      }
      if (RELATION_METHODS.has(step)) {
        return { kind: 'relation', modelName: type.modelName };
      }
      if (INSTANCE_RETURNING_METHODS.has(step)) {
        return { kind: 'instance', modelName: type.modelName };
      }
      return { kind: 'unknown' };
    }

    if (type.kind === 'instance') {
      if (model) {
        const assoc = model.associations.find((a) => a.name === step);
        if (assoc) {
          if (
            assoc.kind === 'has_many' ||
            assoc.kind === 'has_and_belongs_to_many'
          ) {
            return { kind: 'relation', modelName: assoc.targetClass };
          }
          return { kind: 'instance', modelName: assoc.targetClass };
        }
      }
      return { kind: 'unknown' };
    }

    // relation
    if (RELATION_METHODS.has(step)) return type;
    if (INSTANCE_RETURNING_METHODS.has(step)) {
      return { kind: 'instance', modelName: type.modelName };
    }
    if (model) {
      if (model.scopes.some((s) => s.name === step)) return type;
      const assoc = model.associations.find((a) => a.name === step);
      if (assoc) {
        if (
          assoc.kind === 'has_many' ||
          assoc.kind === 'has_and_belongs_to_many'
        ) {
          return { kind: 'relation', modelName: assoc.targetClass };
        }
        return { kind: 'instance', modelName: assoc.targetClass };
      }
    }
    return { kind: 'unknown' };
  }

  private controllerIvarConvention(
    doc: vscode.TextDocument,
    ivar: string,
  ): ReceiverType | null {
    const match = /app\/controllers\/(?:.+\/)?(\w+)_controller\.rb$/.exec(
      doc.uri.fsPath,
    );
    if (!match) return null;
    const controllerBase = match[1];
    const singular = simpleSingularize(controllerBase);
    const camel = camelize(singular);
    if (!this.index.byName(camel)) return null;
    if (ivar === `@${singular}`) {
      return { kind: 'instance', modelName: camel };
    }
    if (ivar === `@${controllerBase}`) {
      return { kind: 'relation', modelName: camel };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chain parsing
// ---------------------------------------------------------------------------

function findChainStart(text: string, dotPos: number): number {
  let i = dotPos;
  while (i > 0) {
    const c = text[i - 1];
    if (/[A-Za-z0-9_@?!:.]/.test(c)) {
      i -= 1;
      continue;
    }
    if (c === ')') {
      let depth = 1;
      i -= 1;
      while (i > 0 && depth > 0) {
        const prev = text[i - 1];
        if (prev === ')') depth += 1;
        else if (prev === '(') depth -= 1;
        i -= 1;
      }
      continue;
    }
    break;
  }
  return i;
}

function parseChain(s: string): ParsedChain | null {
  if (!s) return null;
  const rootMatch =
    /^(@?[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*|@?[a-z_][A-Za-z0-9_]*)/.exec(
      s,
    );
  if (!rootMatch) return null;
  const root = rootMatch[1];
  let i = root.length;
  const steps: string[] = [];
  while (i < s.length) {
    if (s[i] !== '.') return null;
    i += 1;
    const stepMatch = /^([A-Za-z_][A-Za-z0-9_]*[?!]?)/.exec(s.slice(i));
    if (!stepMatch) return null;
    steps.push(stepMatch[1]);
    i += stepMatch[1].length;
    if (s[i] === '(') {
      let depth = 1;
      i += 1;
      while (i < s.length && depth > 0) {
        if (s[i] === '(') depth += 1;
        else if (s[i] === ')') depth -= 1;
        i += 1;
      }
    }
  }
  return { root, steps };
}

// ---------------------------------------------------------------------------
// Assignment scanning
// ---------------------------------------------------------------------------

function findAssignmentRhs(
  text: string,
  cursorOffset: number,
  varName: string,
): string | null {
  const before = text.slice(0, cursorOffset);
  const lastDef = lastIndexOfRegex(before, /(^|\n)\s*def\s/);
  const startOffset = lastDef === -1 ? 0 : lastDef;
  const block = before.slice(startOffset);
  const escaped = escapeRegex(varName);
  const re = new RegExp(`^\\s*${escaped}\\s*=\\s*(.*?)$`, 'gm');
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    lastMatch = m;
  }
  return lastMatch ? lastMatch[1] : null;
}

function lastIndexOfRegex(text: string, re: RegExp): number {
  let lastIdx = -1;
  const search = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = search.exec(text)) !== null) {
    lastIdx = m.index;
    if (search.lastIndex === m.index) search.lastIndex += 1;
  }
  return lastIdx;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Inflection helpers (kept local — narrower than ModelTableResolver's)
// ---------------------------------------------------------------------------

function camelize(snake: string): string {
  return snake
    .split('_')
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : ''))
    .join('');
}

function simpleSingularize(plural: string): string {
  if (plural.endsWith('ies')) return plural.slice(0, -3) + 'y';
  if (
    plural.endsWith('ses') ||
    plural.endsWith('xes') ||
    plural.endsWith('zes') ||
    plural.endsWith('ches') ||
    plural.endsWith('shes')
  ) {
    return plural.slice(0, -2);
  }
  if (plural.endsWith('s')) return plural.slice(0, -1);
  return plural;
}
