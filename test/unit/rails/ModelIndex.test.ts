/**
 * Unit tests for ModelIndex. Each test feeds a Ruby snippet through
 * ModelIndex.build via a stub deps and asserts on the resulting ModelInfo.
 */

import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { Uri } from '../../helpers/mock-vscode';
import { ModelIndex } from '../../../src/rails/ModelIndex';

function indexFrom(files: Record<string, string>): Promise<ModelIndex> {
  const uris = Object.keys(files).map((p) => Uri.file(p));
  return ModelIndex.build(Uri.file('/app'), {
    findModelFiles: async () => uris,
    readFile: async (uri: vscode.Uri) => files[uri.fsPath],
  });
}

describe('ModelIndex.build', () => {
  it('records a single class with its parent', async () => {
    const idx = await indexFrom({
      '/app/app/models/user.rb': `class User < ApplicationRecord\nend\n`,
    });
    const user = idx.byName('User')!;
    expect(user).toBeDefined();
    expect(user.parent).toBe('ApplicationRecord');
    expect(user.fileUri.fsPath).toBe('/app/app/models/user.rb');
  });

  it('records namespaced classes via module wrapping', async () => {
    const idx = await indexFrom({
      '/app/app/models/admin/user.rb': `module Admin
  class User < ApplicationRecord
  end
end
`,
    });
    expect(idx.byName('Admin::User')).toBeDefined();
    expect(idx.byName('User')).toBeUndefined();
  });

  it('captures has_many / belongs_to / has_one / habtm associations', async () => {
    const idx = await indexFrom({
      '/app/app/models/user.rb': `class User < ApplicationRecord
  has_many :posts
  has_one :profile
  belongs_to :organization
  has_and_belongs_to_many :tags
end
`,
    });
    const user = idx.byName('User')!;
    const kinds = user.associations.map((a) => `${a.kind}:${a.name}`);
    expect(kinds).toContain('has_many:posts');
    expect(kinds).toContain('has_one:profile');
    expect(kinds).toContain('belongs_to:organization');
    expect(kinds).toContain('has_and_belongs_to_many:tags');
  });

  it('resolves association target classes by convention (plural → singular Camel)', async () => {
    const idx = await indexFrom({
      '/app/app/models/user.rb': `class User < ApplicationRecord
  has_many :posts
  has_many :order_items
  has_many :categories
  belongs_to :user_account
end
`,
    });
    const user = idx.byName('User')!;
    const map = Object.fromEntries(user.associations.map((a) => [a.name, a.targetClass]));
    expect(map.posts).toBe('Post');
    expect(map.order_items).toBe('OrderItem');
    expect(map.categories).toBe('Category');
    expect(map.user_account).toBe('UserAccount');
  });

  it('respects class_name: overrides on associations', async () => {
    const idx = await indexFrom({
      '/app/app/models/user.rb': `class User < ApplicationRecord
  has_many :authored_posts, class_name: "Post"
  belongs_to :manager, class_name: "User"
end
`,
    });
    const user = idx.byName('User')!;
    const posts = user.associations.find((a) => a.name === 'authored_posts')!;
    expect(posts.targetClass).toBe('Post');
    const manager = user.associations.find((a) => a.name === 'manager')!;
    expect(manager.targetClass).toBe('User');
  });

  it('captures through: and polymorphic: options', async () => {
    const idx = await indexFrom({
      '/app/app/models/user.rb': `class User < ApplicationRecord
  has_many :memberships
  has_many :groups, through: :memberships
end
`,
      '/app/app/models/comment.rb': `class Comment < ApplicationRecord
  belongs_to :commentable, polymorphic: true
end
`,
    });
    const user = idx.byName('User')!;
    const groups = user.associations.find((a) => a.name === 'groups')!;
    expect(groups.through).toBe('memberships');

    const comment = idx.byName('Comment')!;
    const commentable = comment.associations.find((a) => a.name === 'commentable')!;
    expect(commentable.polymorphic).toBe(true);
  });

  it('captures scope declarations with arity', async () => {
    const idx = await indexFrom({
      '/app/app/models/post.rb': `class Post < ApplicationRecord
  scope :published, -> { where(published: true) }
  scope :recent, ->(days = 7) { where(created_at: days.ago..) }
  scope :by_author, ->(author_id, status) { where(author_id:, status:) }
end
`,
    });
    const post = idx.byName('Post')!;
    const scopes = Object.fromEntries(post.scopes.map((s) => [s.name, s]));
    expect(scopes.published.arity).toBe(0);
    expect(scopes.recent.arity).toBe(1);
    expect(scopes.by_author.arity).toBe(2);
  });

  it('captures def self.method and def method separately', async () => {
    const idx = await indexFrom({
      '/app/app/models/user.rb': `class User < ApplicationRecord
  def self.search(query)
    where("name LIKE ?", "%\#{query}%")
  end

  def display_name
    name || email
  end

  def full_address(formatter)
    formatter.call(street, city)
  end
end
`,
    });
    const user = idx.byName('User')!;
    expect(user.classMethods.map((m) => m.name)).toEqual(['search']);
    expect(user.classMethods[0].arity).toBe(1);
    const instances = Object.fromEntries(user.instanceMethods.map((m) => [m.name, m]));
    expect(instances.display_name.arity).toBe(0);
    expect(instances.full_address.arity).toBe(1);
  });

  it('skips macros declared inside method bodies', async () => {
    const idx = await indexFrom({
      '/app/app/models/user.rb': `class User < ApplicationRecord
  def setup
    has_many :red_herring
    scope :nope, -> {}
  end
end
`,
    });
    const user = idx.byName('User')!;
    expect(user.associations).toEqual([]);
    expect(user.scopes).toEqual([]);
    expect(user.instanceMethods.map((m) => m.name)).toEqual(['setup']);
  });

  it('treats methods inside `class << self` as class methods', async () => {
    const idx = await indexFrom({
      '/app/app/models/user.rb': `class User < ApplicationRecord
  class << self
    def by_role(r)
      where(role: r)
    end
  end

  def name_with_role
    name
  end
end
`,
    });
    const user = idx.byName('User')!;
    expect(user.classMethods.map((m) => m.name)).toEqual(['by_role']);
    expect(user.instanceMethods.map((m) => m.name)).toEqual(['name_with_role']);
  });

  it('does not crash on STI-shaped declarations', async () => {
    const idx = await indexFrom({
      '/app/app/models/animal.rb': `class Animal < ApplicationRecord
end

class Dog < Animal
  scope :friendly, -> { where(friendly: true) }
end
`,
    });
    expect(idx.byName('Animal')).toBeDefined();
    const dog = idx.byName('Dog')!;
    expect(dog.parent).toBe('Animal');
    expect(dog.scopes.map((s) => s.name)).toEqual(['friendly']);
  });

  it('reparseFile replaces previous models for that file', async () => {
    const files = {
      '/app/app/models/user.rb': `class User < ApplicationRecord
  has_many :posts
end
`,
    };
    const idx = await ModelIndex.build(Uri.file('/app'), {
      findModelFiles: async () => [Uri.file('/app/app/models/user.rb')],
      readFile: async (uri: vscode.Uri) => files[uri.fsPath as keyof typeof files],
    });
    expect(idx.byName('User')!.associations).toHaveLength(1);

    files['/app/app/models/user.rb'] = `class User < ApplicationRecord
  has_many :posts
  has_many :comments
  scope :active, -> { where(active: true) }
end
`;
    await idx.reparseFile(Uri.file('/app/app/models/user.rb'));
    const user = idx.byName('User')!;
    expect(user.associations.map((a) => a.name).sort()).toEqual(['comments', 'posts']);
    expect(user.scopes.map((s) => s.name)).toEqual(['active']);
  });
});
