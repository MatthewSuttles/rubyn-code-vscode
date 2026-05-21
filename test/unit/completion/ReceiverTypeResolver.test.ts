/**
 * Table-driven tests for ReceiverTypeResolver. Each case is a Ruby snippet
 * with a `|` cursor marker; the test rig strips it before passing text +
 * offset to the resolver.
 *
 * Covers ≥50 cursor positions across:
 *   - constant root → class / relation / instance / unknown chain steps
 *   - association traversal across has_many / has_one / belongs_to
 *   - local-variable assignment scanning
 *   - ivar assignment scanning
 *   - controller-convention ivar binding
 *   - negative cases (no `.` before cursor, undefined model, etc.)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { __resetAll, Uri, Position } from '../../helpers/mock-vscode';

import { ModelIndex } from '../../../src/rails/ModelIndex';
import {
  ReceiverType,
  ReceiverTypeResolver,
} from '../../../src/completion/ReceiverTypeResolver';

const MODEL_FILES = {
  '/app/app/models/user.rb': `class User < ApplicationRecord
  has_many :posts
  has_many :comments
  has_one :profile
  belongs_to :organization
  has_many :groups, through: :memberships
  has_many :memberships

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
  belongs_to :user
  belongs_to :post
end
`,
  '/app/app/models/organization.rb': `class Organization < ApplicationRecord
  has_many :users
end
`,
  '/app/app/models/profile.rb': `class Profile < ApplicationRecord
  belongs_to :user
end
`,
  '/app/app/models/group.rb': `class Group < ApplicationRecord
  has_many :memberships
end
`,
  '/app/app/models/membership.rb': `class Membership < ApplicationRecord
  belongs_to :user
  belongs_to :group
end
`,
};

async function buildIndex(): Promise<ModelIndex> {
  const uris = Object.keys(MODEL_FILES).map((p) => Uri.file(p));
  return ModelIndex.build(Uri.file('/app'), {
    findModelFiles: async () => uris,
    readFile: async (uri: vscode.Uri) =>
      MODEL_FILES[uri.fsPath as keyof typeof MODEL_FILES],
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

interface Case {
  name: string;
  text: string;
  filePath?: string;
  expect: ReceiverType;
}

const CONSTANT_CASES: Case[] = [
  {
    name: 'User. → class',
    text: 'User.|',
    expect: { kind: 'class', modelName: 'User' },
  },
  {
    name: 'User.active. → relation (scope)',
    text: 'User.active.|',
    expect: { kind: 'relation', modelName: 'User' },
  },
  {
    name: 'User.where(active: true). → relation',
    text: 'User.where(active: true).|',
    expect: { kind: 'relation', modelName: 'User' },
  },
  {
    name: 'User.find(1). → instance',
    text: 'User.find(1).|',
    expect: { kind: 'instance', modelName: 'User' },
  },
  {
    name: 'User.first. → instance',
    text: 'User.first.|',
    expect: { kind: 'instance', modelName: 'User' },
  },
  {
    name: 'User.find_by(email: "x"). → instance',
    text: 'User.find_by(email: "x").|',
    expect: { kind: 'instance', modelName: 'User' },
  },
  {
    name: 'User.search("foo"). → relation (class method, best-effort)',
    text: 'User.search("foo").|',
    expect: { kind: 'relation', modelName: 'User' },
  },
  {
    name: 'User.all. → relation',
    text: 'User.all.|',
    expect: { kind: 'relation', modelName: 'User' },
  },
  {
    name: 'User.none. → relation',
    text: 'User.none.|',
    expect: { kind: 'relation', modelName: 'User' },
  },
  {
    name: 'Post.published. → relation',
    text: 'Post.published.|',
    expect: { kind: 'relation', modelName: 'Post' },
  },
];

const ASSOC_CASES: Case[] = [
  {
    name: 'user.posts. (has_many) → relation of Post',
    text: 'user = User.find(1)\nuser.posts.|',
    expect: { kind: 'relation', modelName: 'Post' },
  },
  {
    name: 'user.profile. (has_one) → instance of Profile',
    text: 'user = User.find(1)\nuser.profile.|',
    expect: { kind: 'instance', modelName: 'Profile' },
  },
  {
    name: 'user.organization. (belongs_to) → instance of Organization',
    text: 'user = User.find(1)\nuser.organization.|',
    expect: { kind: 'instance', modelName: 'Organization' },
  },
  {
    name: 'user.posts.first. → instance of Post',
    text: 'user = User.find(1)\nuser.posts.first.|',
    expect: { kind: 'instance', modelName: 'Post' },
  },
  {
    name: 'user.posts.published. → relation of Post',
    text: 'user = User.find(1)\nuser.posts.published.|',
    expect: { kind: 'relation', modelName: 'Post' },
  },
  {
    name: 'user.posts.published.where(x: 1). → relation of Post',
    text: 'user = User.find(1)\nuser.posts.published.where(x: 1).|',
    expect: { kind: 'relation', modelName: 'Post' },
  },
  {
    name: 'user.posts.where(x: 1).first. → instance of Post',
    text: 'user = User.find(1)\nuser.posts.where(x: 1).first.|',
    expect: { kind: 'instance', modelName: 'Post' },
  },
  {
    name: 'organization.users. (has_many) → relation of User',
    text: 'org = Organization.find(1)\norg.users.|',
    expect: { kind: 'relation', modelName: 'User' },
  },
];

const IVAR_AND_LOCAL_CASES: Case[] = [
  {
    name: '@user assigned to User.find(...) → instance',
    text: `def show
  @user = User.find(params[:id])
  @user.|
end
`,
    expect: { kind: 'instance', modelName: 'User' },
  },
  {
    name: '@user assigned to User.where(...).first → instance',
    text: `def show
  @user = User.where(active: true).first
  @user.|
end
`,
    expect: { kind: 'instance', modelName: 'User' },
  },
  {
    name: 'local var bound to a relation → relation',
    text: `def index
  scope = User.active
  scope.|
end
`,
    expect: { kind: 'relation', modelName: 'User' },
  },
  {
    name: 'local var bound to User class → class',
    text: `model = User
model.|
`,
    expect: { kind: 'class', modelName: 'User' },
  },
  {
    name: 'undefined local var → unknown',
    text: 'unknown_var.|',
    expect: { kind: 'unknown' },
  },
];

const CONTROLLER_CONVENTION_CASES: Case[] = [
  {
    name: '@user in UsersController → instance of User',
    text: '@user.|',
    filePath: '/app/app/controllers/users_controller.rb',
    expect: { kind: 'instance', modelName: 'User' },
  },
  {
    name: '@users in UsersController → relation of User',
    text: '@users.|',
    filePath: '/app/app/controllers/users_controller.rb',
    expect: { kind: 'relation', modelName: 'User' },
  },
  {
    name: '@post in PostsController → instance of Post',
    text: '@post.|',
    filePath: '/app/app/controllers/posts_controller.rb',
    expect: { kind: 'instance', modelName: 'Post' },
  },
  {
    name: '@user in NonController file → unknown',
    text: '@user.|',
    filePath: '/app/lib/something.rb',
    expect: { kind: 'unknown' },
  },
  {
    name: '@nonsense in UsersController → unknown',
    text: '@nonsense.|',
    filePath: '/app/app/controllers/users_controller.rb',
    expect: { kind: 'unknown' },
  },
];

const RELATION_CHAIN_CASES: Case[] = [
  {
    name: 'User.active.recent. → relation (scope chain)',
    text: 'User.active.recent.|',
    expect: { kind: 'relation', modelName: 'User' },
  },
  {
    name: 'User.where(active: true).order(:name). → relation',
    text: 'User.where(active: true).order(:name).|',
    expect: { kind: 'relation', modelName: 'User' },
  },
  {
    name: 'User.where(...).first.posts. → relation of Post',
    text: 'User.where(active: true).first.posts.|',
    expect: { kind: 'relation', modelName: 'Post' },
  },
  {
    name: 'User.find(1).posts.first. → instance of Post',
    text: 'User.find(1).posts.first.|',
    expect: { kind: 'instance', modelName: 'Post' },
  },
  {
    name: 'User.find_by(email: "x").profile. → instance of Profile',
    text: 'User.find_by(email: "x").profile.|',
    expect: { kind: 'instance', modelName: 'Profile' },
  },
  {
    name: 'User.find(1).comments. → relation of Comment',
    text: 'User.find(1).comments.|',
    expect: { kind: 'relation', modelName: 'Comment' },
  },
  {
    name: 'Post.first.user. → instance of User (belongs_to)',
    text: 'Post.first.user.|',
    expect: { kind: 'instance', modelName: 'User' },
  },
  {
    name: 'Post.first.user.posts. → relation of Post (transitive)',
    text: 'Post.first.user.posts.|',
    expect: { kind: 'relation', modelName: 'Post' },
  },
  {
    name: 'User.includes(:posts).where(active: true). → relation',
    text: 'User.includes(:posts).where(active: true).|',
    expect: { kind: 'relation', modelName: 'User' },
  },
  {
    name: 'User.joins(:posts). → relation',
    text: 'User.joins(:posts).|',
    expect: { kind: 'relation', modelName: 'User' },
  },
];

const VAR_RHS_CASES: Case[] = [
  {
    name: '@org assigned to Organization.find → users. on @org. → unknown without resolver chain',
    text: `def show
  @org = Organization.find(params[:id])
  @org.|
end
`,
    expect: { kind: 'instance', modelName: 'Organization' },
  },
  {
    name: '@org.users. → relation of User',
    text: `def show
  @org = Organization.find(params[:id])
  @org.users.|
end
`,
    expect: { kind: 'relation', modelName: 'User' },
  },
  {
    name: 'local var bound to relation, then .first → instance',
    text: `def index
  scope = User.active
  scope.first.|
end
`,
    expect: { kind: 'instance', modelName: 'User' },
  },
  {
    name: 'local var bound to instance, then .posts → relation',
    text: `def index
  current = User.find(1)
  current.posts.|
end
`,
    expect: { kind: 'relation', modelName: 'Post' },
  },
  {
    name: 'reassignment — last assignment wins',
    text: `def index
  it = Post.first
  it = User.first
  it.|
end
`,
    expect: { kind: 'instance', modelName: 'User' },
  },
];

const NEGATIVE_CASES: Case[] = [
  {
    name: 'no dot before cursor',
    text: 'User|',
    expect: { kind: 'unknown' },
  },
  {
    name: 'unknown model constant',
    text: 'NoSuchModel.|',
    expect: { kind: 'unknown' },
  },
  {
    name: 'string literal before cursor',
    text: '"foo".|',
    expect: { kind: 'unknown' },
  },
  {
    name: 'chain step on unknown class is unknown',
    text: 'NoSuchModel.where.|',
    expect: { kind: 'unknown' },
  },
  {
    name: 'user. instance — but no assoc named `nope` → unknown',
    text: 'user = User.find(1)\nuser.nope.|',
    expect: { kind: 'unknown' },
  },
  {
    name: 'integer literal receiver → unknown',
    text: '42.|',
    expect: { kind: 'unknown' },
  },
  {
    name: 'class. method that is neither AR nor declared → unknown',
    text: 'User.completely_unknown_method.|',
    expect: { kind: 'unknown' },
  },
];

const ALL_CASES = [
  ...CONSTANT_CASES,
  ...ASSOC_CASES,
  ...IVAR_AND_LOCAL_CASES,
  ...CONTROLLER_CONVENTION_CASES,
  ...RELATION_CHAIN_CASES,
  ...VAR_RHS_CASES,
  ...NEGATIVE_CASES,
];

describe('ReceiverTypeResolver', () => {
  let resolver: ReceiverTypeResolver;

  beforeEach(async () => {
    __resetAll();
    resolver = new ReceiverTypeResolver(await buildIndex());
  });

  for (const c of ALL_CASES) {
    it(c.name, () => {
      const cursorOffset = c.text.indexOf('|');
      if (cursorOffset === -1) throw new Error(`no cursor in: ${c.text}`);
      const clean = c.text.slice(0, cursorOffset) + c.text.slice(cursorOffset + 1);
      const doc = makeDoc(clean, c.filePath);
      const pos = doc.positionAt(cursorOffset);
      const result = resolver.resolveAt(doc, pos);
      expect(result).toEqual(c.expect);
    });
  }

  it('runs at least 50 scenarios', () => {
    expect(ALL_CASES.length).toBeGreaterThanOrEqual(50);
  });
});
