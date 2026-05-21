/**
 * Unit tests for PlanWriter — feeds it a real GitAdapter with mocked spawn
 * AND mocked vscode.workspace.fs.writeFile so we observe the exact files
 * + git invocations on approval.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter as NodeEventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as vscode from 'vscode';
import { __resetAll, Uri } from '../../helpers/mock-vscode';
import { GitAdapter } from '../../../src/plans/GitAdapter';
import { PlanWriter, renderRoadmap } from '../../../src/plans/PlanWriter';
import { Plan } from '../../../src/plans/types';

function makeSpawn(records: Array<{ command: string; args: ReadonlyArray<string> }>) {
  return ((command: string, args: ReadonlyArray<string>) => {
    records.push({ command, args });
    const proc = new NodeEventEmitter();
    Object.assign(proc, {
      stdout: Readable.from([]),
      stderr: Readable.from([]),
    });
    setImmediate(() => proc.emit('close', 0));
    return proc as never;
  }) as never;
}

function samplePlan(): Plan {
  return {
    id: 'plan-1',
    slug: 'soft-delete-posts',
    feature: 'Soft-delete posts',
    state: 'approved',
    currentPhaseIndex: 0,
    phases: [
      {
        number: 1,
        slug: 'add-column',
        name: 'Add deleted_at column',
        summary: 'Migration + scope',
        requirementsMd: '# Requirements\n',
        designMd: '# Design\n',
        tasksMd: '# Tasks\n- [ ] 1.1 migration\n',
      },
      {
        number: 2,
        slug: 'hook-controllers',
        name: 'Hook controllers',
        summary: 'Filter by default',
        requirementsMd: '# Requirements\n',
        designMd: '# Design\n',
        tasksMd: '# Tasks\n- [ ] 2.1 default scope\n',
      },
    ],
  };
}

describe('PlanWriter.write', () => {
  let writes: Array<{ path: string; content: string }>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetAll();
    writes = [];
    writeSpy = vi
      .spyOn(vscode.workspace.fs, 'writeFile')
      .mockImplementation(async (uri: vscode.Uri, bytes: Uint8Array) => {
        writes.push({ path: uri.fsPath, content: new TextDecoder().decode(bytes) });
      });
  });

  it('writes each phase trio + a roadmap README under docs/<slug>/', async () => {
    const spawnRecords: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const writer = new PlanWriter({
      root: Uri.file('/repo'),
      git: new GitAdapter({ cwd: '/repo', spawn: makeSpawn(spawnRecords) }),
      autoBranch: true,
      autoPush: false,
    });
    const result = await writer.write(samplePlan());

    const paths = writes.map((w) => w.path).sort();
    expect(paths).toEqual([
      '/repo/docs/soft-delete-posts/01-add-column/design.md',
      '/repo/docs/soft-delete-posts/01-add-column/requirements.md',
      '/repo/docs/soft-delete-posts/01-add-column/tasks.md',
      '/repo/docs/soft-delete-posts/02-hook-controllers/design.md',
      '/repo/docs/soft-delete-posts/02-hook-controllers/requirements.md',
      '/repo/docs/soft-delete-posts/02-hook-controllers/tasks.md',
      '/repo/docs/soft-delete-posts/README.md',
    ]);
    expect(result.branch).toBe('rubyn/soft-delete-posts-phase-01-add-column');
    expect(result.writtenPaths).toHaveLength(7);
  });

  it('branch + commit are invoked when autoBranch is on', async () => {
    const spawnRecords: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const writer = new PlanWriter({
      root: Uri.file('/repo'),
      git: new GitAdapter({ cwd: '/repo', spawn: makeSpawn(spawnRecords) }),
      autoBranch: true,
      autoPush: false,
    });
    await writer.write(samplePlan());

    const subcommands = spawnRecords.map((r) => r.args[0]);
    expect(subcommands).toContain('checkout');
    expect(subcommands).toContain('add');
    expect(subcommands).toContain('commit');
    expect(subcommands).not.toContain('push'); // autoPush off
    const commit = spawnRecords.find((r) => r.args[0] === 'commit')!;
    expect(commit.args).toEqual(['commit', '-m', 'Megaplan: Soft-delete posts']);
  });

  it('skips git operations when autoBranch is false', async () => {
    const spawnRecords: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const writer = new PlanWriter({
      root: Uri.file('/repo'),
      git: new GitAdapter({ cwd: '/repo', spawn: makeSpawn(spawnRecords) }),
      autoBranch: false,
      autoPush: false,
    });
    const result = await writer.write(samplePlan());
    expect(spawnRecords).toHaveLength(0);
    expect(result.branch).toBeNull();
  });

  it('pushes when autoPush is on', async () => {
    const spawnRecords: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const writer = new PlanWriter({
      root: Uri.file('/repo'),
      git: new GitAdapter({ cwd: '/repo', spawn: makeSpawn(spawnRecords) }),
      autoBranch: true,
      autoPush: true,
    });
    await writer.write(samplePlan());
    expect(spawnRecords.some((r) => r.args[0] === 'push')).toBe(true);
  });

  it('ensures every written file ends with a newline', async () => {
    const writer = new PlanWriter({
      root: Uri.file('/repo'),
      git: new GitAdapter({ cwd: '/repo', spawn: makeSpawn([]) }),
      autoBranch: false,
      autoPush: false,
    });
    await writer.write({
      ...samplePlan(),
      phases: [
        {
          ...samplePlan().phases[0],
          requirementsMd: '# No newline',
        },
        ...samplePlan().phases.slice(1),
      ],
    });
    const req = writes.find((w) => w.path.endsWith('requirements.md'))!;
    expect(req.content.endsWith('\n')).toBe(true);
  });

  void writeSpy;
});

describe('renderRoadmap', () => {
  it('lists each phase with `[ ]` checkbox + link', () => {
    const text = renderRoadmap(samplePlan());
    expect(text).toContain('# Soft-delete posts — Roadmap');
    expect(text).toContain('- [ ] **[Phase 1 — Add deleted_at column](01-add-column/)** — Migration + scope');
    expect(text).toContain('- [ ] **[Phase 2 — Hook controllers](02-hook-controllers/)** — Filter by default');
  });
});
