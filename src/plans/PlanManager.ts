/**
 * Megaplan orchestrator. Owns the lifecycle of proposed → approved →
 * executing → phase_1_pr_open / failed / rejected. Doesn't parse, doesn't
 * write files directly, doesn't shell out — delegates to collaborators so
 * Phase 7 (multi-phase) can layer on top without rewriting state machinery.
 *
 * The CLI gem does the heavy lifting (planning prompt, plan_proposal
 * generation, phase execution). The extension orchestrates and renders.
 * When the gem doesn't yet support `plan/propose`, `request()` rejects with
 * a friendly error and the plan is dropped — never silently empty.
 */

import * as vscode from 'vscode';
import {
  Plan,
  PhaseSpec,
  PlanAgentClient,
  PlanProposalPayload,
  PlanState,
  slugify,
} from './types';

export interface PlanManagerDeps {
  agent: PlanAgentClient;
  /** Invoked when the user approves a plan. Implementation lives in PlanWriter. */
  onApprove: (plan: Plan) => Promise<void>;
}

export class PlanManager implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Plan>();
  private readonly plans = new Map<string, Plan>();
  private nextId = 1;

  readonly onDidChange = this.emitter.event;

  constructor(private readonly deps: PlanManagerDeps) {}

  async request(feature: string): Promise<Plan> {
    const trimmed = feature.trim();
    if (!trimmed) throw new Error('Feature description is empty.');
    const payload = await this.deps.agent.proposePlan(trimmed);
    const plan = this.toPlan(payload);
    this.plans.set(plan.id, plan);
    this.emitter.fire(plan);
    return plan;
  }

  /**
   * Mutate a proposed plan in place — used by the panel after the user edits
   * a phase's documents. Refuses to mutate plans past `proposed`.
   */
  updatePhase(planId: string, phaseNumber: number, patch: Partial<PhaseSpec>): void {
    const plan = this.plans.get(planId);
    if (!plan || plan.state !== 'proposed') return;
    const idx = plan.phases.findIndex((p) => p.number === phaseNumber);
    if (idx === -1) return;
    plan.phases[idx] = { ...plan.phases[idx], ...patch };
    this.emitter.fire(plan);
  }

  /**
   * Reorder, delete, or replace phases. Caller hands in the full new list of
   * phases; PlanManager renumbers them 1..N so downstream filenames are
   * stable.
   */
  updatePhases(planId: string, phases: PhaseSpec[]): void {
    const plan = this.plans.get(planId);
    if (!plan || plan.state !== 'proposed') return;
    plan.phases = phases.map((p, i) => ({ ...p, number: i + 1 }));
    this.emitter.fire(plan);
  }

  async approve(planId: string): Promise<void> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Unknown plan: ${planId}`);
    if (plan.state !== 'proposed') {
      throw new Error(`Plan ${planId} is in state ${plan.state}, not 'proposed'.`);
    }
    this.transition(plan, 'approved');
    try {
      await this.deps.onApprove(plan);
      // The onApprove callback is responsible for transitioning to
      // 'executing' / 'phase_1_pr_open' / 'failed' via the registry and
      // calls back into PlanManager via setExecuting / setPrOpen / setFailed.
    } catch (err) {
      plan.error = err instanceof Error ? err.message : String(err);
      this.transition(plan, 'failed');
      throw err;
    }
  }

  reject(planId: string): void {
    const plan = this.plans.get(planId);
    if (!plan) return;
    if (plan.state !== 'proposed') return;
    this.transition(plan, 'rejected');
  }

  setExecuting(planId: string): void {
    const plan = this.plans.get(planId);
    if (!plan) return;
    this.transition(plan, 'executing');
  }

  setPrOpen(planId: string, url: string): void {
    const plan = this.plans.get(planId);
    if (!plan) return;
    plan.prUrl = url;
    this.transition(plan, 'phase_1_pr_open');
  }

  setFailed(planId: string, error: string): void {
    const plan = this.plans.get(planId);
    if (!plan) return;
    plan.error = error;
    this.transition(plan, 'failed');
  }

  get(planId: string): Plan | undefined {
    return this.plans.get(planId);
  }

  list(): Plan[] {
    return Array.from(this.plans.values());
  }

  dispose(): void {
    this.plans.clear();
    this.emitter.dispose();
  }

  private toPlan(payload: PlanProposalPayload): Plan {
    if (!payload.phases || payload.phases.length === 0) {
      throw new Error('plan_proposal contained no phases.');
    }
    if (payload.phases.length > 12) {
      throw new Error(
        `plan_proposal returned ${payload.phases.length} phases (max 12).`,
      );
    }
    const id = `plan-${this.nextId++}`;
    const slug = payload.slug || slugify(payload.feature);
    const phases: PhaseSpec[] = payload.phases.map((p, i) => ({
      number: p.number ?? i + 1,
      slug: p.slug || slugify(p.name),
      name: p.name,
      summary: p.summary,
      requirementsMd: p.requirements_md,
      designMd: p.design_md,
      tasksMd: p.tasks_md,
    }));
    return {
      id,
      slug,
      feature: payload.feature,
      state: 'proposed',
      phases,
      currentPhaseIndex: 0,
    };
  }

  private transition(plan: Plan, next: PlanState): void {
    if (plan.state === next) return;
    plan.state = next;
    this.emitter.fire(plan);
  }
}
