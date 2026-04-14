/**
 * Rubyn Code VS Code extension — activation and lifecycle.
 */

import * as vscode from 'vscode';
import { Bridge } from './bridge';
import { ProcessManager } from './process-manager';
import { ContextProvider } from './context-provider';
import { createStatusBar } from './status-bar';
import { createModelSelector } from './model-selector';
import { ChatWebviewProvider } from './webview-provider';
import { DiffProvider } from './diff-provider';
import { InitializeParams, InitializeResult, ConfigGetAllResult } from './types';

// ---------------------------------------------------------------------------
// Module-level state (accessible from both activate and deactivate)
// ---------------------------------------------------------------------------

let bridge: Bridge | undefined;
let processManager: ProcessManager | undefined;
let contextProvider: ContextProvider | undefined;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // 1. Create output channel.
  const outputChannel = vscode.window.createOutputChannel('Rubyn Code');
  outputChannel.appendLine('Rubyn Code extension activating...');
  outputChannel.show(true); // Force the output panel to show on activation
  console.log('[Rubyn Code] Extension activate() called');
  vscode.window.showInformationMessage('Rubyn Code is starting...');
  context.subscriptions.push(outputChannel);

  // 2. Create ProcessManager and spawn the CLI process.
  processManager = new ProcessManager(outputChannel);
  context.subscriptions.push(processManager);

  let child;
  try {
    child = processManager.spawn();
  } catch {
    // Error already surfaced to user by ProcessManager.
    return;
  }

  // 3. Create Bridge connected to the process stdio.
  if (!child.stdin || !child.stdout) {
    outputChannel.appendLine('ERROR: Failed to get stdio streams from child process');
    vscode.window.showErrorMessage('Failed to start Rubyn Code: could not connect to process.');
    return;
  }

  bridge = new Bridge(child.stdin, child.stdout);
  processManager.setBridge(bridge);
  context.subscriptions.push({ dispose: () => bridge?.dispose() });

  bridge.on('error', (err: Error) => {
    outputChannel.appendLine(`[bridge error] ${err.message}`);
  });

  bridge.on('close', () => {
    outputChannel.appendLine('[bridge] Connection closed');
  });

  bridge.on('config/changed', (params: Record<string, unknown> | undefined) => {
    if (!params) return;
    const serverToVscode: Record<string, string> = {
      'provider': 'rubyn-code.provider',
      'model': 'rubyn-code.model',
      'session_budget_usd': 'rubyn-code.sessionBudget',
      'daily_budget_usd': 'rubyn-code.dailyBudget',
      'max_iterations': 'rubyn-code.maxIterations',
      'context_threshold_tokens': 'rubyn-code.contextThreshold',
    };
    const key = params.key as string;
    const value = params.value;
    const vsKey = serverToVscode[key];
    if (vsKey) {
      const [section, prop] = [vsKey.split('.')[0], vsKey.split('.')[1]];
      vscode.workspace.getConfiguration(section).update(prop, value, vscode.ConfigurationTarget.Global);
    }
  });

  // 4. Send initialize request.
  const workspacePath =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const extensionVersion =
    vscode.extensions.getExtension('rubyn.rubyn-code')?.packageJSON?.version ??
    '0.1.0';

  try {
    const initResult = await bridge.request<InitializeResult>('initialize', {
      workspacePath,
      extensionVersion,
      capabilities: {
        inlineDiff: true,
        streaming: true,
      },
    } as InitializeParams as unknown as Record<string, unknown>);

    outputChannel.appendLine(
      `Server initialized: v${initResult.serverVersion} ` +
        `(${initResult.capabilities.tools} tools, ${initResult.capabilities.skills} skills)`,
    );
  } catch (err) {
    outputChannel.appendLine(
      `Initialize failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Continue anyway — some commands may still work.
  }

  // 4b. Sync server config to VS Code settings.
  try {
    const serverConfig = await bridge.request<ConfigGetAllResult>('config/get', {});
    syncServerConfigToVscode(serverConfig);
    const provider = serverConfig.settings['provider']?.value ?? 'unknown';
    const model = serverConfig.settings['model']?.value ?? 'unknown';
    const mode = serverConfig.settings['model_mode']?.value ?? 'auto';
    outputChannel.appendLine(`Config synced: provider=${provider} model=${model} mode=${mode}`);
  } catch {
    outputChannel.appendLine('Config sync skipped — server does not support config/get.');
  }

  // 5. Create ContextProvider.
  contextProvider = new ContextProvider();
  context.subscriptions.push(contextProvider);

  // 5a. Register the diff provider. This owns the `file/edit` / `file/create`
  // notification handlers, opens the diff/preview view, and surfaces the
  // Accept / Reject CodeLens at the top of the proposed document. Without
  // this the gem's edit notifications have no subscriber — it times out
  // after 60s and auto-denies the edit with no UI prompt ever shown.
  const diffProvider = new DiffProvider(bridge);
  context.subscriptions.push(diffProvider);

  // 5b. Register the chat webview provider.
  const chatProvider = new ChatWebviewProvider(context.extensionUri, bridge);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatWebviewProvider.viewType,
      chatProvider,
    ),
  );
  context.subscriptions.push(chatProvider);

  // 5c. Forward model/config changes to the webview dropdown.
  bridge.on('config/changed', (params: Record<string, unknown> | undefined) => {
    if (!params) return;
    const key = params.key as string;
    if (key === 'model' || key === 'model_mode' || key === 'provider') {
      chatProvider.postMessage({
        type: 'models/update',
        payload: { [key === 'model' ? 'activeModel' : key === 'provider' ? 'activeProvider' : 'modelMode']: params.value },
      });
      outputChannel.appendLine(`[config] ${key} changed to: ${params.value}`);
    }
  });

  // 5d. Fetch available models and send to the webview.
  try {
    const modelsResult = await bridge.request<Record<string, unknown>>('models/list', {});
    chatProvider.postMessage({ type: 'models/update', payload: modelsResult });
    const modelsList = (modelsResult.models as Array<{ provider: string; model: string }>) ?? [];
    outputChannel.appendLine(`Models loaded: ${modelsList.length} models from ${new Set(modelsList.map(m => m.provider)).size} providers`);
    modelsList.forEach(m => outputChannel.appendLine(`  ${m.provider}: ${m.model}`));
  } catch {
    outputChannel.appendLine('Models list skipped — server does not support models/list.');
  }

  // 5d. Forward active editor context to the webview.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.uri.scheme === 'file') {
        const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
        chatProvider.postMessage({
          type: 'context/update',
          payload: { activeFile: relativePath, language: editor.document.languageId },
        });
      }
    }),
  );

  // Send initial active file context.
  if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file') {
    const editor = vscode.window.activeTextEditor;
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
    chatProvider.postMessage({
      type: 'context/update',
      payload: { activeFile: relativePath, language: editor.document.languageId },
    });
  }

  // 5d. Push VS Code setting changes to the server.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!bridge) return;
      const configMap: Record<string, string> = {
        'rubyn-code.provider': 'provider',
        'rubyn-code.model': 'model',
        'rubyn-code.sessionBudget': 'session_budget_usd',
        'rubyn-code.dailyBudget': 'daily_budget_usd',
        'rubyn-code.maxIterations': 'max_iterations',
        'rubyn-code.contextThreshold': 'context_threshold_tokens',
      };
      for (const [vsKey, serverKey] of Object.entries(configMap)) {
        if (e.affectsConfiguration(vsKey)) {
          const value = vscode.workspace.getConfiguration('rubyn-code').get(vsKey.split('.')[1]);
          bridge.request('config/set', { key: serverKey, value }).catch((err: Error) => {
            outputChannel.appendLine(`Config sync failed for ${serverKey}: ${err.message}`);
          });
        }
      }
    }),
  );

  // 6. Register commands.

  // rubyn-code.openChat — focus the chat webview panel.
  context.subscriptions.push(
    vscode.commands.registerCommand('rubyn-code.openChat', () => {
      vscode.commands.executeCommand('rubyn-code.chat.focus');
    }),
  );

  // rubyn-code.reviewPR — send review request with git base branch.
  context.subscriptions.push(
    vscode.commands.registerCommand('rubyn-code.reviewPR', async () => {
      if (!bridge) {
        vscode.window.showErrorMessage('Rubyn Code is not running.');
        return;
      }

      const baseBranch = await vscode.window.showInputBox({
        prompt: 'Base branch for PR review',
        value: 'main',
        placeHolder: 'main',
      });

      if (baseBranch === undefined) {
        return; // Cancelled.
      }

      try {
        await bridge.request('review', {
          baseBranch,
          focus: 'all',
        });
      } catch (err) {
        vscode.window.showErrorMessage(
          `PR review failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  // The three "smart command" shortcuts below all route through the chat
  // webview rather than calling bridge.request directly. That way the
  // prompt appears as a user bubble in the active chat AND uses the
  // webview's sessionId, so the gem treats it as a follow-up turn on the
  // current conversation — not a fresh session every click.
  const runChatCommand = async (
    commandName: string,
    promptText: string,
    failMessage: string,
    requireSelection = true,
  ): Promise<void> => {
    if (!contextProvider) {
      vscode.window.showErrorMessage('Rubyn Code is not running.');
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || (requireSelection && editor.selection.isEmpty)) {
      vscode.window.showWarningMessage(failMessage);
      return;
    }
    try {
      const { prompt, context: ctx } = await contextProvider.enrichPrompt(commandName, promptText);
      await chatProvider.sendExternalPrompt(prompt, ctx as unknown as Record<string, unknown>);
    } catch (err) {
      vscode.window.showErrorMessage(
        `${commandName} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // rubyn-code.refactorSelection — refactor selected code.
  context.subscriptions.push(
    vscode.commands.registerCommand('rubyn-code.refactorSelection', () =>
      runChatCommand(
        'refactorSelection',
        'Refactor this code. Improve readability, reduce duplication, and follow Ruby/Rails best practices.',
        'Select some code first, then run Refactor Selection.',
      ),
    ),
  );

  // rubyn-code.generateSpecs — generate specs for the active file.
  context.subscriptions.push(
    vscode.commands.registerCommand('rubyn-code.generateSpecs', () =>
      runChatCommand(
        'generateSpecs',
        'Write specs for this file. Provide thorough test coverage with edge cases.',
        'Open a file first, then run Generate Specs.',
        false,
      ),
    ),
  );

  // rubyn-code.explainCode — explain selected code.
  context.subscriptions.push(
    vscode.commands.registerCommand('rubyn-code.explainCode', () =>
      runChatCommand(
        'explainCode',
        'Explain this code. Describe what it does, why, and any notable patterns or potential issues.',
        'Select some code first, then run Explain Code.',
      ),
    ),
  );

  // 7. Register status bar.
  try {
    const statusBarDisposable = createStatusBar(bridge);
    context.subscriptions.push(statusBarDisposable);
  } catch {
    // Status bar module may not be available yet (being built by another agent).
    outputChannel.appendLine(
      'Status bar module not available — skipping status bar registration.',
    );
  }

  // 8. Register model selector.
  try {
    const modelSelector = createModelSelector(bridge);
    await modelSelector.refresh();
    context.subscriptions.push(modelSelector);
  } catch {
    outputChannel.appendLine('Model selector not available — skipping.');
  }

  outputChannel.appendLine('Rubyn Code extension activated.');
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function syncServerConfigToVscode(serverConfig: ConfigGetAllResult): void {
  const config = vscode.workspace.getConfiguration('rubyn-code');
  const mapping: Record<string, string> = {
    'provider': 'provider',
    'model': 'model',
    'session_budget_usd': 'sessionBudget',
    'daily_budget_usd': 'dailyBudget',
    'max_iterations': 'maxIterations',
    'context_threshold_tokens': 'contextThreshold',
  };
  for (const [serverKey, vscodeProp] of Object.entries(mapping)) {
    const entry = serverConfig.settings[serverKey];
    if (entry && entry.value !== undefined) {
      config.update(vscodeProp, entry.value, vscode.ConfigurationTarget.Global);
    }
  }
}

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------

export async function deactivate(): Promise<void> {
  if (bridge) {
    try {
      await bridge.request('shutdown', undefined, 3_000);
    } catch {
      // Best effort.
    }
    bridge.dispose();
    bridge = undefined;
  }

  if (processManager) {
    await processManager.kill();
    processManager = undefined;
  }

  if (contextProvider) {
    contextProvider.dispose();
    contextProvider = undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random session ID for prompt requests. */
function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `session_${timestamp}_${random}`;
}
