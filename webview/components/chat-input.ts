import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';

interface SlashCommand {
  name: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/review', description: 'Review PR against base branch' },
  { name: '/refactor', description: 'Refactor selected code' },
  { name: '/specs', description: 'Generate RSpec for active file' },
  { name: '/explain', description: 'Explain selected code' },
  { name: '/model', description: 'Open model picker' },
  { name: '/new', description: 'Start a new session' },
  { name: '/budget', description: 'Show session budget' },
];

@customElement('chat-input')
export class ChatInput extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 8px 12px 12px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      position: relative;
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

    .input-wrap {
      flex: 1;
      position: relative;
    }

    textarea {
      width: 100%;
      box-sizing: border-box;
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

    /* Slash command autocomplete */
    .slash-menu {
      position: absolute;
      bottom: 100%;
      left: 0;
      right: 0;
      margin-bottom: 4px;
      background: var(--vscode-editorWidget-background, var(--vscode-dropdown-background));
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-dropdown-border));
      border-radius: 6px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      z-index: 100;
    }

    .slash-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 12px;
      transition: background 100ms ease;
    }

    .slash-item:hover,
    .slash-item.active {
      background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
    }

    .slash-item.active {
      background: var(--vscode-list-activeSelectionBackground, var(--vscode-button-background));
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-button-foreground));
    }

    .slash-name {
      font-weight: 600;
      font-family: var(--vscode-editor-font-family, monospace);
      min-width: 70px;
    }

    .slash-desc {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }

    .slash-item.active .slash-desc {
      color: inherit;
      opacity: 0.8;
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

  @state() private _showSlashMenu = false;
  @state() private _filteredCommands: SlashCommand[] = [];
  @state() private _activeIndex = 0;

  @query('textarea')
  private _textarea!: HTMLTextAreaElement;

  override render() {
    return html`
      ${this.activeFile
        ? html`<div class="file-hint">Currently editing: <span class="filename">${this.activeFile}</span></div>`
        : nothing}
      <div class="input-row">
        <div class="input-wrap">
          ${this._showSlashMenu && this._filteredCommands.length > 0
            ? html`
                <div class="slash-menu">
                  ${this._filteredCommands.map(
                    (cmd, i) => html`
                      <div
                        class="slash-item ${i === this._activeIndex ? 'active' : ''}"
                        @click=${() => this._selectCommand(cmd)}
                        @mouseenter=${() => { this._activeIndex = i; }}
                      >
                        <span class="slash-name">${cmd.name}</span>
                        <span class="slash-desc">${cmd.description}</span>
                      </div>
                    `,
                  )}
                </div>
              `
            : nothing}
          <textarea
            rows="1"
            placeholder="Ask Rubyn anything... (type / for commands)"
            @keydown=${this._onKeydown}
            @input=${this._onInput}
          ></textarea>
        </div>
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
      this._onInput();
    }
    this._send();
  }

  private _onInput() {
    this._autoGrow();
    this._updateSlashMenu();
  }

  private _updateSlashMenu() {
    const ta = this._textarea;
    if (!ta) return;

    const text = ta.value;

    if (text.startsWith('/')) {
      const query = text.toLowerCase();
      this._filteredCommands = SLASH_COMMANDS.filter((cmd) =>
        cmd.name.startsWith(query),
      );
      this._showSlashMenu = true;
      this._activeIndex = Math.min(this._activeIndex, this._filteredCommands.length - 1);
      if (this._activeIndex < 0) this._activeIndex = 0;
    } else {
      this._showSlashMenu = false;
      this._filteredCommands = [];
    }
  }

  private _selectCommand(cmd: SlashCommand) {
    this._showSlashMenu = false;
    this._filteredCommands = [];

    this.dispatchEvent(
      new CustomEvent('slash-command', {
        detail: { command: cmd.name },
        bubbles: true,
        composed: true,
      }),
    );

    if (this._textarea) {
      this._textarea.value = '';
      this._textarea.style.height = 'auto';
    }
  }

  private _onKeydown(e: KeyboardEvent) {
    if (this._showSlashMenu && this._filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._activeIndex = (this._activeIndex + 1) % this._filteredCommands.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._activeIndex = (this._activeIndex - 1 + this._filteredCommands.length) % this._filteredCommands.length;
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        this._selectCommand(this._filteredCommands[this._activeIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this._showSlashMenu = false;
        return;
      }
    }

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
    this._showSlashMenu = false;
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
