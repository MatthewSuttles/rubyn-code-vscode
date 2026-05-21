/**
 * In-memory index of `db/schema.rb`. One source of truth for column
 * metadata; consumed by query-method completion (Phase 1) and later by
 * diagnostics + megaplan (Phases 4 and 6).
 *
 * Parsing is regex-based by design: schema.rb is machine-generated and
 * follows a strict template, so reaching for Prism would be overkill and
 * adds a runtime dep the extension does not otherwise need.
 */

export interface ColumnInfo {
  name: string;
  /** SQL type as written in schema.rb — e.g. "string", "integer", "bigint". */
  sqlType: string;
  nullable: boolean;
  /** Raw default expression from the schema line, or null when absent. */
  default: string | null;
  isPrimary: boolean;
}

const TABLE_OPENER = /^\s*create_table\s+["'](\w+)["'](.*)$/;
const COLUMN_LINE = /^\s*t\.(\w+)\s*(.*)$/;
const TABLE_END = /^\s*end\s*$/;

/** `t.<method>` calls that do not declare a column. */
const NON_COLUMN_METHODS = new Set([
  'index',
  'foreign_key',
  'check_constraint',
  'comment',
]);

export class SchemaIndex {
  private readonly tablesByName: Map<string, ColumnInfo[]>;

  private constructor(tables: Map<string, ColumnInfo[]>) {
    this.tablesByName = tables;
  }

  /** Empty index — returned when schema.rb is missing. */
  static empty(): SchemaIndex {
    return new SchemaIndex(new Map());
  }

  static parse(source: string): SchemaIndex {
    const tables = new Map<string, ColumnInfo[]>();
    const lines = source.split('\n');

    let currentTable: { name: string; columns: ColumnInfo[] } | null = null;

    for (const rawLine of lines) {
      const line = stripComment(rawLine);

      if (currentTable === null) {
        const opener = TABLE_OPENER.exec(line);
        if (!opener) continue;
        const [, tableName, opts] = opener;
        const columns = implicitPrimaryKey(opts);
        currentTable = { name: tableName, columns };
        continue;
      }

      if (TABLE_END.test(line)) {
        tables.set(currentTable.name, currentTable.columns);
        currentTable = null;
        continue;
      }

      const colMatch = COLUMN_LINE.exec(line);
      if (!colMatch) continue;
      const [, method, rest] = colMatch;

      if (NON_COLUMN_METHODS.has(method)) continue;

      if (method === 'timestamps') {
        currentTable.columns.push(
          column('created_at', 'datetime', { nullable: false }),
          column('updated_at', 'datetime', { nullable: false }),
        );
        continue;
      }

      if (method === 'references' || method === 'belongs_to') {
        const refName = firstQuotedArg(rest);
        if (!refName) continue;
        const opts = parseColumnOptions(rest);
        currentTable.columns.push(
          column(`${refName}_id`, 'bigint', { nullable: opts.nullable ?? true }),
        );
        if (/polymorphic:\s*true/.test(rest)) {
          currentTable.columns.push(
            column(`${refName}_type`, 'string', { nullable: opts.nullable ?? true }),
          );
        }
        continue;
      }

      const name = firstQuotedArg(rest);
      if (!name) continue;
      const opts = parseColumnOptions(rest);
      currentTable.columns.push(
        column(name, method, {
          nullable: opts.nullable ?? true,
          default: opts.default ?? null,
          isPrimary: opts.isPrimary ?? false,
        }),
      );
    }

    return new SchemaIndex(tables);
  }

  tables(): string[] {
    return Array.from(this.tablesByName.keys());
  }

  hasTable(name: string): boolean {
    return this.tablesByName.has(name);
  }

  columnsFor(name: string): ColumnInfo[] | undefined {
    return this.tablesByName.get(name);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripComment(line: string): string {
  const hashIdx = line.indexOf('#');
  return hashIdx === -1 ? line : line.slice(0, hashIdx);
}

function column(
  name: string,
  sqlType: string,
  opts: { nullable?: boolean; default?: string | null; isPrimary?: boolean } = {},
): ColumnInfo {
  return {
    name,
    sqlType,
    nullable: opts.nullable ?? true,
    default: opts.default ?? null,
    isPrimary: opts.isPrimary ?? false,
  };
}

function firstQuotedArg(text: string): string | null {
  const m = /^["'](\w+)["']/.exec(text);
  return m ? m[1] : null;
}

interface ColumnOptions {
  nullable?: boolean;
  default?: string | null;
  isPrimary?: boolean;
}

function parseColumnOptions(text: string): ColumnOptions {
  const opts: ColumnOptions = {};

  const nullMatch = /\bnull:\s*(true|false)\b/.exec(text);
  if (nullMatch) opts.nullable = nullMatch[1] === 'true';

  const pkMatch = /\bprimary_key:\s*true\b/.exec(text);
  if (pkMatch) opts.isPrimary = true;

  const defaultMatch = /\bdefault:\s*([^,]+?)(?:,|$)/.exec(text);
  if (defaultMatch) opts.default = defaultMatch[1].trim();

  return opts;
}

/**
 * Returns the implicit primary-key columns Rails would add for a
 * `create_table` block, based on the options trailing the table name.
 *
 * Default: a single `id` bigint PK column. `id: false` skips it. `id: :uuid`
 * (or any other symbol/string) sets the SQL type. `primary_key: ["a","b"]`
 * indicates a composite PK declared explicitly via column lines — no
 * implicit `id`.
 */
function implicitPrimaryKey(tableOpts: string): ColumnInfo[] {
  if (/\bid:\s*false\b/.test(tableOpts)) return [];
  if (/\bprimary_key:\s*\[/.test(tableOpts)) return [];

  const idTypeMatch = /\bid:\s*:(\w+)\b/.exec(tableOpts);
  const sqlType = idTypeMatch ? idTypeMatch[1] : 'bigint';

  const customPk = /\bprimary_key:\s*["'](\w+)["']/.exec(tableOpts);
  const name = customPk ? customPk[1] : 'id';

  return [column(name, sqlType, { nullable: false, isPrimary: true })];
}
