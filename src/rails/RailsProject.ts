/**
 * Workspace-folder-level service for a detected Rails project.
 *
 * Owns the lifecycle of per-project indexes (schema, routes, models). Phase 1
 * only carries the detection result and a pointer to db/schema.rb; later
 * phases compose more indexes onto this same object.
 */

import * as vscode from 'vscode';

const GEMFILE_RAILS_LINE = /^\s*gem\s+['"]rails['"]/m;

export class RailsProject {
  readonly root: vscode.Uri;
  readonly schemaPath: vscode.Uri | null;

  private constructor(root: vscode.Uri, schemaPath: vscode.Uri | null) {
    this.root = root;
    this.schemaPath = schemaPath;
  }

  /**
   * Inspect a workspace folder and return a RailsProject if it qualifies.
   *
   * A folder qualifies when:
   *   - `Gemfile` exists and declares `gem 'rails'`
   *   - `config/application.rb` exists
   *
   * Returns null otherwise. `db/schema.rb` is optional at detection time —
   * its absence is reported via `schemaPath === null`, not a failed detect.
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
    const schemaPath = (await fileExists(schemaUri)) ? schemaUri : null;

    return new RailsProject(root, schemaPath);
  }

  dispose(): void {
    // Phase 1 owns no disposables. Later phases (file watchers, index caches)
    // will release them here.
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
