import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export interface QuickAction {
  icon: string;
  label: string;
  prompt: string;
}

const ACTIONS: QuickAction[] = [
  {
    icon: '\u{1F527}',
    label: 'Refactor',
    prompt: 'Refactor the currently open file. Improve readability, reduce duplication, follow Ruby/Rails best practices.',
  },
  {
    icon: '\u2705',
    label: 'Best Practices',
    prompt: 'Review the currently open file for Ruby/Rails best practices violations. Check naming conventions, N+1 queries, missing validations, security issues, and suggest improvements.',
  },
  {
    icon: '\u{1F9EA}',
    label: 'Generate Specs',
    prompt: 'Write comprehensive RSpec specs for the currently open file. Include edge cases, error scenarios, and use factories where appropriate.',
  },
  {
    icon: '\u{1F4D6}',
    label: 'Explain',
    prompt: 'Explain what the currently open file does, its role in the codebase, and any patterns or issues to watch for.',
  },
  {
    icon: '\u{1F50D}',
    label: 'Review PR',
    prompt: 'Review the current branch changes against main.',
  },
];

@customElement('quick-actions')
export class QuickActions extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 8px 12px;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    button {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      font-size: 11px;
      font-family: inherit;
      border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-panel-border));
      border-radius: 12px;
      background: var(--vscode-button-secondaryBackground, var(--vscode-editor-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
      cursor: pointer;
      transition: background-color 200ms ease, border-color 200ms ease;
      white-space: nowrap;
      line-height: 1.6;
    }

    button:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
      border-color: var(--vscode-focusBorder);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .icon {
      font-size: 12px;
    }
  `;

  @property({ type: Boolean }) disabled = false;

  override render() {
    return html`
      <div class="actions">
        ${ACTIONS.map(
          (action) => html`
            <button
              ?disabled=${this.disabled}
              @click=${() => this._dispatch(action)}
              title="${action.prompt}"
            >
              <span class="icon">${action.icon}</span>
              ${action.label}
            </button>
          `,
        )}
      </div>
    `;
  }

  private _dispatch(action: QuickAction) {
    this.dispatchEvent(
      new CustomEvent('quick-action', {
        detail: { prompt: action.prompt },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'quick-actions': QuickActions;
  }
}
