/**
 * Tests for RefactorCodeActionProvider — emits "Ask Rubyn to refactor" for
 * any `rubyn-code`-sourced diagnostic and skips everything else.
 */

import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import {
  Diagnostic,
  DiagnosticSeverity,
  Range,
  Uri,
  CodeActionKind,
} from '../../helpers/mock-vscode';
import { RefactorCodeActionProvider } from '../../../src/diagnostics/RefactorCodeActionProvider';

function fakeDoc(): vscode.TextDocument {
  return { uri: Uri.file('/app/lib/foo.rb') } as unknown as vscode.TextDocument;
}

describe('RefactorCodeActionProvider', () => {
  const provider = new RefactorCodeActionProvider();

  it('emits the action for a rubyn-code diagnostic', () => {
    const diag = new Diagnostic(
      new Range(2, 0, 2, 30),
      'too many methods',
      DiagnosticSeverity.Warning,
    );
    diag.source = 'rubyn-code';
    diag.code = 'rubyn.method-count';
    const actions = provider.provideCodeActions(
      fakeDoc(),
      new Range(2, 0, 2, 30),
      { diagnostics: [diag] } as never,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].title).toBe('Ask Rubyn to refactor');
    expect(actions[0].kind).toBe(CodeActionKind.QuickFix);
    expect(actions[0].command?.command).toBe('rubyn-code.refactorFromDiagnostic');
    const payload = actions[0].command?.arguments?.[0] as { diagnosticCode: string };
    expect(payload.diagnosticCode).toBe('rubyn.method-count');
  });

  it('skips diagnostics from other sources', () => {
    const diag = new Diagnostic(
      new Range(0, 0, 0, 1),
      'foreign warning',
      DiagnosticSeverity.Warning,
    );
    diag.source = 'rubocop';
    diag.code = 'Style/Foo';
    const actions = provider.provideCodeActions(
      fakeDoc(),
      new Range(0, 0, 0, 1),
      { diagnostics: [diag] } as never,
    );
    expect(actions).toHaveLength(0);
  });

  it('skips rubyn-code diagnostics with an unknown code', () => {
    const diag = new Diagnostic(
      new Range(0, 0, 0, 1),
      'something else',
      DiagnosticSeverity.Warning,
    );
    diag.source = 'rubyn-code';
    diag.code = 'rubyn.other';
    const actions = provider.provideCodeActions(
      fakeDoc(),
      new Range(0, 0, 0, 1),
      { diagnostics: [diag] } as never,
    );
    expect(actions).toHaveLength(0);
  });
});
