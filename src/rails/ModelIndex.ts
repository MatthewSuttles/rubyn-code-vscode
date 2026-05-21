/**
 * Index of every Ruby file under `app/models`. Source of truth for class-
 * shape information downstream features need: associations, scopes, declared
 * class/instance methods, parent class.
 *
 * Parsing is regex + line-scan, consistent with the rest of the rails/
 * services. The Phase 3 design called for Prism via @ruby/prism; we deferred
 * the WASI/ESM/webpack integration cost and shipped a line-based parser that
 * recognizes the macros and `def` declarations that sit at class-body top
 * level — which is where every macro this phase cares about lives. Method
 * bodies are intentionally skipped (we only need name + arity).
 */

import * as vscode from 'vscode';
import { camelToSnake, pluralize } from './ModelTableResolver';

export type AssociationKind =
  | 'has_many'
  | 'has_one'
  | 'belongs_to'
  | 'has_and_belongs_to_many';

export interface AssociationInfo {
  kind: AssociationKind;
  name: string;
  /** Resolved class name. e.g. 'Post' for `has_many :posts`. */
  targetClass: string;
  through: string | null;
  polymorphic: boolean;
}

export interface ScopeInfo {
  name: string;
  arity: number;
  signature: string;
}

export interface MethodInfo {
  name: string;
  isClass: boolean;
  arity: number;
}

export interface ModelInfo {
  name: string;
  fileUri: vscode.Uri;
  parent: string | null;
  associations: AssociationInfo[];
  scopes: ScopeInfo[];
  classMethods: MethodInfo[];
  instanceMethods: MethodInfo[];
}

export interface ModelIndexDeps {
  /** Read the contents of a model file (injectable for tests). */
  readFile(uri: vscode.Uri): Promise<string>;
  /** Glob-style enumeration of model files under app/models/. */
  findModelFiles(): Promise<vscode.Uri[]>;
}

export class ModelIndex {
  private byNameMap = new Map<string, ModelInfo>();
  private byFileMap = new Map<string, ModelInfo[]>();
  private watcher: vscode.FileSystemWatcher | null = null;

  private constructor(
    readonly root: vscode.Uri,
    private readonly deps: ModelIndexDeps,
  ) {}

  static async build(
    root: vscode.Uri,
    deps: ModelIndexDeps,
  ): Promise<ModelIndex> {
    const idx = new ModelIndex(root, deps);
    const files = await deps.findModelFiles();
    await Promise.all(files.map((f) => idx.indexFile(f)));
    return idx;
  }

  byName(name: string): ModelInfo | undefined {
    return this.byNameMap.get(name);
  }

  all(): ModelInfo[] {
    return Array.from(this.byNameMap.values());
  }

  /**
   * Re-parse a single file in place. Removes the file's previous models from
   * the index before installing the fresh ones.
   */
  async reparseFile(uri: vscode.Uri): Promise<void> {
    const previous = this.byFileMap.get(uri.fsPath) ?? [];
    for (const model of previous) {
      this.byNameMap.delete(model.name);
    }
    this.byFileMap.delete(uri.fsPath);
    await this.indexFile(uri);
  }

  /** Remove a file's models entirely (for delete events). */
  removeFile(uri: vscode.Uri): void {
    const previous = this.byFileMap.get(uri.fsPath) ?? [];
    for (const model of previous) {
      this.byNameMap.delete(model.name);
    }
    this.byFileMap.delete(uri.fsPath);
  }

  startWatching(folder: vscode.WorkspaceFolder): void {
    if (this.watcher) return;
    const pattern = new vscode.RelativePattern(folder, 'app/models/**/*.rb');
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
    const models = parseModels(source, uri);
    this.byFileMap.set(uri.fsPath, models);
    for (const model of models) {
      this.byNameMap.set(model.name, model);
    }
  }
}

// ---------------------------------------------------------------------------
// Line-based parser
// ---------------------------------------------------------------------------

const CLASS_DECL = /^\s*class\s+([A-Z][A-Za-z0-9_:]*)\s*(?:<\s*([A-Z][A-Za-z0-9_:]*))?\s*$/;
const MODULE_DECL = /^\s*module\s+([A-Z][A-Za-z0-9_]*)\s*$/;
const END_LINE = /^\s*end\s*$/;
const ASSOC_LINE =
  /^\s*(has_many|has_one|belongs_to|has_and_belongs_to_many)\s+:([A-Za-z_]\w*)(.*)$/;
const SCOPE_LINE = /^\s*scope\s+:([A-Za-z_]\w*)\s*,\s*(->\s*\(([^)]*)\)|->\s*\{|lambda)/;
const DEF_LINE = /^\s*def\s+(self\.)?([A-Za-z_][A-Za-z0-9_?!=]*)(\(([^)]*)\))?/;
const CLASS_SHIFT = /^\s*class\s*<<\s*self\s*$/;

type FrameKind = 'module' | 'class' | 'class_shift' | 'def' | 'block';
interface Frame {
  kind: FrameKind;
  name?: string;
  parent?: string;
  /** Path of namespace prefix for the model name. */
  namespace: string;
  inClassShift: boolean;
}

function parseModels(source: string, uri: vscode.Uri): ModelInfo[] {
  const lines = source.split('\n');
  const stack: Frame[] = [];
  const models = new Map<string, ModelInfo>();

  const currentClassFrame = (): Frame | undefined => {
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

  const inDef = (): boolean => stack[stack.length - 1]?.kind === 'def';

  const namespaceOf = (frame: Frame, addSelf = false): string => {
    return frame.namespace;
  };

  for (const rawLine of lines) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue;

    // Block openers we care about
    const classMatch = CLASS_DECL.exec(line);
    if (classMatch) {
      const parentNs = stack.length > 0 ? stack[stack.length - 1].namespace : '';
      const nameWithNs = parentNs
        ? `${parentNs}::${classMatch[1]}`
        : classMatch[1];
      const frame: Frame = {
        kind: 'class',
        name: nameWithNs,
        parent: classMatch[2] ?? undefined,
        namespace: nameWithNs,
        inClassShift: false,
      };
      stack.push(frame);
      // Ensure the model record exists even for non-AR classes — the index
      // consumer filters on `parent` if it wants only AR descendants.
      if (!models.has(nameWithNs)) {
        models.set(nameWithNs, {
          name: nameWithNs,
          fileUri: uri,
          parent: classMatch[2] ?? null,
          associations: [],
          scopes: [],
          classMethods: [],
          instanceMethods: [],
        });
      }
      continue;
    }

    const moduleMatch = MODULE_DECL.exec(line);
    if (moduleMatch) {
      const parentNs = stack.length > 0 ? stack[stack.length - 1].namespace : '';
      const ns = parentNs ? `${parentNs}::${moduleMatch[1]}` : moduleMatch[1];
      stack.push({ kind: 'module', namespace: ns, inClassShift: false });
      continue;
    }

    if (CLASS_SHIFT.test(line)) {
      const parent = stack[stack.length - 1];
      stack.push({
        kind: 'class_shift',
        namespace: parent?.namespace ?? '',
        inClassShift: true,
      });
      continue;
    }

    const defMatch = DEF_LINE.exec(line);
    if (defMatch) {
      const frame = currentClassFrame();
      if (frame) {
        const model = models.get(frame.name!)!;
        const isClass = defMatch[1] === 'self.' || inClassShift();
        const name = defMatch[2];
        const arity = countArgs(defMatch[4]);
        if (isClass) {
          model.classMethods.push({ name, isClass: true, arity });
        } else {
          model.instanceMethods.push({ name, isClass: false, arity });
        }
      }
      stack.push({
        kind: 'def',
        namespace: stack[stack.length - 1]?.namespace ?? '',
        inClassShift: false,
      });
      continue;
    }

    if (END_LINE.test(line)) {
      stack.pop();
      continue;
    }

    // Skip everything inside a def body.
    if (inDef()) continue;

    // Class-body declarations.
    const frame = currentClassFrame();
    if (!frame) continue;
    const model = models.get(frame.name!)!;

    const assocMatch = ASSOC_LINE.exec(line);
    if (assocMatch) {
      const kind = assocMatch[1] as AssociationKind;
      const name = assocMatch[2];
      const opts = assocMatch[3] ?? '';
      const explicitClass = extractStringOrSymbol(opts, 'class_name');
      const through = extractSymbol(opts, 'through');
      const polymorphic = /\bpolymorphic:\s*true\b/.test(opts);
      const targetClass = explicitClass ?? defaultClassFromAssoc(kind, name);
      model.associations.push({
        kind,
        name,
        targetClass,
        through,
        polymorphic,
      });
      continue;
    }

    const scopeMatch = SCOPE_LINE.exec(line);
    if (scopeMatch) {
      const name = scopeMatch[1];
      const argText = scopeMatch[3] ?? '';
      const arity = countArgs(argText);
      const signature = arity > 0 ? `(${argText.trim()})` : '()';
      model.scopes.push({ name, arity, signature });
      continue;
    }
  }

  return Array.from(models.values());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function extractStringOrSymbol(opts: string, key: string): string | null {
  const re = new RegExp(
    `\\b${key}:\\s*(?:["']([A-Z][A-Za-z0-9_:]*)["']|:([a-z][A-Za-z0-9_]*))`,
  );
  const m = re.exec(opts);
  if (!m) return null;
  return m[1] ?? camelize(m[2]);
}

function extractSymbol(opts: string, key: string): string | null {
  const m = new RegExp(`\\b${key}:\\s*:([A-Za-z_]\\w*)`).exec(opts);
  return m ? m[1] : null;
}

function defaultClassFromAssoc(kind: AssociationKind, name: string): string {
  if (kind === 'has_many' || kind === 'has_and_belongs_to_many') {
    // Singularize the association name then camelize.
    return camelize(singularizeForAssoc(name));
  }
  return camelize(name);
}

function countArgs(argText: string | undefined): number {
  if (!argText || !argText.trim()) return 0;
  return argText.split(',').filter((a) => a.trim().length > 0).length;
}

function camelize(snake: string): string {
  return snake
    .split('_')
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : ''))
    .join('');
}

function singularizeForAssoc(plural: string): string {
  if (plural.endsWith('ies')) return plural.slice(0, -3) + 'y';
  if (plural.endsWith('ses') || plural.endsWith('xes') || plural.endsWith('zes')) {
    return plural.slice(0, -2);
  }
  if (plural.endsWith('children')) return plural.slice(0, -3); // child + ren → child
  if (plural.endsWith('s')) return plural.slice(0, -1);
  return plural;
}

// Avoid an unused-import warning on shared helpers we re-export for tests.
export const _internal = { camelToSnake, pluralize };
