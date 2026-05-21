/**
 * Sanity check on the committed test/fixtures/rails-app/db/schema.rb. If a
 * future schema edit breaks parsing, this fails fast — before the e2e harness
 * (which is heavier) has to surface the same issue.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { SchemaIndex } from '../../../src/rails/SchemaIndex';

const SCHEMA_PATH = path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'rails-app',
  'db',
  'schema.rb',
);

describe('test/fixtures/rails-app/db/schema.rb', () => {
  it('parses cleanly and exposes the three fixture tables', () => {
    const source = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    const idx = SchemaIndex.parse(source);

    expect(idx.tables().sort()).toEqual(['comments', 'posts', 'users']);

    const users = idx.columnsFor('users')!;
    const names = users.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('email');
    expect(names).toContain('role');
    expect(names).toContain('created_at');

    const comments = idx.columnsFor('comments')!;
    const commentNames = comments.map((c) => c.name);
    expect(commentNames).toContain('user_id');
    expect(commentNames).toContain('commentable_id');
    expect(commentNames).toContain('commentable_type');
  });
});
