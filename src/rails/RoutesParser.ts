/**
 * Regex-driven parser for `config/routes.rb`.
 *
 * Strategy: tokenize the file into a sequence of "events" (block opener,
 * block closer, route declaration, draw call). Walk events with a context
 * stack — namespace / scope / resources / resource / member / collection /
 * concern / constraints — and emit NamedRoute records as we encounter
 * macros and HTTP verb calls.
 *
 * This is intentionally a partial port of `ActionDispatch::Routing::Mapper`.
 * The common DSL surface (resources, resource, namespace, scope path: /
 * module:, member, collection, http verb with as:/to:/only:/except:, draw)
 * works. Heavier patterns (constraints with blocks, custom matchers,
 * metaprogrammed routes) fall through to RoutesShellParser via the
 * coverage heuristic in RoutesIndex.
 */

import * as vscode from 'vscode';

export type HttpVerb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ANY';

export interface NamedRoute {
  /** Bare helper name; `_path` / `_url` is appended by the completion layer. */
  helper: string;
  verb: HttpVerb;
  pattern: string;
  controller: string;
  action: string;
}

export interface ParserDeps {
  readFile(uri: vscode.Uri): Promise<string>;
  routesDir: vscode.Uri;
}

const STANDARD_PLURAL_ACTIONS: Array<{
  action: string;
  verb: HttpVerb;
  helperShape: 'collection' | 'collectionFor' | 'memberFor' | 'newMember' | 'editMember';
}> = [
  { action: 'index',   verb: 'GET',    helperShape: 'collection' },
  { action: 'create',  verb: 'POST',   helperShape: 'collection' },
  { action: 'new',     verb: 'GET',    helperShape: 'newMember' },
  { action: 'show',    verb: 'GET',    helperShape: 'memberFor' },
  { action: 'edit',    verb: 'GET',    helperShape: 'editMember' },
  { action: 'update',  verb: 'PATCH',  helperShape: 'memberFor' },
  { action: 'destroy', verb: 'DELETE', helperShape: 'memberFor' },
];

const STANDARD_SINGULAR_ACTIONS: Array<{
  action: string;
  verb: HttpVerb;
  helperShape: 'singular' | 'newSingular' | 'editSingular';
}> = [
  { action: 'create',  verb: 'POST',   helperShape: 'singular' },
  { action: 'new',     verb: 'GET',    helperShape: 'newSingular' },
  { action: 'show',    verb: 'GET',    helperShape: 'singular' },
  { action: 'edit',    verb: 'GET',    helperShape: 'editSingular' },
  { action: 'update',  verb: 'PATCH',  helperShape: 'singular' },
  { action: 'destroy', verb: 'DELETE', helperShape: 'singular' },
];

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const BLOCK_OPENER =
  /^\s*(namespace|scope|resources|resource|member|collection|concern|constraints)\b(.*?)\bdo(?:\s*\|[^|]*\|)?\s*$/;
const BLOCK_END = /^\s*end\s*$/;
const HTTP_VERB_LINE = /^\s*(get|post|put|patch|delete|match)\b(.*)$/;
const DRAW_LINE = /^\s*draw\s+:?(\w+)/;
const ROOT_LINE = /^\s*root\b(.*)$/;
const RESOURCES_SHORTHAND =
  /^\s*(resources|resource)\s+(:[A-Za-z_]\w*(?:\s*,\s*:[A-Za-z_]\w*)*)\s*(?:,\s*(.*))?$/;

interface Frame {
  kind:
    | 'namespace'
    | 'scope'
    | 'resources'
    | 'resource'
    | 'member'
    | 'collection'
    | 'concern'
    | 'constraints';
  pathPrefix: string;
  helperPrefix: string;
  modulePrefix: string;
  /** For resources / resource: the resource name (raw, e.g. "users"). */
  resourceName?: string;
  /** Singular form used in helpers/paths for `resource` and member routes. */
  resourceSingular?: string;
  /** Effective controller path: 'admin/users'. */
  resourceController?: string;
  /** Truthful when within a `resources` block (not `resource` singular). */
  resourcePlural?: boolean;
}

export class RoutesParser {
  constructor(private readonly deps: ParserDeps) {}

  async parse(source: string): Promise<NamedRoute[]> {
    const out: NamedRoute[] = [];
    await this.parseSource(source, [], out, new Set());
    return out;
  }

  private async parseSource(
    source: string,
    stack: Frame[],
    out: NamedRoute[],
    drawnFiles: Set<string>,
  ): Promise<void> {
    const lines = joinContinuations(source.split('\n'));
    for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
      const raw = lines[lineNo];
      const line = stripComment(raw);
      if (!line.trim()) continue;

      // 1. Block closer.
      if (BLOCK_END.test(line)) {
        stack.pop();
        continue;
      }

      // 2. draw recursion.
      const drawMatch = DRAW_LINE.exec(line);
      if (drawMatch) {
        await this.handleDraw(drawMatch[1], stack, out, drawnFiles);
        continue;
      }

      // 3. Block opener.
      const opener = BLOCK_OPENER.exec(line);
      if (opener) {
        const frame = this.openFrame(opener[1], opener[2], stack);
        if (frame) {
          this.emitResourceRoutes(frame, out);
          stack.push(frame);
        }
        continue;
      }

      // 4. resources / resource shorthand (no block).
      const short = RESOURCES_SHORTHAND.exec(line);
      if (short) {
        const kind = short[1];
        const names = short[2].split(',').map((s) => s.trim().slice(1));
        const opts = short[3] ?? '';
        for (const name of names) {
          const frame = this.buildResourceFrame(kind, name, opts, stack);
          this.emitResourceRoutes(frame, out);
        }
        continue;
      }

      // 5. HTTP verb call.
      const verb = HTTP_VERB_LINE.exec(line);
      if (verb) {
        this.emitVerbRoute(verb[1], verb[2], stack, out);
        continue;
      }

      // 6. `root to: '...'` or `root '...'`.
      const root = ROOT_LINE.exec(line);
      if (root) {
        const route = this.parseRootRoute(root[1], stack);
        if (route) out.push(route);
        continue;
      }
    }
  }

  private async handleDraw(
    name: string,
    stack: Frame[],
    out: NamedRoute[],
    drawnFiles: Set<string>,
  ): Promise<void> {
    const target = vscode.Uri.joinPath(this.deps.routesDir, `${name}.rb`);
    if (drawnFiles.has(target.fsPath)) return;
    drawnFiles.add(target.fsPath);
    try {
      const body = await this.deps.readFile(target);
      await this.parseSource(body, [...stack], out, drawnFiles);
    } catch {
      // Missing draw target — skip silently.
    }
  }

  private openFrame(
    kind: string,
    argsText: string,
    stack: Frame[],
  ): Frame | null {
    const parent = topFrame(stack);
    if (kind === 'namespace') {
      const name = firstSymbolOrString(argsText);
      if (!name) return null;
      return {
        kind: 'namespace',
        pathPrefix: joinPath(parent.pathPrefix, `/${name}`),
        helperPrefix: joinHelperPrefix(parent.helperPrefix, name),
        modulePrefix: joinPath(parent.modulePrefix, name),
      };
    }
    if (kind === 'scope') {
      return this.buildScopeFrame(argsText, parent);
    }
    if (kind === 'resources' || kind === 'resource') {
      const name = firstSymbolOrString(argsText);
      if (!name) return null;
      return this.buildResourceFrame(kind, name, argsText, stack);
    }
    if (kind === 'member' || kind === 'collection') {
      return { ...parent, kind: kind as 'member' | 'collection' };
    }
    if (kind === 'constraints' || kind === 'concern') {
      return { ...parent, kind: kind as 'constraints' | 'concern' };
    }
    return null;
  }

  private buildScopeFrame(argsText: string, parent: Frame): Frame {
    const path = extractKwarg(argsText, 'path') ?? extractFirstStringOrSymbol(argsText);
    const moduleKw = extractKwarg(argsText, 'module');
    const asKw = extractKwarg(argsText, 'as');
    return {
      kind: 'scope',
      pathPrefix: path ? joinPath(parent.pathPrefix, `/${stripLeadingSlash(path)}`) : parent.pathPrefix,
      helperPrefix: asKw ? joinHelperPrefix(parent.helperPrefix, asKw) : parent.helperPrefix,
      modulePrefix: moduleKw ? joinPath(parent.modulePrefix, moduleKw) : parent.modulePrefix,
    };
  }

  private buildResourceFrame(
    kind: string,
    name: string,
    argsText: string,
    stack: Frame[],
  ): Frame {
    const parent = topFrame(stack);
    const isPlural = kind === 'resources';
    const singular = singularize(name);
    const plural = isPlural ? name : pluralize(name);
    const controllerName = extractKwarg(argsText, 'controller') ?? plural;
    const controller = joinPath(parent.modulePrefix, controllerName).replace(/^\//, '');
    const onlyList = extractArray(argsText, 'only');
    const exceptList = extractArray(argsText, 'except');
    const customAs = extractKwarg(argsText, 'as');

    return {
      kind: isPlural ? 'resources' : 'resource',
      pathPrefix: joinPath(parent.pathPrefix, `/${isPlural ? plural : singular}`),
      helperPrefix: joinHelperPrefix(parent.helperPrefix, customAs ?? (isPlural ? singular : singular)),
      modulePrefix: parent.modulePrefix,
      resourceName: name,
      resourceSingular: singular,
      resourceController: controller,
      resourcePlural: isPlural,
      // Stash filters on the frame so emitResourceRoutes can read them. We
      // store them via an out-of-band map for clarity.
      ...(onlyList ? { __only: new Set(onlyList) } : {}),
      ...(exceptList ? { __except: new Set(exceptList) } : {}),
    } as Frame;
  }

  private emitResourceRoutes(frame: Frame, out: NamedRoute[]): void {
    if (frame.kind !== 'resources' && frame.kind !== 'resource') return;
    if (!frame.resourceName || !frame.resourceSingular) return;

    const only = (frame as unknown as { __only?: Set<string> }).__only;
    const except = (frame as unknown as { __except?: Set<string> }).__except;
    const allow = (action: string): boolean => {
      if (only && !only.has(action)) return false;
      if (except && except.has(action)) return false;
      return true;
    };

    if (frame.resourcePlural) {
      for (const spec of STANDARD_PLURAL_ACTIONS) {
        if (!allow(spec.action)) continue;
        out.push(this.buildPluralRoute(frame, spec));
      }
    } else {
      for (const spec of STANDARD_SINGULAR_ACTIONS) {
        if (!allow(spec.action)) continue;
        out.push(this.buildSingularRoute(frame, spec));
      }
    }
  }

  private buildPluralRoute(
    frame: Frame,
    spec: { action: string; verb: HttpVerb; helperShape: string },
  ): NamedRoute {
    const helperRoot = stripPluralFromHelperPrefix(frame.helperPrefix);
    const helperPlural = pluralize(frame.resourceSingular!);
    const helperPrefixForPlural = replaceTailWith(frame.helperPrefix, helperPlural);
    const memberPath = `${frame.pathPrefix}/:id`;

    switch (spec.helperShape) {
      case 'collection':
        return {
          helper: helperPrefixForPlural,
          verb: spec.verb,
          pattern: frame.pathPrefix,
          controller: frame.resourceController!,
          action: spec.action,
        };
      case 'newMember':
        return {
          helper: `new_${helperRoot}`,
          verb: spec.verb,
          pattern: `${frame.pathPrefix}/new`,
          controller: frame.resourceController!,
          action: spec.action,
        };
      case 'editMember':
        return {
          helper: `edit_${helperRoot}`,
          verb: spec.verb,
          pattern: `${memberPath}/edit`,
          controller: frame.resourceController!,
          action: spec.action,
        };
      case 'memberFor':
      default:
        return {
          helper: helperRoot,
          verb: spec.verb,
          pattern: memberPath,
          controller: frame.resourceController!,
          action: spec.action,
        };
    }
  }

  private buildSingularRoute(
    frame: Frame,
    spec: { action: string; verb: HttpVerb; helperShape: string },
  ): NamedRoute {
    const helperRoot = frame.helperPrefix;
    switch (spec.helperShape) {
      case 'newSingular':
        return {
          helper: `new_${helperRoot}`,
          verb: spec.verb,
          pattern: `${frame.pathPrefix}/new`,
          controller: frame.resourceController!,
          action: spec.action,
        };
      case 'editSingular':
        return {
          helper: `edit_${helperRoot}`,
          verb: spec.verb,
          pattern: `${frame.pathPrefix}/edit`,
          controller: frame.resourceController!,
          action: spec.action,
        };
      case 'singular':
      default:
        return {
          helper: helperRoot,
          verb: spec.verb,
          pattern: frame.pathPrefix,
          controller: frame.resourceController!,
          action: spec.action,
        };
    }
  }

  private emitVerbRoute(
    verbStr: string,
    argsText: string,
    stack: Frame[],
    out: NamedRoute[],
  ): void {
    const verb = (verbStr === 'match' ? 'ANY' : verbStr.toUpperCase()) as HttpVerb;
    const parent = topFrame(stack);

    // Member/collection inside a resources/resource block: action name is the
    // first symbol/string arg.
    if (parent.kind === 'member' || parent.kind === 'collection') {
      const resourceFrame = findResourceFrame(stack);
      if (!resourceFrame) return;
      const action = firstSymbolOrString(argsText);
      if (!action) return;
      const isMember = parent.kind === 'member';
      const helperRoot = stripPluralFromHelperPrefix(resourceFrame.helperPrefix);
      const collectionPath = resourceFrame.pathPrefix;
      const memberPath = `${resourceFrame.pathPrefix}/:id`;
      const helper = isMember ? `${action}_${helperRoot}` :
        resourceFrame.resourcePlural
          ? `${action}_${pluralize(resourceFrame.resourceSingular!)}`
          : `${action}_${helperRoot}`;
      out.push({
        helper,
        verb,
        pattern: `${isMember ? memberPath : collectionPath}/${action}`,
        controller: resourceFrame.resourceController!,
        action,
      });
      return;
    }

    // Top-level / namespace / scope verb call.
    const path = firstStringLiteral(argsText) ?? firstSymbolOrString(argsText);
    if (!path) return;
    const to = extractKwarg(argsText, 'to');
    const asName = extractKwarg(argsText, 'as');
    const { controller, action } = splitControllerAction(to, path, parent);
    const helper = asName
      ? joinHelperPrefix(parent.helperPrefix, asName)
      : joinHelperPrefix(parent.helperPrefix, defaultHelperFromPath(path));
    out.push({
      helper,
      verb,
      pattern: joinPath(parent.pathPrefix, ensureLeadingSlash(path)),
      controller,
      action,
    });
  }

  private parseRootRoute(argsText: string, stack: Frame[]): NamedRoute | null {
    const parent = topFrame(stack);
    const to = extractKwarg(argsText, 'to') ?? firstStringLiteral(argsText);
    if (!to) return null;
    const [controllerPart, actionPart] = to.split('#');
    if (!controllerPart || !actionPart) return null;
    return {
      helper: joinHelperPrefix(parent.helperPrefix, 'root'),
      verb: 'GET',
      pattern: parent.pathPrefix || '/',
      controller: joinPath(parent.modulePrefix, controllerPart).replace(/^\//, ''),
      action: actionPart,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function topFrame(stack: Frame[]): Frame {
  if (stack.length === 0) {
    return { kind: 'scope', pathPrefix: '', helperPrefix: '', modulePrefix: '' };
  }
  return stack[stack.length - 1];
}

function findResourceFrame(stack: Frame[]): Frame | undefined {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].kind === 'resources' || stack[i].kind === 'resource') return stack[i];
  }
  return undefined;
}

function stripComment(line: string): string {
  let inString: false | '"' | "'" = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inString) {
      if (c === inString && line[i - 1] !== '\\') inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      continue;
    }
    if (c === '#') return line.slice(0, i);
  }
  return line;
}

/**
 * Join continuation lines (those ending with a bare `,`) with the following
 * line so the regex matchers see a single statement.
 */
function joinContinuations(lines: string[]): string[] {
  const out: string[] = [];
  let buffer = '';
  for (const raw of lines) {
    const trimmed = raw.replace(/\s+$/, '');
    if (/[,]\s*$/.test(stripComment(trimmed))) {
      buffer += trimmed + ' ';
    } else {
      out.push(buffer + trimmed);
      buffer = '';
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

function firstSymbolOrString(text: string): string | null {
  const sym = /:([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  if (sym) return sym[1];
  const str = /["']([^"']+)["']/.exec(text);
  if (str) return str[1];
  return null;
}

function firstStringLiteral(text: string): string | null {
  const m = /["']([^"']+)["']/.exec(text);
  return m ? m[1] : null;
}

function extractKwarg(text: string, key: string): string | null {
  const re = new RegExp(`\\b${key}:\\s*(?::([A-Za-z_]\\w*)|["']([^"']+)["'])`);
  const m = re.exec(text);
  if (!m) return null;
  return m[1] ?? m[2];
}

function extractArray(text: string, key: string): string[] | null {
  const m = new RegExp(`\\b${key}:\\s*\\[([^\\]]+)\\]`).exec(text);
  if (!m) return null;
  return Array.from(m[1].matchAll(/:([A-Za-z_]\w*)/g)).map((mm) => mm[1]);
}

function extractFirstStringOrSymbol(text: string): string | null {
  return firstSymbolOrString(text);
}

function joinPath(prefix: string, segment: string): string {
  if (!prefix) return segment;
  if (!segment) return prefix;
  const cleaned = segment.startsWith('/') ? segment : `/${segment}`;
  return prefix.replace(/\/+$/, '') + cleaned;
}

function ensureLeadingSlash(p: string): string {
  return p.startsWith('/') ? p : `/${p}`;
}

function stripLeadingSlash(p: string): string {
  return p.replace(/^\//, '');
}

function joinHelperPrefix(prefix: string, segment: string): string {
  if (!prefix) return segment;
  if (!segment) return prefix;
  return `${prefix}_${segment}`;
}

function defaultHelperFromPath(path: string): string {
  // Last segment, stripped of `:` placeholders, with non-word chars → `_`.
  const clean = path.split('/').filter((s) => s && !s.startsWith(':')).pop() ?? path;
  return clean.replace(/[^A-Za-z0-9_]/g, '_');
}

function splitControllerAction(
  to: string | null,
  path: string,
  parent: Frame,
): { controller: string; action: string } {
  if (to && to.includes('#')) {
    const [c, a] = to.split('#');
    return {
      controller: joinPath(parent.modulePrefix, c).replace(/^\//, ''),
      action: a,
    };
  }
  // Fallback: infer from path (rarely accurate but better than empty).
  const segments = path.split('/').filter(Boolean);
  const controller = segments[0] ?? 'unknown';
  const action = segments[segments.length - 1] ?? 'index';
  return {
    controller: joinPath(parent.modulePrefix, controller).replace(/^\//, ''),
    action,
  };
}

function stripPluralFromHelperPrefix(prefix: string): string {
  // The helperPrefix already accumulates the singular form; for plural-resource
  // helpers we sometimes need the trailing identifier without modification.
  return prefix;
}

function replaceTailWith(prefix: string, newTail: string): string {
  const idx = prefix.lastIndexOf('_');
  if (idx === -1) return newTail;
  return `${prefix.slice(0, idx)}_${newTail}`;
}

// ---------------------------------------------------------------------------
// Minimal singular/plural rules (purposely simpler than ModelTableResolver —
// routes.rb usually uses pre-pluralized symbols).
// ---------------------------------------------------------------------------

const SINGULAR_TO_PLURAL: Record<string, string> = {
  person: 'people',
  child: 'children',
  ox: 'oxen',
};
const PLURAL_TO_SINGULAR: Record<string, string> = {
  people: 'person',
  children: 'child',
  oxen: 'ox',
};

export function pluralize(word: string): string {
  if (SINGULAR_TO_PLURAL[word]) return SINGULAR_TO_PLURAL[word];
  if (Object.values(SINGULAR_TO_PLURAL).includes(word)) return word;
  if (/(s|x|z|ch|sh)$/.test(word)) return word + 'es';
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + 'ies';
  if (word.endsWith('s')) return word; // already plural-ish
  return word + 's';
}

export function singularize(word: string): string {
  if (PLURAL_TO_SINGULAR[word]) return PLURAL_TO_SINGULAR[word];
  if (Object.keys(SINGULAR_TO_PLURAL).includes(word)) return word;
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/ses$/.test(word) || /xes$/.test(word) || /zes$/.test(word) || /ches$/.test(word) || /shes$/.test(word)) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}
