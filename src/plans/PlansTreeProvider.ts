/**
 * TreeDataProvider for the `rubyn-code.plans` view. Top level: plans. Each
 * plan has phase children. Context menu (wired through `view/item/context`):
 * Approve / Reject on plan rows, View PR on plans in the `phase_1_pr_open`
 * state.
 */

import * as vscode from 'vscode';
import { PlanManager } from './PlanManager';
import { Plan, PhaseSpec } from './types';

type Node = PlanNode | PhaseNode;

class PlanNode {
  readonly kind = 'plan';
  constructor(public readonly plan: Plan) {}
}

class PhaseNode {
  readonly kind = 'phase';
  constructor(
    public readonly plan: Plan,
    public readonly phase: PhaseSpec,
  ) {}
}

const STATE_ICON: Record<Plan['state'], string> = {
  proposed: 'lightbulb',
  approved: 'check',
  executing: 'sync~spin',
  phase_1_pr_open: 'git-pull-request',
  failed: 'error',
  rejected: 'circle-slash',
};

export class PlansTreeProvider
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly manager: PlanManager) {
    this.subscription = manager.onDidChange(() => this.emitter.fire(undefined));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'plan') {
      const item = new vscode.TreeItem(
        node.plan.feature,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = node.plan.id;
      item.description = node.plan.state;
      item.iconPath = new vscode.ThemeIcon(STATE_ICON[node.plan.state]);
      item.contextValue = contextForPlan(node.plan);
      if (node.plan.prUrl) {
        item.command = {
          title: 'Open PR',
          command: 'vscode.open',
          arguments: [vscode.Uri.parse(node.plan.prUrl)],
        };
        item.tooltip = node.plan.prUrl;
      }
      return item;
    }
    const item = new vscode.TreeItem(
      `Phase ${node.phase.number} — ${node.phase.name}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `${node.plan.id}:${node.phase.number}`;
    item.description = node.phase.summary;
    item.contextValue = 'phase';
    item.tooltip = new vscode.MarkdownString(`**${node.phase.name}**\n\n${node.phase.summary}`);
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.manager.list().map((p) => new PlanNode(p));
    }
    if (node.kind === 'plan') {
      return node.plan.phases.map((ph) => new PhaseNode(node.plan, ph));
    }
    return [];
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

function contextForPlan(plan: Plan): string {
  switch (plan.state) {
    case 'proposed':
      return 'plan.proposed';
    case 'phase_1_pr_open':
      return 'plan.pr-open';
    case 'failed':
      return 'plan.failed';
    case 'rejected':
      return 'plan.rejected';
    default:
      return 'plan.running';
  }
}
