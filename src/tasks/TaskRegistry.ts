/**
 * In-memory registry of Rubyn-managed background tasks.
 *
 * One source of truth for task lifecycle (`pending` → `running` →
 * `succeeded` / `failed` / `canceled`). The sessions tree, status bar, and
 * notifier all subscribe to `onDidChange` for updates. Phase 6 (megaplan
 * execution) and Phase 8 (PR-check recovery) will use this primitive too.
 *
 * Deliberately not persisted across reloads; phase 5 design treats that as
 * future opt-in work.
 */

import * as vscode from 'vscode';

export type TaskState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export const TERMINAL_STATES = new Set<TaskState>([
  'succeeded',
  'failed',
  'canceled',
]);

export interface TaskResult {
  /** Display-only summary surfaced in notifications and the result view. */
  summary?: string;
  /** Files the task touched, so cancellation can still surface partials. */
  touchedPaths?: string[];
  /** Arbitrary metadata the result viewer can consume. */
  [k: string]: unknown;
}

export interface Task {
  id: string;
  label: string;
  /** The command that started this task (e.g. `*.background` variant). */
  command: string;
  state: TaskState;
  startedAt: Date;
  endedAt: Date | null;
  result?: TaskResult;
  error?: string;
}

export interface TaskSpec {
  label: string;
  command: string;
  run: (token: vscode.CancellationToken) => Promise<TaskResult | void>;
}

export class TaskRegistry implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Task>();
  private readonly tasks = new Map<string, Task>();
  private readonly tokenSources = new Map<string, vscode.CancellationTokenSource>();
  private nextId = 1;

  readonly onDidChange = this.emitter.event;

  start(spec: TaskSpec): Task {
    const id = `task-${this.nextId++}`;
    const tokenSource = new vscode.CancellationTokenSource();
    this.tokenSources.set(id, tokenSource);
    const task: Task = {
      id,
      label: spec.label,
      command: spec.command,
      state: 'pending',
      startedAt: new Date(),
      endedAt: null,
    };
    this.tasks.set(id, task);
    this.emitter.fire(task);

    // Kick off async work on the next tick so callers can subscribe between
    // start() and any state transitions.
    queueMicrotask(() => this.invoke(task, spec.run, tokenSource.token));
    return task;
  }

  cancel(id: string): void {
    const task = this.tasks.get(id);
    if (!task || TERMINAL_STATES.has(task.state)) return;
    const tokenSource = this.tokenSources.get(id);
    tokenSource?.cancel();
    // Force-transition after a 5s budget if the task body hasn't finished.
    setTimeout(() => {
      const current = this.tasks.get(id);
      if (current && !TERMINAL_STATES.has(current.state)) {
        this.transition(current, 'canceled');
      }
    }, 5_000);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }

  running(): Task[] {
    return this.list().filter((t) => t.state === 'pending' || t.state === 'running');
  }

  recent(limit = 25): Task[] {
    return this.list()
      .filter((t) => TERMINAL_STATES.has(t.state))
      .sort((a, b) => (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  dismiss(id: string): void {
    const task = this.tasks.get(id);
    if (!task || !TERMINAL_STATES.has(task.state)) return;
    this.tasks.delete(id);
    this.tokenSources.delete(id);
    this.emitter.fire(task);
  }

  dispose(): void {
    for (const ts of this.tokenSources.values()) ts.dispose();
    this.tokenSources.clear();
    this.tasks.clear();
    this.emitter.dispose();
  }

  private async invoke(
    task: Task,
    run: TaskSpec['run'],
    token: vscode.CancellationToken,
  ): Promise<void> {
    this.transition(task, 'running');
    try {
      const result = await run(token);
      if (token.isCancellationRequested) {
        if (result && typeof result === 'object') task.result = result;
        this.transition(task, 'canceled');
        return;
      }
      if (result && typeof result === 'object') task.result = result;
      this.transition(task, 'succeeded');
    } catch (err) {
      if (token.isCancellationRequested) {
        this.transition(task, 'canceled');
        return;
      }
      task.error = err instanceof Error ? err.message : String(err);
      this.transition(task, 'failed');
    }
  }

  private transition(task: Task, next: TaskState): void {
    if (task.state === next) return;
    task.state = next;
    if (TERMINAL_STATES.has(next)) {
      task.endedAt = new Date();
    }
    this.emitter.fire(task);
  }
}
