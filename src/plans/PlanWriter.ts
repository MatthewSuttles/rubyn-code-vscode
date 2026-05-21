/**
 * Writes the megaplan document trio for each phase to the workspace, plus a
 * roadmap-tracker README. Optionally branches and commits via GitAdapter.
 *
 * Layout matches the megaplan skill convention so the written plan is itself
 * megaplan-compliant from the start:
 *
 *   docs/<plan-slug>/README.md
 *   docs/<plan-slug>/<NN-phase-slug>/requirements.md
 *   docs/<plan-slug>/<NN-phase-slug>/design.md
 *   docs/<plan-slug>/<NN-phase-slug>/tasks.md
 */

import * as vscode from 'vscode';
import { GitAdapter } from './GitAdapter';
import { Plan, PhaseSpec } from './types';

export interface PlanWriterDeps {
  root: vscode.Uri;
  git: GitAdapter;
  autoBranch: boolean;
  autoPush: boolean;
}

export interface WriteResult {
  branch: string | null;
  writtenPaths: string[];
}

export class PlanWriter {
  constructor(private readonly deps: PlanWriterDeps) {}

  async write(plan: Plan): Promise<WriteResult> {
    const branch = this.deps.autoBranch ? this.branchName(plan) : null;
    if (branch) {
      await this.deps.git.branch(branch);
    }

    const written: vscode.Uri[] = [];
    const docsRoot = vscode.Uri.joinPath(this.deps.root, 'docs', plan.slug);

    for (const phase of plan.phases) {
      const phaseDir = vscode.Uri.joinPath(
        docsRoot,
        `${pad2(phase.number)}-${phase.slug}`,
      );
      await this.writeFile(
        vscode.Uri.joinPath(phaseDir, 'requirements.md'),
        phase.requirementsMd,
      );
      written.push(vscode.Uri.joinPath(phaseDir, 'requirements.md'));
      await this.writeFile(
        vscode.Uri.joinPath(phaseDir, 'design.md'),
        phase.designMd,
      );
      written.push(vscode.Uri.joinPath(phaseDir, 'design.md'));
      await this.writeFile(
        vscode.Uri.joinPath(phaseDir, 'tasks.md'),
        phase.tasksMd,
      );
      written.push(vscode.Uri.joinPath(phaseDir, 'tasks.md'));
    }

    const readme = vscode.Uri.joinPath(docsRoot, 'README.md');
    await this.writeFile(readme, renderRoadmap(plan));
    written.push(readme);

    if (branch) {
      const writtenPaths = written.map((u) => relativePath(this.deps.root, u));
      await this.deps.git.add(writtenPaths);
      await this.deps.git.commit(`Megaplan: ${plan.feature}`);
      if (this.deps.autoPush) await this.deps.git.push(branch);
    }

    return {
      branch,
      writtenPaths: written.map((u) => relativePath(this.deps.root, u)),
    };
  }

  branchName(plan: Plan): string {
    const phase1Slug = plan.phases[0]?.slug ?? 'phase-01';
    return `rubyn/${plan.slug}-phase-01-${phase1Slug}`;
  }

  private async writeFile(uri: vscode.Uri, content: string): Promise<void> {
    const bytes = new TextEncoder().encode(ensureTrailingNewline(content));
    await vscode.workspace.fs.writeFile(uri, bytes);
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function relativePath(root: vscode.Uri, uri: vscode.Uri): string {
  const rootPath = root.fsPath.replace(/\/$/, '');
  return uri.fsPath.startsWith(rootPath + '/')
    ? uri.fsPath.slice(rootPath.length + 1)
    : uri.fsPath;
}

export function renderRoadmap(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`# ${plan.feature} — Roadmap`, '');
  lines.push(
    'Megaplan-style multi-phase plan. Each phase is a vertical slice; ship them independently.',
    '',
  );
  lines.push('## Phases', '');
  for (const phase of plan.phases) {
    const dir = `${pad2(phase.number)}-${phase.slug}`;
    lines.push(
      `- [ ] **[Phase ${phase.number} — ${phase.name}](${dir}/)** — ${phase.summary}`,
    );
  }
  lines.push('');
  lines.push('## Conventions', '');
  lines.push('- One folder per phase, numbered `NN-slug` (kebab-case).');
  lines.push('- Three files per phase: `requirements.md`, `design.md`, `tasks.md`.');
  lines.push('- `[ ]` / `[x]` checkboxes track progress.');
  lines.push('- Each phase is a vertical slice — trunk works at every boundary.');
  return lines.join('\n');
}

export function phaseRelativePath(plan: Plan, phase: PhaseSpec): string {
  return `docs/${plan.slug}/${pad2(phase.number)}-${phase.slug}`;
}
