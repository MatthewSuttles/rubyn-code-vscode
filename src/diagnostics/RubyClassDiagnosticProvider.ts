/**
 * Owns the `rubyn-code` DiagnosticCollection. For each class in the
 * ClassIndex, runs the four metric calculators and emits diagnostics for any
 * signal that trips its threshold. Diagnostics carry a `code` string
 * (`rubyn.method-count`, `rubyn.lcom4`, `rubyn.fan-out`, `rubyn.cyclomatic`)
 * so RefactorCodeActionProvider can match them.
 */

import * as vscode from 'vscode';
import { ClassIndex, ClassInfo, ClassMethodInfo } from '../rails/ClassIndex';
import { ThresholdConfig } from './ThresholdConfig';
import { publicMethodCount } from './metrics/methodCount';
import { lcom4 } from './metrics/lcom4';
import { fanOut } from './metrics/fanOut';
import { cyclomaticComplexity } from './metrics/cyclomatic';

export type DiagnosticCode =
  | 'rubyn.method-count'
  | 'rubyn.lcom4'
  | 'rubyn.fan-out'
  | 'rubyn.cyclomatic';

export class RubyClassDiagnosticProvider {
  readonly collection: vscode.DiagnosticCollection;

  constructor(
    private readonly getIndex: () => Promise<ClassIndex>,
    private getThresholds: () => ThresholdConfig,
  ) {
    this.collection = vscode.languages.createDiagnosticCollection('rubyn-code');
  }

  async refreshAll(): Promise<void> {
    this.collection.clear();
    const t = this.getThresholds();
    if (!t.enabled) return;
    const index = await this.getIndex();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const c of index.all()) {
      const diags = diagnosticsFor(c, t);
      if (diags.length === 0) continue;
      const key = c.fileUri.fsPath;
      const list = byFile.get(key) ?? [];
      list.push(...diags);
      byFile.set(key, list);
    }
    for (const [path, diags] of byFile.entries()) {
      this.collection.set(vscode.Uri.file(path), diags);
    }
  }

  async refreshForFile(uri: vscode.Uri): Promise<void> {
    const t = this.getThresholds();
    this.collection.delete(uri);
    if (!t.enabled) return;
    const index = await this.getIndex();
    const classes = index.classesIn(uri);
    const diags: vscode.Diagnostic[] = [];
    for (const c of classes) {
      diags.push(...diagnosticsFor(c, t));
    }
    if (diags.length > 0) this.collection.set(uri, diags);
  }

  dispose(): void {
    this.collection.dispose();
  }
}

export function diagnosticsFor(
  c: ClassInfo,
  t: ThresholdConfig,
): vscode.Diagnostic[] {
  const out: vscode.Diagnostic[] = [];
  const classRange = new vscode.Range(
    new vscode.Position(c.declarationLine, 0),
    new vscode.Position(c.declarationLine, Number.MAX_SAFE_INTEGER),
  );

  if (t.methodCountThreshold > 0) {
    const count = publicMethodCount(c);
    if (count > t.methodCountThreshold) {
      out.push(
        diag(
          classRange,
          `Class \`${c.name}\` has ${count} public methods (threshold ${t.methodCountThreshold}). Consider splitting responsibilities.`,
          vscode.DiagnosticSeverity.Warning,
          'rubyn.method-count',
        ),
      );
    }
  }

  if (t.lcomMinMethods > 0 && c.methods.length >= t.lcomMinMethods) {
    const lcom = lcom4(c);
    if (lcom.total > 1) {
      out.push(
        diag(
          classRange,
          `Class \`${c.name}\` has ${lcom.total} unrelated method clusters (sizes: ${lcom.components.join(', ')}). The methods may want to live on separate objects.`,
          vscode.DiagnosticSeverity.Warning,
          'rubyn.lcom4',
        ),
      );
    }
  }

  if (t.fanOutThreshold > 0) {
    const fan = fanOut(c);
    if (fan.count > t.fanOutThreshold) {
      out.push(
        diag(
          classRange,
          `Class \`${c.name}\` references ${fan.count} external classes (threshold ${t.fanOutThreshold}). Heavy coupling — consider extracting collaborators.`,
          vscode.DiagnosticSeverity.Information,
          'rubyn.fan-out',
        ),
      );
    }
  }

  if (t.cyclomaticThreshold > 0) {
    for (const method of c.methods) {
      const score = cyclomaticComplexity(method);
      if (score > t.cyclomaticThreshold) {
        out.push(
          diag(
            methodRange(method),
            `Method \`${method.name}\` has cyclomatic complexity ${score} (threshold ${t.cyclomaticThreshold}). Consider extracting branches.`,
            vscode.DiagnosticSeverity.Warning,
            'rubyn.cyclomatic',
          ),
        );
      }
    }
  }

  return out;
}

function diag(
  range: vscode.Range,
  message: string,
  severity: vscode.DiagnosticSeverity,
  code: DiagnosticCode,
): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, message, severity);
  d.source = 'rubyn-code';
  d.code = code;
  return d;
}

function methodRange(m: ClassMethodInfo): vscode.Range {
  return new vscode.Range(
    new vscode.Position(m.declarationLine, 0),
    new vscode.Position(m.declarationLine, Number.MAX_SAFE_INTEGER),
  );
}
