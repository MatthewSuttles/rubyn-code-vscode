/**
 * Threshold cascade for complexity diagnostics. Reads VS Code settings first,
 * then overlays per-project values from `.rubyn-code/diagnostics.yml` if the
 * file exists. Treating 0 as "disabled" lets users silence one signal
 * without flipping the master switch.
 *
 * YAML support is a hand-written `key: value` parser — the override file is
 * just thresholds, so reaching for js-yaml would be over-engineering.
 */

import * as vscode from 'vscode';

export interface ThresholdConfig {
  enabled: boolean;
  methodCountThreshold: number;
  lcomMinMethods: number;
  fanOutThreshold: number;
  cyclomaticThreshold: number;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  enabled: true,
  methodCountThreshold: 15,
  lcomMinMethods: 5,
  fanOutThreshold: 10,
  cyclomaticThreshold: 8,
};

export async function loadThresholds(
  root: vscode.Uri,
): Promise<ThresholdConfig> {
  const settings = readFromSettings();
  const yml = await readFromYml(root);
  return { ...DEFAULT_THRESHOLDS, ...yml, ...settings };
}

function readFromSettings(): Partial<ThresholdConfig> {
  const cfg = vscode.workspace.getConfiguration('rubyn-code.diagnostics');
  const out: Partial<ThresholdConfig> = {};
  const enabled = cfg.get<boolean>('enabled');
  if (enabled !== undefined) out.enabled = enabled;
  const method = cfg.get<number>('methodCountThreshold');
  if (method !== undefined) out.methodCountThreshold = method;
  const lcom = cfg.get<number>('lcomMinMethods');
  if (lcom !== undefined) out.lcomMinMethods = lcom;
  const fan = cfg.get<number>('fanOutThreshold');
  if (fan !== undefined) out.fanOutThreshold = fan;
  const cyc = cfg.get<number>('cyclomaticThreshold');
  if (cyc !== undefined) out.cyclomaticThreshold = cyc;
  return out;
}

async function readFromYml(root: vscode.Uri): Promise<Partial<ThresholdConfig>> {
  const ymlUri = vscode.Uri.joinPath(root, '.rubyn-code', 'diagnostics.yml');
  let text: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(ymlUri);
    text = new TextDecoder().decode(bytes);
  } catch {
    return {};
  }
  return parseSimpleYml(text);
}

const YML_KEYS: ReadonlyArray<keyof ThresholdConfig> = [
  'enabled',
  'methodCountThreshold',
  'lcomMinMethods',
  'fanOutThreshold',
  'cyclomaticThreshold',
];

export function parseSimpleYml(text: string): Partial<ThresholdConfig> {
  const out: Partial<ThresholdConfig> = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1] as keyof ThresholdConfig;
    if (!YML_KEYS.includes(key)) continue;
    const valueText = m[2].trim();
    if (key === 'enabled') {
      out.enabled = /^(true|yes|on)$/i.test(valueText);
    } else {
      const n = parseInt(valueText, 10);
      if (!Number.isNaN(n)) (out as Record<string, number>)[key] = n;
    }
  }
  return out;
}
