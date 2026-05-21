/**
 * Status-bar item: "Rubyn: N task(s)" when N > 0, hidden otherwise. Spinner
 * icon when at least one task is in `pending` or `running`. Click focuses
 * the Rubyn activity-bar container.
 *
 * Separate from the existing src/status-bar.ts which tracks chat/permission
 * state — this is the per-task counter.
 */

import * as vscode from 'vscode';
import { TaskRegistry } from './TaskRegistry';

export class TaskStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly registry: TaskRegistry) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      90,
    );
    this.item.command = 'workbench.view.extension.rubyn-code';
    this.item.tooltip = 'Open the Rubyn Code sessions view';
    this.subscription = registry.onDidChange(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    const running = this.registry.running().length;
    if (running === 0) {
      this.item.hide();
      return;
    }
    const icon = '$(sync~spin)';
    const word = running === 1 ? 'task' : 'tasks';
    this.item.text = `${icon} Rubyn: ${running} ${word}`;
    this.item.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
