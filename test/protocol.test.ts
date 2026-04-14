/**
 * Protocol round-trip tests.
 *
 * These are the guard rails that catch "gem renamed a method / extension
 * didn't notice" regressions. They exercise the full extension-side chain
 * with the gem simulated via PassThrough streams: for each workflow we
 * feed in the exact JSON the gem actually emits today and assert that
 * the extension emits the JSON the gem is listening for, on the method
 * names the gem has registered in handlers.rb.
 *
 * If you rename a JSON-RPC method or change a payload shape on either
 * side, one of these tests should fail. That's the point.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import * as vscode from 'vscode';
import {
  __resetAll,
  __setConfig,
  __getRegisteredCommands,
  Uri,
  Position,
} from './helpers/mock-vscode';
import { Bridge } from '../src/bridge';
import { DiffProvider } from '../src/diff-provider';

// ---------------------------------------------------------------------------
// Gem handler registry — keep in lock-step with
// lib/rubyn_code/ide/handlers.rb REGISTRY. If the gem renames a method,
// update this list and a test below will fail until the extension catches up.
// ---------------------------------------------------------------------------

const GEM_HANDLERS = new Set([
  'initialize',
  'prompt',
  'cancel',
  'review',
  'approveToolUse',
  'acceptEdit',
  'shutdown',
  'config/get',
  'config/set',
  'models/list',
  'session/reset',
]);

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function createEnv() {
  const stdin = new PassThrough(); // ext writes → gem reads (simulated)
  const stdout = new PassThrough(); // gem writes → ext reads (simulated)
  const bridge = new Bridge(stdin, stdout);
  const diff = new DiffProvider(bridge);

  /** Feed a JSON-RPC message as if it came from the gem. */
  function gemSends(method: string, params: Record<string, unknown>, id?: number): void {
    const msg: Record<string, unknown> = { jsonrpc: '2.0', method, params };
    if (id !== undefined) msg.id = id;
    stdout.write(JSON.stringify(msg) + '\n');
  }

  /** Feed a JSON-RPC response as if the gem responded to a request. */
  function gemResponds(id: number | string, result: Record<string, unknown>): void {
    stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  /** Read everything the extension has written to the gem's stdin so far. */
  function extMessages(): Array<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let chunk: Buffer | null;
    while ((chunk = stdin.read() as Buffer | null) !== null) chunks.push(chunk);
    if (chunks.length === 0) return [];
    return Buffer.concat(chunks)
      .toString('utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  /** Simulate the user clicking the editor-title or CodeLens Accept action. */
  async function clickAccept(editId: string): Promise<void> {
    const handler = __getRegisteredCommands().get('rubyn-code.acceptEdit');
    if (!handler) throw new Error('rubyn-code.acceptEdit not registered');
    await handler(editId);
  }

  async function clickReject(editId: string): Promise<void> {
    const handler = __getRegisteredCommands().get('rubyn-code.rejectEdit');
    if (!handler) throw new Error('rubyn-code.rejectEdit not registered');
    await handler(editId);
  }

  return { stdin, stdout, bridge, diff, gemSends, gemResponds, extMessages, clickAccept, clickReject };
}

describe('protocol round-trip', () => {
  let env: ReturnType<typeof createEnv>;

  beforeEach(() => {
    __resetAll();
    env = createEnv();
    __setConfig('rubyn-code', { yoloMode: false });
    (vscode.window.tabGroups as any).all = [];
  });

  afterEach(() => {
    env.diff.dispose();
    env.bridge.dispose();
    __resetAll();
  });

  // -----------------------------------------------------------------------
  // Method-name alignment — the single source of truth
  // -----------------------------------------------------------------------

  describe('method names', () => {
    it('every method the extension requests is a registered gem handler', async () => {
      // This is a static check. If you add a new bridge.request(...) call,
      // update GEM_HANDLERS above too (and verify the gem side).
      const extensionCalls = [
        'initialize',
        'prompt',
        'cancel',
        'review',
        'approveToolUse',
        'acceptEdit',
        'shutdown',
        'config/get',
        'config/set',
        'models/list',
        'session/reset',
      ];
      for (const method of extensionCalls) {
        expect(GEM_HANDLERS.has(method), `method "${method}" must be a gem handler`).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Session reset flow — "New Session" button → gem drops conversation
  // -----------------------------------------------------------------------

  describe('session reset flow', () => {
    it('notifies the gem on session/reset when the user starts a new session', async () => {
      // The webview posts {type: 'resetSession', payload: {sessionId}} which
      // the extension host forwards as bridge.notify('session/reset', ...).
      // We simulate the extension-host leg directly.
      env.bridge.notify('session/reset', { sessionId: 'sess-old' });
      await new Promise((r) => setTimeout(r, 10));

      const sent = env.extMessages();
      const msg = sent.find((m) => m.method === 'session/reset');
      expect(msg, 'extension must send session/reset JSON-RPC').toBeDefined();
      expect((msg!.params as any).sessionId).toBe('sess-old');
      expect(msg!.id, 'session/reset is a notification, must have no id').toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Bash approval flow
  // -----------------------------------------------------------------------

  describe('bash approval flow', () => {
    it('round-trips tool/use → approveToolUse → tool/result', async () => {
      // 1. Gem emits tool/use with requiresApproval: true. In a real run this
      //    is the ToolOutput adapter's emit_tool_use(). Shape MUST match what
      //    the extension expects: {requestId, tool, args, requiresApproval}.
      env.gemSends('tool/use', {
        requestId: 'bash-req-1',
        tool: 'bash',
        args: { command: 'ls -la' },
        requiresApproval: true,
      });
      await new Promise((r) => setTimeout(r, 20));

      // 2. User clicks "Allow" in chat. The webview posts
      //    {type: 'approveToolUse'} to the extension host. The extension
      //    then sends a JSON-RPC request with method "approveToolUse" —
      //    this must match what handlers.rb REGISTRY uses.
      //
      //    We simulate the webview→extension leg by calling the bridge
      //    directly with the same method name the webview-provider uses.
      const approvalPromise = env.bridge.request('approveToolUse', {
        requestId: 'bash-req-1',
        approved: true,
      });

      await new Promise((r) => setTimeout(r, 20));
      const sent = env.extMessages();
      const approvalMsg = sent.find((m) => m.method === 'approveToolUse');
      expect(approvalMsg, 'extension should send approveToolUse JSON-RPC').toBeDefined();
      expect((approvalMsg!.params as any).requestId).toBe('bash-req-1');
      expect((approvalMsg!.params as any).approved).toBe(true);

      // 3. Gem responds to the request. The Bridge awaits by id.
      env.gemResponds(approvalMsg!.id as number, { resolved: true, requestId: 'bash-req-1' });
      await approvalPromise;

      // 4. Gem emits tool/result. Shape: {requestId, tool, success, summary}.
      env.gemSends('tool/result', {
        requestId: 'bash-req-1',
        tool: 'bash',
        success: true,
        summary: '$ ls -la',
      });

      // Nothing to assert on the extension side here — tool/result is
      // forwarded to the webview which renders it. Having it not throw
      // is the assertion.
    });

    it('round-trips denial via UserDeniedError path', async () => {
      env.gemSends('tool/use', {
        requestId: 'bash-req-2',
        tool: 'bash',
        args: { command: 'rm -rf /' },
        requiresApproval: true,
      });
      await new Promise((r) => setTimeout(r, 20));

      const pr = env.bridge.request('approveToolUse', {
        requestId: 'bash-req-2',
        approved: false,
      });
      await new Promise((r) => setTimeout(r, 20));
      const sent = env.extMessages();
      const denyMsg = sent.find((m) => m.method === 'approveToolUse');
      expect(denyMsg).toBeDefined();
      expect((denyMsg!.params as any).approved).toBe(false);

      env.gemResponds(denyMsg!.id as number, { resolved: true, requestId: 'bash-req-2' });
      await pr;
    });
  });

  // -----------------------------------------------------------------------
  // Edit file flow
  // -----------------------------------------------------------------------

  describe('edit_file approval flow', () => {
    it('round-trips file/edit → acceptEdit → file write', async () => {
      (vscode.workspace.openTextDocument as any).mockResolvedValue({
        getText: () => 'before\n',
        positionAt: (o: number) => new Position(0, o),
        uri: Uri.file('/workspace/app.rb'),
        save: vi.fn(async () => true),
      });

      // 1. Gem emits file/edit. Shape MUST match FileEditParams in types.ts:
      //    {editId, path, type: 'modify'|'create'|'delete', content}.
      env.gemSends('file/edit', {
        editId: 'edit-1',
        path: '/workspace/app.rb',
        type: 'modify',
        content: 'after\n',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(env.diff.hasPending('edit-1')).toBe(true);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'vscode.diff',
        expect.any(Object),
        expect.any(Object),
        expect.stringContaining('app.rb'),
      );

      // 2. User clicks Accept (editor title button or CodeLens).
      await env.clickAccept('edit-1');

      // 3. Extension wrote the proposed content directly to disk.
      expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({ fsPath: '/workspace/app.rb' }),
        expect.any(Uint8Array),
      );

      // 4. Extension sent acceptEdit notification. Method name MUST match
      //    handlers.rb's 'acceptEdit' registration.
      const sent = env.extMessages();
      const accept = sent.find((m) => m.method === 'acceptEdit');
      expect(accept, 'extension must send acceptEdit JSON-RPC').toBeDefined();
      expect((accept!.params as any).editId).toBe('edit-1');
      expect((accept!.params as any).accepted).toBe(true);

      expect(env.diff.hasPending('edit-1')).toBe(false);
    });

    it('file/create round-trip writes new file on accept', async () => {
      (vscode.workspace.openTextDocument as any).mockResolvedValue({
        getText: () => '',
        uri: Uri.parse('rubyn-proposed://rubyn/new'),
      });

      env.gemSends('file/create', {
        editId: 'create-1',
        path: '/workspace/new.rb',
        content: 'class New\nend\n',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(env.diff.hasPending('create-1')).toBe(true);

      await env.clickAccept('create-1');

      expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({ fsPath: '/workspace/new.rb' }),
        expect.any(Uint8Array),
      );

      const sent = env.extMessages();
      const accept = sent.find((m) => m.method === 'acceptEdit');
      expect(accept).toBeDefined();
      expect((accept!.params as any).accepted).toBe(true);
    });

    it('reject path sends acceptEdit with accepted=false', async () => {
      (vscode.workspace.openTextDocument as any).mockResolvedValue({
        getText: () => 'x',
        positionAt: (o: number) => new Position(0, o),
        uri: Uri.file('/workspace/a.rb'),
        save: vi.fn(async () => true),
      });

      env.gemSends('file/edit', {
        editId: 'edit-rej',
        path: '/workspace/a.rb',
        type: 'modify',
        content: 'y',
      });
      await new Promise((r) => setTimeout(r, 50));

      await env.clickReject('edit-rej');

      const sent = env.extMessages();
      const msg = sent.find((m) => m.method === 'acceptEdit');
      expect(msg).toBeDefined();
      expect((msg!.params as any).editId).toBe('edit-rej');
      expect((msg!.params as any).accepted).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Shape sanity for tool/use and tool/result — if the gem stops sending
  // `tool` as the key (or reverts to `toolName`) or drops `requiresApproval`,
  // the webview card loses critical info. These tests pin the contract.
  // -----------------------------------------------------------------------

  describe('payload shape guards', () => {
    it('tool/use with `tool` key is handled as-is by the webview forwarder', async () => {
      // The bridge has no direct test surface for the webview forwarder,
      // but the bridge.on handler accepts the shape. If the gem switches
      // back to `toolName`, the webview falls back to `toolName` — but
      // that fallback is a safety net, not the contract. Primary contract
      // is `tool`.
      const received: unknown[] = [];
      env.bridge.on('tool/use', (params) => received.push(params));

      env.gemSends('tool/use', {
        requestId: 'r',
        tool: 'bash',
        args: { command: 'ls' },
        requiresApproval: true,
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(received).toHaveLength(1);
      expect((received[0] as any).tool).toBe('bash');
      expect((received[0] as any).requiresApproval).toBe(true);
    });

    it('file/edit with type=modify and content is handled by DiffProvider', async () => {
      (vscode.workspace.openTextDocument as any).mockResolvedValue({
        getText: () => '',
        positionAt: (o: number) => new Position(0, o),
        uri: Uri.file('/x.rb'),
        save: vi.fn(async () => true),
      });

      env.gemSends('file/edit', {
        editId: 'e1',
        path: '/x.rb',
        type: 'modify',
        content: 'z',
      });
      await new Promise((r) => setTimeout(r, 30));

      // Contract: if the payload lacks `type`, the switch in onFileEdit
      // falls through and the edit is dropped silently. This is how the
      // very first protocol break manifested. Asserting `hasPending`
      // catches any regression to a no-type payload.
      expect(env.diff.hasPending('e1')).toBe(true);
    });
  });
});
