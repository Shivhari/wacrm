// ============================================================
// Paginated reads for PostgREST.
//
// Supabase's PostgREST silently caps any SELECT at `max-rows`
// (default 1000). A plain `.select('*')` on a table with 2 270 rows
// returns 1 000 with no error, which is how a broadcast to "all
// contacts" once sent to 1 000 of them and reported success. Every
// read whose size is driven by user data goes through here.
//
// Pages are keyset, not offset: each request asks for rows whose key
// is greater than the last one seen. An offset window shifts when a
// row is inserted or deleted mid-read (the inbound webhook creates
// contacts at any time), which re-serves or skips a row at the page
// boundary; a keyset cursor cannot. The loop ends only on an empty
// page, so a response shorter than requested (a lower server cap)
// is just another page, never mistaken for the end.
// ============================================================

/**
 * PostgREST's default `max-rows`. A page larger than this is silently
 * truncated to it; asking for more is pointless, so the page size is
 * clamped here.
 */
export const POSTGREST_MAX_ROWS = 1000;

/**
 * Upper bound on ids per `.in(...)` clause. The list is serialised
 * into the URL, and past a few hundred UUIDs it risks the URL length
 * limit; 500 stays well clear.
 */
export const IN_CHUNK_SIZE = 500;

/**
 * Hard stop on pages per read. A builder that ignores the cursor (an
 * RPC, a view, a bad mock) would otherwise loop forever from a browser
 * tab. 10 000 pages × 1 000 rows is far beyond any audience here.
 */
export const MAX_PAGES = 10_000;

/**
 * The slice of a PostgREST builder this module needs. Structurally
 * satisfied by `supabase.from(...).select(...)` and everything
 * chained off it; a fake in tests satisfies it too.
 */
export interface PageQuery<T> {
  order(column: string, opts?: { ascending?: boolean }): PageQuery<T>;
  gt(column: string, value: string | number): PageQuery<T>;
  limit(count: number): PageQuery<T>;
  then<R1 = PageResult<T>, R2 = never>(
    onfulfilled?: ((value: PageResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2>;
}

export interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export interface FetchAllOptions {
  /** Rows per page. Clamped to {@link POSTGREST_MAX_ROWS}. */
  pageSize?: number;
  /**
   * Unique column that orders the read and carries the cursor. It
   * must be selected, since the cursor is read off the returned rows,
   * and unique, or rows sharing a value could be skipped. Defaults to
   * `id`.
   */
  orderBy?: string;
}

/**
 * Read a whole result set, one keyset page at a time, until a page
 * comes back empty. `makeQuery` must return a *fresh* builder on each
 * call — PostgREST builders accumulate their query string, so re-using
 * one across pages would stack `order`/`gt` params.
 */
export async function fetchAllRows<T>(
  makeQuery: () => PageQuery<T>,
  options: FetchAllOptions = {},
): Promise<T[]> {
  const pageSize = Math.min(options.pageSize ?? POSTGREST_MAX_ROWS, POSTGREST_MAX_ROWS);
  const orderBy = options.orderBy ?? 'id';
  const out: T[] = [];
  let cursor: string | number | null = null;

  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) {
      throw new Error(`fetchAllRows: gave up after ${MAX_PAGES} pages ordered by "${orderBy}"`);
    }

    let q = makeQuery().order(orderBy, { ascending: true }).limit(pageSize);
    if (cursor !== null) q = q.gt(orderBy, cursor);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    if (rows.length === 0) break;

    out.push(...rows);

    const last = (rows[rows.length - 1] as Record<string, unknown>)[orderBy];
    if (typeof last !== 'string' && typeof last !== 'number') {
      throw new Error(
        `fetchAllRows: ordering key "${orderBy}" is missing from the selected columns`,
      );
    }
    cursor = last;
  }

  return out;
}

export interface FetchAllInOptions extends FetchAllOptions {
  /** Ids per `.in(...)` clause. Defaults to {@link IN_CHUNK_SIZE}. */
  chunkSize?: number;
}

/**
 * Read every row matching a long id list: the list is split into
 * chunks small enough for one `.in(...)` clause, and each chunk's
 * result is paginated with {@link fetchAllRows} (a chunk of 500
 * contacts can still own more than 1 000 child rows).
 */
export async function fetchAllIn<T>(
  ids: readonly string[],
  makeQuery: (chunk: string[]) => PageQuery<T>,
  options: FetchAllInOptions = {},
): Promise<T[]> {
  const chunkSize = options.chunkSize ?? IN_CHUNK_SIZE;
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    out.push(...(await fetchAllRows(() => makeQuery(chunk), options)));
  }
  return out;
}
