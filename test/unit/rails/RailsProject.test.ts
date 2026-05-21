/**
 * Unit tests for RailsProject.detect — the Rails-project gate for every
 * downstream Rails-aware feature.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { __resetAll, Uri } from '../../helpers/mock-vscode';

import { RailsProject } from '../../../src/rails/RailsProject';

interface FakeFiles {
  /** Files that exist on disk. Value is the file body for readFile. */
  [path: string]: string;
}

function mockFs(files: FakeFiles): void {
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
      if (body === undefined) {
        throw new Error(`ENOENT: ${uri.fsPath}`);
      }
      return new TextEncoder().encode(body);
    },
  );
}

function folder(path: string): vscode.WorkspaceFolder {
  return { uri: Uri.file(path), name: 'fixture', index: 0 };
}

describe('RailsProject.detect', () => {
  beforeEach(() => {
    __resetAll();
  });

  it('returns a project when Gemfile declares rails and application.rb exists', async () => {
    mockFs({
      '/app/Gemfile': "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n",
      '/app/config/application.rb': "module App\n  class Application < Rails::Application\n  end\nend\n",
    });

    const project = await RailsProject.detect(folder('/app'));

    expect(project).not.toBeNull();
    expect(project!.root.fsPath).toBe('/app');
    expect(project!.schemaPath).toBeNull();
  });

  it('populates schemaPath and loads the schema when db/schema.rb exists', async () => {
    mockFs({
      '/app/Gemfile': "gem 'rails'\n",
      '/app/config/application.rb': '',
      '/app/db/schema.rb': `
        ActiveRecord::Schema[7.1].define(version: 1) do
          create_table "users", force: :cascade do |t|
            t.string "email"
          end
        end
      `,
    });

    const project = await RailsProject.detect(folder('/app'));

    expect(project).not.toBeNull();
    expect(project!.schemaPath?.fsPath).toBe('/app/db/schema.rb');
    expect(project!.schema.hasTable('users')).toBe(true);
    expect(project!.schema.columnsFor('users')!.some((c) => c.name === 'email')).toBe(true);
    project!.dispose();
  });

  it('returns an empty schema index when db/schema.rb is absent', async () => {
    mockFs({
      '/app/Gemfile': "gem 'rails'\n",
      '/app/config/application.rb': '',
    });

    const project = await RailsProject.detect(folder('/app'));

    expect(project).not.toBeNull();
    expect(project!.schemaPath).toBeNull();
    expect(project!.schema.tables()).toEqual([]);
    project!.dispose();
  });

  it('returns null when Gemfile is missing', async () => {
    mockFs({
      '/app/config/application.rb': '',
    });

    const project = await RailsProject.detect(folder('/app'));

    expect(project).toBeNull();
  });

  it('returns null when config/application.rb is missing', async () => {
    mockFs({
      '/app/Gemfile': "gem 'rails'\n",
    });

    const project = await RailsProject.detect(folder('/app'));

    expect(project).toBeNull();
  });

  it('returns null when Gemfile does not declare the rails gem', async () => {
    mockFs({
      '/app/Gemfile': "source 'https://rubygems.org'\ngem 'sinatra'\n",
      '/app/config/application.rb': '',
    });

    const project = await RailsProject.detect(folder('/app'));

    expect(project).toBeNull();
  });

  it('matches the rails gem regardless of quote style or surrounding whitespace', async () => {
    mockFs({
      '/app/Gemfile': '  gem "rails", "~> 7.0"\n',
      '/app/config/application.rb': '',
    });

    const project = await RailsProject.detect(folder('/app'));

    expect(project).not.toBeNull();
  });

  it('does not match a gem whose name merely contains "rails"', async () => {
    mockFs({
      '/app/Gemfile': "gem 'rails-i18n'\n",
      '/app/config/application.rb': '',
    });

    const project = await RailsProject.detect(folder('/app'));

    expect(project).toBeNull();
  });
});
