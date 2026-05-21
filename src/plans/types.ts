/**
 * Public types for the Megaplan orchestrator. Kept in their own module so the
 * tests and the CLI-gem protocol layer can import them without pulling in the
 * full PlanManager.
 */

export type PlanState =
  | 'proposed'
  | 'approved'
  | 'executing'
  | 'phase_1_pr_open'
  | 'failed'
  | 'rejected';

export interface PhaseSpec {
  number: number;
  /** kebab-case slug, e.g. "schema-aware-autocomplete". */
  slug: string;
  name: string;
  summary: string;
  requirementsMd: string;
  designMd: string;
  tasksMd: string;
}

export interface Plan {
  id: string;
  /** kebab-case feature slug used for `docs/<slug>/` and branch names. */
  slug: string;
  feature: string;
  state: PlanState;
  phases: PhaseSpec[];
  /** Index into phases[] of the currently-running phase (0 before any). */
  currentPhaseIndex: number;
  prUrl?: string;
  error?: string;
}

/** The CLI gem's `plan_proposal` payload shape. Validated at the boundary. */
export interface PlanProposalPayload {
  slug: string;
  feature: string;
  phases: Array<{
    number: number;
    name: string;
    slug?: string;
    summary: string;
    requirements_md: string;
    design_md: string;
    tasks_md: string;
  }>;
}

/**
 * Pluggable interface so PlanManager can be unit-tested without the bridge.
 * The default implementation wraps `bridge.request('plan/propose', …)` and
 * `bridge.request('plan/cancel', …)`; tests inject a stub.
 */
export interface PlanAgentClient {
  proposePlan(feature: string): Promise<PlanProposalPayload>;
  cancelPlan?(planId: string): Promise<void>;
}

/**
 * Slugify a feature description into a `kebab-case` slug, dropping symbols
 * outside `[a-z0-9-]`. Empty input returns 'feature' so the rest of the
 * filesystem code has a stable fallback.
 */
export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'feature';
}
