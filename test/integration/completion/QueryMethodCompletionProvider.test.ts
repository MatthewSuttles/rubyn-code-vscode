/**
 * Integration tests for QueryMethodCompletionProvider. Drives the provider
 * via a stub TextDocument so we exercise the full path: detectContext →
 * resolver → schema → CompletionItem build, without spinning up VS Code.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { __resetAll, Uri, Position, Range } from '../../helpers/mock-vscode';

import { RailsProject } from '../../../src/rails/RailsProject';
import { QueryMethodCompletionProvider } from '../../../src/completion/QueryMethodCompletionProvider';

const SCHEMA_RB = `
ActiveRecord::Schema[7.1].define(version: 1) do
  create_table "users", force: :cascade do |t|
    t.string "name", null: false
    t.string "email", null: false
    t.boolean "active", default: true
    t.timestamps
  end
end
`;

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
    '/app/db/schema.rb': SCHEMA_RB,
  });
  return (await RailsProject.detect({
    uri: Uri.file('/app'),
    name: 'app',
    index: 0,
  }))!;
}

function fakeDoc(text: string, cursor: number): vscode.TextDocument {
  return {
    uri: Uri.file('/app/app/controllers/users_controller.rb'),
    languageId: 'ruby',
    getText: () => text,
    offsetAt: (pos: vscode.Position) => pos.character,
    positionAt: (offset: number) => new Position(0, offset),
  } as unknown as vscode.TextDocument;
}

describe('QueryMethodCompletionProvider', () => {
  beforeEach(() => {
    __resetAll();
  });

  it('returns columns for User.where(:|)', async () => {
    const project = await makeProject();
    const provider = new QueryMethodCompletionProvider(
      () => project,
      (p) => p.resolver,
    );

    const text = 'User.where(:)';
    const cursor = 12; // between `:` and `)`
    const doc = fakeDoc(text, cursor);

    const items = await provider.provideCompletionItems(
      doc,
      new Position(0, cursor),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );

    expect(items).toBeDefined();
    const labels = items!.map((i) => i.label);
    expect(labels).toContain('name');
    expect(labels).toContain('email');
    expect(labels).toContain('active');
    expect(labels).toContain('created_at');
    expect(labels).toContain('id');

    project.dispose();
  });

  it('decorates items with sqlType detail and a nullability/default doc', async () => {
    const project = await makeProject();
    const provider = new QueryMethodCompletionProvider(
      () => project,
      (p) => p.resolver,
    );
    const text = 'User.where(:)';
    const items = await provider.provideCompletionItems(
      fakeDoc(text, 12),
      new Position(0, 12),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );

    const active = items!.find((i) => i.label === 'active')!;
    expect(active.detail).toBe(':boolean');
    expect((active.documentation as { value: string }).value).toContain('null:');
    expect((active.documentation as { value: string }).value).toContain('default:');

    project.dispose();
  });

  it('inserts `name:` (shorthand) in open context', async () => {
    const project = await makeProject();
    const provider = new QueryMethodCompletionProvider(
      () => project,
      (p) => p.resolver,
    );
    // Cursor at offset 11, immediately after `(` — open context.
    const text = 'User.where()';
    const items = await provider.provideCompletionItems(
      fakeDoc(text, 11),
      new Position(0, 11),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );

    const name = items!.find((i) => i.label === 'name')!;
    expect(name.insertText).toBe('name:');
    project.dispose();
  });

  it('inserts plain `name` when cursor is in a bare-symbol context', async () => {
    const project = await makeProject();
    const provider = new QueryMethodCompletionProvider(
      () => project,
      (p) => p.resolver,
    );
    const text = 'User.where(:)';
    const items = await provider.provideCompletionItems(
      fakeDoc(text, 12),
      new Position(0, 12),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );
    const name = items!.find((i) => i.label === 'name')!;
    expect(name.insertText).toBe('name');
    project.dispose();
  });

  it('returns undefined when the model has no schema entry', async () => {
    const project = await makeProject();
    const provider = new QueryMethodCompletionProvider(
      () => project,
      (p) => p.resolver,
    );
    const text = 'UnknownModel.where(:)';
    const items = await provider.provideCompletionItems(
      fakeDoc(text, 20),
      new Position(0, 20),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );
    expect(items).toBeUndefined();
    project.dispose();
  });

  it('returns undefined when getProject returns null', async () => {
    const provider = new QueryMethodCompletionProvider(
      () => null,
      () => null as never,
    );
    const text = 'User.where(:)';
    const items = await provider.provideCompletionItems(
      fakeDoc(text, 12),
      new Position(0, 12),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );
    expect(items).toBeUndefined();
  });

  it('returns undefined when the cursor is outside a query method', async () => {
    const project = await makeProject();
    const provider = new QueryMethodCompletionProvider(
      () => project,
      (p) => p.resolver,
    );
    const text = 'User.create(:name)';
    const items = await provider.provideCompletionItems(
      fakeDoc(text, 13),
      new Position(0, 13),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );
    expect(items).toBeUndefined();
    project.dispose();
  });
});
