/**
 * Soft performance budget: parsing a 100-table schema must finish well under
 * 500ms (Phase 1 Req 2.5). Generated fixture in-test to keep the repo small.
 */

import { describe, it, expect } from 'vitest';
import { SchemaIndex } from '../../../src/rails/SchemaIndex';

function generateSchema(tableCount: number): string {
  const lines: string[] = ['ActiveRecord::Schema[7.1].define(version: 1) do'];
  for (let i = 0; i < tableCount; i += 1) {
    lines.push(`  create_table "table_${i}", force: :cascade do |t|`);
    lines.push('    t.string "name", null: false');
    lines.push('    t.string "slug"');
    lines.push('    t.integer "rank", default: 0');
    lines.push('    t.boolean "active", default: true');
    lines.push('    t.text "body"');
    lines.push('    t.references "owner", null: false');
    lines.push('    t.timestamps');
    lines.push('    t.index ["slug"], unique: true');
    lines.push('  end');
  }
  lines.push('end');
  return lines.join('\n');
}

describe('SchemaIndex.parse — performance', () => {
  it('parses a 100-table schema in under 500ms', () => {
    const source = generateSchema(100);
    const t0 = performance.now();
    const idx = SchemaIndex.parse(source);
    const elapsed = performance.now() - t0;

    expect(idx.tables()).toHaveLength(100);
    expect(idx.columnsFor('table_42')!.length).toBeGreaterThan(5);
    expect(elapsed).toBeLessThan(500);
  });
});
