/**
 * In-memory index of `config/routes.rb`. Source of truth for route-helper
 * completion in Phase 2; later phases may use the controller#action map for
 * goto-definition and references.
 *
 * The index composes two strategies:
 *   - regex-based parsing of `config/routes.rb` (`RoutesParser`)
 *   - shell-out to `bin/rails routes --format=json` when the parse looks
 *     under-covered (`RoutesShellParser`)
 *
 * The original phase 2 design called for Prism-based AST parsing. After
 * weighing the WASI/ESM/webpack integration cost we shipped with regex +
 * shell fallback — see CLAUDE.md for the rationale.
 */

import * as vscode from 'vscode';
import { NamedRoute, RoutesParser } from './RoutesParser';
import { RoutesShellParser } from './RoutesShellParser';

const ROUTES_RELOAD_DEBOUNCE_MS = 500;
/** Threshold under which we suspect the regex parser missed routes. */
const SHELL_FALLBACK_MIN_ROUTE_COUNT = 1;
/** If the file is at least this many bytes per parsed route, we fall back. */
const SHELL_FALLBACK_BYTES_PER_ROUTE = 400;

export class RoutesIndex {
  private routes: NamedRoute[] = [];
  private watcher: vscode.FileSystemWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private loadPromise: Promise<void> | null = null;

  private constructor(
    readonly root: vscode.Uri,
    readonly routesPath: vscode.Uri,
  ) {}

  /**
   * Construct (but don't yet load) a RoutesIndex for a project. Caller should
   * call `ensureLoaded()` before the first read — or just let `matching()` do
   * it lazily.
   */
  static create(
    root: vscode.Uri,
    routesPath: vscode.Uri,
  ): RoutesIndex {
    return new RoutesIndex(root, routesPath);
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }
    await this.loadPromise;
  }

  /** Force a fresh parse. Used by file watchers and manual reload. */
  async reload(): Promise<void> {
    this.loadPromise = this.load();
    await this.loadPromise;
  }

  all(): NamedRoute[] {
    return this.routes;
  }

  matching(prefix: string): NamedRoute[] {
    if (!prefix) return this.routes;
    const lower = prefix.toLowerCase();
    return this.routes.filter((r) => r.helper.toLowerCase().startsWith(lower));
  }

  startWatching(folder: vscode.WorkspaceFolder): void {
    if (this.watcher) return;
    const pattern = new vscode.RelativePattern(folder, 'config/routes{.rb,/**/*.rb}');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const queue = (): void => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        void this.reload();
      }, ROUTES_RELOAD_DEBOUNCE_MS);
    };
    this.watcher.onDidChange(queue);
    this.watcher.onDidCreate(queue);
    this.watcher.onDidDelete(queue);
  }

  dispose(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.watcher?.dispose();
    this.watcher = null;
  }

  private async load(): Promise<void> {
    let source: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.routesPath);
      source = new TextDecoder().decode(bytes);
    } catch {
      this.routes = [];
      return;
    }

    const parser = new RoutesParser({
      readFile: async (uri) => {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder().decode(bytes);
      },
      routesDir: vscode.Uri.joinPath(this.root, 'config', 'routes'),
    });
    let routes = await parser.parse(source);

    if (shouldUseShellFallback(routes.length, source.length)) {
      const shell = new RoutesShellParser({ root: this.root });
      const shellRoutes = await shell.parse();
      if (shellRoutes && shellRoutes.length > routes.length) {
        routes = shellRoutes;
      }
    }

    this.routes = routes;
  }
}

export { NamedRoute } from './RoutesParser';

function shouldUseShellFallback(parsedCount: number, bytes: number): boolean {
  if (parsedCount < SHELL_FALLBACK_MIN_ROUTE_COUNT && bytes > 200) return true;
  if (bytes / Math.max(parsedCount, 1) > SHELL_FALLBACK_BYTES_PER_ROUTE) return true;
  return false;
}
