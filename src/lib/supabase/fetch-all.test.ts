import { describe, expect, it } from 'vitest';

import { fetchAllRows, fetchAllIn, MAX_PAGES, type PageQuery } from './fetch-all';

interface Row {
  id: string;
  group?: string;
}

interface FakeOpts {
  /** Server-side cap, like PostgREST `max-rows`. */
  maxRows?: number;
  /** Fail the Nth query (0-based). */
  failOnQuery?: number;
  /** Ignore the keyset cursor entirely (a builder that drops `.gt`). */
  ignoreCursor?: boolean;
  /** Called after each page is served; may mutate `rows` (live inserts). */
  afterPage?: (pageIndex: number, rows: Row[]) => void;
}

/**
 * In-memory stand-in for a PostgREST builder, keyset flavour: honours
 * `.order(col)`, `.gt(col, v)` and `.limit(n)`, and silently truncates
 * to `maxRows` exactly like PostgREST's `max-rows` does.
 */
function fakeTable(rows: Row[], opts: FakeOpts = {}) {
  const calls: { after: string | null; limit: number | null; order?: string }[] = [];

  const makeQuery = (): PageQuery<Row> => {
    let order: string | undefined;
    let after: string | null = null;
    let limit: number | null = null;
    const q: PageQuery<Row> = {
      order(column) {
        order = column;
        return q;
      },
      gt(column, value) {
        if (column !== order) throw new Error('fake: gt column must match order column');
        after = String(value);
        return q;
      },
      limit(n) {
        limit = n;
        return q;
      },
      then(onfulfilled, onrejected) {
        calls.push({ after, limit, order });
        const idx = calls.length - 1;
        if (opts.failOnQuery === idx) {
          return Promise.resolve({ data: null, error: { message: 'boom' } }).then(
            onfulfilled,
            onrejected,
          );
        }
        const key = (order ?? 'id') as keyof Row;
        let page = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
        if (after !== null && !opts.ignoreCursor) {
          page = page.filter((r) => String(r[key]) > after!);
        }
        if (limit !== null) page = page.slice(0, limit);
        if (opts.maxRows !== undefined) page = page.slice(0, opts.maxRows);
        opts.afterPage?.(idx, rows);
        return Promise.resolve({ data: page, error: null }).then(onfulfilled, onrejected);
      },
    };
    return q;
  };

  return { calls, makeQuery };
}

function rowsOf(n: number, group?: string): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i).padStart(5, '0'),
    group,
  }));
}

describe('fetchAllRows', () => {
  it('returns every row when the table is bigger than one page', async () => {
    const table = fakeTable(rowsOf(2270));
    const out = await fetchAllRows(table.makeQuery, { pageSize: 1000 });
    expect(out).toHaveLength(2270);
    expect(new Set(out.map((r) => r.id)).size).toBe(2270);
  });

  it('pages by keyset: each request starts after the last id seen', async () => {
    const table = fakeTable(rowsOf(2270));
    await fetchAllRows(table.makeQuery, { pageSize: 1000 });
    expect(table.calls.map((c) => c.after)).toEqual([null, '00999', '01999', '02269']);
    expect(table.calls.every((c) => c.limit === 1000 && c.order === 'id')).toBe(true);
  });

  it('stops only on an empty page, so a short page is not mistaken for the end', async () => {
    // Server cap lower than the requested page: 1500 rows, 500 per response.
    const table = fakeTable(rowsOf(1500), { maxRows: 500 });
    const out = await fetchAllRows(table.makeQuery, { pageSize: 1000 });
    expect(out).toHaveLength(1500);
  });

  it('returns an empty list for an empty table', async () => {
    const table = fakeTable([]);
    expect(await fetchAllRows(table.makeQuery, { pageSize: 1000 })).toEqual([]);
  });

  it('does not return a row twice when rows are inserted mid-read', async () => {
    // A row inserted with a key that sorts before the cursor would shift
    // an offset window and re-serve the last row of the previous page.
    const rows = rowsOf(2000);
    const table = fakeTable(rows, {
      afterPage: (i, r) => {
        if (i === 0) r.push({ id: '00000-early' }, { id: '0000-earlier' });
      },
    });
    const out = await fetchAllRows(table.makeQuery, { pageSize: 1000 });
    expect(new Set(out.map((r) => r.id)).size).toBe(out.length);
    expect(out.filter((r) => r.id === '00999')).toHaveLength(1);
  });

  it('never asks for a page larger than the server cap', async () => {
    const table = fakeTable(rowsOf(5));
    await fetchAllRows(table.makeQuery, { pageSize: 5000 });
    expect(table.calls[0].limit).toBe(1000);
  });

  it('throws on a query error instead of returning a partial list', async () => {
    const table = fakeTable(rowsOf(2500), { failOnQuery: 1 });
    await expect(fetchAllRows(table.makeQuery, { pageSize: 1000 })).rejects.toThrow('boom');
  });

  it('throws instead of looping forever on a builder that ignores the cursor', async () => {
    const table = fakeTable(rowsOf(1000), { ignoreCursor: true });
    await expect(fetchAllRows(table.makeQuery, { pageSize: 1000 })).rejects.toThrow(/pages/);
    expect(table.calls.length).toBeLessThanOrEqual(MAX_PAGES + 1);
  });

  it('throws when a row lacks the ordering key, rather than paging blind', async () => {
    const table = fakeTable([{ id: '1' }]);
    await expect(
      fetchAllRows(table.makeQuery, { pageSize: 1000, orderBy: 'missing' }),
    ).rejects.toThrow(/missing/);
  });
});

describe('fetchAllIn', () => {
  it('splits a long id list into chunks and pages each chunk', async () => {
    const ids = rowsOf(1200).map((r) => r.id);
    const rows: Row[] = ids.flatMap((id) => [
      { id: `${id}-a`, group: id },
      { id: `${id}-b`, group: id },
    ]);
    const chunksSeen: string[][] = [];
    const out = await fetchAllIn(
      ids,
      (chunk) => {
        chunksSeen.push(chunk);
        return fakeTable(rows.filter((r) => chunk.includes(r.group!))).makeQuery();
      },
      { chunkSize: 500, pageSize: 1000 },
    );
    expect(out).toHaveLength(2400);
    const distinctChunks = [...new Set(chunksSeen.map((c) => c.join(',')))];
    expect(distinctChunks.map((c) => c.split(',').length)).toEqual([500, 500, 200]);
  });

  it('returns an empty list without querying when there are no ids', async () => {
    let called = false;
    const out = await fetchAllIn([], () => {
      called = true;
      return fakeTable([]).makeQuery();
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});
