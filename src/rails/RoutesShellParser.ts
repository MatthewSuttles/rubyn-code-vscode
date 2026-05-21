/**
 * Fallback parser: shell out to `bin/rails routes --format=json` and translate
 * the result into NamedRoute. Used when the regex parser comes up short on
 * heavily metaprogrammed routes files.
 *
 * Booting Rails is slow (5–30s cold) — the result is cached to disk keyed on
 * `config/routes.rb` mtime so we don't pay the cost on every reload.
 */

import * as childProcess from 'node:child_process';
import * as nodeFs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { HttpVerb, NamedRoute } from './RoutesParser';

const SHELL_TIMEOUT_MS = 30_000;
const CACHE_DIR = '.rubyn-code';
const CACHE_FILE = 'routes-cache.json';

export interface ShellParserDeps {
  root: vscode.Uri;
  /** Injectable for tests — defaults to child_process.spawn. */
  spawn?: typeof childProcess.spawn;
  /** Override clock for cache mtime tests. */
  now?: () => number;
}

interface CacheBody {
  routesMtimeMs: number;
  routes: NamedRoute[];
}

export class RoutesShellParser {
  private readonly spawnImpl: typeof childProcess.spawn;

  constructor(private readonly deps: ShellParserDeps) {
    this.spawnImpl = deps.spawn ?? childProcess.spawn;
  }

  async parse(): Promise<NamedRoute[] | null> {
    const routesRb = path.join(this.deps.root.fsPath, 'config', 'routes.rb');
    const cachePath = path.join(this.deps.root.fsPath, CACHE_DIR, CACHE_FILE);

    let routesMtimeMs: number;
    try {
      const stat = await nodeFs.stat(routesRb);
      routesMtimeMs = stat.mtimeMs;
    } catch {
      return null;
    }

    const cached = await readCache(cachePath);
    if (cached && cached.routesMtimeMs === routesMtimeMs) {
      return cached.routes;
    }

    const routes = await this.runShell();
    if (!routes) return null;

    await writeCache(cachePath, { routesMtimeMs, routes });
    return routes;
  }

  private async runShell(): Promise<NamedRoute[] | null> {
    return new Promise<NamedRoute[] | null>((resolve) => {
      let resolved = false;
      const finish = (val: NamedRoute[] | null): void => {
        if (resolved) return;
        resolved = true;
        resolve(val);
      };

      let proc: childProcess.ChildProcess;
      try {
        proc = this.spawnImpl('bin/rails', ['routes', '--format=json'], {
          cwd: this.deps.root.fsPath,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        finish(null);
        return;
      }

      let stdout = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
      });
      proc.on('error', () => finish(null));
      proc.on('close', (code) => {
        if (code !== 0) {
          finish(parseTableOutput(stdout));
          return;
        }
        const parsed = parseJsonOutput(stdout) ?? parseTableOutput(stdout);
        finish(parsed);
      });

      setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // proc already exited.
        }
        finish(null);
      }, SHELL_TIMEOUT_MS);
    });
  }
}

async function readCache(file: string): Promise<CacheBody | null> {
  try {
    const text = await nodeFs.readFile(file, 'utf-8');
    return JSON.parse(text) as CacheBody;
  } catch {
    return null;
  }
}

async function writeCache(file: string, body: CacheBody): Promise<void> {
  try {
    await nodeFs.mkdir(path.dirname(file), { recursive: true });
    await nodeFs.writeFile(file, JSON.stringify(body, null, 2), 'utf-8');
  } catch {
    // Cache write is best-effort.
  }
}

function parseJsonOutput(stdout: string): NamedRoute[] | null {
  const jsonStart = stdout.indexOf('[');
  if (jsonStart === -1) return null;
  try {
    const raw = JSON.parse(stdout.slice(jsonStart)) as Array<{
      name?: string | null;
      verb?: string;
      path?: string;
      reqs?: string;
    }>;
    return raw
      .filter((r) => r.name)
      .map((r) => ({
        helper: r.name!,
        verb: normalizeVerb(r.verb),
        pattern: cleanPattern(r.path ?? ''),
        controller: splitReqs(r.reqs).controller,
        action: splitReqs(r.reqs).action,
      }));
  } catch {
    return null;
  }
}

const KNOWN_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * Parse the Rails 6 / table-format output. Columns are whitespace-separated:
 * Prefix, Verb, URI Pattern, Controller#Action. Header rows and routes
 * without a prefix or a recognizable verb are skipped.
 */
function parseTableOutput(stdout: string): NamedRoute[] {
  const out: NamedRoute[] = [];
  for (const raw of stdout.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^Prefix\b/.test(trimmed)) continue;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 4) continue;
    const verbIdx = tokens.findIndex((t) => KNOWN_VERBS.has(t.toUpperCase()));
    if (verbIdx < 1) continue; // need at least one prefix token before verb
    const helper = tokens.slice(0, verbIdx).join('_');
    const verb = tokens[verbIdx];
    const pattern = tokens[verbIdx + 1];
    const controllerAction = tokens[verbIdx + 2];
    if (!helper || !controllerAction || !controllerAction.includes('#')) continue;
    const [controller, action] = controllerAction.split('#');
    out.push({
      helper,
      verb: normalizeVerb(verb),
      pattern: cleanPattern(pattern),
      controller,
      action,
    });
  }
  return out;
}

function normalizeVerb(v?: string): HttpVerb {
  const upper = (v ?? '').toUpperCase();
  if (upper === 'GET' || upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE') {
    return upper;
  }
  return 'ANY';
}

function cleanPattern(p: string): string {
  return p.replace(/\(\.[^)]+\)/g, '').trim();
}

function splitReqs(reqs?: string): { controller: string; action: string } {
  if (!reqs || !reqs.includes('#')) return { controller: '', action: '' };
  const [controller, action] = reqs.split('#');
  return { controller, action };
}
