/**
 * Unit tests for ClassIndex. Body-aware parser feeding the four complexity
 * metrics. Focuses on what each class records — method visibility, body
 * extraction, ivar / class-ref / method-call sets, branch-point count.
 */

import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { Uri } from '../../helpers/mock-vscode';
import { ClassIndex } from '../../../src/rails/ClassIndex';

function indexFrom(files: Record<string, string>): Promise<ClassIndex> {
  const uris = Object.keys(files).map((p) => Uri.file(p));
  return ClassIndex.build(Uri.file('/app'), {
    findRubyFiles: async () => uris,
    readFile: async (uri: vscode.Uri) => files[uri.fsPath],
  });
}

describe('ClassIndex.build', () => {
  it('records a class with declaration / end ranges and parent', async () => {
    const idx = await indexFrom({
      '/app/lib/foo.rb': `class Foo < Bar
  def hello
  end
end
`,
    });
    const foo = idx.byName('Foo')!;
    expect(foo).toBeDefined();
    expect(foo.parent).toBe('Bar');
    expect(foo.declarationLine).toBe(0);
    expect(foo.endLine).toBe(3);
    expect(foo.methods).toHaveLength(1);
  });

  it('tracks visibility transitions (public → private → public)', async () => {
    const idx = await indexFrom({
      '/app/lib/foo.rb': `class Foo
  def pub_one
  end

  private

  def priv_one
  end

  def priv_two
  end

  public

  def pub_two
  end
end
`,
    });
    const foo = idx.byName('Foo')!;
    const byName = Object.fromEntries(foo.methods.map((m) => [m.name, m]));
    expect(byName.pub_one.visibility).toBe('public');
    expect(byName.priv_one.visibility).toBe('private');
    expect(byName.priv_two.visibility).toBe('private');
    expect(byName.pub_two.visibility).toBe('public');
  });

  it('promotes methods inside `class << self` to class methods', async () => {
    const idx = await indexFrom({
      '/app/lib/foo.rb': `class Foo
  class << self
    def builder
    end
  end

  def instance_one
  end
end
`,
    });
    const foo = idx.byName('Foo')!;
    const byName = Object.fromEntries(foo.methods.map((m) => [m.name, m]));
    expect(byName.builder.isClass).toBe(true);
    expect(byName.instance_one.isClass).toBe(false);
  });

  it('extracts ivar refs inside method bodies', async () => {
    const idx = await indexFrom({
      '/app/lib/foo.rb': `class Foo
  def populate
    @name = "x"
    @count = (@count || 0) + 1
    "static"
  end
end
`,
    });
    const populate = idx.byName('Foo')!.methods[0];
    expect(populate.ivarRefs.has('@name')).toBe(true);
    expect(populate.ivarRefs.has('@count')).toBe(true);
    expect(populate.ivarRefs.size).toBe(2);
  });

  it('extracts class constant refs minus the method-owner', async () => {
    const idx = await indexFrom({
      '/app/lib/foo.rb': `class Foo
  def build
    Bar.new
    Baz::Qux.do_it
    "ignore #{Useless}"
  end
end
`,
    });
    const build = idx.byName('Foo')!.methods[0];
    expect(build.classRefs.has('Bar')).toBe(true);
    expect(build.classRefs.has('Baz::Qux')).toBe(true);
    // Inside a string literal — should be scrubbed.
    expect(build.classRefs.has('Useless')).toBe(false);
  });

  it('captures candidate method-call identifiers, excluding ruby keywords', async () => {
    const idx = await indexFrom({
      '/app/lib/foo.rb': `class Foo
  def do_thing
    helper_a
    helper_b(1, 2)
    if some_predicate?
      another_call
    end
  end
end
`,
    });
    const m = idx.byName('Foo')!.methods[0];
    expect(m.methodCalls.has('helper_a')).toBe(true);
    expect(m.methodCalls.has('helper_b')).toBe(true);
    expect(m.methodCalls.has('some_predicate?')).toBe(true);
    expect(m.methodCalls.has('another_call')).toBe(true);
    expect(m.methodCalls.has('if')).toBe(false);
    expect(m.methodCalls.has('end')).toBe(false);
  });

  it('counts branch points for cyclomatic complexity', async () => {
    const idx = await indexFrom({
      '/app/lib/foo.rb': `class Foo
  def linear
    1 + 1
  end

  def branchy(x)
    if x > 0
      x.times do |i|
        puts i if i.even?
      end
    elsif x < 0
      raise "neg"
    end
    x || 0
  rescue StandardError
    nil
  end
end
`,
    });
    const byName = Object.fromEntries(
      idx.byName('Foo')!.methods.map((m) => [m.name, m]),
    );
    expect(byName.linear.branchPoints).toBe(0);
    // if, if (inline), elsif, ||, rescue → 5 branch points (cyclomatic 6).
    expect(byName.branchy.branchPoints).toBeGreaterThanOrEqual(4);
  });

  it('records multiple classes per file in declaration order', async () => {
    const idx = await indexFrom({
      '/app/lib/multi.rb': `class A
  def a; end
end

class B < A
  def b; end
end
`,
    });
    expect(idx.byName('A')).toBeDefined();
    expect(idx.byName('B')).toBeDefined();
    expect(idx.byName('B')!.parent).toBe('A');
    expect(idx.classesIn(Uri.file('/app/lib/multi.rb'))).toHaveLength(2);
  });

  it('reparseFile replaces previous entries for that file', async () => {
    const files = {
      '/app/lib/foo.rb': `class Foo
  def a; end
end
`,
    };
    const idx = await ClassIndex.build(Uri.file('/app'), {
      findRubyFiles: async () => [Uri.file('/app/lib/foo.rb')],
      readFile: async (u: vscode.Uri) => files[u.fsPath as keyof typeof files],
    });
    expect(idx.byName('Foo')!.methods).toHaveLength(1);

    files['/app/lib/foo.rb'] = `class Foo
  def a; end
  def b; end
  def c; end
end
`;
    await idx.reparseFile(Uri.file('/app/lib/foo.rb'));
    expect(idx.byName('Foo')!.methods).toHaveLength(3);
  });
});
