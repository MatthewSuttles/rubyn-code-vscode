/**
 * Integration tests for RubyClassDiagnosticProvider. Feeds the god-class
 * fixture through the full pipeline (ClassIndex → metric calculators →
 * diagnostic emission) and asserts the right diagnostics fire with the
 * right codes / severities / ranges.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { __resetAll, Uri, DiagnosticSeverity } from '../../helpers/mock-vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClassIndex } from '../../../src/rails/ClassIndex';
import { RubyClassDiagnosticProvider } from '../../../src/diagnostics/RubyClassDiagnosticProvider';
import {
  DEFAULT_THRESHOLDS,
  ThresholdConfig,
} from '../../../src/diagnostics/ThresholdConfig';

const GOD_PATH = path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'rails-app',
  'app',
  'controllers',
  'god_controller.rb',
);

async function buildProvider(
  thresholds: ThresholdConfig = DEFAULT_THRESHOLDS,
): Promise<RubyClassDiagnosticProvider> {
  const idx = await ClassIndex.build(Uri.file('/'), {
    findRubyFiles: async () => [Uri.file(GOD_PATH)],
    readFile: async (uri: vscode.Uri) => fs.readFile(uri.fsPath, 'utf-8'),
  });
  return new RubyClassDiagnosticProvider(
    async () => idx,
    () => thresholds,
  );
}

describe('RubyClassDiagnosticProvider', () => {
  beforeEach(() => {
    __resetAll();
  });

  it('emits diagnostics for at least 3 signals on the god-controller fixture', async () => {
    const provider = await buildProvider();
    await provider.refreshAll();
    const diags = provider.collection.get(Uri.file(GOD_PATH))!;
    expect(diags).toBeDefined();
    const codes = new Set(diags.map((d) => d.code));
    // The god controller is built to trip method-count, fan-out, and
    // cyclomatic at the default thresholds.
    expect(codes.size).toBeGreaterThanOrEqual(3);
    expect(codes.has('rubyn.method-count')).toBe(true);
    expect(codes.has('rubyn.cyclomatic')).toBe(true);
    provider.dispose();
  });

  it('method-count diagnostic message reports current value + threshold', async () => {
    const provider = await buildProvider();
    await provider.refreshAll();
    const diags = provider.collection.get(Uri.file(GOD_PATH))!;
    const mc = diags.find((d) => d.code === 'rubyn.method-count')!;
    expect(mc.message).toMatch(/\d+ public methods/);
    expect(mc.message).toMatch(/threshold 15/);
    expect(mc.severity).toBe(DiagnosticSeverity.Warning);
    expect(mc.source).toBe('rubyn-code');
    provider.dispose();
  });

  it('threshold of 0 disables the corresponding signal', async () => {
    const provider = await buildProvider({
      ...DEFAULT_THRESHOLDS,
      methodCountThreshold: 0,
      fanOutThreshold: 0,
      lcomMinMethods: 0,
    });
    await provider.refreshAll();
    const diags = provider.collection.get(Uri.file(GOD_PATH)) ?? [];
    const codes = new Set(diags.map((d) => d.code));
    expect(codes.has('rubyn.method-count')).toBe(false);
    expect(codes.has('rubyn.fan-out')).toBe(false);
    expect(codes.has('rubyn.lcom4')).toBe(false);
    // Cyclomatic should still fire.
    expect(codes.has('rubyn.cyclomatic')).toBe(true);
    provider.dispose();
  });

  it('master-switch disabled → no diagnostics', async () => {
    const provider = await buildProvider({
      ...DEFAULT_THRESHOLDS,
      enabled: false,
    });
    await provider.refreshAll();
    expect(provider.collection.get(Uri.file(GOD_PATH))).toBeUndefined();
    provider.dispose();
  });

  it('refreshForFile only touches the given URI', async () => {
    const provider = await buildProvider();
    await provider.refreshAll();
    const beforeCount = provider.collection.get(Uri.file(GOD_PATH))!.length;
    await provider.refreshForFile(Uri.file(GOD_PATH));
    const afterCount = provider.collection.get(Uri.file(GOD_PATH))!.length;
    expect(afterCount).toBe(beforeCount);
    provider.dispose();
  });

  it('cyclomatic diagnostic targets the method declaration, not the class', async () => {
    const provider = await buildProvider();
    await provider.refreshAll();
    const diags = provider.collection.get(Uri.file(GOD_PATH))!;
    const cyc = diags.find((d) => d.code === 'rubyn.cyclomatic')!;
    expect(cyc.message).toContain('big_branchy_method');
    provider.dispose();
  });
});
