/**
 * Unit tests for Notifier. Asserts the right notification level fires per
 * terminal state, that canceled tasks are silent, and that the setting gate
 * works.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { __resetAll, __setConfig } from '../../helpers/mock-vscode';
import { TaskRegistry } from '../../../src/tasks/TaskRegistry';
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

describe('Notifier', () => {
  let registry: TaskRegistry;

  beforeEach(() => {
    __resetAll();
    registry = new TaskRegistry();
    new Notifier(registry);
  });

  it('fires an info notification on success', async () => {
    const spy = vi.spyOn(vscode.window, 'showInformationMessage');
    const task = registry.start({
      label: 'noop',
      command: 'test.noop',
      run: async () => undefined,
    });
    await waitFor(() => registry.get(task.id)!.state === 'succeeded');
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('noop ✓');
  });

  it('fires an error notification on failure with the error attached', async () => {
    const spy = vi.spyOn(vscode.window, 'showErrorMessage');
    const task = registry.start({
      label: 'broken',
      command: 'test.broken',
      run: async () => {
        throw new Error('boom');
      },
    });
    await waitFor(() => registry.get(task.id)!.state === 'failed');
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('broken ✕');
    expect(spy.mock.calls[0][0]).toContain('boom');
  });

  it('is silent on cancel', async () => {
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
    const errSpy = vi.spyOn(vscode.window, 'showErrorMessage');
    const task = registry.start({
      label: 'cancelable',
      command: 'test.cancelable',
      run: (token) =>
        new Promise<void>((resolve) => {
          token.onCancellationRequested(() => resolve());
        }),
    });
    await waitFor(() => registry.get(task.id)!.state === 'running');
    registry.cancel(task.id);
    await waitFor(() => registry.get(task.id)!.state === 'canceled');
    expect(infoSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('respects the rubyn-code.tasks.notifications=false gate', async () => {
    __setConfig('rubyn-code.tasks', { notifications: false });
    const spy = vi.spyOn(vscode.window, 'showInformationMessage');
    const task = registry.start({
      label: 'noisy',
      command: 'test.noisy',
      run: async () => undefined,
    });
    await waitFor(() => registry.get(task.id)!.state === 'succeeded');
    await new Promise((r) => setImmediate(r));
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not double-notify if onDidChange fires again post-terminal', async () => {
    const spy = vi.spyOn(vscode.window, 'showInformationMessage');
    const task = registry.start({
      label: 'once',
      command: 'test.once',
      run: async () => undefined,
    });
    await waitFor(() => registry.get(task.id)!.state === 'succeeded');
    // Dismiss fires onDidChange a second time with the same task.
    registry.dismiss(task.id);
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalledOnce();
  });
});
