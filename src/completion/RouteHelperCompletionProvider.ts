/**
 * Suggests Rails route helpers (`*_path`, `*_url`) inside views, controllers,
 * and mailers. Reads the RoutesIndex composed on the per-folder RailsProject.
 *
 * Trigger heuristic: at the end of a partial identifier with ≥2 chars (or
 * ending in `_`), look up the prefix in the routes index. Quiet when there
 * are no matches so we don't crowd the popup for unrelated identifiers.
 */

import * as vscode from 'vscode';
import { RailsProject } from '../rails/RailsProject';
import { NamedRoute } from '../rails/RoutesParser';

/** Matches any partial of `_path` or `_url` (incl. just `_`) at end of token. */
const HELPER_SUFFIX_PARTIAL = /_(p(?:a(?:t(?:h)?)?)?|u(?:r(?:l)?)?)?$/;
const SUPPORTED_LANGUAGES = new Set(['ruby', 'erb', 'haml', 'slim']);

export class RouteHelperCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(
    private readonly getProject: (
      doc: vscode.TextDocument,
    ) => RailsProject | null,
  ) {}

  async provideCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    _token: vscode.CancellationToken,
    _ctx: vscode.CompletionContext,
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (!SUPPORTED_LANGUAGES.has(doc.languageId)) return undefined;

    const project = this.getProject(doc);
    if (!project) return undefined;

    const partial = readPartialIdentifier(doc, pos);
    if (!partial) return undefined;
    if (partial.text.length < 2 && !partial.text.endsWith('_')) return undefined;

    const lookupPrefix = partial.text.replace(HELPER_SUFFIX_PARTIAL, '');
    if (!lookupPrefix) return undefined;

    const routes = project.routes;
    await routes.ensureLoaded();
    const matches = routes.matching(lookupPrefix);
    if (matches.length === 0) return undefined;

    const grouped = groupByHelper(matches);
    const items: vscode.CompletionItem[] = [];
    for (const [helper, group] of grouped.entries()) {
      items.push(buildItem(doc, partial.range, helper, group, 'path'));
      items.push(buildItem(doc, partial.range, helper, group, 'url'));
    }
    return items;
  }
}

interface PartialIdentifier {
  text: string;
  range: vscode.Range;
}

function readPartialIdentifier(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): PartialIdentifier | null {
  const line = doc.lineAt(pos.line).text;
  const col = pos.character;
  let start = col;
  while (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1])) start -= 1;
  let end = col;
  while (end < line.length && /[A-Za-z0-9_]/.test(line[end])) end += 1;
  if (start === end) return null;
  const text = line.slice(start, end);
  if (!/^[A-Za-z_]/.test(text)) return null;
  return {
    text,
    range: new vscode.Range(
      new vscode.Position(pos.line, start),
      new vscode.Position(pos.line, end),
    ),
  };
}

function groupByHelper(routes: NamedRoute[]): Map<string, NamedRoute[]> {
  const grouped = new Map<string, NamedRoute[]>();
  for (const route of routes) {
    const list = grouped.get(route.helper);
    if (list) list.push(route);
    else grouped.set(route.helper, [route]);
  }
  return grouped;
}

function buildItem(
  _doc: vscode.TextDocument,
  range: vscode.Range,
  helper: string,
  group: NamedRoute[],
  suffix: 'path' | 'url',
): vscode.CompletionItem {
  const label = `${helper}_${suffix}`;
  const item = new vscode.CompletionItem(
    label,
    vscode.CompletionItemKind.Function,
  );
  const primary = pickRepresentative(group);
  item.detail = `${primary.verb} ${primary.pattern}`;
  item.documentation = buildDocumentation(group);
  item.insertText = buildSnippet(label, primary.pattern);
  item.range = range;
  return item;
}

/**
 * Pick the route variant most useful to show in detail: prefer GET show/edit,
 * then GET index, then whichever was emitted first.
 */
function pickRepresentative(group: NamedRoute[]): NamedRoute {
  const byVerb = (verb: string, action?: string): NamedRoute | undefined =>
    group.find((r) => r.verb === verb && (!action || r.action === action));
  return (
    byVerb('GET', 'show') ??
    byVerb('GET', 'edit') ??
    byVerb('GET', 'index') ??
    byVerb('GET') ??
    group[0]
  );
}

function buildDocumentation(group: NamedRoute[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  for (const r of group) {
    md.appendMarkdown(
      `- **${r.verb}** \`${r.pattern}\` → \`${r.controller}#${r.action}\`\n`,
    );
  }
  return md;
}

function buildSnippet(label: string, pattern: string): vscode.SnippetString {
  const params = Array.from(pattern.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)).map(
    (m) => m[1],
  );
  if (params.length === 0) {
    return new vscode.SnippetString(label);
  }
  const filled = params
    .map((name, i) => `\${${i + 1}:${name}}`)
    .join(', ');
  return new vscode.SnippetString(`${label}(${filled})`);
}
