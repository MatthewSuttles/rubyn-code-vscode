import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

type MessageRole = 'user' | 'assistant';

/* ------------------------------------------------------------------ */
/*  Lightweight Markdown renderer                                     */
/* ------------------------------------------------------------------ */

/** Basic keyword sets for syntax highlighting. */
const KEYWORDS: Record<string, Set<string>> = {
  ruby: new Set([
    'def','end','class','module','do','if','else','elsif','unless','while','until',
    'for','in','return','yield','begin','rescue','ensure','raise','require','include',
    'extend','attr_accessor','attr_reader','attr_writer','self','nil','true','false',
    'and','or','not','then','puts','print','private','protected','public','super','new',
  ]),
  js: new Set([
    'const','let','var','function','return','if','else','for','while','do','switch',
    'case','break','continue','class','extends','import','export','from','default',
    'async','await','new','this','try','catch','finally','throw','typeof','instanceof',
    'true','false','null','undefined','yield','of','in',
  ]),
  sql: new Set([
    'SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE','CREATE',
    'TABLE','ALTER','DROP','INDEX','JOIN','LEFT','RIGHT','INNER','OUTER','ON','AND',
    'OR','NOT','NULL','IS','IN','LIKE','ORDER','BY','GROUP','HAVING','LIMIT','OFFSET',
    'AS','DISTINCT','COUNT','SUM','AVG','MIN','MAX','BETWEEN','EXISTS','UNION','ALL',
    'select','from','where','insert','into','values','update','set','delete','create',
    'table','alter','drop','index','join','left','right','inner','outer','on','and',
    'or','not','null','is','in','like','order','by','group','having','limit','offset',
  ]),
  shell: new Set([
    'if','then','else','elif','fi','for','do','done','while','until','case','esac',
    'function','return','exit','echo','cd','ls','grep','sed','awk','cat','rm','mv',
    'cp','mkdir','chmod','chown','export','source','alias','sudo','apt','brew','npm',
    'yarn','git','docker','bundle','rake','rails',
  ]),
  yaml: new Set([
    'true','false','null','yes','no','on','off',
  ]),
};

function langKeywords(lang: string): Set<string> | undefined {
  const l = lang.toLowerCase();
  if (l === 'ruby' || l === 'rb') return KEYWORDS.ruby;
  if (l === 'javascript' || l === 'js' || l === 'typescript' || l === 'ts' || l === 'jsx' || l === 'tsx') return KEYWORDS.js;
  if (l === 'sql') return KEYWORDS.sql;
  if (l === 'bash' || l === 'sh' || l === 'shell' || l === 'zsh') return KEYWORDS.shell;
  if (l === 'yaml' || l === 'yml') return KEYWORDS.yaml;
  return undefined;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightCode(code: string, lang: string): string {
  const kw = langKeywords(lang);
  const escaped = escapeHtml(code);
  if (!kw) return escaped;

  // Tokenize comments and strings first, replacing them with placeholders so
  // the subsequent keyword/number regex only runs on plain text. Without this,
  // a keyword like `class` would match inside the attribute of an already-
  // inserted `<span class="hl-cmt">`, mangling the HTML into something like
  // `<span <span class="hl-kw">class</span>="hl-cmt">`, and browsers would
  // render the leftover `="hl-cmt">` as literal text.
  const tokens: string[] = [];
  const stash = (html: string): string => {
    const idx = tokens.length;
    tokens.push(html);
    return `\u0000T${idx}\u0000`;
  };

  let result = escaped;

  // Strings (quoted single/double/backtick).
  result = result.replace(/(["'`])(?:(?=(\\?))\2.)*?\1/g, (m) =>
    stash(`<span class="hl-str">${m}</span>`),
  );

  // Comments — syntax varies by language.
  const l = lang.toLowerCase();
  if (['ruby', 'rb', 'bash', 'sh', 'shell', 'zsh', 'yaml', 'yml'].includes(l)) {
    result = result.replace(
      /(^|[\n])(\s*)(#[^\n]*)/g,
      (_m, p1, p2, p3) => `${p1}${p2}${stash(`<span class="hl-cmt">${p3}</span>`)}`,
    );
  } else if (['javascript', 'js', 'typescript', 'ts', 'jsx', 'tsx'].includes(l)) {
    result = result.replace(/(\/\/[^\n]*)/g, (m) => stash(`<span class="hl-cmt">${m}</span>`));
  } else if (l === 'sql') {
    result = result.replace(/(--[^\n]*)/g, (m) => stash(`<span class="hl-cmt">${m}</span>`));
  }

  // Keywords (whole word only) — now safe to run, strings/comments are stashed.
  result = result.replace(/\b([a-zA-Z_]+)\b/g, (match) =>
    kw.has(match) ? `<span class="hl-kw">${match}</span>` : match,
  );

  // Numbers.
  result = result.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="hl-num">$1</span>');

  // Restore stashed strings/comments.
  return result.replace(/\u0000T(\d+)\u0000/g, (_m, i) => tokens[Number(i)]);
}

/** Parse markdown text into HTML. Handles fenced code, inline formatting, headers, lists, links. */
function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  let inList = false;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      if (inList) { out.push('</ul>'); inList = false; }
      const lang = fenceMatch[1] || '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const code = codeLines.join('\n');
      const highlighted = highlightCode(code, lang);
      const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
      out.push(
        `<div class="code-block-wrapper">` +
        `<div class="code-block-header">${langLabel}<button class="copy-btn" data-code="${escapeHtml(code)}">Copy</button></div>` +
        `<pre class="code-block"><code>${highlighted}</code></pre>` +
        `</div>`,
      );
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      if (inList) { out.push('</ul>'); inList = false; }
      const level = headerMatch[1].length;
      out.push(`<h${level}>${inlineFormat(headerMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list
    const listMatch = line.match(/^(\s*)[-*]\s+(.+)/);
    if (listMatch) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inlineFormat(listMatch[2])}</li>`);
      i++;
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inlineFormat(olMatch[2])}</li>`);
      i++;
      continue;
    }

    // Close list if we leave list context
    if (inList && line.trim() === '') {
      out.push('</ul>');
      inList = false;
    }

    // Empty line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph
    if (inList) { out.push('</ul>'); inList = false; }
    out.push(`<p>${inlineFormat(line)}</p>`);
    i++;
  }

  if (inList) out.push('</ul>');
  return out.join('');
}

/** Inline markdown formatting: bold, italic, code, links. */
function inlineFormat(text: string): string {
  let s = escapeHtml(text);
  // inline code
  s = s.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  // bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // italic
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  return s;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

@customElement('chat-message')
export class ChatMessage extends LitElement {
  static override styles = css`
    :host {
      display: block;
      animation: fade-in 200ms ease;
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .message {
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.55;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    .message.user {
      background: color-mix(in srgb, var(--vscode-button-background) 20%, transparent);
      margin-left: 40px;
      border-radius: 12px 12px 4px 12px;
    }

    .message.assistant {
      background: transparent;
      margin-right: 8px;
    }

    .message.tool-use {
      background: color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 6%, transparent);
      border-left: 2px solid color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 40%, transparent);
      border-radius: 2px;
      padding: 4px 10px;
      font-size: 12px;
    }

    .message.tool-result {
      background: transparent;
      border-radius: 2px;
      padding: 2px 10px 2px 14px;
      font-size: 12px;
    }

    .message.error {
      background: color-mix(in srgb, var(--vscode-errorForeground, #f85149) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #f85149) 25%, transparent);
      border-radius: 8px;
      padding: 8px 12px;
      color: var(--vscode-errorForeground, #f85149);
    }

    /* Markdown content */
    .content p {
      margin: 0 0 8px 0;
    }

    .content p:last-child {
      margin-bottom: 0;
    }

    .content h1, .content h2, .content h3, .content h4 {
      margin: 12px 0 6px 0;
      font-weight: 600;
    }

    .content h1 { font-size: 16px; }
    .content h2 { font-size: 14px; }
    .content h3 { font-size: 13px; }
    .content h4 { font-size: 13px; opacity: 0.85; }

    .content ul {
      margin: 4px 0;
      padding-left: 20px;
    }

    .content li {
      margin: 2px 0;
    }

    .content a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }

    .content a:hover {
      text-decoration: underline;
    }

    .content strong {
      font-weight: 600;
    }

    /* Inline code */
    .content .inline-code {
      background: var(--vscode-textCodeBlock-background, rgba(110, 118, 129, 0.15));
      padding: 1px 5px;
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family, 'Menlo', 'Monaco', monospace);
      font-size: 12px;
    }

    /* Code blocks */
    .content .code-block-wrapper {
      margin: 8px 0;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
    }

    .content .code-block-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 10px;
      background: color-mix(in srgb, var(--vscode-textCodeBlock-background, #1e1e1e) 80%, transparent);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .content .code-lang {
      text-transform: lowercase;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    .content .copy-btn {
      background: none;
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      border-radius: 4px;
      padding: 1px 8px;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
      transition: color 200ms ease;
    }

    .content .copy-btn:hover {
      color: var(--vscode-editor-foreground);
      border-color: var(--vscode-focusBorder);
    }

    .content .code-block {
      margin: 0;
      padding: 10px 12px;
      background: var(--vscode-textCodeBlock-background, rgba(30, 30, 30, 0.9));
      font-family: var(--vscode-editor-font-family, 'Menlo', 'Monaco', monospace);
      font-size: 12px;
      line-height: 1.5;
      overflow-x: auto;
      white-space: pre;
    }

    .content .code-block code {
      font-family: inherit;
    }

    /* Syntax highlighting */
    .content .hl-kw { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
    .content .hl-str { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
    .content .hl-num { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
    .content .hl-cmt { color: var(--vscode-symbolIcon-commentForeground, #6a9955); font-style: italic; }

    /* Tool use card — compact inline style */
    .tool-header {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .tool-name {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      font-weight: 600;
      opacity: 0.7;
    }

    .tool-preview {
      margin-top: 2px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--vscode-editor-foreground);
    }

    .tool-args {
      margin-top: 4px;
    }

    .tool-args summary {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      user-select: none;
      opacity: 0.6;
    }

    .tool-args summary:hover {
      opacity: 1;
    }

    .tool-args pre {
      margin: 4px 0 0 0;
      padding: 6px 10px;
      background: var(--vscode-textCodeBlock-background, rgba(30, 30, 30, 0.5));
      border-radius: 4px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }

    /* Tool result — single line */
    .result-icon {
      margin-right: 4px;
    }

    .result-summary {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    /* Streaming cursor */
    .streaming-cursor {
      display: inline-block;
      width: 2px;
      height: 14px;
      background: var(--vscode-editorCursor-foreground, var(--vscode-editor-foreground));
      margin-left: 2px;
      vertical-align: text-bottom;
      animation: blink-cursor 1s step-end infinite;
    }

    @keyframes blink-cursor {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }

    /* Approval buttons */
    .approval-actions {
      margin-top: 8px;
      display: flex;
      gap: 8px;
    }

    .approval-actions button {
      padding: 3px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      border: none;
      transition: opacity 200ms;
    }

    .btn-approve {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .btn-deny {
      background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
      border: 1px solid var(--vscode-panel-border) !important;
    }

    .approval-actions button:hover {
      opacity: 0.85;
    }

    .approval-status {
      margin-top: 8px;
      font-size: 12px;
      font-style: italic;
      opacity: 0.8;
    }

    .approval-status.approved {
      color: var(--vscode-testing-iconPassed, #73c991);
    }

    .approval-status.denied {
      color: var(--vscode-errorForeground, #f85149);
    }
  `;

  @property({ type: String }) role: MessageRole = 'assistant';
  @property({ type: String }) content = '';
  @property({ type: Boolean }) streaming = false;

  /* Tool use properties */
  @property({ type: String }) toolName = '';
  @property({ type: Object }) toolArgs: Record<string, unknown> = {};
  @property({ type: String }) requestId = '';
  @property({ type: Boolean }) requiresApproval = false;
  @property({ type: String }) approvalState: 'pending' | 'approved' | 'denied' = 'pending';

  /* Tool result properties */
  @property({ type: Boolean }) toolSuccess = false;
  @property({ type: String }) toolSummary = '';

  /* Special message types */
  @property({ type: String }) messageType: 'text' | 'tool-use' | 'tool-result' | 'error' = 'text';

  override render() {
    switch (this.messageType) {
      case 'tool-use':
        return this._renderToolUse();
      case 'tool-result':
        return this._renderToolResult();
      case 'error':
        return html`<div class="message error">${this.content}</div>`;
      default:
        return this._renderTextMessage();
    }
  }

  override firstUpdated() {
    this.shadowRoot?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('copy-btn')) {
        const code = target.getAttribute('data-code') ?? '';
        navigator.clipboard.writeText(code).then(() => {
          target.textContent = 'Copied!';
          setTimeout(() => { target.textContent = 'Copy'; }, 1500);
        });
      }
      if (target.classList.contains('btn-approve') || target.classList.contains('btn-deny')) {
        // Ignore double-clicks once a decision has already been made.
        if (this.approvalState !== 'pending') return;
        const approved = target.classList.contains('btn-approve');
        // Optimistic UI: flip state immediately so the buttons disappear and
        // the card shows "Approved / running…" or "Denied" right away.
        this.approvalState = approved ? 'approved' : 'denied';
        this.dispatchEvent(
          new CustomEvent('tool-approval', {
            detail: { requestId: this.requestId, approved },
            bubbles: true,
            composed: true,
          }),
        );
      }
    });
  }

  private _renderTextMessage() {
    const rendered = this.role === 'user'
      ? html`<div class="message user">${this.content}</div>`
      : html`
          <div class="message assistant">
            <div class="content">
              ${unsafeHTML(renderMarkdown(this.content))}
              ${this.streaming ? html`<span class="streaming-cursor"></span>` : nothing}
            </div>
          </div>
        `;
    return rendered;
  }

  private _renderToolUse() {
    const preview = this._toolPreview();
    const argsStr = JSON.stringify(this.toolArgs, null, 2);
    const hasExtraArgs = argsStr !== '{}' && argsStr !== JSON.stringify(preview ? undefined : this.toolArgs);

    return html`
      <div class="message tool-use">
        <div class="tool-header">
          <span class="tool-name">${this.toolName}</span>
        </div>
        ${preview ? html`<div class="tool-preview">${preview}</div>` : nothing}
        ${hasExtraArgs ? html`
          <details class="tool-args">
            <summary>details</summary>
            <pre>${argsStr}</pre>
          </details>
        ` : nothing}
        ${this._renderApprovalUI()}
      </div>
    `;
  }

  /** Extract the most useful one-liner from tool args based on tool type. */
  private _toolPreview(): string {
    const a = this.toolArgs;
    switch (this.toolName) {
      case 'bash':
        return (a.command as string) ?? '';
      case 'read_file':
        return (a.path as string) ?? '';
      case 'write_file':
        return (a.path as string) ?? '';
      case 'edit_file':
        return (a.path as string) ?? '';
      case 'glob':
        return (a.pattern as string) ?? '';
      case 'grep': {
        const pattern = (a.pattern as string) ?? '';
        const path = (a.path as string) ?? '';
        return path ? `${pattern} in ${path}` : pattern;
      }
      case 'git_diff':
      case 'git_status':
      case 'git_log':
      case 'git_commit':
        return (a.args as string) ?? '';
      case 'run_specs':
        return (a.path as string) ?? (a.args as string) ?? '';
      case 'web_search':
        return (a.query as string) ?? '';
      case 'web_fetch':
        return (a.url as string) ?? '';
      case 'spawn_agent':
        return (a.prompt as string)?.slice(0, 120) ?? '';
      case 'ide_diagnostics':
        return (a.file as string) ?? 'workspace';
      case 'ide_symbols':
        return (a.query as string) ?? '';
      default:
        // For unknown tools, show the first string value if there's only one
        {
          const vals = Object.values(a).filter((v) => typeof v === 'string') as string[];
          return vals.length === 1 ? vals[0].slice(0, 200) : '';
        }
    }
  }

  private _renderApprovalUI() {
    if (!this.requiresApproval) return nothing;

    // Once the user has clicked, hide the buttons and show a status line.
    // A tool/result card will arrive next to show the actual outcome;
    // this just confirms the click landed and the request is in flight.
    if (this.approvalState === 'approved') {
      return html`<div class="approval-status approved">\u2705 Approved — running…</div>`;
    }
    if (this.approvalState === 'denied') {
      return html`<div class="approval-status denied">\u274C Denied</div>`;
    }

    return html`
      <div class="approval-actions">
        <button class="btn-approve">Allow</button>
        <button class="btn-deny">Deny</button>
      </div>
    `;
  }

  private _renderToolResult() {
    return html`
      <div class="message tool-result">
        <span class="result-icon">${this.toolSuccess ? '\u2705' : '\u274C'}</span>
        <span class="result-summary">${this.toolSummary || (this.toolSuccess ? 'Done' : 'Failed')}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-message': ChatMessage;
  }
}
