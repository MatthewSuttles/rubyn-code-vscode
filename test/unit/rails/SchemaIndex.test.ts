/**
 * Unit tests for SchemaIndex — the regex-based db/schema.rb parser.
 */

import { describe, it, expect } from 'vitest';
import { SchemaIndex } from '../../../src/rails/SchemaIndex';

const minimalSchema = `
ActiveRecord::Schema[7.1].define(version: 2024_01_01_000000) do
  create_table "users", force: :cascade do |t|
    t.string "name", null: false
    t.string "email"
    t.boolean "active", default: false
    t.timestamps
  end

  create_table "posts", force: :cascade do |t|
    t.string "title"
    t.text "body"
    t.references "user", null: false
    t.timestamps
  end
end
`;

describe('SchemaIndex.parse', () => {
  it('lists every create_table', () => {
    const idx = SchemaIndex.parse(minimalSchema);
    expect(idx.tables().sort()).toEqual(['posts', 'users']);
    expect(idx.hasTable('users')).toBe(true);
    expect(idx.hasTable('comments')).toBe(false);
  });

  it('adds an implicit bigint id primary key', () => {
    const idx = SchemaIndex.parse(minimalSchema);
    const users = idx.columnsFor('users')!;
    const id = users.find((c) => c.name === 'id')!;
    expect(id.sqlType).toBe('bigint');
    expect(id.isPrimary).toBe(true);
    expect(id.nullable).toBe(false);
  });

  it('captures sqlType, nullability and default for explicit columns', () => {
    const idx = SchemaIndex.parse(minimalSchema);
    const users = idx.columnsFor('users')!;

    const name = users.find((c) => c.name === 'name')!;
    expect(name.sqlType).toBe('string');
    expect(name.nullable).toBe(false);

    const email = users.find((c) => c.name === 'email')!;
    expect(email.nullable).toBe(true);
    expect(email.default).toBeNull();

    const active = users.find((c) => c.name === 'active')!;
    expect(active.sqlType).toBe('boolean');
    expect(active.default).toBe('false');
  });

  it('expands t.timestamps into created_at and updated_at datetimes', () => {
    const idx = SchemaIndex.parse(minimalSchema);
    const users = idx.columnsFor('users')!;
    const createdAt = users.find((c) => c.name === 'created_at')!;
    const updatedAt = users.find((c) => c.name === 'updated_at')!;
    expect(createdAt.sqlType).toBe('datetime');
    expect(createdAt.nullable).toBe(false);
    expect(updatedAt.sqlType).toBe('datetime');
    expect(updatedAt.nullable).toBe(false);
  });

  it('expands t.references into <name>_id with null: false honored', () => {
    const idx = SchemaIndex.parse(minimalSchema);
    const posts = idx.columnsFor('posts')!;
    const userId = posts.find((c) => c.name === 'user_id')!;
    expect(userId.sqlType).toBe('bigint');
    expect(userId.nullable).toBe(false);
  });

  it('expands polymorphic references into _id and _type', () => {
    const idx = SchemaIndex.parse(`
      create_table "comments", force: :cascade do |t|
        t.references "commentable", polymorphic: true, null: false
      end
    `);
    const cols = idx.columnsFor('comments')!;
    const id = cols.find((c) => c.name === 'commentable_id');
    const type = cols.find((c) => c.name === 'commentable_type');
    expect(id?.sqlType).toBe('bigint');
    expect(type?.sqlType).toBe('string');
  });

  it('skips t.index / t.foreign_key / t.check_constraint lines', () => {
    const idx = SchemaIndex.parse(`
      create_table "users", force: :cascade do |t|
        t.string "email"
        t.index ["email"], unique: true
        t.foreign_key "accounts"
        t.check_constraint "char_length(email) > 0"
      end
    `);
    const users = idx.columnsFor('users')!;
    const names = users.map((c) => c.name);
    expect(names).toContain('email');
    expect(names).not.toContain('index');
    expect(names).not.toContain('foreign_key');
    expect(names).not.toContain('check_constraint');
  });

  it('respects id: false (no implicit id column)', () => {
    const idx = SchemaIndex.parse(`
      create_table "join_table", id: false, force: :cascade do |t|
        t.bigint "user_id", null: false
        t.bigint "role_id", null: false
      end
    `);
    const cols = idx.columnsFor('join_table')!;
    expect(cols.find((c) => c.name === 'id')).toBeUndefined();
    expect(cols.map((c) => c.name).sort()).toEqual(['role_id', 'user_id']);
  });

  it('respects id: :uuid', () => {
    const idx = SchemaIndex.parse(`
      create_table "events", id: :uuid, force: :cascade do |t|
        t.string "name"
      end
    `);
    const id = idx.columnsFor('events')!.find((c) => c.name === 'id')!;
    expect(id.sqlType).toBe('uuid');
    expect(id.isPrimary).toBe(true);
  });

  it('handles composite primary keys (no implicit id, columns declared explicitly)', () => {
    const idx = SchemaIndex.parse(`
      create_table "memberships", primary_key: ["user_id", "group_id"], force: :cascade do |t|
        t.bigint "user_id", null: false
        t.bigint "group_id", null: false
      end
    `);
    const cols = idx.columnsFor('memberships')!;
    expect(cols.find((c) => c.name === 'id')).toBeUndefined();
    expect(cols.map((c) => c.name).sort()).toEqual(['group_id', 'user_id']);
  });

  it('strips trailing comments', () => {
    const idx = SchemaIndex.parse(`
      create_table "users", force: :cascade do |t|
        t.string "name" # primary display name
      end
    `);
    expect(idx.columnsFor('users')!.find((c) => c.name === 'name')).toBeDefined();
  });

  it('does not crash on malformed schema', () => {
    const broken = `
      create_table "users" do |t
        t.string
        t.??? garbage
      end
      garbage line
      create_table "posts" force: :cascade do |t|
        t.text "body"
      end
    `;
    expect(() => SchemaIndex.parse(broken)).not.toThrow();
    const idx = SchemaIndex.parse(broken);
    expect(idx.hasTable('posts')).toBe(true);
    expect(idx.columnsFor('posts')!.some((c) => c.name === 'body')).toBe(true);
  });

  it('SchemaIndex.empty has no tables', () => {
    const idx = SchemaIndex.empty();
    expect(idx.tables()).toEqual([]);
    expect(idx.hasTable('users')).toBe(false);
    expect(idx.columnsFor('users')).toBeUndefined();
  });
});
