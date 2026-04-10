/**
 * Rubyn Code — Webview provider for the sidebar chat panel.
 *
 * Implements VS Code's WebviewViewProvider to render a React-based chat UI
 * inside the `rubyn-code.chat` view. Bridges messages between the webview
 * and the Rubyn Code CLI process via the Bridge instance.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { Bridge } from './bridge';

/** Messages the webview can send to the extension host. */
interface WebviewToExtension {
  type: 'sendPrompt' | 'approveToolUse' | 'cancel';
  payload?: Record<string, unknown>;
}

/** Notification methods forwarded from bridge to webview. */
const FORWARDED_NOTIFICATIONS = [
  'stream/text',
  'stream/codeBlock',
  'tool/use',
  'tool/result',
  'agent/status',
  'session/cost',
] as const;

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'rubyn-code.chat';

  private view?: vscode.WebviewView;
  private readonly extensionUri: vscode.Uri;
  private readonly bridge: Bridge;
  private readonly disposables: vscode.Disposable[] = [];

  /** Notification handlers registered on the bridge; stored so we can remove them. */
  private readonly bridgeListeners: Array<{
    method: string;
    handler: (params: Record<string, unknown> | undefined) => void;
  }> = [];

  constructor(extensionUri: vscode.Uri, bridge: Bridge) {
    this.extensionUri = extensionUri;
    this.bridge = bridge;
  }

  // ---------------------------------------------------------------------------
  // WebviewViewProvider
  // ---------------------------------------------------------------------------

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'webview'),
      ],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // Listen for messages from the webview.
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewToExtension) => this.handleWebviewMessage(message),
      undefined,
      this.disposables,
    );

    // Forward bridge notifications to the webview.
    this.registerBridgeForwarding();

    // Cleanup on dispose.
    webviewView.onDidDispose(() => this.onDispose(), undefined, this.disposables);

    // Re-post current state when the webview becomes visible again.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postMessage({ type: 'webview/restored' });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Public helpers
  // ---------------------------------------------------------------------------

  /** Post a message to the webview (if it exists and is visible). */
  postMessage(message: Record<string, unknown>): void {
    this.view?.webview.postMessage(message);
  }

  // ---------------------------------------------------------------------------
  // Webview -> Extension message handling
  // ---------------------------------------------------------------------------

  private handleWebviewMessage(message: WebviewToExtension): void {
    switch (message.type) {
      case 'sendPrompt': {
        const { text, sessionId, context } = (message.payload ?? {}) as Record<string, unknown>;
        this.bridge.request('prompt', {
          text: text as string,
          sessionId: (sessionId as string) || this.generateSessionId(),
          context: context ?? this.gatherPromptContext(),
        }).catch((err: Error) => {
          this.postMessage({
            type: 'error',
            payload: { message: err.message },
          });
        });
        break;
      }

      case 'approveToolUse': {
        const { requestId, approved } = (message.payload ?? {}) as Record<string, unknown>;
        this.bridge.notify('tool/approve', {
          requestId: requestId as string,
          approved: approved as boolean,
        });
        break;
      }

      case 'cancel': {
        this.bridge.notify('cancel', {});
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Bridge -> Webview notification forwarding
  // ---------------------------------------------------------------------------

  private registerBridgeForwarding(): void {
    for (const method of FORWARDED_NOTIFICATIONS) {
      const handler = (params: Record<string, unknown> | undefined) => {
        this.postMessage({ type: method, payload: params ?? {} });
      };
      this.bridge.on(method, handler);
      this.bridgeListeners.push({ method, handler });
    }
  }

  private unregisterBridgeForwarding(): void {
    for (const { method, handler } of this.bridgeListeners) {
      this.bridge.off(method, handler);
    }
    this.bridgeListeners.length = 0;
  }

  // ---------------------------------------------------------------------------
  // HTML generation
  // ---------------------------------------------------------------------------

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = this.getUri(webview, 'dist', 'webview.js');
    const styleUri = this.getUri(webview, 'dist', 'webview.css');
    const nonce = this.getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';
             font-src ${webview.cspSource};
             img-src ${webview.cspSource} data:;"
  />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Rubyn Code</title>
  <style>
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .chat-container { display: flex; flex-direction: column; height: 100vh; }
    .messages { flex: 1; overflow-y: auto; padding: 12px; }
    .input-area { padding: 12px; border-top: 1px solid var(--vscode-panel-border); display: flex; gap: 8px; }
    .input-area textarea { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 8px; resize: none; font-family: inherit; font-size: 13px; }
    .input-area button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 8px 16px; cursor: pointer; font-size: 13px; }
    .input-area button:hover { background: var(--vscode-button-hoverBackground); }
    .message { margin-bottom: 12px; padding: 8px 12px; border-radius: 6px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
    .message.user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); margin-left: 40px; }
    .message.assistant { background: var(--vscode-editor-inactiveSelectionBackground); margin-right: 40px; }
    .status { padding: 8px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); text-align: center; }
  </style>
</head>
<body>
  <div class="chat-container">
    <div class="status">Rubyn Code v0.1.0 — connected</div>
    <div class="messages" id="messages"></div>
    <div class="input-area">
      <textarea id="input" rows="3" placeholder="Ask Rubyn anything..."></textarea>
      <button id="send">Send</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    let currentAssistant = null;
    let sessionId = 'session_' + Date.now();

    function addMessage(role, text) {
      const div = document.createElement('div');
      div.className = 'message ' + role;
      div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      addMessage('user', text);
      inputEl.value = '';
      currentAssistant = addMessage('assistant', '');
      vscode.postMessage({ type: 'sendPrompt', payload: { text: text, sessionId: sessionId } });
    }

    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (msg.type === 'stream/text' && msg.payload) {
        if (!currentAssistant) {
          currentAssistant = addMessage('assistant', '');
        }
        var txt = msg.payload.delta || msg.payload.text || '';
        if (!msg.payload.final && !msg.payload.done) {
          currentAssistant.textContent += txt;
        } else {
          currentAssistant.textContent = txt;
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
        if (msg.payload.done || msg.payload.final) {
          currentAssistant = null;
        }
      } else if (msg.type === 'tool/use' && msg.payload) {
        addMessage('assistant', '🔧 Using tool: ' + msg.payload.tool);
      } else if (msg.type === 'tool/result' && msg.payload) {
        addMessage('assistant', (msg.payload.success ? '✅' : '❌') + ' ' + msg.payload.summary);
      } else if (msg.type === 'error' && msg.payload) {
        addMessage('assistant', '⚠️ Error: ' + msg.payload.message);
      }
    });
  </script>
</body>
</html>`;
  }

  /** Build a webview-safe URI for a file relative to the extension root. */
  private getUri(webview: vscode.Webview, ...pathSegments: string[]): vscode.Uri {
    return webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, ...pathSegments),
    );
  }

  /** Generate a cryptographic nonce for the CSP script-src. */
  private getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
      nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
  }

  // ---------------------------------------------------------------------------
  // Context helpers
  // ---------------------------------------------------------------------------

  private gatherPromptContext(): Record<string, unknown> {
    const editor = vscode.window.activeTextEditor;
    const ctx: Record<string, unknown> = {
      workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
    };

    if (editor) {
      ctx.activeFile = editor.document.uri.fsPath;
      ctx.language = editor.document.languageId;
      ctx.cursorLine = editor.selection.active.line;

      if (!editor.selection.isEmpty) {
        ctx.selection = {
          startLine: editor.selection.start.line,
          endLine: editor.selection.end.line,
          text: editor.document.getText(editor.selection),
        };
      }
    }

    ctx.openFiles = vscode.window.visibleTextEditors.map((e) => e.document.uri.fsPath);

    return ctx;
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  private onDispose(): void {
    this.unregisterBridgeForwarding();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.view = undefined;
  }

  dispose(): void {
    this.onDispose();
  }
}
