/**
 * Completion provider for association / scope / method chains on Rails
 * models. Triggered by `.`, asks ReceiverTypeResolver what the receiver is,
 * and emits items appropriate to that type:
 *
 *   - class    → scopes, class methods, AR class methods (find/where/...)
 *   - instance → associations, instance methods, AR instance methods
 *   - relation → associations of target class + AR relation methods
 *   - unknown  → nothing (Phase 1 / Phase 2 providers may still fire)
 *
 * Phase 1's QueryMethodCompletionProvider remains the column-completion path
 * inside `where(...)`; this provider is the model-traversal path. VS Code
 * aggregates both lists and dedupes by label.
 */

import * as vscode from 'vscode';
import { ModelIndex, ModelInfo, AssociationInfo, ScopeInfo, MethodInfo } from '../rails/ModelIndex';
import {
  ReceiverType,
  ReceiverTypeResolver,
} from './ReceiverTypeResolver';

const SUPPORTED_LANGUAGES = new Set(['ruby', 'erb', 'haml', 'slim']);

const AR_CLASS_METHODS = [
  'all', 'none', 'where', 'find', 'find_by', 'find_by!', 'first', 'last',
  'take', 'order', 'reorder', 'group', 'having', 'select', 'pluck',
  'distinct', 'includes', 'joins', 'left_joins', 'preload', 'eager_load',
  'references', 'limit', 'offset', 'lock', 'readonly', 'count', 'sum',
  'average', 'minimum', 'maximum', 'exists?', 'any?', 'many?', 'create',
  'create!', 'new', 'build', 'find_or_create_by', 'find_or_initialize_by',
  'update_all', 'delete_all', 'destroy_all',
];

const AR_INSTANCE_METHODS = [
  'save', 'save!', 'update', 'update!', 'destroy', 'destroy!', 'reload',
  'delete', 'touch', 'persisted?', 'new_record?', 'destroyed?', 'valid?',
  'errors', 'attributes', 'attribute_names', 'changes', 'changed?',
  'previous_changes', 'transaction', 'update_attribute', 'update_columns',
  'increment', 'decrement', 'increment!', 'decrement!', 'toggle', 'toggle!',
];

const AR_RELATION_METHODS = [
  'each', 'map', 'select', 'reject', 'find', 'detect', 'reduce', 'inject',
  'to_a', 'to_ary', 'first', 'last', 'count', 'size', 'length', 'empty?',
  'any?', 'many?', 'where', 'order', 'reorder', 'group', 'having', 'pluck',
  'distinct', 'includes', 'joins', 'limit', 'offset', 'merge', 'or',
  'find_each', 'find_in_batches', 'in_batches',
];

export interface AssociationProviderOptions {
  debug?: boolean;
}

export class AssociationCompletionProvider
  implements vscode.CompletionItemProvider
{
  private readonly debug: boolean;
  private readonly debugLog: ((msg: string) => void) | null;

  constructor(
    private readonly getIndex: (
      doc: vscode.TextDocument,
    ) => Promise<ModelIndex | null>,
    private readonly outputChannel?: vscode.OutputChannel,
    options: AssociationProviderOptions = {},
  ) {
    this.debug = options.debug ?? false;
    this.debugLog =
      this.debug && this.outputChannel
        ? (msg: string) => this.outputChannel!.appendLine(`[assoc] ${msg}`)
        : null;
  }

  async provideCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    _token: vscode.CancellationToken,
    _ctx: vscode.CompletionContext,
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (!SUPPORTED_LANGUAGES.has(doc.languageId)) return undefined;

    const index = await this.getIndex(doc);
    if (!index) return undefined;

    const resolver = new ReceiverTypeResolver(index);
    const type = resolver.resolveAt(doc, pos);
    if (this.debugLog) {
      this.debugLog(
        `${doc.uri.fsPath}:${pos.line + 1}:${pos.character + 1} → ${JSON.stringify(type)}`,
      );
    }
    if (type.kind === 'unknown') return undefined;

    const model = index.byName(type.modelName);
    return buildItems(type, model);
  }
}

function buildItems(
  type: ReceiverType,
  model: ModelInfo | undefined,
): vscode.CompletionItem[] {
  if (type.kind === 'class') {
    const items: vscode.CompletionItem[] = [];
    if (model) {
      for (const scope of model.scopes) items.push(scopeItem(scope));
      for (const m of model.classMethods) items.push(methodItem(m, false));
    }
    for (const name of AR_CLASS_METHODS) items.push(arMethodItem(name));
    return items;
  }
  if (type.kind === 'instance') {
    const items: vscode.CompletionItem[] = [];
    if (model) {
      for (const assoc of model.associations) items.push(associationItem(assoc));
      for (const m of model.instanceMethods) items.push(methodItem(m, false));
    }
    for (const name of AR_INSTANCE_METHODS) items.push(arMethodItem(name));
    return items;
  }
  // relation
  const items: vscode.CompletionItem[] = [];
  if (model) {
    for (const assoc of model.associations) items.push(associationItem(assoc));
    for (const scope of model.scopes) items.push(scopeItem(scope));
  }
  for (const name of AR_RELATION_METHODS) items.push(arMethodItem(name));
  return items;
}

function associationItem(assoc: AssociationInfo): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    assoc.name,
    vscode.CompletionItemKind.Reference,
  );
  item.detail = `→ ${assoc.targetClass}`;
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${assoc.kind} :${assoc.name}**`);
  if (assoc.through) md.appendMarkdown(`, through: \`:${assoc.through}\``);
  if (assoc.polymorphic) md.appendMarkdown(`, polymorphic: \`true\``);
  md.appendMarkdown(`\n\nTarget: \`${assoc.targetClass}\``);
  item.documentation = md;
  return item;
}

function scopeItem(scope: ScopeInfo): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    scope.name,
    vscode.CompletionItemKind.Method,
  );
  item.detail = `scope ${scope.signature}`;
  return item;
}

function methodItem(method: MethodInfo, _isAr: boolean): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    method.name,
    vscode.CompletionItemKind.Method,
  );
  item.detail = method.isClass ? 'def self' : 'def';
  return item;
}

function arMethodItem(name: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    name,
    vscode.CompletionItemKind.Method,
  );
  item.detail = 'ActiveRecord';
  return item;
}
