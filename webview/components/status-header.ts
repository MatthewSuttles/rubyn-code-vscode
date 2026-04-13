import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type AgentStatus = 'idle' | 'thinking' | 'streaming' | 'done';

export interface ModelOption {
  provider: string;
  model: string;
  tier: string;
}

@customElement('status-header')
export class StatusHeader extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .left {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .right {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .logo {
      width: 18px;
      height: 18px;
      border-radius: 3px;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
      transition: background-color 250ms ease;
    }

    .status-dot.idle,
    .status-dot.done {
      background: #3fb950;
    }

    .status-dot.thinking {
      background: #d29922;
      animation: pulse-dot 1.2s ease-in-out infinite;
    }

    .status-dot.streaming {
      background: #58a6ff;
      animation: pulse-dot 0.8s ease-in-out infinite;
    }

    @keyframes pulse-dot {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }

    .model-select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 3px;
      padding: 1px 4px;
      font-size: 10px;
      font-family: inherit;
      cursor: pointer;
      max-width: 140px;
    }

    .model-select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .cost {
      font-variant-numeric: tabular-nums;
    }

    .new-session {
      background: none;
      border: 1px solid var(--vscode-button-background);
      color: var(--vscode-button-background);
      border-radius: 3px;
      padding: 1px 6px;
      font-size: 10px;
      cursor: pointer;
      font-family: inherit;
    }

    .new-session:hover {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
  `;

  @property({ type: String }) status: AgentStatus = 'idle';
  @property({ type: Number }) totalCost = 0;
  @property({ type: Number }) inputTokens = 0;
  @property({ type: Number }) outputTokens = 0;
  @property({ type: String }) logoUri = '';
  @property({ type: Array }) models: ModelOption[] = [];
  @property({ type: String }) modelMode = 'auto';
  @property({ type: String }) activeModel = '';

  override render() {
    const statusLabel =
      this.status === 'idle' || this.status === 'done'
        ? 'Ready'
        : this.status === 'thinking'
          ? 'Thinking...'
          : 'Streaming...';

    const costStr = this.totalCost > 0
      ? `$${this.totalCost.toFixed(4)}`
      : '';

    const selectedValue = this.modelMode === 'auto' ? 'auto' : this.activeModel;

    return html`
      <div class="header">
        <div class="left">
          ${this.logoUri ? html`<img class="logo" src="${this.logoUri}" alt="Rubyn" />` : ''}
          <span class="status-dot ${this.status}"></span>
          <span>Rubyn Code</span>
          <span>\u00b7 ${statusLabel}</span>
        </div>
        <div class="right">
          <select
            class="model-select"
            .value=${selectedValue}
            @change=${this._onModelChange}
            title="Select model"
          >
            <option value="auto">\u2728 Auto</option>
            ${this._renderModelOptions()}
          </select>
          ${costStr ? html`<span class="cost">${costStr}</span>` : ''}
          <button class="new-session" @click=${this._newSession} title="Start a new session">+ New</button>
        </div>
      </div>
    `;
  }

  private _renderModelOptions() {
    const byProvider = new Map<string, ModelOption[]>();
    for (const m of this.models) {
      const list = byProvider.get(m.provider) || [];
      list.push(m);
      byProvider.set(m.provider, list);
    }

    const groups = [];
    for (const [provider, providerModels] of byProvider) {
      groups.push(html`
        <optgroup label=${provider}>
          ${providerModels.map(
            (m) => html`<option value=${m.model}>${m.model} (${m.tier})</option>`,
          )}
        </optgroup>
      `);
    }
    return groups;
  }

  private _onModelChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    const value = select.value;

    this.dispatchEvent(
      new CustomEvent('model-change', {
        detail: { value, isAuto: value === 'auto' },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _newSession() {
    this.dispatchEvent(new CustomEvent('new-session', { bubbles: true, composed: true }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'status-header': StatusHeader;
  }
}
