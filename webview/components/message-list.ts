import { LitElement, html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import './chat-message';

export interface ChatMessageData {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  messageType?: 'text' | 'tool-use' | 'tool-result' | 'error';
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  requestId?: string;
  requiresApproval?: boolean;
  toolSuccess?: boolean;
  toolSummary?: string;
}

@customElement('message-list')
export class MessageList extends LitElement {
  static override styles = css`
    :host {
      display: block;
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 8px 12px 12px;
      scroll-behavior: smooth;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      padding: 24px;
    }

    .empty-logo {
      width: 48px;
      height: 48px;
      margin-bottom: 12px;
      border-radius: 8px;
    }

    .empty-title {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 4px;
      color: var(--vscode-editor-foreground);
    }

    .empty-hint {
      font-size: 12px;
      max-width: 240px;
    }

    .messages {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
  `;

  @property({ type: Array }) messages: ChatMessageData[] = [];
  @property({ type: String }) logoUri = '';

  @query('.messages')
  private _container!: HTMLElement;

  override updated(changed: Map<string, unknown>) {
    if (changed.has('messages')) {
      this._scrollToBottom();
    }
  }

  private _scrollToBottom() {
    requestAnimationFrame(() => {
      this.scrollTop = this.scrollHeight;
    });
  }

  override render() {
    if (this.messages.length === 0) {
      return html`
        <div class="empty-state">
          ${this.logoUri
            ? html`<img class="empty-logo" src="${this.logoUri}" alt="Rubyn" />`
            : html`<div class="empty-logo" style="font-size:32px;">💎</div>`}
          <div class="empty-title">Rubyn Code</div>
          <div class="empty-hint">Ask a question or use the quick actions above to get started.</div>
        </div>
      `;
    }

    return html`
      <div class="messages">
        ${this.messages.map(
          (msg) => html`
            <chat-message
              .role=${msg.role}
              .content=${msg.content}
              .streaming=${msg.streaming ?? false}
              .messageType=${msg.messageType ?? 'text'}
              .toolName=${msg.toolName ?? ''}
              .toolArgs=${msg.toolArgs ?? {}}
              .requestId=${msg.requestId ?? ''}
              .requiresApproval=${msg.requiresApproval ?? false}
              .toolSuccess=${msg.toolSuccess ?? false}
              .toolSummary=${msg.toolSummary ?? ''}
              @tool-approval=${(e: CustomEvent) => this._forwardApproval(e)}
            ></chat-message>
          `,
        )}
      </div>
    `;
  }

  private _forwardApproval(e: CustomEvent) {
    this.dispatchEvent(
      new CustomEvent('tool-approval', {
        detail: e.detail,
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'message-list': MessageList;
  }
}
