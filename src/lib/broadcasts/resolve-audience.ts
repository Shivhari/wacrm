// ============================================================
// Turn an `AudienceConfig` into the full contact rows a broadcast
// will send to. Every read pages through PostgREST, so an audience
// larger than `max-rows` (1000) is resolved in full — a plain
// `.select('*')` once capped a 2 270-contact "all" broadcast at 1 000
// and reported success.
//
// CSV audiences are not handled here: they need the caller's session
// (to insert missing contacts) and stay in the hook.
// ============================================================

import { fetchAllIn, fetchAllRows } from '@/lib/supabase/fetch-all';
import type { Contact } from '@/types';

import type { AudienceConfig, AudienceDb } from './audience';
import {
  contactIdsForCustomField,
  contactIdsForTags,
  isCompleteCustomFieldFilter,
} from './audience-ids';

/**
 * Resolve every contact in a non-CSV audience, exclusion tags applied.
 * Returns `[]` for a partially configured audience (no tags picked,
 * incomplete custom-field rule) and for `csv`, which the caller
 * resolves itself. The result never holds the same contact twice: a
 * duplicate here becomes two recipient rows and two WhatsApp sends.
 */
export async function resolveAudienceContacts(
  db: AudienceDb,
  audience: AudienceConfig,
): Promise<Contact[]> {
  let contacts: Contact[] = [];

  if (audience.type === 'all') {
    contacts = (await fetchAllRows(() => db.from('contacts').select('*'))) as Contact[];
  } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
    const ids = await contactIdsForTags(db, audience.tagIds);
    contacts = await contactsByIds(db, [...ids]);
  } else if (
    audience.type === 'custom_field' &&
    audience.customField &&
    isCompleteCustomFieldFilter(audience.customField)
  ) {
    const ids = await contactIdsForCustomField(db, audience.customField);
    contacts = await contactsByIds(db, [...ids]);
  }

  return applyExcludeTags(db, uniqueById(contacts), audience.excludeTagIds);
}

/** Keep the first row per id. Paging is keyset so this is belt and braces. */
function uniqueById(contacts: Contact[]): Contact[] {
  const seen = new Set<string>();
  return contacts.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

/** Full rows for a (possibly long) list of contact ids. */
export async function contactsByIds(db: AudienceDb, ids: readonly string[]): Promise<Contact[]> {
  if (ids.length === 0) return [];
  return (await fetchAllIn(ids, (chunk) =>
    db.from('contacts').select('*').in('id', chunk),
  )) as Contact[];
}

/**
 * Drop every contact carrying any of `excludeTagIds`. Works for every
 * contact-derived audience; the CSV path calls it too once its rows
 * exist.
 */
export async function applyExcludeTags(
  db: AudienceDb,
  contacts: Contact[],
  excludeTagIds: readonly string[] | undefined,
): Promise<Contact[]> {
  if (!excludeTagIds || excludeTagIds.length === 0 || contacts.length === 0) {
    return contacts;
  }
  const excluded = await contactIdsForTags(db, excludeTagIds);
  return contacts.filter((c) => !excluded.has(c.id));
}
