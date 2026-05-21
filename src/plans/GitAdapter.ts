/**
 * Shells out to the `git` CLI. No libgit2 dep — every Rails dev already has
 * git, and the surface we need is tiny. Each method throws on non-zero
 * exit so PlanManager can transition the plan to `failed` cleanly.
 */

import { spawn as nodeSpawn, ChildProcess, SpawnOptions } from 'node:child_process';

export type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

export interface GitAdapterDeps {
  cwd: string;
  /** Test seam — defaults to node:child_process.spawn. */
  spawn?: SpawnFn;
}

export class GitAdapter {
  private readonly spawn: SpawnFn;

  constructor(private readonly deps: GitAdapterDeps) {
    this.spawn = deps.spawn ?? (nodeSpawn as SpawnFn);
  }

  async branch(name: string, base?: string): Promise<void> {
    const args = base ? ['checkout', '-b', name, base] : ['checkout', '-b', name];
    await this.run('git', args);
  }

  async checkout(name: string): Promise<void> {
    await this.run('git', ['checkout', name]);
  }

  async add(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.run('git', ['add', '--', ...paths]);
  }

  async commit(message: string): Promise<void> {
    await this.run('git', ['commit', '-m', message]);
  }

  async push(branch: string, remote = 'origin'): Promise<void> {
    await this.run('git', ['push', '-u', remote, branch]);
  }

  async currentBranch(): Promise<string> {
    const { stdout } = await this.run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim();
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const { stdout } = await this.run('git', ['status', '--porcelain']);
    return stdout.trim().length > 0;
  }

  private run(
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = this.spawn(command, args, {
        cwd: this.deps.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else
          reject(
            new Error(
              `git ${args.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`,
            ),
          );
      });
    });
  }
}
