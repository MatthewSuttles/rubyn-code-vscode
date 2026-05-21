/**
 * Integration test: mutate config/routes.rb → RoutesIndex.matching reflects
 * the change within the debounce window. Mirrors the schema-reload test.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  __resetAll,
  __getFileSystemWatchers,
  Uri,
} from '../../helpers/mock-vscode';

import { RailsProject } from '../../../src/rails/RailsProject';

const ROUTES_BEFORE = `
Rails.application.routes.draw do
  resources :users
end
`;

const ROUTES_AFTER = `
Rails.application.routes.draw do
  resources :users
  resources :posts
  get "/about", to: "pages#about", as: :about
end
`;

describe('RoutesIndex — reload on disk change', () => {
  beforeEach(() => {
    __resetAll();
  });

  it('rebuilds the index after a file change event', async () => {
    const files: Record<string, string> = {
      '/app/Gemfile': "gem 'rails'\n",
      '/app/config/application.rb': '',
      '/app/config/routes.rb': ROUTES_BEFORE,
    };
    vi.spyOn(vscode.workspace.fs, 'stat').mockImplementation(
      async (uri: vscode.Uri) => {
        if (files[uri.fsPath] !== undefined) {
          return { type: 1, ctime: 0, mtime: 0, size: 0 } as never;
        }
        throw new Error(`ENOENT: ${uri.fsPath}`);
      },
    );
    vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(
      async (uri: vscode.Uri) => {
        const body = files[uri.fsPath];
        if (body === undefined) throw new Error(`ENOENT: ${uri.fsPath}`);
        return new TextEncoder().encode(body);
      },
    );

    const project = (await RailsProject.detect({
      uri: Uri.file('/app'),
      name: 'app',
      index: 0,
    }))!;

    await project.routes.ensureLoaded();
    expect(project.routes.all().some((r) => r.helper === 'users')).toBe(true);
    expect(project.routes.all().some((r) => r.helper === 'posts')).toBe(false);

    files['/app/config/routes.rb'] = ROUTES_AFTER;
    const watcher = __getFileSystemWatchers().find(
      (w) => true, // first watcher created for routes
    );
    // Two watchers exist: schema + routes. Fire on each — routes one will pick
    // up the change.
    for (const w of __getFileSystemWatchers()) {
      w._changeEmitter.fire(Uri.file('/app/config/routes.rb'));
    }

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (project.routes.all().some((r) => r.helper === 'about')) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(project.routes.all().some((r) => r.helper === 'about')).toBe(true);
    expect(project.routes.all().some((r) => r.helper === 'posts')).toBe(true);

    void watcher;
    project.dispose();
  });
});
