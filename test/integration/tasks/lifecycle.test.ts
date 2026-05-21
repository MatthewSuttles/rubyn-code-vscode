/**
 * Integration: start tasks through TaskRegistry, observe SessionsTreeProvider
 * + TaskStatusBar + Notifier wiring respond in lockstep. Mirrors the runtime
 * activate() composition without spinning up the full extension.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { __resetAll } from '../../helpers/mock-vscode';
import { TaskRegistry } from '../../../src/tasks/TaskRegistry';
import { SessionsTreeProvider } from '../../../src/tasks/SessionsTreeProvider';
import { TaskStatusBar } from '../../../src/tasks/TaskStatusBar';
import { Notifier } from '../../../src/tasks/Notifier';

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('Phase 5 — task lifecycle wiring', () => {
  let registry: TaskRegistry;
  let tree: SessionsTreeProvider;
  let statusBar: TaskStatusBar;

  beforeEach(() => {
    __resetAll();
    registry = new TaskRegistry();
    tree = new SessionsTreeProvider(registry);
    statusBar = new TaskStatusBar(registry);
    new Notifier(registry);
  });

  it('a started task becomes visible in Running, and the status bar shows the count', async () => {
    const createSpy = vi.spyOn(vscode.window, 'createStatusBarItem');
    // Re-create the status bar after we install the spy so we capture the item.
    statusBar.dispose();
    statusBar = new TaskStatusBar(registry);

    registry.start({
      label: 'background work',
      command: 'test.background',
      run: () => new Promise((resolve) => setTimeout(resolve, 60)),
    });

    await waitFor(() => registry.running().length === 1);
    const roots = tree.getChildren();
    expect(tree.getChildren(roots[0])).toHaveLength(1);

    // The status bar item was created and is currently shown.
    expect(createSpy).toHaveBeenCalled();
    const lastItem = createSpy.mock.results[createSpy.mock.results.length - 1]?.value as {
      text: string;
      show: ReturnType<typeof vi.fn>;
      hide: ReturnType<typeof vi.fn>;
    };
    expect(lastItem.show).toHaveBeenCalled();
    expect(lastItem.text).toMatch(/Rubyn: 1 task/);
  });

  it('completed tasks fire the success notification', async () => {
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
    const task = registry.start({
      label: 'finish me',
      command: 'test.finish',
      run: async () => ({ summary: 'all good' }),
    });
    await waitFor(() => registry.get(task.id)!.state === 'succeeded');
    await new Promise((r) => setImmediate(r));
    expect(infoSpy).toHaveBeenCalledOnce();
    expect(infoSpy.mock.calls[0][0]).toContain('finish me ✓');
  });

  it('cancel mid-run lands within the 5s budget', async () => {
    const task = registry.start({
      label: 'unbounded',
      command: 'test.unbounded',
      // Body that ignores the token entirely; the registry's force-cancel
      // budget must kick in.
      run: () => new Promise<void>(() => undefined),
    });
    await waitFor(() => registry.get(task.id)!.state === 'running');
    const before = Date.now();
    registry.cancel(task.id);
    await waitFor(
      () => registry.get(task.id)!.state === 'canceled',
      6_000,
    );
    expect(Date.now() - before).toBeLessThanOrEqual(5_500);
  });

  it('status bar hides when no tasks are running', async () => {
    const createSpy = vi.spyOn(vscode.window, 'createStatusBarItem');
    statusBar.dispose();
    statusBar = new TaskStatusBar(registry);
    const lastItem = createSpy.mock.results[createSpy.mock.results.length - 1]?.value as {
      hide: ReturnType<typeof vi.fn>;
    };
    expect(lastItem.hide).toHaveBeenCalled();
  });
});
