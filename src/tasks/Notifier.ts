/**
 * Subscribes to TaskRegistry terminal transitions and fires VS Code
 * notifications. Successful tasks → info; failed → error; canceled
 * intentionally silent (the user did this on purpose).
 *
 * Gated by `rubyn-code.tasks.notifications` (default true). The "View" action
 * dispatches `rubyn-code.viewTaskResult` so users can jump straight to the
 * output.
 */

import * as vscode from 'vscode';
import { Task, TaskRegistry, TERMINAL_STATES } from './TaskRegistry';

export class Notifier implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  /** Tracks tasks we've already notified for, since onDidChange can re-fire. */
  private readonly notified = new Set<string>();

  constructor(private readonly registry: TaskRegistry) {
    this.subscription = registry.onDidChange((task) => this.handle(task));
  }

  private handle(task: Task): void {
    if (!TERMINAL_STATES.has(task.state)) return;
    if (this.notified.has(task.id)) return;
    this.notified.add(task.id);
    if (!isEnabled()) return;
    if (task.state === 'canceled') return;
    if (task.state === 'succeeded') {
      void this.show(
        `${task.label} ✓`,
        vscode.window.showInformationMessage.bind(vscode.window),
        task,
      );
    } else if (task.state === 'failed') {
      const detail = task.error ? ` — ${task.error}` : '';
      void this.show(
        `${task.label} ✕${detail}`,
        vscode.window.showErrorMessage.bind(vscode.window),
        task,
      );
    }
  }

  private async show(
    message: string,
    fn: (msg: string, ...items: string[]) => Thenable<string | undefined>,
    task: Task,
  ): Promise<void> {
    const choice = await fn(message, 'View');
    if (choice === 'View') {
      await vscode.commands.executeCommand('rubyn-code.viewTaskResult', task.id);
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.notified.clear();
  }
}

function isEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('rubyn-code.tasks')
    .get<boolean>('notifications', true);
}
