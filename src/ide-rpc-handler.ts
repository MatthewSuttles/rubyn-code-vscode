/**
 * Rubyn Code — IDE RPC handler for bidirectional communication.
 *
 * Implements server-initiated `ide/*` JSON-RPC methods using VS Code APIs.
 * These let the CLI process ask the extension to do things like read the
 * current selection, open diffs, navigate to files, or get diagnostics.
 */

import * as vscode from 'vscode';
import { Bridge } from './bridge';

/**
 * Register all `ide/*` request handlers on the bridge.
 *
 * Returns a Disposable that unregisters the handlers.
 */
export function registerIdeRpcHandlers(bridge: Bridge): vscode.Disposable {
  bridge.onRequest('ide/openDiff', handleOpenDiff);
  bridge.onRequest('ide/readSelection', handleReadSelection);
  bridge.onRequest('ide/readActiveFile', handleReadActiveFile);
  bridge.onRequest('ide/saveFile', handleSaveFile);
  bridge.onRequest('ide/navigateTo', handleNavigateTo);
  bridge.onRequest('ide/getOpenTabs', handleGetOpenTabs);
  bridge.onRequest('ide/getDiagnostics', handleGetDiagnostics);
  bridge.onRequest('ide/getWorkspaceSymbols', handleGetWorkspaceSymbols);

  return { dispose() { /* handlers cleared on bridge.dispose() */ } };
}

// ---------------------------------------------------------------------------
// ide/openDiff
// ---------------------------------------------------------------------------

async function handleOpenDiff(
  params: Record<string, unknown>,
): Promise<{ accepted: boolean }> {
  const filePath = params.path as string;
  const proposedContent = params.proposedContent as string;
  const title = (params.title as string) ?? `Rubyn: ${filePath}`;

  if (!filePath || proposedContent === undefined) {
    return { accepted: false };
  }

  const uri = vscode.Uri.file(filePath);

  // Create a virtual document with the proposed content
  const proposedUri = vscode.Uri.parse(
    `rubyn-proposed://${filePath}?${Date.now()}`,
  );

  // Open the diff editor
  await vscode.commands.executeCommand('vscode.diff', uri, proposedUri, title);

  return { accepted: true };
}

// ---------------------------------------------------------------------------
// ide/readSelection
// ---------------------------------------------------------------------------

async function handleReadSelection(): Promise<{
  text: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  language?: string;
}> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return { text: '' };
  }

  return {
    text: editor.document.getText(editor.selection),
    file: editor.document.uri.fsPath,
    startLine: editor.selection.start.line,
    endLine: editor.selection.end.line,
    language: editor.document.languageId,
  };
}

// ---------------------------------------------------------------------------
// ide/readActiveFile
// ---------------------------------------------------------------------------

async function handleReadActiveFile(): Promise<{
  path: string;
  content: string;
  language: string;
}> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error('No active editor');
  }

  return {
    path: editor.document.uri.fsPath,
    content: editor.document.getText(),
    language: editor.document.languageId,
  };
}

// ---------------------------------------------------------------------------
// ide/saveFile
// ---------------------------------------------------------------------------

async function handleSaveFile(
  params: Record<string, unknown>,
): Promise<{ saved: boolean }> {
  const filePath = params.path as string;
  if (!filePath) {
    return { saved: false };
  }

  const uri = vscode.Uri.file(filePath);

  // Find the document if it's already open
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === uri.fsPath,
  );
  if (doc && doc.isDirty) {
    await doc.save();
    return { saved: true };
  }

  return { saved: false };
}

// ---------------------------------------------------------------------------
// ide/navigateTo
// ---------------------------------------------------------------------------

async function handleNavigateTo(
  params: Record<string, unknown>,
): Promise<Record<string, never>> {
  const filePath = params.path as string;
  const line = (params.line as number) ?? 0;
  const column = (params.column as number) ?? 0;

  if (!filePath) {
    throw new Error('Missing path parameter');
  }

  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);

  const position = new vscode.Position(line, column);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenter,
  );

  return {};
}

// ---------------------------------------------------------------------------
// ide/getOpenTabs
// ---------------------------------------------------------------------------

async function handleGetOpenTabs(): Promise<{
  tabs: Array<{ path: string; language?: string; isDirty: boolean }>;
}> {
  const tabs: Array<{ path: string; language?: string; isDirty: boolean }> = [];

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        const uri = tab.input.uri;
        if (uri.scheme === 'file') {
          const doc = vscode.workspace.textDocuments.find(
            (d) => d.uri.fsPath === uri.fsPath,
          );
          tabs.push({
            path: uri.fsPath,
            language: doc?.languageId,
            isDirty: tab.isDirty,
          });
        }
      }
    }
  }

  return { tabs };
}

// ---------------------------------------------------------------------------
// ide/getDiagnostics
// ---------------------------------------------------------------------------

async function handleGetDiagnostics(
  params: Record<string, unknown>,
): Promise<{
  diagnostics: Array<{
    file: string;
    line: number;
    column: number;
    severity: string;
    message: string;
    source?: string;
  }>;
}> {
  const filePath = params.file as string | undefined;

  let allDiagnostics: [vscode.Uri, readonly vscode.Diagnostic[]][];

  if (filePath) {
    const uri = vscode.Uri.file(filePath);
    const diags = vscode.languages.getDiagnostics(uri);
    allDiagnostics = [[uri, diags]];
  } else {
    allDiagnostics = vscode.languages.getDiagnostics() as [vscode.Uri, readonly vscode.Diagnostic[]][];
  }

  const diagnostics: Array<{
    file: string;
    line: number;
    column: number;
    severity: string;
    message: string;
    source?: string;
  }> = [];

  for (const [uri, diags] of allDiagnostics) {
    for (const diag of diags) {
      diagnostics.push({
        file: uri.fsPath,
        line: diag.range.start.line,
        column: diag.range.start.character,
        severity: severityToString(diag.severity),
        message: diag.message,
        source: diag.source,
      });
    }
  }

  return { diagnostics };
}

function severityToString(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'info';
  }
}

// ---------------------------------------------------------------------------
// ide/getWorkspaceSymbols
// ---------------------------------------------------------------------------

async function handleGetWorkspaceSymbols(
  params: Record<string, unknown>,
): Promise<{
  symbols: Array<{
    name: string;
    kind: string;
    file: string;
    line?: number;
    containerName?: string;
  }>;
}> {
  const query = (params.query as string) ?? '';

  const results = (await vscode.commands.executeCommand(
    'vscode.executeWorkspaceSymbolProvider',
    query,
  )) as vscode.SymbolInformation[] | undefined;

  const symbols = (results ?? []).map((sym) => ({
    name: sym.name,
    kind: vscode.SymbolKind[sym.kind] ?? 'Unknown',
    file: sym.location.uri.fsPath,
    line: sym.location.range.start.line,
    containerName: sym.containerName || undefined,
  }));

  return { symbols };
}
