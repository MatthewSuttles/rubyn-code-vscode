/**
 * Sanity check on the committed test/fixtures/rails-app/app/models/. If a
 * future model edit breaks parsing, this fails fast — before downstream
 * association-completion tests get confusing.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Uri } from '../../helpers/mock-vscode';
import { ModelIndex } from '../../../src/rails/ModelIndex';

const MODELS_DIR = path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'rails-app',
  'app',
  'models',
);

async function listModelFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listModelFiles(full)));
    } else if (entry.name.endsWith('.rb')) {
      out.push(full);
    }
  }
  return out;
}

describe('test/fixtures/rails-app/app/models', () => {
  it('parses the committed fixture into the expected models', async () => {
    const files = await listModelFiles(MODELS_DIR);
    const idx = await ModelIndex.build(Uri.file('/'), {
      findModelFiles: async () => files.map((f) => Uri.file(f)),
      readFile: async (uri) => fs.readFile(uri.fsPath, 'utf-8'),
    });

    const names = idx.all().map((m) => m.name).sort();
    expect(names).toEqual(['Admin::User', 'Comment', 'Post', 'User']);

    const user = idx.byName('User')!;
    expect(user.associations.map((a) => a.name).sort()).toEqual([
      'comments',
      'groups',
      'posts',
      'profile',
    ]);
    expect(user.scopes.map((s) => s.name)).toContain('active');
    expect(user.classMethods.map((m) => m.name)).toContain('search');

    const adminUser = idx.byName('Admin::User')!;
    expect(adminUser.classMethods.map((m) => m.name)).toContain('with_role');
    expect(adminUser.scopes.map((s) => s.name)).toContain('superusers');

    const post = idx.byName('Post')!;
    const through = post.associations.find((a) => a.name === 'commenters');
    expect(through?.through).toBe('comments');

    const comment = idx.byName('Comment')!;
    expect(
      comment.associations.find((a) => a.name === 'commentable')?.polymorphic,
    ).toBe(true);
  });
});
