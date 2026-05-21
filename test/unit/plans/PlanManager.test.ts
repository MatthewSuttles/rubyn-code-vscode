/**
 * Unit tests for PlanManager — the orchestrator's state machine. The agent
 * client and approval callback are stubbed; we only exercise PlanManager's
 * own logic.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlanManager } from '../../../src/plans/PlanManager';
import {
  Plan,
  PlanAgentClient,
  PlanProposalPayload,
} from '../../../src/plans/types';

function stubAgent(payload: Partial<PlanProposalPayload> = {}): PlanAgentClient {
  const defaultPayload: PlanProposalPayload = {
    slug: 'soft-delete-posts',
    feature: 'Soft-delete posts',
    phases: [
      {
        number: 1,
        name: 'Add deleted_at column',
        summary: 'Migration + scope',
        requirements_md: '# Reqs',
        design_md: '# Design',
        tasks_md: '# Tasks',
      },
      {
        number: 2,
        name: 'Hook controllers',
        summary: 'Filter by default',
        requirements_md: '# Reqs',
        design_md: '# Design',
        tasks_md: '# Tasks',
      },
    ],
  };
  return {
    proposePlan: vi.fn(async () => ({ ...defaultPayload, ...payload })),
  };
}

describe('PlanManager.request', () => {
  it('returns a `proposed` plan with phases', async () => {
    const manager = new PlanManager({
      agent: stubAgent(),
      onApprove: vi.fn(async () => undefined),
    });
    const plan = await manager.request('Soft-delete posts');
    expect(plan.state).toBe('proposed');
    expect(plan.slug).toBe('soft-delete-posts');
    expect(plan.phases).toHaveLength(2);
    expect(plan.phases[0].name).toBe('Add deleted_at column');
  });

  it('rejects empty feature descriptions', async () => {
    const manager = new PlanManager({
      agent: stubAgent(),
      onApprove: vi.fn(),
    });
    await expect(manager.request('   ')).rejects.toThrow(/empty/);
  });

  it('rejects proposals with zero phases', async () => {
    const manager = new PlanManager({
      agent: stubAgent({ phases: [] }),
      onApprove: vi.fn(),
    });
    await expect(manager.request('x')).rejects.toThrow(/no phases/);
  });

  it('rejects proposals with more than 12 phases', async () => {
    const phases = Array.from({ length: 13 }, (_, i) => ({
      number: i + 1,
      name: `phase-${i}`,
      summary: 's',
      requirements_md: '',
      design_md: '',
      tasks_md: '',
    }));
    const manager = new PlanManager({
      agent: stubAgent({ phases }),
      onApprove: vi.fn(),
    });
    await expect(manager.request('x')).rejects.toThrow(/13 phases/);
  });

  it('fires onDidChange for the new plan', async () => {
    const manager = new PlanManager({
      agent: stubAgent(),
      onApprove: vi.fn(),
    });
    const seen: Plan[] = [];
    manager.onDidChange((p) => seen.push(p));
    await manager.request('feature');
    expect(seen).toHaveLength(1);
    expect(seen[0].state).toBe('proposed');
  });
});

describe('PlanManager.approve', () => {
  let manager: PlanManager;
  let onApprove: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onApprove = vi.fn(async () => undefined);
    manager = new PlanManager({ agent: stubAgent(), onApprove });
  });

  it('transitions proposed → approved and calls onApprove', async () => {
    const plan = await manager.request('f');
    await manager.approve(plan.id);
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: plan.id }));
    expect(manager.get(plan.id)!.state).toBe('approved');
  });

  it('refuses to approve a rejected plan', async () => {
    const plan = await manager.request('f');
    manager.reject(plan.id);
    await expect(manager.approve(plan.id)).rejects.toThrow(/state rejected/);
  });

  it('transitions to failed if onApprove throws', async () => {
    onApprove.mockRejectedValueOnce(new Error('git failed'));
    const plan = await manager.request('f');
    await expect(manager.approve(plan.id)).rejects.toThrow('git failed');
    const current = manager.get(plan.id)!;
    expect(current.state).toBe('failed');
    expect(current.error).toBe('git failed');
  });
});

describe('PlanManager — phase editing before approval', () => {
  let manager: PlanManager;

  beforeEach(() => {
    manager = new PlanManager({
      agent: stubAgent(),
      onApprove: vi.fn(async () => undefined),
    });
  });

  it('updatePhase mutates a phase in a proposed plan', async () => {
    const plan = await manager.request('f');
    manager.updatePhase(plan.id, 1, { tasksMd: '# Updated tasks\n- [ ] new\n' });
    expect(manager.get(plan.id)!.phases[0].tasksMd).toContain('Updated tasks');
  });

  it('refuses to mutate phases on an approved plan', async () => {
    const plan = await manager.request('f');
    await manager.approve(plan.id);
    manager.updatePhase(plan.id, 1, { tasksMd: 'overwrite' });
    expect(manager.get(plan.id)!.phases[0].tasksMd).not.toBe('overwrite');
  });

  it('updatePhases renumbers from 1..N', async () => {
    const plan = await manager.request('f');
    const reordered = [...plan.phases].reverse();
    manager.updatePhases(plan.id, reordered);
    const updated = manager.get(plan.id)!;
    expect(updated.phases.map((p) => p.number)).toEqual([1, 2]);
    expect(updated.phases[0].name).toBe('Hook controllers');
  });
});

describe('PlanManager — execution state pokes', () => {
  it('setExecuting / setPrOpen / setFailed advance through the terminal states', async () => {
    const manager = new PlanManager({
      agent: stubAgent(),
      onApprove: vi.fn(async () => undefined),
    });
    const plan = await manager.request('f');
    await manager.approve(plan.id);
    manager.setExecuting(plan.id);
    expect(manager.get(plan.id)!.state).toBe('executing');
    manager.setPrOpen(plan.id, 'https://github.com/o/r/pull/1');
    const final = manager.get(plan.id)!;
    expect(final.state).toBe('phase_1_pr_open');
    expect(final.prUrl).toBe('https://github.com/o/r/pull/1');
  });
});
