/**
 * PR creation. Two paths, tried in order:
 *
 *   1. `gh` CLI on PATH and authenticated — preferred, picks up the user's
 *      existing auth posture (browser sessions, SSO, fine-grained tokens).
 *   2. GitHub REST API with a token from VS Code SecretStorage under the
 *      key `rubyn-code.github.token`.
 *
 * If both fail we surface a clear error. PlanManager's caller should still
 * have written + committed the docs by then — only the PR-open step fails.
 */

import { spawn as nodeSpawn, ChildProcess, SpawnOptions } from 'node:child_process';

export type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

export interface TokenStore {
  get(key: string): Promise<string | undefined>;
}

export type FetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>;

export interface GitHubAdapterDeps {
  cwd: string;
  secrets: TokenStore;
  /** Test seams. */
  spawn?: SpawnFn;
  fetch?: FetchFn;
}

export interface OpenPROptions {
  title: string;
  body: string;
  base: string;
  head: string;
}

export class GitHubAdapter {
  private readonly spawn: SpawnFn;
  private readonly fetchImpl: FetchFn;

  constructor(private readonly deps: GitHubAdapterDeps) {
    this.spawn = deps.spawn ?? (nodeSpawn as SpawnFn);
    this.fetchImpl =
      deps.fetch ??
      ((url, init) =>
        // eslint-disable-next-line no-undef
        fetch(url, init as unknown as RequestInit) as unknown as ReturnType<FetchFn>);
  }

  async openPR(opts: OpenPROptions): Promise<string> {
    if (await this.ghAvailable()) {
      return this.openViaGh(opts);
    }
    const token = await this.deps.secrets.get('rubyn-code.github.token');
    if (token) {
      return this.openViaApi(opts, token);
    }
    throw new Error(
      'No PR-creation auth available. Install the `gh` CLI (`brew install gh && gh auth login`) ' +
        'or set the `rubyn-code.github.token` secret with a Personal Access Token (repo scope).',
    );
  }

  private async ghAvailable(): Promise<boolean> {
    try {
      const { code } = await this.runCapture('gh', ['auth', 'status']);
      return code === 0;
    } catch {
      return false;
    }
  }

  private async openViaGh(opts: OpenPROptions): Promise<string> {
    const { code, stdout, stderr } = await this.runCapture('gh', [
      'pr',
      'create',
      '--base',
      opts.base,
      '--head',
      opts.head,
      '--title',
      opts.title,
      '--body',
      opts.body,
    ]);
    if (code !== 0) {
      throw new Error(
        `gh pr create exited ${code}: ${stderr.trim() || stdout.trim()}`,
      );
    }
    const url = extractUrl(stdout);
    if (!url) throw new Error(`gh pr create produced no URL. stdout: ${stdout}`);
    return url;
  }

  private async openViaApi(opts: OpenPROptions, token: string): Promise<string> {
    const remote = await this.detectRemote();
    const url = `https://api.github.com/repos/${remote.owner}/${remote.repo}/pulls`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: opts.title,
        body: opts.body,
        head: opts.head,
        base: opts.base,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API ${res.status}: ${text}`);
    }
    const parsed = (await res.json()) as { html_url?: string };
    if (!parsed.html_url) throw new Error('GitHub API response missing html_url.');
    return parsed.html_url;
  }

  private async detectRemote(): Promise<{ owner: string; repo: string }> {
    const { code, stdout, stderr } = await this.runCapture('git', [
      'config',
      '--get',
      'remote.origin.url',
    ]);
    if (code !== 0) {
      throw new Error(`Could not detect origin remote: ${stderr.trim()}`);
    }
    const parsed = parseGitHubRemote(stdout.trim());
    if (!parsed) {
      throw new Error(`Remote URL ${stdout.trim()} doesn't look like a GitHub repo.`);
    }
    return parsed;
  }

  private runCapture(
    command: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = this.spawn(command, args, {
          cwd: this.deps.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(err);
        return;
      }
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (c: Buffer) => {
        stdout += c.toString('utf-8');
      });
      proc.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString('utf-8');
      });
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) =>
        resolve({ code: code ?? -1, stdout, stderr }),
      );
    });
  }
}

function extractUrl(text: string): string | null {
  const m = /https?:\/\/[^\s]+/.exec(text);
  return m ? m[0].replace(/[)\].,]+$/, '') : null;
}

export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  // Supports:
  //   git@github.com:owner/repo.git
  //   https://github.com/owner/repo
  //   https://github.com/owner/repo.git
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const https =
    /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}
