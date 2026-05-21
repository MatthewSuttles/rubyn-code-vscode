/**
 * Unit tests for ModelTableResolver.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { __resetAll, Uri } from '../../helpers/mock-vscode';

import {
  ModelTableResolver,
  defaultTableName,
  camelToSnake,
  pluralize,
} from '../../../src/rails/ModelTableResolver';
import { RailsProject } from '../../../src/rails/RailsProject';

function mockFs(files: Record<string, string>): void {
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
}

async function makeProject(): Promise<RailsProject> {
  mockFs({
    '/app/Gemfile': "gem 'rails'\n",
    '/app/config/application.rb': '',
  });
  const project = await RailsProject.detect({
    uri: Uri.file('/app'),
    name: 'app',
    index: 0,
  });
  return project!;
}

describe('camelToSnake', () => {
  it('converts simple CamelCase', () => {
    expect(camelToSnake('User')).toBe('user');
    expect(camelToSnake('OrderItem')).toBe('order_item');
    expect(camelToSnake('APIKey')).toBe('api_key');
    expect(camelToSnake('HTTPRequest')).toBe('http_request');
  });
});

describe('pluralize', () => {
  it('handles the +s default', () => {
    expect(pluralize('user')).toBe('users');
    expect(pluralize('order_item')).toBe('order_items');
  });

  it('handles +es for s/x/z/ch/sh endings', () => {
    expect(pluralize('box')).toBe('boxes');
    expect(pluralize('bus')).toBe('buses');
    expect(pluralize('match')).toBe('matches');
    expect(pluralize('brush')).toBe('brushes');
  });

  it('handles consonant + y → ies', () => {
    expect(pluralize('category')).toBe('categories');
    expect(pluralize('country')).toBe('countries');
    expect(pluralize('day')).toBe('days'); // vowel + y is plain +s
  });

  it('handles f / fe → ves', () => {
    expect(pluralize('leaf')).toBe('leaves');
    expect(pluralize('knife')).toBe('knives');
  });

  it('handles irregulars including compound model names', () => {
    expect(pluralize('person')).toBe('people');
    expect(pluralize('child')).toBe('children');
    expect(pluralize('admin_person')).toBe('admin_people');
  });

  it('leaves uncountables alone', () => {
    expect(pluralize('equipment')).toBe('equipment');
    expect(pluralize('fish')).toBe('fish');
  });
});

describe('defaultTableName', () => {
  it('drops namespace and pluralizes the leaf class name', () => {
    expect(defaultTableName('User')).toBe('users');
    expect(defaultTableName('OrderItem')).toBe('order_items');
    expect(defaultTableName('Admin::User')).toBe('users');
    expect(defaultTableName('Person')).toBe('people');
  });
});

describe('ModelTableResolver.resolve', () => {
  beforeEach(() => {
    __resetAll();
  });

  it('uses the default table for a model with no override', async () => {
    const project = await makeProject();
    mockFs({
      '/app/app/models/user.rb': "class User < ApplicationRecord\nend\n",
    });
    const resolver = new ModelTableResolver(project);

    expect(await resolver.resolve('User')).toBe('users');
    expect(await resolver.resolve('OrderItem')).toBe('order_items');
    resolver.dispose();
    project.dispose();
  });

  it('honors self.table_name = "..." in the model file', async () => {
    const project = await makeProject();
    mockFs({
      '/app/app/models/legacy_user.rb': `class LegacyUser < ApplicationRecord
  self.table_name = "old_users_v2"
end
`,
    });
    const resolver = new ModelTableResolver(project);

    expect(await resolver.resolve('LegacyUser')).toBe('old_users_v2');
    resolver.dispose();
    project.dispose();
  });

  it('caches the override scan per file', async () => {
    const project = await makeProject();
    const fileBody = `class User < ApplicationRecord
  self.table_name = "people_v2"
end
`;
    mockFs({ '/app/app/models/user.rb': fileBody });
    const resolver = new ModelTableResolver(project);

    const readSpy = vi.spyOn(vscode.workspace.fs, 'readFile');
    await resolver.resolve('User');
    await resolver.resolve('User');
    await resolver.resolve('User');

    // First resolve hits the file once; subsequent resolves use the cache.
    expect(readSpy).toHaveBeenCalledTimes(1);
    resolver.dispose();
    project.dispose();
  });

  it('returns the default when the model file is missing', async () => {
    const project = await makeProject();
    // No model file mocked.
    const resolver = new ModelTableResolver(project);

    expect(await resolver.resolve('Ghost')).toBe('ghosts');
    resolver.dispose();
    project.dispose();
  });

  it('resolveDefault skips the override scan entirely', async () => {
    const project = await makeProject();
    const resolver = new ModelTableResolver(project);

    const readSpy = vi.spyOn(vscode.workspace.fs, 'readFile');
    expect(resolver.resolveDefault('User')).toBe('users');
    expect(readSpy).not.toHaveBeenCalled();
    resolver.dispose();
    project.dispose();
  });
});
