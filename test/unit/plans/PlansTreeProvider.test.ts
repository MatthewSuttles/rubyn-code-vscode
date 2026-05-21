/**
 * Unit tests for PlansTreeProvider. Composes a real PlanManager with a stub
 * agent — proves the tree wiring without standing up the rest of the
 * extension.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThemeIcon, TreeItemCollapsibleState } from '../../helpers/mock-vscode';
import { PlanManager } from '../../../src/plans/PlanManager';
import { PlansTreeProvider } from '../../../src/plans/PlansTreeProvider';
import { PlanAgentClient, PlanProposalPayload } from '../../../src/plans/types';

function agent(payload?: Partial<PlanProposalPayload>): PlanAgentClient {
  const base: PlanProposalPayload = {
    slug: 'feature',
    feature: 'Add a thing',
    phases: [
      {
        number: 1,
        name: 'Schema',
        summary: 'migration',
        requirements_md: '',
        design_md: '',
        tasks_md: '',
      },
      {
        number: 2,
        name: 'Wire',
        summary: 'controller',
        requirements_md: '',
        design_md: '',
        tasks_md: '',
      },
    ],
  };
  return { proposePlan: vi.fn(async () => ({ ...base, ...payload })) };
}

describe('PlansTreeProvider', () => {
  let manager: PlanManager;
  let provider: PlansTreeProvider;

  beforeEach(() => {
    manager = new PlanManager({ agent: agent(), onApprove: vi.fn() });
    provider = new PlansTreeProvider(manager);
  });

  it('top-level is empty when no plans exist', () => {
    expect(provider.getChildren()).toEqual([]);
  });

  it('renders one node per plan with expanded phases beneath', async () => {
    const plan = await manager.request('Add a thing');
    const roots = provider.getChildren();
    expect(roots).toHaveLength(1);
    const planItem = provider.getTreeItem(roots[0]);
    expect(planItem.label).toBe('Add a thing');
    expect(planItem.description).toBe('proposed');
    expect(planItem.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
    expect(planItem.iconPath).toBeInstanceOf(ThemeIcon);

    const phaseNodes = provider.getChildren(roots[0]);
    expect(phaseNodes).toHaveLength(2);
    const phase1 = provider.getTreeItem(phaseNodes[0]);
    expect(phase1.label).toBe('Phase 1 — Schema');
    expect(phase1.description).toBe('migration');
    void plan;
  });

  it('sets contextValue per state for menu wiring', async () => {
    const plan = await manager.request('Add a thing');
    let item = provider.getTreeItem(provider.getChildren()[0]);
    expect(item.contextValue).toBe('plan.proposed');

    manager.reject(plan.id);
    item = provider.getTreeItem(provider.getChildren()[0]);
    expect(item.contextValue).toBe('plan.rejected');
  });

  it('attaches a vscode.open command when a PR URL is set', async () => {
    const plan = await manager.request('Add a thing');
    await manager.approve(plan.id);
    manager.setExecuting(plan.id);
    manager.setPrOpen(plan.id, 'https://github.com/o/r/pull/1');
    const item = provider.getTreeItem(provider.getChildren()[0]);
    expect(item.contextValue).toBe('plan.pr-open');
    expect(item.command?.command).toBe('vscode.open');
  });

  it('fires onDidChangeTreeData on any plan change', async () => {
    let fired = 0;
    provider.onDidChangeTreeData(() => {
      fired += 1;
    });
    await manager.request('one');
    expect(fired).toBeGreaterThan(0);
  });
});
