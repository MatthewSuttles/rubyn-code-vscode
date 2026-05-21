/**
 * Integration tests for RouteHelperCompletionProvider. Builds a RailsProject
 * with a mocked routes.rb on disk, then drives the provider via stub
 * TextDocuments to assert the completion list contents and snippet bodies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  __resetAll,
  Uri,
  Position,
  Range,
  SnippetString,
} from '../../helpers/mock-vscode';

import { RailsProject } from '../../../src/rails/RailsProject';
import { RouteHelperCompletionProvider } from '../../../src/completion/RouteHelperCompletionProvider';

const ROUTES_RB = `
Rails.application.routes.draw do
  root to: "pages#home"
  get "/about", to: "pages#about", as: :about

  resources :users do
    member do
      get :follow
    end
  end

  namespace :admin do
    resources :posts
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
    '/app/config/routes.rb': ROUTES_RB,
  });
  return (await RailsProject.detect({
    uri: Uri.file('/app'),
    name: 'app',
    index: 0,
  }))!;
}

function fakeDoc(text: string, languageId = 'ruby'): vscode.TextDocument {
  return {
    uri: Uri.file('/app/app/views/users/index.html.erb'),
    languageId,
    lineAt: (lineOrPos: number | vscode.Position) => {
      const line = typeof lineOrPos === 'number' ? lineOrPos : lineOrPos.line;
      return { text: text.split('\n')[line] ?? '' } as never;
    },
  } as unknown as vscode.TextDocument;
}

describe('RouteHelperCompletionProvider', () => {
  beforeEach(() => {
    __resetAll();
  });

  it('suggests *_path and *_url for a known route helper prefix', async () => {
    const project = await makeProject();
    const provider = new RouteHelperCompletionProvider(() => project);

    const items = await provider.provideCompletionItems(
      fakeDoc('edit_user_'),
      new Position(0, 10),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );

    expect(items).toBeDefined();
    const labels = items!.map((i) => i.label);
    expect(labels).toContain('edit_user_path');
    expect(labels).toContain('edit_user_url');
    project.dispose();
  });

  it('builds a snippet with placeholders for path params', async () => {
    const project = await makeProject();
    const provider = new RouteHelperCompletionProvider(() => project);

    const items = await provider.provideCompletionItems(
      fakeDoc('edit_user_'),
      new Position(0, 10),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );

    const editPath = items!.find((i) => i.label === 'edit_user_path')!;
    expect(editPath.insertText).toBeInstanceOf(SnippetString);
    expect((editPath.insertText as SnippetString).value).toBe('edit_user_path(${1:id})');
  });

  it('builds a parameterless snippet for collection helpers', async () => {
    const project = await makeProject();
    const provider = new RouteHelperCompletionProvider(() => project);

    const items = await provider.provideCompletionItems(
      fakeDoc('users_'),
      new Position(0, 6),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );

    const usersPath = items!.find((i) => i.label === 'users_path')!;
    expect((usersPath.insertText as SnippetString).value).toBe('users_path');
  });

  it('shows verb + pattern in detail and a multi-route doc body', async () => {
    const project = await makeProject();
    const provider = new RouteHelperCompletionProvider(() => project);

    const items = await provider.provideCompletionItems(
      fakeDoc('users_'),
      new Position(0, 6),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );
    const usersPath = items!.find((i) => i.label === 'users_path')!;
    expect(usersPath.detail).toMatch(/(GET|POST) \/users/);
    const docValue = (usersPath.documentation as { value: string }).value;
    expect(docValue).toContain('users#index');
    expect(docValue).toContain('users#create');
    project.dispose();
  });

  it('returns undefined for unsupported languages', async () => {
    const project = await makeProject();
    const provider = new RouteHelperCompletionProvider(() => project);

    const items = await provider.provideCompletionItems(
      fakeDoc('edit_user_', 'plaintext'),
      new Position(0, 10),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );
    expect(items).toBeUndefined();
    project.dispose();
  });

  it('returns undefined when the prefix matches no route', async () => {
    const project = await makeProject();
    const provider = new RouteHelperCompletionProvider(() => project);

    const items = await provider.provideCompletionItems(
      fakeDoc('completely_unrelated_'),
      new Position(0, 20),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );
    expect(items).toBeUndefined();
    project.dispose();
  });

  it('suggests namespaced helpers when prefix matches the namespace', async () => {
    const project = await makeProject();
    const provider = new RouteHelperCompletionProvider(() => project);

    const items = await provider.provideCompletionItems(
      fakeDoc('admin_'),
      new Position(0, 6),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );
    expect(items).toBeDefined();
    const labels = items!.map((i) => i.label);
    expect(labels).toContain('admin_posts_path');
    expect(labels).toContain('admin_post_path');
    project.dispose();
  });

  it('works in erb files (view context)', async () => {
    const project = await makeProject();
    const provider = new RouteHelperCompletionProvider(() => project);

    const items = await provider.provideCompletionItems(
      fakeDoc('about_', 'erb'),
      new Position(0, 6),
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as never,
      {} as never,
    );
    expect(items!.map((i) => i.label)).toContain('about_path');
    project.dispose();
  });
});
