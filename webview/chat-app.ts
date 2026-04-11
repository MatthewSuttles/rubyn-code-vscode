/**
 * Rubyn Code — Lit-based chat webview entry point.
 *
 * Mounts <chat-app> to #root, manages state, and bridges VS Code messages.
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';

import './styles/theme.css';
import './components/status-header';
import './components/quick-actions';
import './components/message-list';
import './components/chat-input';

import type { AgentStatus } from './components/status-header';
import type { ChatMessageData } from './components/message-list';
import type { ChatInput } from './components/chat-input';

/* ------------------------------------------------------------------ */
/*  VS Code API type                                                  */
/* ------------------------------------------------------------------ */

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/* ------------------------------------------------------------------ */
/*  State                                                             */
/* ------------------------------------------------------------------ */

interface AppState {
  messages: ChatMessageData[];
  sessionId: string;
  agentStatus: AgentStatus;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  activeFile: string;
  activeLanguage: string;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

@customElement('chat-app')
export class ChatApp extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }

    message-list {
      flex: 1;
      min-height: 0;
    }
  `;

  private vscode!: VsCodeApi;

  @state() private messages: ChatMessageData[] = [];
  @state() private sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  @state() private agentStatus: AgentStatus = 'idle';
  @state() private totalCost = 0;
  @state() private inputTokens = 0;
  @state() private outputTokens = 0;
  @state() private activeFile = '';
  @state() private activeLanguage = '';

  @property({ type: String }) logoUri = '';

  /** ID counter for messages. */
  private _nextId = 1;

  /** Index of current streaming assistant message (or -1). */
  private _streamingIdx = -1;

  @query('chat-input')
  private _chatInput!: ChatInput;

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                       */
  /* ---------------------------------------------------------------- */

  override connectedCallback() {
    super.connectedCallback();
    this.vscode = acquireVsCodeApi();

    // Restore persisted state if available.
    const saved = this.vscode.getState() as AppState | null;
    if (saved) {
      this.messages = saved.messages;
      this.sessionId = saved.sessionId;
      this.totalCost = saved.totalCost;
      this.inputTokens = saved.inputTokens;
      this.outputTokens = saved.outputTokens;
      this.activeFile = saved.activeFile ?? '';
      this.activeLanguage = saved.activeLanguage ?? '';
      this._nextId = this.messages.length + 1;
    }

    window.addEventListener('message', this._onMessage);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('message', this._onMessage);
  }

  override updated() {
    // Persist state on every change.
    this.vscode.setState({
      messages: this.messages,
      sessionId: this.sessionId,
      agentStatus: this.agentStatus,
      totalCost: this.totalCost,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      activeFile: this.activeFile,
      activeLanguage: this.activeLanguage,
    } satisfies AppState);
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */

  override render() {
    const isStreaming = this.agentStatus === 'streaming' || this.agentStatus === 'thinking';

    return html`
      <status-header
        .status=${this.agentStatus}
        .totalCost=${this.totalCost}
        .inputTokens=${this.inputTokens}
        .outputTokens=${this.outputTokens}
        .logoUri=${this.logoUri}
        @new-session=${this._onNewSession}
      ></status-header>

      <quick-actions
        ?disabled=${isStreaming}
        @quick-action=${this._onQuickAction}
      ></quick-actions>

      <message-list
        .messages=${this.messages}
        .logoUri=${this.logoUri}
        @tool-approval=${this._onToolApproval}
      ></message-list>

      <chat-input
        ?streaming=${isStreaming}
        .activeFile=${this.activeFile}
        @send-prompt=${this._onSendPrompt}
        @cancel-prompt=${this._onCancel}
      ></chat-input>
    `;
  }

  /* ---------------------------------------------------------------- */
  /*  Event handlers (from child components)                          */
  /* ---------------------------------------------------------------- */

  private _onSendPrompt(e: CustomEvent<{ text: string }>) {
    const text = e.detail.text;
    this._addUserMessage(text);
    this.vscode.postMessage({
      type: 'sendPrompt',
      payload: { text, sessionId: this.sessionId },
    });
  }

  private _onQuickAction(e: CustomEvent<{ prompt: string }>) {
    const text = e.detail.prompt;
    this._addUserMessage(text);
    this.vscode.postMessage({
      type: 'sendPrompt',
      payload: { text, sessionId: this.sessionId },
    });
  }

  private _onCancel() {
    this.vscode.postMessage({ type: 'cancel' });
  }

  private _onNewSession() {
    this.messages = [];
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.totalCost = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.agentStatus = 'idle';
    this._streamingIdx = -1;
  }

  private _onToolApproval(e: CustomEvent<{ requestId: string; approved: boolean }>) {
    this.vscode.postMessage({
      type: 'approveToolUse',
      payload: e.detail,
    });
  }

  /* ---------------------------------------------------------------- */
  /*  VS Code message handler                                         */
  /* ---------------------------------------------------------------- */

  private _onMessage = (event: MessageEvent) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'stream/text':
        this._handleStreamText(msg.payload);
        break;

      case 'tool/use':
        this._handleToolUse(msg.payload);
        break;

      case 'tool/result':
        this._handleToolResult(msg.payload);
        break;

      case 'agent/status':
        this._handleAgentStatus(msg.payload);
        break;

      case 'session/cost':
        this._handleSessionCost(msg.payload);
        break;

      case 'context/update':
        this._handleContextUpdate(msg.payload);
        break;

      case 'error':
        this._handleError(msg.payload);
        break;

      case 'webview/restored':
        // State already restored from getState().
        break;
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Message processing                                              */
  /* ---------------------------------------------------------------- */

  private _addUserMessage(text: string) {
    const msg: ChatMessageData = {
      id: `msg_${this._nextId++}`,
      role: 'user',
      content: text,
      messageType: 'text',
    };
    this.messages = [...this.messages, msg];
  }

  private _handleStreamText(payload: {
    text?: string;
    delta?: string;
    final?: boolean;
    done?: boolean;
    sessionId?: string;
  }) {
    if (!payload) return;

    const isFinal = payload.final || payload.done;

    if (this._streamingIdx === -1) {
      // Start a new assistant message.
      const msg: ChatMessageData = {
        id: `msg_${this._nextId++}`,
        role: 'assistant',
        content: '',
        streaming: true,
        messageType: 'text',
      };
      this.messages = [...this.messages, msg];
      this._streamingIdx = this.messages.length - 1;
    }

    const updated = [...this.messages];
    const current = { ...updated[this._streamingIdx] };

    if (isFinal) {
      // Final message: just stop streaming, keep the content we already accumulated.
      // Don't replace with payload.text since that would duplicate what we already streamed.
      current.streaming = false;
      this._streamingIdx = -1;
    } else {
      // Partial: append the text chunk.
      const chunk = payload.delta || payload.text || '';
      if (chunk) {
        current.content += chunk;
      }
    }

    updated[this._streamingIdx !== -1 ? this._streamingIdx : updated.length - 1] = current;
    this.messages = updated;
  }

  private _handleToolUse(payload: {
    tool?: string;
    requestId?: string;
    args?: Record<string, unknown>;
    requiresApproval?: boolean;
  }) {
    if (!payload) return;

    // End any active stream.
    this._finalizeStreaming();

    const msg: ChatMessageData = {
      id: `msg_${this._nextId++}`,
      role: 'assistant',
      content: '',
      messageType: 'tool-use',
      toolName: payload.tool ?? 'unknown',
      toolArgs: payload.args ?? {},
      requestId: payload.requestId ?? '',
      requiresApproval: payload.requiresApproval ?? false,
    };
    this.messages = [...this.messages, msg];
  }

  private _handleToolResult(payload: {
    tool?: string;
    requestId?: string;
    success?: boolean;
    summary?: string;
  }) {
    if (!payload) return;

    const msg: ChatMessageData = {
      id: `msg_${this._nextId++}`,
      role: 'assistant',
      content: '',
      messageType: 'tool-result',
      toolName: payload.tool ?? '',
      toolSuccess: payload.success ?? true,
      toolSummary: payload.summary ?? '',
    };
    this.messages = [...this.messages, msg];
  }

  private _handleAgentStatus(payload: { status?: string; sessionId?: string }) {
    if (!payload) return;

    const status = payload.status as AgentStatus;
    this.agentStatus = status;

    if (status === 'done') {
      this._finalizeStreaming();
      // Reset to idle after a short delay.
      setTimeout(() => {
        this.agentStatus = 'idle';
      }, 300);
    }
  }

  private _handleSessionCost(payload: {
    totalCost?: number;
    inputTokens?: number;
    outputTokens?: number;
  }) {
    if (!payload) return;
    if (payload.totalCost !== undefined) this.totalCost = payload.totalCost;
    if (payload.inputTokens !== undefined) this.inputTokens = payload.inputTokens;
    if (payload.outputTokens !== undefined) this.outputTokens = payload.outputTokens;
  }

  private _handleContextUpdate(payload: {
    activeFile?: string;
    language?: string;
  }) {
    if (!payload) return;
    if (payload.activeFile !== undefined) this.activeFile = payload.activeFile;
    if (payload.language !== undefined) this.activeLanguage = payload.language;
  }

  private _handleError(payload: { message?: string }) {
    if (!payload) return;

    this._finalizeStreaming();

    const msg: ChatMessageData = {
      id: `msg_${this._nextId++}`,
      role: 'assistant',
      content: payload.message ?? 'An unknown error occurred.',
      messageType: 'error',
    };
    this.messages = [...this.messages, msg];
  }

  private _finalizeStreaming() {
    if (this._streamingIdx !== -1) {
      const updated = [...this.messages];
      updated[this._streamingIdx] = {
        ...updated[this._streamingIdx],
        streaming: false,
      };
      this.messages = updated;
      this._streamingIdx = -1;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-app': ChatApp;
  }
}
