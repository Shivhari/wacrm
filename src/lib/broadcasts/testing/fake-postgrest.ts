// ============================================================
// In-memory stand-in for the slice of `supabase.from(...)` that the
// broadcast audience code uses. Reproduces the one server behaviour
// the code must survive: PostgREST silently truncates every response
// to `max-rows` (1000). A read that isn't paginated passes against a
// naive fake and fails in production, so this one truncates too.
// ============================================================

export const FAKE_MAX_ROWS = 1000;

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

export interface FakeTables {
  [table: string]: Row[];
}

interface Result {
  data: Row[] | null;
  error: { message: string } | null;
  count: number | null;
}

class FakeBuilder implements PromiseLike<Result> {
  private readonly predicates: Predicate[] = [];
  private orderBy: string | null = null;
  private rangeFrom = 0;
  private rangeTo: number | null = null;
  private after: { column: string; value: string } | null = null;
  private limitN: number | null = null;
  private wantCount = false;
  private headOnly = false;

  constructor(
    private readonly rows: Row[],
    private readonly log: string[],
    private readonly table: string,
    private readonly hooks: FakeHooks,
  ) {}

  select(_columns?: string, opts?: { count?: 'exact'; head?: boolean }) {
    this.wantCount = opts?.count === 'exact';
    this.headOnly = opts?.head === true;
    return this;
  }

  eq(column: string, value: unknown) {
    this.predicates.push((r) => r[column] === value);
    return this;
  }

  neq(column: string, value: unknown) {
    this.predicates.push((r) => r[column] !== value);
    return this;
  }

  ilike(column: string, pattern: string) {
    const needle = pattern.replace(/^%|%$/g, '').toLowerCase();
    this.predicates.push((r) => String(r[column] ?? '').toLowerCase().includes(needle));
    return this;
  }

  in(column: string, values: readonly unknown[]) {
    const set = new Set(values);
    this.predicates.push((r) => set.has(r[column]));
    return this;
  }

  order(column: string) {
    this.orderBy = column;
    return this;
  }

  gt(column: string, value: unknown) {
    this.after = { column, value: String(value) };
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  private run(): Result {
    let rows = this.rows.filter((r) => this.predicates.every((p) => p(r)));
    const count = this.wantCount ? rows.length : null;
    if (this.headOnly) {
      this.log.push(`${this.table}:head`);
      return { data: null, error: null, count };
    }
    if (this.orderBy) {
      const key = this.orderBy;
      rows = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
    }
    if (this.after) {
      const { column, value } = this.after;
      rows = rows.filter((r) => String(r[column]) > value);
    }
    if (this.rangeTo !== null) rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    // The behaviour under test: PostgREST's max-rows cap.
    rows = rows.slice(0, FAKE_MAX_ROWS);
    this.log.push(`${this.table}:${rows.length}`);
    this.hooks.afterQuery?.(this.table, this.rows);
    return { data: rows, error: null, count };
  }

  then<R1 = Result, R2 = never>(
    onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

/**
 * Build a fake client. `log` records one entry per executed query
 * (`table:rowsReturned` or `table:head`) so tests can assert on how
 * the data was fetched, not only on what came back.
 */
export interface FakeHooks {
  /** Runs after every executed query; may mutate the table (live inserts). */
  afterQuery?: (table: string, rows: Row[]) => void;
}

export function fakePostgrest(tables: FakeTables, hooks: FakeHooks = {}) {
  const log: string[] = [];
  const client = {
    from(table: string) {
      if (!tables[table]) tables[table] = [];
      return new FakeBuilder(tables[table], log, table, hooks);
    },
  };
  return { client, log };
}

/** `n` contacts with ids `c00000`…, all on one account. */
export function fakeContacts(n: number, accountId = 'acc-1'): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${String(i).padStart(5, '0')}`,
    account_id: accountId,
    user_id: 'user-1',
    phone: `+1${String(i).padStart(9, '0')}`,
    name: `Contact ${i}`,
  }));
}
