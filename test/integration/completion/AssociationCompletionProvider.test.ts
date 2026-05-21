/**
 * Integration tests for AssociationCompletionProvider. Builds a ModelIndex
 * over a small in-memory fixture, then drives the provider via stub
 * TextDocuments and asserts the emitted CompletionItem labels.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { __resetAll, Uri, Position } from '../../helpers/mock-vscode';

import { ModelIndex } from '../../../src/rails/ModelIndex';
import { AssociationCompletionProvider } from '../../../src/completion/AssociationCompletionProvider';

const FIXTURE = {
  '/app/app/models/user.rb': `class User < ApplicationRecord
  has_many :posts
  has_one :profile
  belongs_to :organization
  scope :active, -> { where(active: true) }
  scope :recent, ->(days = 7) { where(created_at: days.ago..) }
  def self.search(q)
  end
  def display_name
  end
end
`,
  '/app/app/models/post.rb': `class Post < ApplicationRecord
  belongs_to :user
  has_many :comments
  scope :published, -> { where(published: true) }
end
`,
  '/app/app/models/comment.rb': `class Comment < ApplicationRecord
  belongs_to :post
end
`,
  '/app/app/models/profile.rb': `class Profile < ApplicationRecord
  belongs_to :user
end
`,
  '/app/app/models/organization.rb': `class Organization < ApplicationRecord
  has_many :users
end
`,
};

async function buildIndex(): Promise<ModelIndex> {
  return ModelIndex.build(Uri.file('/app'), {
    findModelFiles: async () =>
      Object.keys(FIXTURE).map((p) => Uri.file(p)),
    readFile: async (uri) =>
      FIXTURE[uri.fsPath as keyof typeof FIXTURE],
  });
}

function makeDoc(text: string, filePath = '/app/app/views/users/index.erb'): vscode.TextDocument {
  return {
    uri: Uri.file(filePath),
    languageId: 'ruby',
    getText: () => text,
    offsetAt: (pos: vscode.Position) => {
      const lines = text.split('\n');
      let offset = 0;
      for (let i = 0; i < pos.line; i += 1) offset += lines[i].length + 1;
      return offset + pos.character;
    },
    positionAt: (offset: number) => {
      const before = text.slice(0, offset);
      const lines = before.split('\n');
      return new Position(lines.length - 1, lines[lines.length - 1].length);
    },
    lineAt: (lineOrPos: number | vscode.Position) => {
      const line =
        typeof lineOrPos === 'number' ? lineOrPos : lineOrPos.line;
      return { text: text.split('\n')[line] ?? '' } as never;
    },
  } as unknown as vscode.TextDocument;
}

async function runAt(text: string, filePath?: string): Promise<vscode.CompletionItem[] | undefined> {
  const index = await buildIndex();
  const provider = new AssociationCompletionProvider(async () => index);
  const cursor = text.indexOf('|');
  const clean = text.slice(0, cursor) + text.slice(cursor + 1);
  const doc = makeDoc(clean, filePath);
  const pos = doc.positionAt(cursor);
  return provider.provideCompletionItems(
    doc,
    pos,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as never,
    {} as never,
  );
}

function labels(items: vscode.CompletionItem[] | undefined): string[] {
  return (items ?? []).map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
}

describe('AssociationCompletionProvider', () => {
  beforeEach(() => {
    __resetAll();
  });

  it('class context: User. → scopes + class methods + AR class methods', async () => {
    const items = await runAt('User.|');
    const l = labels(items);
    expect(l).toContain('active');
    expect(l).toContain('recent');
    expect(l).toContain('search');
    expect(l).toContain('where');
    expect(l).toContain('find_by');
    expect(l).toContain('all');
  });

  it('instance context: user.find → associations + instance methods + AR instance methods', async () => {
    const items = await runAt('user = User.find(1)\nuser.|');
    const l = labels(items);
    expect(l).toContain('posts');
    expect(l).toContain('profile');
    expect(l).toContain('organization');
    expect(l).toContain('display_name');
    expect(l).toContain('save');
    expect(l).toContain('destroy');
  });

  it('relation context: User.where(...). → AR relation methods + scopes + associations', async () => {
    const items = await runAt('User.where(active: true).|');
    const l = labels(items);
    expect(l).toContain('active');
    expect(l).toContain('recent');
    expect(l).toContain('each');
    expect(l).toContain('order');
    // Relation also exposes associations of the target class for chaining.
    expect(l).toContain('posts');
  });

  it('association chain: user.posts. → relation of Post (Post associations + scopes)', async () => {
    const items = await runAt('user = User.find(1)\nuser.posts.|');
    const l = labels(items);
    expect(l).toContain('user');
    expect(l).toContain('comments');
    expect(l).toContain('published');
    expect(l).toContain('each');
  });

  it('unknown receiver → no items', async () => {
    const items = await runAt('NoSuchModel.|');
    expect(items).toBeUndefined();
  });

  it('does not fire in unsupported languages', async () => {
    const index = await buildIndex();
    const provider = new AssociationCompletionProvider(async () => index);
    const doc = makeDoc('User.|', '/app/foo.txt');
    const docPlaintext = { ...doc, languageId: 'plaintext' };
    const items = await provider.provideCompletionItems(
      docPlaintext as unknown as vscode.TextDocument,
      new Position(0, 5),
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as never,
      {} as never,
    );
    expect(items).toBeUndefined();
  });

  it('controller convention: @user. inside UsersController → User instance items', async () => {
    const items = await runAt(
      '@user.|',
      '/app/app/controllers/users_controller.rb',
    );
    const l = labels(items);
    expect(l).toContain('posts');
    expect(l).toContain('profile');
    expect(l).toContain('save');
  });

  it('associations carry a `→ TargetClass` detail', async () => {
    const items = await runAt('user = User.find(1)\nuser.|');
    const posts = items!.find((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'posts')!;
    expect(posts.detail).toBe('→ Post');
  });
});
