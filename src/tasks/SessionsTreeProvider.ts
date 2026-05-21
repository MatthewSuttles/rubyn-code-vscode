/**
 * TreeDataProvider for the `rubyn-code.sessions` view. Renders two groups —
 * Running (pending + running) and Recent (terminal) — and a row per task
 * with elapsed time + a status icon. Subscribes to TaskRegistry.onDidChange
 * and refreshes within the 1s observability budget by firing
 * onDidChangeTreeData on every transition.
 */

import * as vscode from 'vscode';
import { Task, TaskRegistry, TERMINAL_STATES } from './TaskRegistry';

type Node = GroupNode | TaskNode;

class GroupNode {
  readonly kind = 'group';
  constructor(public readonly label: 'Running' | 'Recent') {}
}

class TaskNode {
  readonly kind = 'task';
  constructor(public readonly task: Task) {}
}

const STATE_ICON: Record<Task['state'], string> = {
  pending: 'clock',
  running: 'sync~spin',
  succeeded: 'pass',
  failed: 'error',
  canceled: 'circle-slash',
};

export class SessionsTreeProvider
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly registry: TaskRegistry) {
    this.subscription = registry.onDidChange(() => {
      // Refresh the whole tree on any change — the row count is small enough
      // that surgical refresh isn't worth the bookkeeping.
      this.emitter.fire(undefined);
    });
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = `group.${node.label.toLowerCase()}`;
      return item;
    }
    const task = node.task;
    const item = new vscode.TreeItem(task.label, vscode.TreeItemCollapsibleState.None);
    item.id = task.id;
    item.description = describe(task);
    item.iconPath = new vscode.ThemeIcon(STATE_ICON[task.state]);
    item.contextValue = TERMINAL_STATES.has(task.state)
      ? 'task.terminal'
      : 'task.running';
    item.command = {
      title: 'View result',
      command: 'rubyn-code.viewTaskResult',
      arguments: [task.id],
    };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return [new GroupNode('Running'), new GroupNode('Recent')];
    }
    if (node.kind === 'group') {
      if (node.label === 'Running') {
        return this.registry.running().map((t) => new TaskNode(t));
      }
      return this.registry.recent().map((t) => new TaskNode(t));
    }
    return [];
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

function describe(task: Task): string {
  const elapsed = formatElapsed(task);
  if (task.state === 'failed' && task.error) {
    return `${task.state} · ${task.error}`;
  }
  return `${task.state} · ${elapsed}`;
}

function formatElapsed(task: Task): string {
  const end = task.endedAt?.getTime() ?? Date.now();
  const ms = end - task.startedAt.getTime();
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}
