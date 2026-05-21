/**
 * Unit tests for the four phase-4 metric calculators. Each test runs a small
 * Ruby snippet through ClassIndex, then asserts the metric's output. Keeps
 * the fixture data realistic without standing up the diagnostic provider.
 */

import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { Uri } from '../../../helpers/mock-vscode';
import { ClassIndex } from '../../../../src/rails/ClassIndex';
import { publicMethodCount } from '../../../../src/diagnostics/metrics/methodCount';
import { lcom4 } from '../../../../src/diagnostics/metrics/lcom4';
import { fanOut } from '../../../../src/diagnostics/metrics/fanOut';
import { cyclomaticComplexity } from '../../../../src/diagnostics/metrics/cyclomatic';

async function classFrom(source: string, fileName = '/app/lib/foo.rb') {
  const idx = await ClassIndex.build(Uri.file('/app'), {
    findRubyFiles: async () => [Uri.file(fileName)],
    readFile: async (_u: vscode.Uri) => source,
  });
  return idx.all()[0];
}

describe('publicMethodCount', () => {
  it('counts only public methods', async () => {
    const c = await classFrom(`class Foo
  def pub_a; end
  def pub_b; end
  private
  def priv_a; end
end
`);
    expect(publicMethodCount(c)).toBe(2);
  });

  it('returns 0 for an empty class', async () => {
    const c = await classFrom('class Foo\nend\n');
    expect(publicMethodCount(c)).toBe(0);
  });
});

describe('lcom4', () => {
  it('single component when methods share an ivar', async () => {
    const c = await classFrom(`class Foo
  def a
    @x
  end
  def b
    @x + 1
  end
end
`);
    const result = lcom4(c);
    expect(result.total).toBe(1);
    expect(result.components).toEqual([2]);
  });

  it('two components when methods are isolated', async () => {
    const c = await classFrom(`class Foo
  def a
    @x
  end
  def b
    @y
  end
end
`);
    const result = lcom4(c);
    expect(result.total).toBe(2);
    expect(result.components).toEqual([1, 1]);
  });

  it('union via method call', async () => {
    const c = await classFrom(`class Foo
  def a
    helper
  end
  def helper
    @x
  end
end
`);
    expect(lcom4(c).total).toBe(1);
  });

  it('bridge method joins two otherwise disjoint groups', async () => {
    const c = await classFrom(`class Foo
  def a; @x; end
  def b; @x; end
  def c; @y; end
  def d; @y; end
  def bridge
    @x
    @y
  end
end
`);
    expect(lcom4(c).total).toBe(1);
  });

  it('fully disconnected methods report N components', async () => {
    const c = await classFrom(`class Foo
  def a; @x; end
  def b; @y; end
  def c; @z; end
end
`);
    const result = lcom4(c);
    expect(result.total).toBe(3);
    expect(result.components).toEqual([1, 1, 1]);
  });

  it('empty class returns no components', async () => {
    const c = await classFrom('class Foo\nend\n');
    expect(lcom4(c).total).toBe(0);
  });
});

describe('fanOut', () => {
  it('counts distinct external class refs and strips stdlib', async () => {
    const c = await classFrom(`class Foo
  def do_a
    Bar.new
    Baz.process
    Hash.new
    Time.now
  end

  def do_b
    Bar.find(1)
    OtherThing.run
  end
end
`);
    const result = fanOut(c);
    expect(result.count).toBe(3);
    expect(result.classes.sort()).toEqual(['Bar', 'Baz', 'OtherThing']);
  });

  it('excludes refs to self by both qualified and leaf name', async () => {
    const c = await classFrom(`module Admin
  class User
    def something
      User.new
      Admin::User.find(1)
      Bar.process
    end
  end
end
`);
    const result = fanOut(c);
    expect(result.count).toBe(1);
    expect(result.classes).toEqual(['Bar']);
  });

  it('returns 0 when only stdlib types are referenced', async () => {
    const c = await classFrom(`class Foo
  def do_it
    Array.new
    Hash.new
    String.new
  end
end
`);
    expect(fanOut(c).count).toBe(0);
  });
});

describe('cyclomaticComplexity', () => {
  it('baseline of 1 for a straight-line method', async () => {
    const c = await classFrom(`class Foo
  def a
    1 + 1
  end
end
`);
    expect(cyclomaticComplexity(c.methods[0])).toBe(1);
  });

  it('counts if + elsif + && + rescue', async () => {
    const c = await classFrom(`class Foo
  def a(x)
    if x && x > 0
      :positive
    elsif x < 0
      :negative
    else
      :zero
    end
  rescue StandardError
    :err
  end
end
`);
    // if, &&, elsif, rescue = 4 branch points → cyclomatic 5
    expect(cyclomaticComplexity(c.methods[0])).toBe(5);
  });

  it('case/when adds one per when', async () => {
    const c = await classFrom(`class Foo
  def a(x)
    case x
    when 1
      :one
    when 2
      :two
    when 3
      :three
    end
  end
end
`);
    // 3 whens → 4. Plus an `if` somewhere? No. So 3 branch points → 4.
    expect(cyclomaticComplexity(c.methods[0])).toBe(4);
  });

  it('counts ||', async () => {
    const c = await classFrom(`class Foo
  def a(x, y)
    x || y || 0
  end
end
`);
    expect(cyclomaticComplexity(c.methods[0])).toBe(3);
  });
});
