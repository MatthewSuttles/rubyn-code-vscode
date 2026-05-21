/**
 * Tests for ThresholdConfig — VS Code settings + `.rubyn-code/diagnostics.yml`
 * cascade with defaults.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  __resetAll,
  __setConfig,
  Uri,
} from '../../helpers/mock-vscode';

import {
  DEFAULT_THRESHOLDS,
  loadThresholds,
  parseSimpleYml,
} from '../../../src/diagnostics/ThresholdConfig';

describe('parseSimpleYml', () => {
  it('parses key: value pairs and ignores comments / blank lines', () => {
    const parsed = parseSimpleYml(`
# top comment
methodCountThreshold: 20
lcomMinMethods: 3    # inline comment
fanOutThreshold: 5
cyclomaticThreshold: 12
enabled: false
`);
    expect(parsed).toEqual({
      methodCountThreshold: 20,
      lcomMinMethods: 3,
      fanOutThreshold: 5,
      cyclomaticThreshold: 12,
      enabled: false,
    });
  });

  it('ignores unknown keys', () => {
    expect(parseSimpleYml('bogus: 1\nmethodCountThreshold: 99')).toEqual({
      methodCountThreshold: 99,
    });
  });

  it('handles `enabled: true` / `enabled: yes`', () => {
    expect(parseSimpleYml('enabled: true').enabled).toBe(true);
    expect(parseSimpleYml('enabled: yes').enabled).toBe(true);
    expect(parseSimpleYml('enabled: false').enabled).toBe(false);
  });
});

describe('loadThresholds', () => {
  beforeEach(() => {
    __resetAll();
  });

  it('returns defaults when no settings or yml file', async () => {
    vi.spyOn(vscode.workspace.fs, 'readFile').mockRejectedValue(new Error('ENOENT'));
    const t = await loadThresholds(Uri.file('/app'));
    expect(t).toEqual(DEFAULT_THRESHOLDS);
  });

  it('overlays per-project yml on defaults', async () => {
    vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation(
      async (uri: vscode.Uri) => {
        if (uri.fsPath.endsWith('diagnostics.yml')) {
          return new TextEncoder().encode('methodCountThreshold: 30\n');
        }
        throw new Error('ENOENT');
      },
    );
    const t = await loadThresholds(Uri.file('/app'));
    expect(t.methodCountThreshold).toBe(30);
    expect(t.lcomMinMethods).toBe(DEFAULT_THRESHOLDS.lcomMinMethods);
  });

  it('VS Code settings beat yml', async () => {
    __setConfig('rubyn-code.diagnostics', { methodCountThreshold: 7 });
    vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
      new TextEncoder().encode('methodCountThreshold: 30\n'),
    );
    const t = await loadThresholds(Uri.file('/app'));
    expect(t.methodCountThreshold).toBe(7);
  });

  it('respects disabled master switch from yml', async () => {
    vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(
      new TextEncoder().encode('enabled: false\n'),
    );
    const t = await loadThresholds(Uri.file('/app'));
    expect(t.enabled).toBe(false);
  });
});
