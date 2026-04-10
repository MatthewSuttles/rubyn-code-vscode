import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';

@customElement('chat-input')
export class ChatInput extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 8px 12px 12px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }

    .file-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 0 2px;
    }

    .file-hint .filename {
      color: var(--vscode-textLink-foreground);
      font-family: var(--vscode-editor-font-family, monospace);
    }

    .input-row {
      display: flex;
      gap: 6px;
      align-items: flex-end;
    }

    textarea {
      flex: 1;
      min-height: 28px;
      max-height: 160px;
      padding: 6px 10px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      font-family: inherit;
      font-size: 13px;
      line-height: 1.4;
      resize: none;
      overflow-y: auto;
      outline: none;
      transition: border-color 200ms ease;
    }

    textarea::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    textarea:focus {
      border-color: var(--vscode-focusBorder);
    }

    .btn-send,
    .btn-cancel {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 28px;
      padding: 0 12px;
      border: none;
      border-radius: 6px;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 200ms ease, background-color 200ms ease;
      white-space: nowrap;
    }

    .btn-send {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .btn-send:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }

    .btn-send:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .btn-cancel {
      background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
      border: 1px solid var(--vscode-panel-border);
    }

    .btn-cancel:hover {
      opacity: 0.85;
    }
  `;

  @property({ type: Boolean }) streaming = false;
  @property({ type: String }) activeFile = '';

  @query('textarea')
  private _textarea!: HTMLTextAreaElement;

  override render() {
    return html`
      ${this.activeFile
        ? html`<div class="file-hint">Currently editing: <span class="filename">${this.activeFile}</span></div>`
        : nothing}
      <div class="input-row">
        <textarea
          rows="1"
          placeholder="Ask Rubyn anything..."
          @keydown=${this._onKeydown}
          @input=${this._autoGrow}
        ></textarea>
        ${this.streaming
          ? html`<button class="btn-cancel" @click=${this._cancel}>Cancel</button>`
          : html`<button class="btn-send" ?disabled=${false} @click=${this._send}>\u2191 Send</button>`}
      </div>
    `;
  }

  /** Focus the textarea. */
  focus() {
    this._textarea?.focus();
  }

  /** Programmatically set input text and send. */
  sendText(text: string) {
    if (this._textarea) {
      this._textarea.value = text;
      this._autoGrow();
    }
    this._send();
  }

  private _onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._send();
    }
  }

  private _autoGrow() {
    const ta = this._textarea;
    if (!ta) return;
    ta.style.height = 'auto';
    const maxH = 160; // 8 rows approx
    ta.style.height = `${Math.min(ta.scrollHeight, maxH)}px`;
  }

  private _send() {
    const ta = this._textarea;
    if (!ta) return;
    const text = ta.value.trim();
    if (!text || this.streaming) return;

    this.dispatchEvent(
      new CustomEvent('send-prompt', {
        detail: { text },
        bubbles: true,
        composed: true,
      }),
    );

    ta.value = '';
    ta.style.height = 'auto';
  }

  private _cancel() {
    this.dispatchEvent(
      new CustomEvent('cancel-prompt', {
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-input': ChatInput;
  }
}
