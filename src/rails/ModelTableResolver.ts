/**
 * Maps a model class constant name (e.g. `User`, `OrderItem`, `Admin::User`)
 * to the database table name (`users`, `order_items`, `users`).
 *
 * Default: drop the namespace, convert CamelCase → snake_case, pluralize.
 * Override: if `app/models/<path>.rb` declares `self.table_name = "..."`,
 * that wins. Overrides are cached per file and invalidated when the file
 * changes on disk.
 *
 * This is intentionally a partial port of ActiveSupport::Inflector — we cover
 * the common irregulars and suffix rules. Future enhancement: pull user-
 * defined inflections from `config/initializers/inflections.rb`.
 */

import * as vscode from 'vscode';
import { RailsProject } from './RailsProject';

const TABLE_NAME_OVERRIDE = /self\.table_name\s*=\s*['"]([^'"]+)['"]/;

interface CacheEntry {
  /** null marker means "no override found", so we don't re-scan. */
  tableName: string | null;
}

export class ModelTableResolver {
  private readonly project: RailsProject;
  private readonly overrideCache = new Map<string, CacheEntry>();
  private watcher: vscode.FileSystemWatcher | null = null;

  constructor(project: RailsProject) {
    this.project = project;
    this.watcher = createModelWatcher(project, (uri) => {
      this.overrideCache.delete(uri.fsPath);
    });
  }

  async resolve(modelName: string): Promise<string | null> {
    if (!modelName) return null;
    const override = await this.lookupOverride(modelName);
    if (override) return override;
    return defaultTableName(modelName);
  }

  /** Synchronous variant — skips override scan; useful in hot completion paths. */
  resolveDefault(modelName: string): string | null {
    if (!modelName) return null;
    return defaultTableName(modelName);
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = null;
    this.overrideCache.clear();
  }

  private async lookupOverride(modelName: string): Promise<string | null> {
    const fileUri = modelFileUri(this.project.root, modelName);
    const cached = this.overrideCache.get(fileUri.fsPath);
    if (cached) return cached.tableName;

    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      text = new TextDecoder().decode(bytes);
    } catch {
      this.overrideCache.set(fileUri.fsPath, { tableName: null });
      return null;
    }

    const match = TABLE_NAME_OVERRIDE.exec(text);
    const tableName = match ? match[1] : null;
    this.overrideCache.set(fileUri.fsPath, { tableName });
    return tableName;
  }
}

function createModelWatcher(
  project: RailsProject,
  onChange: (uri: vscode.Uri) => void,
): vscode.FileSystemWatcher | null {
  // Build a workspace-folder pattern matching every model file under the
  // project root. RelativePattern keeps this scoped to the project.
  const folder = { uri: project.root, name: 'rails', index: 0 };
  const pattern = new vscode.RelativePattern(folder, 'app/models/**/*.rb');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  return watcher;
}

function modelFileUri(root: vscode.Uri, modelName: string): vscode.Uri {
  const relative = modelName
    .split('::')
    .map(camelToSnake)
    .join('/');
  return vscode.Uri.joinPath(root, 'app', 'models', `${relative}.rb`);
}

export function defaultTableName(modelName: string): string {
  // Drop namespace — `Admin::User` → `User` by default (the namespace becomes
  // a table_name_prefix only when explicitly configured).
  const lastSegment = modelName.split('::').pop()!;
  const snake = camelToSnake(lastSegment);
  return pluralize(snake);
}

export function camelToSnake(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Pluralization
// ---------------------------------------------------------------------------

/**
 * Irregular singular → plural mappings. Cover the common cases Rails apps
 * actually model; long tail (e.g. "ox" → "oxen") is intentionally trimmed.
 */
const IRREGULARS: Record<string, string> = {
  person: 'people',
  man: 'men',
  woman: 'women',
  child: 'children',
  foot: 'feet',
  tooth: 'teeth',
  mouse: 'mice',
  goose: 'geese',
  ox: 'oxen',
  datum: 'data',
  criterion: 'criteria',
  analysis: 'analyses',
  diagnosis: 'analyses',
  thesis: 'theses',
  fungus: 'fungi',
  cactus: 'cacti',
  index: 'indices',
  matrix: 'matrices',
  vertex: 'vertices',
  leaf: 'leaves',
  knife: 'knives',
  life: 'lives',
  wife: 'wives',
  wolf: 'wolves',
  half: 'halves',
};

const UNCOUNTABLE = new Set([
  'equipment',
  'information',
  'rice',
  'money',
  'species',
  'series',
  'fish',
  'sheep',
  'jeans',
  'police',
]);

export function pluralize(word: string): string {
  if (!word) return word;
  if (UNCOUNTABLE.has(word)) return word;

  // Irregulars match on the trailing token so `OrderItem` (→ `order_item`)
  // pluralizes to `order_items` via the default rule, while `Person` (→
  // `person`) hits the irregular table.
  const lastUnderscoreIdx = word.lastIndexOf('_');
  const prefix = lastUnderscoreIdx === -1 ? '' : word.slice(0, lastUnderscoreIdx + 1);
  const tail = lastUnderscoreIdx === -1 ? word : word.slice(lastUnderscoreIdx + 1);

  if (IRREGULARS[tail]) return prefix + IRREGULARS[tail];

  // Suffix rules — first match wins. The f/fe → ves rule is intentionally
  // absent: too many false positives (roof, chef). The handful of common
  // model names that need it (leaf, knife, …) live in IRREGULARS.
  if (/(s|x|z|ch|sh)$/.test(tail)) return prefix + tail + 'es';
  if (/[^aeiou]y$/.test(tail)) return prefix + tail.slice(0, -1) + 'ies';

  return prefix + tail + 's';
}
