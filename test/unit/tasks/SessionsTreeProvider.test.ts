/**
 * Unit tests for SessionsTreeProvider. The provider reads from a real
 * TaskRegistry — easier than mocking it and proves the wiring works end-
 * to-end.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TreeItemCollapsibleState, ThemeIcon } from '../../helpers/mock-vscode';
import { TaskRegistry } from '../../../src/tasks/TaskRegistry';
import { SessionsTreeProvider } from '../../../src/tasks/SessionsTreeProvider';

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

describe('SessionsTreeProvider', () => {
  let registry: TaskRegistry;
  let provider: SessionsTreeProvider;

  beforeEach(() => {
    registry = new TaskRegistry();
    provider = new SessionsTreeProvider(registry);
  });

  it('renders the two top-level groups', () => {
    const roots = provider.getChildren();
    expect(roots).toHaveLength(2);
    const labels = roots.map((n) => (provider.getTreeItem(n).label as string));
    expect(labels).toEqual(['Running', 'Recent']);
  });

  it('puts a pending task under Running', async () => {
    registry.start({
      label: 'wait',
      command: 'test.wait',
      run: () => new Promise((resolve) => setTimeout(resolve, 50)),
    });
    const roots = provider.getChildren();
    const runningGroup = roots[0];
    const tasks = provider.getChildren(runningGroup);
    expect(tasks).toHaveLength(1);
  });

  it('moves a completed task into the Recent group', async () => {
    const task = registry.start({
      label: 'done',
      command: 'test.done',
      run: async () => undefined,
    });
    await waitFor(() => registry.get(task.id)!.state === 'succeeded');

    const roots = provider.getChildren();
    expect(provider.getChildren(roots[0])).toHaveLength(0); // Running
    expect(provider.getChildren(roots[1])).toHaveLength(1); // Recent
  });

  it('emits onDidChangeTreeData when the registry changes', async () => {
    let fired = 0;
    provider.onDidChangeTreeData(() => {
      fired += 1;
    });
    registry.start({
      label: 'go',
      command: 'test.go',
      run: async () => undefined,
    });
    await waitFor(() => fired >= 2);
    // At minimum: start (pending), running, succeeded.
    expect(fired).toBeGreaterThanOrEqual(2);
  });

  it('tree items expose status icon + view-result command', async () => {
    const task = registry.start({
      label: 'noop',
      command: 'test.noop',
      run: async () => undefined,
    });
    await waitFor(() => registry.get(task.id)!.state === 'succeeded');
    const roots = provider.getChildren();
    const tasks = provider.getChildren(roots[1]);
    const item = provider.getTreeItem(tasks[0]);
    expect(item.label).toBe('noop');
    expect(item.iconPath).toBeInstanceOf(ThemeIcon);
    expect(item.collapsibleState).toBe(TreeItemCollapsibleState.None);
    expect(item.command?.command).toBe('rubyn-code.viewTaskResult');
    expect(item.contextValue).toBe('task.terminal');
  });
});
