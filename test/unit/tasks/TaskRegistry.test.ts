/**
 * Unit tests for TaskRegistry — the state machine that owns task lifecycle
 * for Phase 5 (and the substrate Phase 6+ stand on).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Task,
  TaskRegistry,
} from '../../../src/tasks/TaskRegistry';

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

describe('TaskRegistry', () => {
  let registry: TaskRegistry;

  beforeEach(() => {
    registry = new TaskRegistry();
  });

  it('starts a task in `pending` and transitions to `running`', async () => {
    const transitions: string[] = [];
    registry.onDidChange((t: Task) => transitions.push(t.state));
    registry.start({
      label: 'sleep',
      command: 'test.sleep',
      run: () => new Promise((resolve) => setTimeout(() => resolve(), 50)),
    });
    await waitFor(() => transitions.includes('running'));
    expect(transitions[0]).toBe('pending');
    expect(transitions).toContain('running');
  });

  it('transitions to `succeeded` when the run callback resolves', async () => {
    const task = registry.start({
      label: 'noop',
      command: 'test.noop',
      run: async () => ({ summary: 'done' }),
    });
    await waitFor(() => registry.get(task.id)!.state === 'succeeded');
    const final = registry.get(task.id)!;
    expect(final.state).toBe('succeeded');
    expect(final.result?.summary).toBe('done');
    expect(final.endedAt).toBeInstanceOf(Date);
  });

  it('transitions to `failed` when the run callback throws', async () => {
    const task = registry.start({
      label: 'boom',
      command: 'test.boom',
      run: async () => {
        throw new Error('nope');
      },
    });
    await waitFor(() => registry.get(task.id)!.state === 'failed');
    const final = registry.get(task.id)!;
    expect(final.state).toBe('failed');
    expect(final.error).toBe('nope');
  });

  it('cancel() drives the token and transitions to `canceled`', async () => {
    let observedCancel = false;
    const task = registry.start({
      label: 'cancelable',
      command: 'test.cancelable',
      run: (token) =>
        new Promise<void>((resolve) => {
          token.onCancellationRequested(() => {
            observedCancel = true;
            resolve();
          });
        }),
    });
    await waitFor(() => registry.get(task.id)!.state === 'running');
    registry.cancel(task.id);
    await waitFor(() => registry.get(task.id)!.state === 'canceled');
    expect(observedCancel).toBe(true);
  });

  it('cancel() force-transitions after the 5s budget even if the body ignores the token', async () => {
    vi.useFakeTimers();
    let resolveBody!: () => void;
    const task = registry.start({
      label: 'stubborn',
      command: 'test.stubborn',
      run: () =>
        new Promise<void>((resolve) => {
          resolveBody = resolve;
        }),
    });
    // Let the queueMicrotask scheduler fire so the task moves to running.
    await vi.advanceTimersByTimeAsync(0);
    registry.cancel(task.id);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(registry.get(task.id)!.state).toBe('canceled');
    resolveBody();
    vi.useRealTimers();
  });

  it('cancel() on an unknown id is a no-op', () => {
    expect(() => registry.cancel('does-not-exist')).not.toThrow();
  });

  it('list() / running() / recent() partition correctly', async () => {
    const a = registry.start({
      label: 'a',
      command: 'test.a',
      run: async () => undefined,
    });
    const b = registry.start({
      label: 'b',
      command: 'test.b',
      run: () => new Promise((resolve) => setTimeout(resolve, 50)),
    });
    await waitFor(() => registry.get(a.id)!.state === 'succeeded');
    expect(registry.running().map((t) => t.id)).toEqual([b.id]);
    expect(registry.recent().map((t) => t.id)).toContain(a.id);
  });

  it('dismiss() removes a terminal task from the index', async () => {
    const task = registry.start({
      label: 'done',
      command: 'test.done',
      run: async () => undefined,
    });
    await waitFor(() => registry.get(task.id)!.state === 'succeeded');
    registry.dismiss(task.id);
    expect(registry.get(task.id)).toBeUndefined();
  });

  it('dismiss() refuses to remove a still-running task', async () => {
    const task = registry.start({
      label: 'live',
      command: 'test.live',
      run: () => new Promise((resolve) => setTimeout(resolve, 50)),
    });
    await waitFor(() => registry.get(task.id)!.state === 'running');
    registry.dismiss(task.id);
    expect(registry.get(task.id)).toBeDefined();
  });
});
