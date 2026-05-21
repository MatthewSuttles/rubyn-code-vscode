/**
 * For any `rubyn-code` complexity diagnostic on the current range, offer an
 * "Ask Rubyn to refactor" code action. The action invokes
 * `rubyn-code.refactorFromDiagnostic` with the diagnostic + the source
 * range, which the extension's command handler turns into a chat prompt.
 */

import * as vscode from 'vscode';

const RUBYN_DIAGNOSTIC_CODES = new Set([
  'rubyn.method-count',
  'rubyn.lcom4',
  'rubyn.fan-out',
  'rubyn.cyclomatic',
]);

export class RefactorCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  provideCodeActions(
    doc: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const diag of context.diagnostics) {
      if (diag.source !== 'rubyn-code') continue;
      const rawCode = diag.code;
      const code =
        typeof rawCode === 'string'
          ? rawCode
          : typeof rawCode === 'object' && rawCode !== null
            ? String(rawCode.value)
            : null;
      if (!code || !RUBYN_DIAGNOSTIC_CODES.has(code)) continue;
      const action = new vscode.CodeAction(
        'Ask Rubyn to refactor',
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = [diag];
      action.command = {
        title: 'Ask Rubyn to refactor',
        command: 'rubyn-code.refactorFromDiagnostic',
        arguments: [
          {
            uri: doc.uri.toString(),
            diagnosticCode: code,
            message: diag.message,
            range: {
              start: { line: diag.range.start.line, character: diag.range.start.character },
              end: { line: diag.range.end.line, character: diag.range.end.character },
            },
          },
        ],
      };
      actions.push(action);
    }
    return actions;
  }
}
