/**
 * Integration test: mutate db/schema.rb on disk → RailsProject.schema
 * reflects the new contents after the debounce window. Exercises the
 * FileSystemWatcher wiring inside RailsProject.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  __resetAll,
  __getFileSystemWatchers,
  Uri,
} from '../../helpers/mock-vscode';

import { RailsProject } from '../../../src/rails/RailsProject';

const SCHEMA_BEFORE = `
ActiveRecord::Schema[7.1].define(version: 1) do
  create_table "users", force: :cascade do |t|
    t.string "email"
  end
end
`;

const SCHEMA_AFTER = `
ActiveRecord::Schema[7.1].define(version: 2) do
  create_table "users", force: :cascade do |t|
    t.string "email"
    t.string "display_name"
  end

  create_table "audits", force: :cascade do |t|
    t.string "actor"
  end
end
`;

describe('RailsProject — schema reload on disk change', () => {
  beforeEach(() => {
    __resetAll();
  });

  it('reparses db/schema.rb within the debounce window after a change event', async () => {
    const files: Record<string, string> = {
      '/app/Gemfile': "gem 'rails'\n",
      '/app/config/application.rb': '',
      '/app/db/schema.rb': SCHEMA_BEFORE,
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

    // Sanity check the pre-reload schema.
    expect(project.schema.tables().sort()).toEqual(['users']);
    expect(
      project.schema.columnsFor('users')!.some((c) => c.name === 'display_name'),
    ).toBe(false);

    // Mutate the file on disk and fire the watcher's change event.
    files['/app/db/schema.rb'] = SCHEMA_AFTER;
    const watchers = __getFileSystemWatchers();
    expect(watchers.length).toBe(1);
    watchers[0]._changeEmitter.fire(Uri.file('/app/db/schema.rb'));

    // Reload is debounced (200ms) and then async. Poll up to 2s — the Phase 1
    // requirement is "reload within 2 seconds".
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (project.schema.hasTable('audits')) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(project.schema.hasTable('audits')).toBe(true);
    expect(
      project.schema.columnsFor('users')!.some((c) => c.name === 'display_name'),
    ).toBe(true);

    project.dispose();
  });
});
