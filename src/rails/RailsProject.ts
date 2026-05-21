/**
 * Workspace-folder-level service for a detected Rails project.
 *
 * Owns the lifecycle of per-project indexes (schema today; routes, models in
 * later phases). Holds the FileSystemWatcher that keeps the schema index in
 * sync with `db/schema.rb` on disk.
 */

import * as vscode from 'vscode';
import { SchemaIndex } from './SchemaIndex';

const GEMFILE_RAILS_LINE = /^\s*gem\s+['"]rails['"]/m;
const SCHEMA_RELOAD_DEBOUNCE_MS = 200;

export class RailsProject {
  readonly root: vscode.Uri;
  readonly schemaPath: vscode.Uri | null;
  private _schema: SchemaIndex;
  private watcher: vscode.FileSystemWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;

  private constructor(
    root: vscode.Uri,
    schemaPath: vscode.Uri | null,
    schema: SchemaIndex,
  ) {
    this.root = root;
    this.schemaPath = schemaPath;
    this._schema = schema;
  }

  get schema(): SchemaIndex {
    return this._schema;
  }

  /**
   * Inspect a workspace folder and return a RailsProject if it qualifies.
   *
   * A folder qualifies when:
   *   - `Gemfile` exists and declares `gem 'rails'`
   *   - `config/application.rb` exists
   *
   * Returns null otherwise. `db/schema.rb` is optional at detection time —
   * its absence is reported via `schemaPath === null` and an empty schema
   * index, not a failed detect.
   */
  static async detect(
    folder: vscode.WorkspaceFolder,
  ): Promise<RailsProject | null> {
    const root = folder.uri;
    const gemfileUri = vscode.Uri.joinPath(root, 'Gemfile');
    const appRbUri = vscode.Uri.joinPath(root, 'config', 'application.rb');

    if (!(await fileExists(appRbUri))) return null;
    if (!(await fileExists(gemfileUri))) return null;

    let gemfileText: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(gemfileUri);
      gemfileText = new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
    if (!GEMFILE_RAILS_LINE.test(gemfileText)) return null;

    const schemaUri = vscode.Uri.joinPath(root, 'db', 'schema.rb');
    const schemaExists = await fileExists(schemaUri);
    const schemaPath = schemaExists ? schemaUri : null;
    const schema = schemaExists ? await loadSchema(schemaUri) : SchemaIndex.empty();

    const project = new RailsProject(root, schemaPath, schema);
    if (schemaPath) project.startWatching(folder);
    return project;
  }

  private startWatching(folder: vscode.WorkspaceFolder): void {
    const pattern = new vscode.RelativePattern(folder, 'db/schema.rb');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const queueReload = (): void => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        void this.reloadSchema();
      }, SCHEMA_RELOAD_DEBOUNCE_MS);
    };

    this.watcher.onDidChange(queueReload);
    this.watcher.onDidCreate(queueReload);
    this.watcher.onDidDelete(() => {
      this._schema = SchemaIndex.empty();
    });
  }

  private async reloadSchema(): Promise<void> {
    if (!this.schemaPath) return;
    this._schema = await loadSchema(this.schemaPath);
  }

  dispose(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.watcher?.dispose();
    this.watcher = null;
  }
}

async function loadSchema(uri: vscode.Uri): Promise<SchemaIndex> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return SchemaIndex.parse(new TextDecoder().decode(bytes));
  } catch {
    return SchemaIndex.empty();
  }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
