/**
 * General Ruby class index — sibling to ModelIndex, deeper per-method data.
 *
 * Whereas ModelIndex only captures Rails-specific shape (associations,
 * scopes, method names + arity), ClassIndex captures what complexity
 * diagnostics need: method bodies, the ivars each method touches, the
 * class constants each method references, and the intra-class method calls
 * that LCOM4 uses to form its cohesion graph.
 *
 * Parsing remains line-based — the fourth Prism deferral. The metrics this
 * index feeds (cyclomatic, fan-out, LCOM4, public method count) are all
 * computable from disciplined token-level scanning, and the rest of the
 * services in src/rails/ already establish this trade-off. CLAUDE.md
 * captures the rationale.
 */

import * as vscode from 'vscode';

export type Visibility = 'public' | 'private' | 'protected';

export interface ClassMethodInfo {
  name: string;
  isClass: boolean;
  visibility: Visibility;
  /** 0-based inclusive line of `def`. */
  declarationLine: number;
  /** 0-based inclusive line of the matching `end`. */
  endLine: number;
  /** Raw body text between `def …` and matching `end` (excluding both). */
  body: string;
  /** Ivars referenced (e.g. `@foo`) inside the body. */
  ivarRefs: Set<string>;
  /** CamelCase class constants referenced inside the body (raw, dedup). */
  classRefs: Set<string>;
  /** Candidate method names (identifier shape) invoked inside the body. */
  methodCalls: Set<string>;
  /** Number of cyclomatic branch points found in the body. */
  branchPoints: number;
}

export interface ClassInfo {
  name: string;
  fileUri: vscode.Uri;
  /** 0-based inclusive line of `class …`. */
  declarationLine: number;
  /** 0-based inclusive line of the matching `end`. */
  endLine: number;
  parent: string | null;
  methods: ClassMethodInfo[];
}

export interface ClassIndexDeps {
  readFile(uri: vscode.Uri): Promise<string>;
  findRubyFiles(): Promise<vscode.Uri[]>;
}

export class ClassIndex {
  private byNameMap = new Map<string, ClassInfo>();
  private byFileMap = new Map<string, ClassInfo[]>();
  private watcher: vscode.FileSystemWatcher | null = null;

  private constructor(
    readonly root: vscode.Uri,
    private readonly deps: ClassIndexDeps,
  ) {}

  static async build(root: vscode.Uri, deps: ClassIndexDeps): Promise<ClassIndex> {
    const idx = new ClassIndex(root, deps);
    const files = await deps.findRubyFiles();
    await Promise.all(files.map((f) => idx.indexFile(f)));
    return idx;
  }

  byName(name: string): ClassInfo | undefined {
    return this.byNameMap.get(name);
  }

  classesIn(uri: vscode.Uri): ClassInfo[] {
    return this.byFileMap.get(uri.fsPath) ?? [];
  }

  all(): ClassInfo[] {
    return Array.from(this.byNameMap.values());
  }

  async reparseFile(uri: vscode.Uri): Promise<void> {
    const previous = this.byFileMap.get(uri.fsPath) ?? [];
    for (const c of previous) this.byNameMap.delete(c.name);
    this.byFileMap.delete(uri.fsPath);
    await this.indexFile(uri);
  }

  removeFile(uri: vscode.Uri): void {
    const previous = this.byFileMap.get(uri.fsPath) ?? [];
    for (const c of previous) this.byNameMap.delete(c.name);
    this.byFileMap.delete(uri.fsPath);
  }

  startWatching(folder: vscode.WorkspaceFolder): void {
    if (this.watcher) return;
    const pattern = new vscode.RelativePattern(folder, '{app,lib}/**/*.rb');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange((uri) => void this.reparseFile(uri));
    this.watcher.onDidCreate((uri) => void this.reparseFile(uri));
    this.watcher.onDidDelete((uri) => this.removeFile(uri));
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = null;
  }

  private async indexFile(uri: vscode.Uri): Promise<void> {
    let source: string;
    try {
      source = await this.deps.readFile(uri);
    } catch {
      return;
    }
    const classes = parseClasses(source, uri);
    this.byFileMap.set(uri.fsPath, classes);
    for (const c of classes) this.byNameMap.set(c.name, c);
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const CLASS_DECL =
  /^\s*class\s+([A-Z][A-Za-z0-9_:]*)\s*(?:<\s*([A-Z][A-Za-z0-9_:]*))?\s*$/;
const MODULE_DECL = /^\s*module\s+([A-Z][A-Za-z0-9_]*)\s*$/;
const DEF_LINE = /^(\s*)def\s+(self\.)?([A-Za-z_][A-Za-z0-9_?!=]*)/;
const VISIBILITY_LINE = /^\s*(public|private|protected)\s*$/;
const CLASS_SHIFT = /^\s*class\s*<<\s*self\s*$/;
const END_LINE = /^\s*end\s*$/;

/** Tokens that increment cyclomatic complexity when found as word boundaries. */
const BRANCH_KEYWORDS = ['if', 'elsif', 'unless', 'while', 'until', 'when', 'rescue'];

interface OpenFrame {
  kind: 'module' | 'class' | 'class_shift' | 'def' | 'block';
  namespace: string;
  startLine: number;
  // Class-frame specifics:
  name?: string;
  parent?: string | null;
  methods?: ClassMethodInfo[];
  currentVisibility?: Visibility;
  inClassShift?: boolean;
  // Def-frame specifics:
  defInfo?: ClassMethodInfo;
  defOwnerClassFrame?: OpenFrame;
  defStartLine?: number;
}

function parseClasses(source: string, uri: vscode.Uri): ClassInfo[] {
  const lines = source.split('\n');
  const stack: OpenFrame[] = [];
  const completed: ClassInfo[] = [];

  const classFrame = (): OpenFrame | undefined => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].kind === 'class') return stack[i];
    }
    return undefined;
  };

  const inClassShift = (): boolean => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].kind === 'class_shift') return true;
      if (stack[i].kind === 'class') return false;
    }
    return false;
  };

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const rawLine = lines[lineIdx];
    const line = stripComment(rawLine);
    if (!line.trim()) continue;

    if (CLASS_DECL.test(line)) {
      const m = CLASS_DECL.exec(line)!;
      const parentNs = stack.length > 0 ? stack[stack.length - 1].namespace : '';
      const nameWithNs = parentNs ? `${parentNs}::${m[1]}` : m[1];
      stack.push({
        kind: 'class',
        namespace: nameWithNs,
        startLine: lineIdx,
        name: nameWithNs,
        parent: m[2] ?? null,
        methods: [],
        currentVisibility: 'public',
      });
      continue;
    }

    if (MODULE_DECL.test(line)) {
      const m = MODULE_DECL.exec(line)!;
      const parentNs = stack.length > 0 ? stack[stack.length - 1].namespace : '';
      const ns = parentNs ? `${parentNs}::${m[1]}` : m[1];
      stack.push({ kind: 'module', namespace: ns, startLine: lineIdx });
      continue;
    }

    if (CLASS_SHIFT.test(line)) {
      const ns = stack[stack.length - 1]?.namespace ?? '';
      stack.push({ kind: 'class_shift', namespace: ns, startLine: lineIdx });
      continue;
    }

    if (END_LINE.test(line)) {
      const popped = stack.pop();
      if (!popped) continue;
      if (popped.kind === 'class') {
        completed.push({
          name: popped.name!,
          fileUri: uri,
          declarationLine: popped.startLine,
          endLine: lineIdx,
          parent: popped.parent ?? null,
          methods: popped.methods!,
        });
      } else if (popped.kind === 'def' && popped.defInfo && popped.defOwnerClassFrame) {
        popped.defInfo.endLine = lineIdx;
        popped.defInfo.body = lines
          .slice(popped.defStartLine! + 1, lineIdx)
          .join('\n');
        analyzeMethodBody(popped.defInfo);
        popped.defOwnerClassFrame.methods!.push(popped.defInfo);
      }
      continue;
    }

    const visMatch = VISIBILITY_LINE.exec(line);
    if (visMatch && stack[stack.length - 1]?.kind === 'class') {
      const cf = stack[stack.length - 1];
      cf.currentVisibility = visMatch[1] as Visibility;
      continue;
    }

    const defMatch = DEF_LINE.exec(line);
    if (defMatch) {
      const owner = classFrame();
      const isClass = defMatch[2] === 'self.' || inClassShift();

      // One-line def — `def foo; end`, `def foo(x) = x + 1`, etc. Record
      // immediately without opening a `def` frame so the outer `end` matcher
      // still balances correctly.
      if (isOneLineDef(line)) {
        if (owner) {
          const info: ClassMethodInfo = {
            name: defMatch[3],
            isClass,
            visibility: owner.currentVisibility ?? 'public',
            declarationLine: lineIdx,
            endLine: lineIdx,
            body: extractOneLineBody(line),
            ivarRefs: new Set(),
            classRefs: new Set(),
            methodCalls: new Set(),
            branchPoints: 0,
          };
          analyzeMethodBody(info);
          owner.methods!.push(info);
        }
        continue;
      }

      if (!owner) {
        // def outside any class — track block for `end`.
        stack.push({
          kind: 'def',
          namespace: stack[stack.length - 1]?.namespace ?? '',
          startLine: lineIdx,
        });
        continue;
      }
      const methodInfo: ClassMethodInfo = {
        name: defMatch[3],
        isClass,
        visibility: owner.currentVisibility ?? 'public',
        declarationLine: lineIdx,
        endLine: lineIdx,
        body: '',
        ivarRefs: new Set(),
        classRefs: new Set(),
        methodCalls: new Set(),
        branchPoints: 0,
      };
      stack.push({
        kind: 'def',
        namespace: owner.namespace,
        startLine: lineIdx,
        defInfo: methodInfo,
        defOwnerClassFrame: owner,
        defStartLine: lineIdx,
      });
      continue;
    }

    // Generic block opener (anything ending in `do` or `{...` with a block).
    // We only track block depth to keep `end` matching correct.
    if (isBlockOpener(line)) {
      stack.push({
        kind: 'block',
        namespace: stack[stack.length - 1]?.namespace ?? '',
        startLine: lineIdx,
      });
      continue;
    }
  }

  return completed;
}

function isOneLineDef(line: string): boolean {
  // `def foo(x) = expr` — endless method (Ruby 3+).
  if (/\bdef\b[^\n]*=\s*\S/.test(line) && !/[<>!*]=/.test(line)) return true;
  // `def foo; ...; end` — trailing `end` outside a string after `def`.
  const scrubbed = stripComment(line);
  if (/\bdef\b/.test(scrubbed) && /;\s*end\s*$/.test(scrubbed)) return true;
  // `def foo() end` — empty body on one line.
  if (/\bdef\b.*\bend\s*$/.test(scrubbed) && !/\n/.test(scrubbed)) {
    // Conservative: only treat as one-line if there are no further block
    // openers between def and end on this same line. Block openers (`do`,
    // bare `if`/`while`) would create nested ends we still need to balance.
    const middle = scrubbed.slice(scrubbed.indexOf('def'), scrubbed.lastIndexOf('end'));
    if (!/\bdo\b|\bbegin\b|\bcase\b/.test(middle)) return true;
  }
  return false;
}

function extractOneLineBody(line: string): string {
  // Best-effort: strip leading `def name(args)?` and trailing `end`.
  const scrubbed = stripComment(line);
  const endless = /\bdef\b[^\n]*?=\s*(.*)$/.exec(scrubbed);
  if (endless) return endless[1].trim();
  const semi = /;\s*(.*?)\s*;\s*end\s*$/.exec(scrubbed);
  if (semi) return semi[1];
  return '';
}

function isBlockOpener(line: string): boolean {
  // Lines ending in ` do` (with optional `|args|`) open a block; or lines
  // beginning with `begin`, `case`, `if`, `unless`, `while`, `until` that
  // are NOT one-liners (no trailing `end` on the same line).
  const trimmed = line.trim();
  if (/[^#]\bdo\s*(\|[^|]*\|)?\s*$/.test(line)) return true;
  if (
    /^(begin|case|if|unless|while|until)\b/.test(trimmed) &&
    !/\bend\b/.test(trimmed)
  ) {
    return true;
  }
  return false;
}

function stripComment(line: string): string {
  let inString: false | '"' | "'" = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inString) {
      if (c === inString && line[i - 1] !== '\\') inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      continue;
    }
    if (c === '#') return line.slice(0, i);
  }
  return line;
}

// ---------------------------------------------------------------------------
// Body analysis
// ---------------------------------------------------------------------------

function analyzeMethodBody(method: ClassMethodInfo): void {
  const tokens = scrubStringsAndComments(method.body);
  // Ivar refs
  for (const m of tokens.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)) {
    method.ivarRefs.add('@' + m[1]);
  }
  // Class constant refs — CamelCase identifiers, optionally namespaced.
  for (const m of tokens.matchAll(
    /\b([A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*)\b/g,
  )) {
    method.classRefs.add(m[1]);
  }
  // Identifier-shaped tokens that could be method calls. Filter out keywords
  // and the method's own name. The diagnostic-side LCOM4 calculator only
  // treats those that match another sibling method's name as edges.
  for (const m of tokens.matchAll(
    /(?<![@:.\w])([a-z_][a-z0-9_]*[?!]?)(?!\s*=[^=])/g,
  )) {
    const name = m[1];
    if (RUBY_KEYWORDS.has(name)) continue;
    if (name === method.name) continue;
    method.methodCalls.add(name);
  }
  // Cyclomatic branch points
  method.branchPoints = countBranchPoints(tokens);
}

const RUBY_KEYWORDS = new Set([
  'def', 'end', 'class', 'module', 'do', 'begin', 'if', 'elsif', 'else',
  'unless', 'while', 'until', 'case', 'when', 'then', 'in', 'return',
  'yield', 'break', 'next', 'redo', 'retry', 'raise', 'rescue', 'ensure',
  'super', 'self', 'nil', 'true', 'false', 'and', 'or', 'not', 'puts',
  'print', 'require', 'require_relative', 'attr_reader', 'attr_writer',
  'attr_accessor', 'include', 'extend', 'prepend', 'private', 'public',
  'protected', 'new', 'lambda', 'proc',
]);

function scrubStringsAndComments(text: string): string {
  // Replace string/heredoc contents with spaces of equal length so byte
  // offsets stay roughly aligned. Strip line comments outright.
  const out: string[] = [];
  let inString: false | '"' | "'" = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === inString && text[i - 1] !== '\\') inString = false;
      out.push(c === '\n' ? '\n' : ' ');
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      out.push(' ');
      continue;
    }
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      if (i < text.length) out.push('\n');
      continue;
    }
    out.push(c);
  }
  return out.join('');
}

function countBranchPoints(text: string): number {
  let count = 0;
  for (const keyword of BRANCH_KEYWORDS) {
    const re = new RegExp(`\\b${keyword}\\b`, 'g');
    count += (text.match(re) ?? []).length;
  }
  // `&&` and `||` (logical operators)
  count += (text.match(/&&/g) ?? []).length;
  count += (text.match(/\|\|/g) ?? []).length;
  // Ternary `?` — heuristic: `<expr> ? <expr> : <expr>`. Counting `?` would
  // catch predicate method names; restrict to `?` followed by whitespace then
  // an expression and not at the end of an identifier.
  count += (text.match(/(?<=[A-Za-z0-9_)\]])\s*\?\s+[^:]/g) ?? []).length;
  return count;
}
