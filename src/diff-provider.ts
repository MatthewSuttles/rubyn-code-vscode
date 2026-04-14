/**
 * Rubyn Code inline diff provider.
 *
 * Intercepts `file/edit` and `file/create` notifications from the Bridge,
 * opens VS Code's native diff editor (modifications) or preview tab
 * (new files), and surfaces per-edit Accept / Reject actions as CodeLens
 * at the top of the proposed document. Deletes get a modal confirm (no
 * diff view is appropriate). In yolo mode every edit is auto-accepted.
 *
 * Why CodeLens rather than a modal dialog: every major code-agent UX
 * (Cursor, Copilot Chat, Continue.dev) puts accept/reject on the diff
 * itself so the user can scroll through the change before deciding.
 * Modals block all interaction and are out of character for VS Code.
 */

import * as vscode from 'vscode';
import { Bridge } from './bridge';
import { AcceptEditParams, FileEditParams, FileCreateParams, Hunk } from './types';

// ---------------------------------------------------------------------------
// URI scheme for virtual "proposed" documents
// ---------------------------------------------------------------------------

const PROPOSED_SCHEME = 'rubyn-proposed';

// Command IDs exposed for CodeLens actions.
const ACCEPT_COMMAND = 'rubyn-code.acceptEdit';
const REJECT_COMMAND = 'rubyn-code.rejectEdit';

// ---------------------------------------------------------------------------
// Pending-edit bookkeeping
// ---------------------------------------------------------------------------

interface PendingModify {
  kind: 'modify';
  editId: string;
  filePath: string;
  hunks: Hunk[];
  proposedContent: string;
  originalUri: vscode.Uri;
  proposedUri: vscode.Uri;
  sessionId?: string;
}

interface PendingCreate {
  kind: 'create';
  editId: string;
  filePath: string;
  content: string;
  previewUri?: vscode.Uri;
  sessionId?: string;
}

interface PendingDelete {
  kind: 'delete';
  editId: string;
  filePath: string;
  sessionId?: string;
}

type PendingEdit = PendingModify | PendingCreate | PendingDelete;

// ---------------------------------------------------------------------------
// ProposedContentProvider — serves virtual documents for the diff view
// ---------------------------------------------------------------------------

class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.onDidChangeEmitter.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.onDidChangeEmitter.fire(uri);
  }

  remove(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  clear(): void {
    this.contents.clear();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
    this.contents.clear();
  }
}

// ---------------------------------------------------------------------------
// CodeLensProvider — shows ✓ Accept / ✗ Reject at the top of proposed docs
// ---------------------------------------------------------------------------

class ProposedCodeLensProvider implements vscode.CodeLensProvider {
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;

  constructor(private readonly getPending: (editId: string) => PendingEdit | undefined) {}

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.uri.scheme !== PROPOSED_SCHEME) return [];
    const editId = extractEditId(doc.uri);
    if (!editId) return [];
    if (!this.getPending(editId)) return [];

    const top = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(top, {
        title: '$(check) Accept Rubyn edit',
        command: ACCEPT_COMMAND,
        arguments: [editId],
      }),
      new vscode.CodeLens(top, {
        title: '$(close) Reject Rubyn edit',
        command: REJECT_COMMAND,
        arguments: [editId],
      }),
    ];
  }

  /** Force VS Code to re-query code lenses (called when pending state changes). */
  refresh(): void {
    this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

function extractEditId(uri: vscode.Uri): string | null {
  const match = uri.query.match(/(?:^|&)editId=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// ---------------------------------------------------------------------------
// DiffProvider
// ---------------------------------------------------------------------------

export class DiffProvider implements vscode.Disposable {
  private readonly bridge: Bridge;
  private readonly contentProvider: ProposedContentProvider;
  private readonly lensProvider: ProposedCodeLensProvider;
  private readonly pending = new Map<string, PendingEdit>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly log: vscode.OutputChannel;

  private seq = 0;

  constructor(bridge: Bridge, outputChannel?: vscode.OutputChannel) {
    this.bridge = bridge;
    this.contentProvider = new ProposedContentProvider();
    this.lensProvider = new ProposedCodeLensProvider((id) => this.pending.get(id));
    this.log =
      outputChannel ?? vscode.window.createOutputChannel('Rubyn Code — Diff');

    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this.contentProvider),
      vscode.languages.registerCodeLensProvider({ scheme: PROPOSED_SCHEME }, this.lensProvider),
      vscode.commands.registerCommand(ACCEPT_COMMAND, (arg?: string | vscode.Uri) => {
        const editId = this.resolveEditId(arg);
        this.log.appendLine(`[accept] command fired editId=${editId ?? '<none>'}`);
        if (!editId) return;
        return this.acceptByEditId(editId).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.appendLine(`[accept] FAILED editId=${editId}: ${msg}`);
          void vscode.window.showErrorMessage(`Rubyn accept failed: ${msg}`);
        });
      }),
      vscode.commands.registerCommand(REJECT_COMMAND, (arg?: string | vscode.Uri) => {
        const editId = this.resolveEditId(arg);
        this.log.appendLine(`[reject] command fired editId=${editId ?? '<none>'}`);
        if (!editId) return;
        return this.rejectByEditId(editId).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.appendLine(`[reject] FAILED editId=${editId}: ${msg}`);
          void vscode.window.showErrorMessage(`Rubyn reject failed: ${msg}`);
        });
      }),
      // If the user closes the diff tab without clicking either CodeLens,
      // treat it as a rejection so the agent doesn't sit waiting for 60s.
      vscode.workspace.onDidCloseTextDocument((doc) => this.onDocumentClosed(doc)),
      this.contentProvider,
      this.lensProvider,
    );

    // Subscribe to bridge notifications.
    this.bridge.on('file/edit', (params) => this.onFileEdit(params));
    this.bridge.on('file/create', (params) => this.onFileCreate(params));
  }

  // -----------------------------------------------------------------------
  // Notification handlers
  // -----------------------------------------------------------------------

  private async onFileEdit(params: Record<string, unknown> | undefined): Promise<void> {
    if (!params) return;

    const edit = params as unknown as FileEditParams;
    switch (edit.type) {
      case 'modify':
        await this.handleModify(edit);
        break;
      case 'create':
        await this.handleCreate(edit);
        break;
      case 'delete':
        await this.handleDelete(edit);
        break;
    }
  }

  private async onFileCreate(params: Record<string, unknown> | undefined): Promise<void> {
    if (!params) return;

    const create = params as unknown as FileCreateParams;
    await this.handleCreate({
      editId: create.editId,
      path: create.path,
      type: 'create',
      content: create.content,
    });
  }

  // -----------------------------------------------------------------------
  // Modify — inline diff with CodeLens accept/reject
  // -----------------------------------------------------------------------

  private async handleModify(edit: FileEditParams): Promise<void> {
    const originalUri = vscode.Uri.file(edit.path);
    const proposedUri = vscode.Uri.parse(
      `${PROPOSED_SCHEME}://rubyn/proposed-${this.seq++}/${encodeURIComponent(edit.path)}?editId=${encodeURIComponent(edit.editId)}`,
    );

    const proposedContent = await this.buildProposedContent(
      originalUri,
      edit.hunks ?? [],
      edit.content,
    );

    this.contentProvider.set(proposedUri, proposedContent);

    const pending: PendingModify = {
      kind: 'modify',
      editId: edit.editId,
      filePath: edit.path,
      hunks: edit.hunks ?? [],
      proposedContent,
      originalUri,
      proposedUri,
    };
    this.pending.set(edit.editId, pending);

    if (this.isYoloMode()) {
      this.flashNotification(`Rubyn auto-applied changes to ${this.basename(edit.path)}`);
      await this.acceptModify(pending);
      return;
    }

    // Open the diff editor. The CodeLensProvider will render ✓/✗ actions
    // at the top of the proposed document — the user scrolls the diff,
    // then clicks Accept or Reject. No modal; no dismissible notification.
    const title = `Rubyn: ${this.basename(edit.path)} (proposed changes)`;
    await vscode.commands.executeCommand('vscode.diff', originalUri, proposedUri, title);
    this.lensProvider.refresh();
  }

  private async acceptModify(pending: PendingModify): Promise<void> {
    // Direct fs write is more reliable than applyEdit + save: it doesn't
    // depend on the document being open in an editor, doesn't race with
    // the user's own edits in the same buffer, and fails loudly if the
    // path is wrong. VS Code's file watcher picks up the change and
    // refreshes any open editor on the same URI automatically.
    try {
      const encoded = new TextEncoder().encode(pending.proposedContent);
      await vscode.workspace.fs.writeFile(pending.originalUri, encoded);
      this.log.appendLine(`[accept] wrote ${pending.filePath} (${encoded.byteLength} bytes)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[accept] fs.writeFile failed for ${pending.filePath}: ${msg}`);
      this.sendAcceptEdit(pending.editId, false);
      this.cleanupEdit(pending);
      throw err;
    }

    this.sendAcceptEdit(pending.editId, true);
    await this.closeDiffTab(pending.proposedUri);
    this.cleanupEdit(pending);
  }

  // -----------------------------------------------------------------------
  // Create — preview tab with CodeLens accept/reject
  // -----------------------------------------------------------------------

  private async handleCreate(edit: FileEditParams): Promise<void> {
    const content = edit.content ?? '';
    const filePath = edit.path;

    const pending: PendingCreate = {
      kind: 'create',
      editId: edit.editId,
      filePath,
      content,
    };
    this.pending.set(edit.editId, pending);

    if (this.isYoloMode()) {
      this.flashNotification(`Rubyn auto-created ${this.basename(filePath)}`);
      await this.acceptCreate(pending);
      return;
    }

    const previewUri = vscode.Uri.parse(
      `${PROPOSED_SCHEME}://rubyn/new-${this.seq++}/${encodeURIComponent(filePath)}?editId=${encodeURIComponent(edit.editId)}`,
    );
    pending.previewUri = previewUri;
    this.contentProvider.set(previewUri, content);

    const doc = await vscode.workspace.openTextDocument(previewUri);
    await vscode.window.showTextDocument(doc, { preview: true });
    this.lensProvider.refresh();
  }

  private async acceptCreate(pending: PendingCreate): Promise<void> {
    const fileUri = vscode.Uri.file(pending.filePath);
    const encoded = new TextEncoder().encode(pending.content);

    await vscode.workspace.fs.writeFile(fileUri, encoded);

    this.sendAcceptEdit(pending.editId, true);
    if (pending.previewUri) {
      this.contentProvider.remove(pending.previewUri);
      await this.closeDiffTab(pending.previewUri);
    }
    this.cleanupEdit(pending);
  }

  // -----------------------------------------------------------------------
  // Delete — modal confirm (no diff view to hang CodeLens on)
  // -----------------------------------------------------------------------

  private async handleDelete(edit: FileEditParams): Promise<void> {
    const pending: PendingDelete = {
      kind: 'delete',
      editId: edit.editId,
      filePath: edit.path,
    };
    this.pending.set(edit.editId, pending);

    if (this.isYoloMode()) {
      this.flashNotification(`Rubyn auto-deleted ${this.basename(edit.path)}`);
      await this.acceptDelete(pending);
      return;
    }

    // Delete is destructive and there's no diff view to host a CodeLens, so
    // a modal warning is the right UX. It's rare enough that the friction
    // is appropriate.
    const choice = await vscode.window.showWarningMessage(
      `Rubyn wants to delete ${this.basename(edit.path)}`,
      {
        modal: true,
        detail: `This will permanently delete ${edit.path}.`,
      },
      'Accept',
      'Reject',
    );

    if (choice === 'Accept') {
      await this.acceptDelete(pending);
    } else {
      await this.rejectEdit(pending);
    }
  }

  private async acceptDelete(pending: PendingDelete): Promise<void> {
    const fileUri = vscode.Uri.file(pending.filePath);
    try {
      await vscode.workspace.fs.delete(fileUri);
    } catch {
      // File may already have been removed — that is fine.
    }
    this.sendAcceptEdit(pending.editId, true);
    this.cleanupEdit(pending);
  }

  // -----------------------------------------------------------------------
  // Reject (shared)
  // -----------------------------------------------------------------------

  private async rejectEdit(pending: PendingEdit): Promise<void> {
    this.sendAcceptEdit(pending.editId, false);
    if (pending.kind === 'modify') {
      await this.closeDiffTab(pending.proposedUri);
    } else if (pending.kind === 'create' && pending.previewUri) {
      this.contentProvider.remove(pending.previewUri);
      await this.closeDiffTab(pending.previewUri);
    }
    this.cleanupEdit(pending);
  }

  // -----------------------------------------------------------------------
  // Command entry points (called by CodeLens clicks)
  // -----------------------------------------------------------------------

  /**
   * Resolve an editId from whatever the command handler got:
   *   - a string editId (passed by our CodeLens)
   *   - a proposed-scheme Uri (passed by the editor/title menu button)
   *   - nothing (invoked from command palette or keybinding) — fall back
   *     to the active editor's Uri if it's a proposed document.
   */
  private resolveEditId(arg?: string | vscode.Uri): string | null {
    if (typeof arg === 'string') return arg;
    if (arg && arg.scheme === PROPOSED_SCHEME) return extractEditId(arg);

    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === PROPOSED_SCHEME) return extractEditId(active);

    // Also check tabGroups for a visible proposed doc — the title-menu
    // button sometimes passes no arg if the diff tab wasn't active when
    // it fired.
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as
          | { modified?: vscode.Uri; uri?: vscode.Uri }
          | undefined;
        const candidate = input?.modified ?? input?.uri;
        if (candidate?.scheme === PROPOSED_SCHEME) {
          const id = extractEditId(candidate);
          if (id && this.pending.has(id)) return id;
        }
      }
    }
    return null;
  }

  async acceptByEditId(editId: string): Promise<void> {
    const pending = this.pending.get(editId);
    if (!pending) {
      this.log.appendLine(`[accept] no pending edit for ${editId}`);
      return;
    }
    this.log.appendLine(`[accept] applying ${pending.kind} → ${pending.filePath}`);
    switch (pending.kind) {
      case 'modify':
        await this.acceptModify(pending);
        break;
      case 'create':
        await this.acceptCreate(pending);
        break;
      case 'delete':
        await this.acceptDelete(pending);
        break;
    }
    this.log.appendLine(`[accept] done ${editId}`);
  }

  async rejectByEditId(editId: string): Promise<void> {
    const pending = this.pending.get(editId);
    if (!pending) {
      this.log.appendLine(`[reject] no pending edit for ${editId}`);
      return;
    }
    this.log.appendLine(`[reject] discarding ${pending.kind} → ${pending.filePath}`);
    await this.rejectEdit(pending);
  }

  // -----------------------------------------------------------------------
  // Grouped / batch edits
  // -----------------------------------------------------------------------

  async acceptSession(sessionId: string): Promise<void> {
    const related = [...this.pending.values()].filter((e) => e.sessionId === sessionId);
    for (const edit of related) {
      await this.acceptByEditId(edit.editId);
    }
  }

  async rejectSession(sessionId: string): Promise<void> {
    const related = [...this.pending.values()].filter((e) => e.sessionId === sessionId);
    for (const edit of related) await this.rejectEdit(edit);
  }

  // -----------------------------------------------------------------------
  // Closed-tab fallback
  // -----------------------------------------------------------------------

  private onDocumentClosed(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== PROPOSED_SCHEME) return;
    const editId = extractEditId(doc.uri);
    if (!editId) return;
    const pending = this.pending.get(editId);
    if (!pending) return;

    // User closed the diff/preview without clicking Accept or Reject.
    // Treat that as a rejection so the agent isn't stranded waiting.
    void this.rejectEdit(pending);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async buildProposedContent(
    originalUri: vscode.Uri,
    hunks: Hunk[],
    fullContent?: string,
  ): Promise<string> {
    if (fullContent !== undefined) return fullContent;

    let originalText: string;
    try {
      const doc = await vscode.workspace.openTextDocument(originalUri);
      originalText = doc.getText();
    } catch {
      const bytes = await vscode.workspace.fs.readFile(originalUri);
      originalText = new TextDecoder().decode(bytes);
    }

    if (hunks.length === 0) return originalText;

    // Apply hunks in reverse order so earlier edits don't shift later ranges.
    const sorted = [...hunks].sort((a, b) => b.startLine - a.startLine);
    const lines = originalText.split('\n');
    for (const hunk of sorted) {
      const replacement = hunk.newContent.split('\n');
      lines.splice(hunk.startLine, hunk.endLine - hunk.startLine + 1, ...replacement);
    }
    return lines.join('\n');
  }

  private async closeDiffTab(uri: vscode.Uri): Promise<void> {
    // Find any tab whose input references this URI and close it. VS Code
    // doesn't expose a direct "close tab for URI" API so we walk the tabs.
    const groups = vscode.window.tabGroups.all;
    for (const group of groups) {
      for (const tab of group.tabs) {
        const input = tab.input as { modified?: vscode.Uri; original?: vscode.Uri; uri?: vscode.Uri } | undefined;
        const refs = [input?.modified?.toString(), input?.original?.toString(), input?.uri?.toString()];
        if (refs.includes(uri.toString())) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
  }

  /** Send the acceptEdit response back to the CLI process. */
  private sendAcceptEdit(editId: string, accepted: boolean): void {
    const params: AcceptEditParams = { editId, accepted };
    this.bridge.notify('acceptEdit', params as unknown as Record<string, unknown>);
  }

  private cleanupEdit(pending: PendingEdit): void {
    this.pending.delete(pending.editId);
    this.lensProvider.refresh();
  }

  /** Whether a specific editId is still pending. */
  hasPending(editId: string): boolean {
    return this.pending.has(editId);
  }

  /** Count of currently-pending edits (used by tests). */
  get pendingCount(): number {
    return this.pending.size;
  }

  private basename(p: string): string {
    return p.split('/').pop() ?? p;
  }

  /** Check the user's yolo-mode setting. */
  private isYoloMode(): boolean {
    return (
      vscode.workspace
        .getConfiguration('rubyn-code')
        .get<boolean>('yoloMode', false)
    );
  }

  /** Show a brief auto-dismiss notification (for yolo mode). */
  private flashNotification(message: string): void {
    void vscode.window.setStatusBarMessage(`$(zap) ${message}`, 4000);
  }

  // -----------------------------------------------------------------------
  // Disposable
  // -----------------------------------------------------------------------

  dispose(): void {
    // Reject any still-pending edits so the server-side waits resolve.
    for (const edit of this.pending.values()) {
      this.sendAcceptEdit(edit.editId, false);
    }
    this.pending.clear();

    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
