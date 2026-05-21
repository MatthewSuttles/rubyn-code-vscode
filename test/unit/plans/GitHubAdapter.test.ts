/**
 * Unit tests for GitHubAdapter — verifies the gh-first / API-fallback /
 * no-auth-error decision tree.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter as NodeEventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { GitHubAdapter, parseGitHubRemote } from '../../../src/plans/GitHubAdapter';

interface FakeProcOptions {
  stdout?: string;
  stderr?: string;
  code?: number;
}

function makeProc(opts: FakeProcOptions = {}): never {
  const proc = new NodeEventEmitter();
  Object.assign(proc, {
    stdout: Readable.from([Buffer.from(opts.stdout ?? '', 'utf-8')]),
    stderr: Readable.from([Buffer.from(opts.stderr ?? '', 'utf-8')]),
  });
  setImmediate(() => proc.emit('close', opts.code ?? 0));
  return proc as never;
}

interface SpawnPlan {
  match(command: string, args: ReadonlyArray<string>): FakeProcOptions | undefined;
}

function spawner(plan: SpawnPlan) {
  return ((command: string, args: ReadonlyArray<string>) => {
    const opts = plan.match(command, args);
    if (!opts) {
      throw new Error(`Unexpected spawn: ${command} ${args.join(' ')}`);
    }
    return makeProc(opts);
  }) as never;
}

describe('parseGitHubRemote', () => {
  it.each([
    ['git@github.com:matt/rubyn.git', { owner: 'matt', repo: 'rubyn' }],
    ['https://github.com/matt/rubyn.git', { owner: 'matt', repo: 'rubyn' }],
    ['https://github.com/matt/rubyn', { owner: 'matt', repo: 'rubyn' }],
    ['https://x:y@github.com/matt/rubyn.git', { owner: 'matt', repo: 'rubyn' }],
  ])('parses %s', (url, expected) => {
    expect(parseGitHubRemote(url)).toEqual(expected);
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGitHubRemote('git@gitlab.com:foo/bar.git')).toBeNull();
    expect(parseGitHubRemote('not a url')).toBeNull();
  });
});

describe('GitHubAdapter', () => {
  it('prefers `gh pr create` and parses the URL from stdout', async () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const adapter = new GitHubAdapter({
      cwd: '/repo',
      secrets: { get: async () => undefined },
      spawn: spawner({
        match(command, args) {
          calls.push({ command, args });
          if (command === 'gh' && args[0] === 'auth') {
            return { code: 0 };
          }
          if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
            return {
              code: 0,
              stdout: 'https://github.com/matt/rubyn/pull/42\n',
            };
          }
          return undefined;
        },
      }),
    });
    const url = await adapter.openPR({
      title: 't',
      body: 'b',
      base: 'main',
      head: 'rubyn/x',
    });
    expect(url).toBe('https://github.com/matt/rubyn/pull/42');
    const ghCreate = calls.find((c) => c.command === 'gh' && c.args[0] === 'pr');
    expect(ghCreate?.args).toEqual([
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'rubyn/x',
      '--title',
      't',
      '--body',
      'b',
    ]);
  });

  it('falls back to the GitHub API when gh is not available but a token is', async () => {
    let fetchCalled = false;
    const adapter = new GitHubAdapter({
      cwd: '/repo',
      secrets: { get: async () => 'ghp_token' },
      spawn: spawner({
        match(command, args) {
          if (command === 'gh' && args[0] === 'auth') return { code: 1 };
          if (command === 'git' && args.includes('--get')) {
            return {
              code: 0,
              stdout: 'git@github.com:matt/rubyn.git\n',
            };
          }
          return undefined;
        },
      }),
      fetch: async (url, init) => {
        fetchCalled = true;
        expect(url).toBe('https://api.github.com/repos/matt/rubyn/pulls');
        expect(init.headers.Authorization).toBe('Bearer ghp_token');
        const body = JSON.parse(init.body);
        expect(body.title).toBe('t');
        expect(body.head).toBe('rubyn/x');
        return {
          ok: true,
          status: 201,
          text: async () => '',
          json: async () => ({ html_url: 'https://github.com/matt/rubyn/pull/9' }),
        };
      },
    });
    const url = await adapter.openPR({
      title: 't',
      body: 'b',
      base: 'main',
      head: 'rubyn/x',
    });
    expect(fetchCalled).toBe(true);
    expect(url).toBe('https://github.com/matt/rubyn/pull/9');
  });

  it('surfaces a setup error when neither gh nor a token is available', async () => {
    const adapter = new GitHubAdapter({
      cwd: '/repo',
      secrets: { get: async () => undefined },
      spawn: spawner({
        match(command, args) {
          if (command === 'gh' && args[0] === 'auth') return { code: 1 };
          return undefined;
        },
      }),
    });
    await expect(
      adapter.openPR({ title: 't', body: 'b', base: 'main', head: 'h' }),
    ).rejects.toThrow(/No PR-creation auth available/);
  });

  it('surfaces gh pr create failures with stderr text', async () => {
    const adapter = new GitHubAdapter({
      cwd: '/repo',
      secrets: { get: async () => undefined },
      spawn: spawner({
        match(command, args) {
          if (command === 'gh' && args[0] === 'auth') return { code: 0 };
          if (command === 'gh' && args[0] === 'pr') {
            return {
              code: 1,
              stderr: 'a pull request already exists',
            };
          }
          return undefined;
        },
      }),
    });
    await expect(
      adapter.openPR({ title: 't', body: 'b', base: 'main', head: 'h' }),
    ).rejects.toThrow(/pull request already exists/);
  });
});
