/**
 * Unit tests for GitAdapter — verify each method shells out with the
 * expected arguments and surfaces non-zero exits as errors.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter as NodeEventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { GitAdapter } from '../../../src/plans/GitAdapter';

interface SpawnRecord {
  command: string;
  args: ReadonlyArray<string>;
}

function makeSpawn(opts: {
  stdout?: string;
  code?: number;
  records: SpawnRecord[];
}) {
  return ((command: string, args: ReadonlyArray<string>) => {
    opts.records.push({ command, args });
    const proc = new NodeEventEmitter();
    Object.assign(proc, {
      stdout: Readable.from([Buffer.from(opts.stdout ?? '', 'utf-8')]),
      stderr: Readable.from([]),
    });
    setImmediate(() => proc.emit('close', opts.code ?? 0));
    return proc as never;
  }) as never;
}

describe('GitAdapter', () => {
  it('branch() runs git checkout -b <name>', async () => {
    const records: SpawnRecord[] = [];
    const adapter = new GitAdapter({ cwd: '/repo', spawn: makeSpawn({ records }) });
    await adapter.branch('rubyn/feature-phase-01');
    expect(records).toContainEqual({
      command: 'git',
      args: ['checkout', '-b', 'rubyn/feature-phase-01'],
    });
  });

  it('branch() with base runs git checkout -b <name> <base>', async () => {
    const records: SpawnRecord[] = [];
    const adapter = new GitAdapter({ cwd: '/repo', spawn: makeSpawn({ records }) });
    await adapter.branch('feature', 'main');
    expect(records[0].args).toEqual(['checkout', '-b', 'feature', 'main']);
  });

  it('add() / commit() / push() emit the right invocations', async () => {
    const records: SpawnRecord[] = [];
    const adapter = new GitAdapter({ cwd: '/repo', spawn: makeSpawn({ records }) });
    await adapter.add(['docs/foo.md', 'docs/bar.md']);
    await adapter.commit('Megaplan: x');
    await adapter.push('rubyn/x');
    expect(records[0].args).toEqual(['add', '--', 'docs/foo.md', 'docs/bar.md']);
    expect(records[1].args).toEqual(['commit', '-m', 'Megaplan: x']);
    expect(records[2].args).toEqual(['push', '-u', 'origin', 'rubyn/x']);
  });

  it('currentBranch() trims trailing whitespace', async () => {
    const records: SpawnRecord[] = [];
    const adapter = new GitAdapter({
      cwd: '/repo',
      spawn: makeSpawn({ records, stdout: 'main\n' }),
    });
    expect(await adapter.currentBranch()).toBe('main');
  });

  it('add() with empty list is a no-op', async () => {
    const records: SpawnRecord[] = [];
    const adapter = new GitAdapter({ cwd: '/repo', spawn: makeSpawn({ records }) });
    await adapter.add([]);
    expect(records).toHaveLength(0);
  });

  it('throws on non-zero git exit, including stderr', async () => {
    const records: SpawnRecord[] = [];
    const adapter = new GitAdapter({
      cwd: '/repo',
      spawn: ((c: string, a: ReadonlyArray<string>) => {
        records.push({ command: c, args: a });
        const proc = new NodeEventEmitter();
        Object.assign(proc, {
          stdout: Readable.from([]),
          stderr: Readable.from([Buffer.from('fatal: not a git repo', 'utf-8')]),
        });
        setImmediate(() => proc.emit('close', 128));
        return proc as never;
      }) as never,
    });
    await expect(adapter.commit('x')).rejects.toThrow(/fatal: not a git repo/);
  });

  it('hasUncommittedChanges() reflects porcelain output', async () => {
    const adapter = new GitAdapter({
      cwd: '/repo',
      spawn: makeSpawn({ records: [], stdout: ' M docs/foo.md\n' }),
    });
    expect(await adapter.hasUncommittedChanges()).toBe(true);
    const clean = new GitAdapter({
      cwd: '/repo',
      spawn: makeSpawn({ records: [], stdout: '' }),
    });
    expect(await clean.hasUncommittedChanges()).toBe(false);
  });
});
