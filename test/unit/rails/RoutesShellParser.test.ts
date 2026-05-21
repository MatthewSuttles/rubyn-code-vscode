/**
 * Unit tests for RoutesShellParser. Mocks node:child_process.spawn and feeds
 * recorded outputs from `bin/rails routes --format=json` (Rails 7+) and the
 * table-format fallback (Rails 6 and older).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter as NodeEventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Uri } from '../../helpers/mock-vscode';

import { RoutesShellParser } from '../../../src/rails/RoutesShellParser';

interface MockProc {
  stdout: Readable;
  stderr: Readable;
  emitClose: (code: number) => void;
  kill: () => void;
  on: NodeEventEmitter['on'];
  emit: NodeEventEmitter['emit'];
}

function makeMockSpawn(output: string, exitCode = 0) {
  return ((..._args: unknown[]) => {
    const stdout = Readable.from([Buffer.from(output, 'utf-8')]);
    const stderr = Readable.from([]);
    const proc = new NodeEventEmitter() as MockProc & NodeEventEmitter;
    Object.assign(proc, { stdout, stderr, kill: vi.fn() });
    // Defer close so listeners attach first.
    setImmediate(() => proc.emit('close', exitCode));
    return proc;
  }) as never;
}

const JSON_OUTPUT_RAILS_7 = JSON.stringify([
  { name: 'users', verb: 'GET', path: '/users(.:format)', reqs: 'users#index' },
  { name: 'user', verb: 'GET', path: '/users/:id(.:format)', reqs: 'users#show' },
  { name: 'edit_user', verb: 'GET', path: '/users/:id/edit(.:format)', reqs: 'users#edit' },
]);

const TABLE_OUTPUT_RAILS_6 = `
                   Prefix Verb   URI Pattern                       Controller#Action
                    users GET    /users(.:format)                  users#index
                     user GET    /users/:id(.:format)              users#show
                edit_user GET    /users/:id/edit(.:format)         users#edit
`;

describe('RoutesShellParser', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rubyn-shell-'));
    await fs.mkdir(path.join(tmpRoot, 'config'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'config', 'routes.rb'), 'placeholder', 'utf-8');
  });

  it('parses Rails 7+ JSON output', async () => {
    const parser = new RoutesShellParser({
      root: Uri.file(tmpRoot),
      spawn: makeMockSpawn(JSON_OUTPUT_RAILS_7),
    });
    const routes = await parser.parse();
    expect(routes).not.toBeNull();
    expect(routes!.map((r) => r.helper).sort()).toEqual(['edit_user', 'user', 'users']);
    const edit = routes!.find((r) => r.helper === 'edit_user')!;
    expect(edit.verb).toBe('GET');
    expect(edit.pattern).toBe('/users/:id/edit');
    expect(edit.controller).toBe('users');
    expect(edit.action).toBe('edit');
  });

  it('falls back to the table format when JSON parse fails', async () => {
    const parser = new RoutesShellParser({
      root: Uri.file(tmpRoot),
      spawn: makeMockSpawn(TABLE_OUTPUT_RAILS_6),
    });
    const routes = await parser.parse();
    expect(routes).not.toBeNull();
    expect(routes!.map((r) => r.helper).sort()).toEqual(['edit_user', 'user', 'users']);
  });

  it('caches the result keyed on routes.rb mtime', async () => {
    let spawnCalls = 0;
    const spawnMock = ((..._args: unknown[]) => {
      spawnCalls += 1;
      const stdout = Readable.from([Buffer.from(JSON_OUTPUT_RAILS_7, 'utf-8')]);
      const stderr = Readable.from([]);
      const proc = new NodeEventEmitter() as MockProc & NodeEventEmitter;
      Object.assign(proc, { stdout, stderr, kill: vi.fn() });
      setImmediate(() => proc.emit('close', 0));
      return proc;
    }) as never;

    const parser = new RoutesShellParser({ root: Uri.file(tmpRoot), spawn: spawnMock });
    await parser.parse();
    await parser.parse();
    expect(spawnCalls).toBe(1);

    // Bump mtime by touching the file — the cache should invalidate.
    await new Promise((r) => setTimeout(r, 10));
    await fs.writeFile(path.join(tmpRoot, 'config', 'routes.rb'), 'still placeholder', 'utf-8');
    await parser.parse();
    expect(spawnCalls).toBe(2);
  });

  it('returns null when routes.rb is missing', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'rubyn-empty-'));
    const parser = new RoutesShellParser({
      root: Uri.file(empty),
      spawn: makeMockSpawn(JSON_OUTPUT_RAILS_7),
    });
    expect(await parser.parse()).toBeNull();
  });
});
