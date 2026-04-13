/**
 * Rubyn Code — Model selector status bar item.
 *
 * Shows the active model in the status bar. Clicking opens a quick pick
 * to switch between "Auto" (task-based routing) and specific models.
 */

import * as vscode from 'vscode';
import { Bridge } from './bridge';

interface ModelInfo {
  provider: string;
  model: string;
  tier: string;
}

interface ModelsListResult {
  models: ModelInfo[];
  activeProvider: string;
  activeModel: string;
  modelMode: string;
}

export class ModelSelector implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private bridge: Bridge;
  private currentMode: string = 'auto';
  private currentModel: string = '';
  private models: ModelInfo[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(bridge: Bridge) {
    this.bridge = bridge;
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99,
    );
    this.item.command = 'rubyn-code.selectModel';
    this.render();
    this.item.show();

    // Register the command
    this.disposables.push(
      vscode.commands.registerCommand('rubyn-code.selectModel', () => this.showPicker()),
    );

    // Listen for config changes from the server
    bridge.on('config/changed', (params: Record<string, unknown> | undefined) => {
      if (!params) return;
      if (params.key === 'model_mode') {
        this.currentMode = params.value as string;
        this.render();
      } else if (params.key === 'model') {
        this.currentModel = params.value as string;
        this.render();
      }
    });
  }

  /** Fetch available models from the server and update state. */
  async refresh(): Promise<void> {
    try {
      const result = await this.bridge.request<ModelsListResult>('models/list', {});
      this.models = result.models;
      this.currentModel = result.activeModel;
      this.currentMode = result.modelMode;
      this.render();
    } catch {
      // Server may not support models/list yet
    }
  }

  private render(): void {
    if (this.currentMode === 'auto') {
      this.item.text = '$(sparkle) Auto';
      this.item.tooltip = 'Model: Auto (task-based routing)\nClick to change';
    } else {
      const shortModel = this.currentModel.replace(/^claude-/, '').replace(/^gpt-/, 'gpt-');
      this.item.text = `$(symbol-enum) ${shortModel}`;
      this.item.tooltip = `Model: ${this.currentModel}\nClick to change`;
    }
  }

  private async showPicker(): Promise<void> {
    // Build quick pick items
    const items: (vscode.QuickPickItem & { modelValue?: string; isAuto?: boolean })[] = [];

    // Auto option
    items.push({
      label: '$(sparkle) Auto',
      description: 'recommended',
      detail: 'Automatically selects the best model based on task complexity',
      isAuto: true,
    });

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

    // Group models by provider
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of this.models) {
      const list = byProvider.get(m.provider) || [];
      list.push(m);
      byProvider.set(m.provider, list);
    }

    for (const [provider, providerModels] of byProvider) {
      items.push({
        label: provider,
        kind: vscode.QuickPickItemKind.Separator,
      });

      for (const m of providerModels) {
        const isCurrent = this.currentMode === 'manual' && this.currentModel === m.model;
        items.push({
          label: `${isCurrent ? '$(check) ' : '     '}${m.model}`,
          description: m.tier,
          modelValue: m.model,
        });
      }
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a model',
      title: 'Rubyn Code \u2014 Model',
    });

    if (!picked) return;

    if ((picked as any).isAuto) {
      // Switch to auto mode
      await this.bridge.request('config/set', { key: 'model_mode', value: 'auto' });
      this.currentMode = 'auto';
    } else if ((picked as any).modelValue) {
      // Switch to manual mode with specific model
      await this.bridge.request('config/set', { key: 'model', value: (picked as any).modelValue });
      await this.bridge.request('config/set', { key: 'model_mode', value: 'manual' });
      this.currentModel = (picked as any).modelValue;
      this.currentMode = 'manual';
    }

    this.render();
  }

  dispose(): void {
    this.item.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/**
 * Create a ModelSelector, wire it to the bridge, and return it as a disposable.
 */
export function createModelSelector(bridge: Bridge): ModelSelector {
  return new ModelSelector(bridge);
}
