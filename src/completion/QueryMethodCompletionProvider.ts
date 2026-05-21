/**
 * Provides column-name completion inside Rails query methods.
 *
 * The heavy lifting (cursor-position parsing) lives in `detectContext.ts` so
 * it can be unit-tested independently. This file is the thin VS Code-facing
 * adapter: pull the project, look up the schema, build CompletionItems.
 */

import * as vscode from 'vscode';
import { ColumnInfo } from '../rails/SchemaIndex';
import { ModelTableResolver } from '../rails/ModelTableResolver';
import { RailsProject } from '../rails/RailsProject';
import { detectContext, ContextMatch } from './detectContext';

export class QueryMethodCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(
    private readonly getProject: (
      doc: vscode.TextDocument,
    ) => RailsProject | null,
    private readonly getResolver: (
      project: RailsProject,
    ) => ModelTableResolver,
  ) {}

  async provideCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    _token: vscode.CancellationToken,
    _ctx: vscode.CompletionContext,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const project = this.getProject(doc);
    if (!project) return undefined;

    const text = doc.getText();
    const offset = doc.offsetAt(pos);
    const match = detectContext(text, offset);
    if (!match) return undefined;

    const resolver = this.getResolver(project);
    const table = await resolver.resolve(match.model);
    if (!table) return undefined;

    const columns = project.schema.columnsFor(table);
    if (!columns || columns.length === 0) return undefined;

    return columns.map((col) => buildItem(doc, match, col));
  }
}

function buildItem(
  doc: vscode.TextDocument,
  match: ContextMatch,
  col: ColumnInfo,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    col.name,
    vscode.CompletionItemKind.Field,
  );
  item.detail = `:${col.sqlType}`;
  item.documentation = buildDocumentation(col);
  item.insertText =
    match.cursorContext === 'open' ? `${col.name}:` : col.name;
  item.range = new vscode.Range(
    doc.positionAt(match.partialStart),
    doc.positionAt(match.partialEnd),
  );
  return item;
}

function buildDocumentation(col: ColumnInfo): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${col.name}** \`:${col.sqlType}\`\n\n`);
  md.appendMarkdown(`- **null:** ${col.nullable ? 'true' : 'false'}\n`);
  if (col.default !== null) {
    md.appendMarkdown(`- **default:** \`${col.default}\`\n`);
  }
  if (col.isPrimary) {
    md.appendMarkdown(`- **primary key**\n`);
  }
  return md;
}
