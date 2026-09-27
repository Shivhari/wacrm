// ============================================================
// Contact-id readers behind the audience picker. Each one pages
// through PostgREST (see `fetch-all.ts`), so a tag or custom-field
// audience larger than one page is read in full. Every read selects
// and orders by the row's own primary key, which the keyset cursor
// needs to be unique.
// ============================================================

import { fetchAllIn, fetchAllRows } from '@/lib/supabase/fetch-all';

import type { AudienceDb, CustomFieldFilter } from './audience';

/** Distinct contact ids carrying any of `tagIds`. */
export async function contactIdsForTags(
  db: AudienceDb,
  tagIds: readonly string[],
): Promise<Set<string>> {
  if (tagIds.length === 0) return new Set();
  const rows = await fetchAllIn(tagIds, (chunk) =>
    db.from('contact_tags').select('id, contact_id').in('tag_id', chunk),
  );
  return new Set(rows.map((r) => r.contact_id as string));
}

/** True when the rule has both a field and a value to match against. */
export function isCompleteCustomFieldFilter(filter: CustomFieldFilter | undefined): boolean {
  return Boolean(filter?.fieldId && filter.value);
}

/**
 * Distinct contact ids whose value for the field matches the rule.
 * Callers check {@link isCompleteCustomFieldFilter} first: an empty
 * value with `contains` would be `ilike '%%'`, every contact with the
 * field, and an empty field id fails the uuid cast server-side.
 */
export async function contactIdsForCustomField(
  db: AudienceDb,
  filter: CustomFieldFilter,
): Promise<Set<string>> {
  const { fieldId, operator, value } = filter;
  const rows = await fetchAllRows(() => {
    let q = db
      .from('contact_custom_values')
      .select('id, contact_id')
      .eq('custom_field_id', fieldId);
    if (operator === 'is') q = q.eq('value', value);
    else if (operator === 'is_not') q = q.neq('value', value);
    else q = q.ilike('value', `%${value}%`);
    return q;
  });
  return new Set(rows.map((r) => r.contact_id as string));
}
