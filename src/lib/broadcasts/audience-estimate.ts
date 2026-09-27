// ============================================================
// Recipient count shown by the wizard before a send. One
// implementation for both the audience step and the review step,
// so the two never disagree (the review step once ignored exclusion
// tags and showed 2 443 for a 1 443-contact send).
// ============================================================

import type { AudienceConfig, AudienceDb } from './audience';
import {
  contactIdsForCustomField,
  contactIdsForTags,
  isCompleteCustomFieldFilter,
} from './audience-ids';

/**
 * How many contacts the audience currently resolves to, or `null`
 * while it is only partly configured (no tag picked, empty
 * custom-field value, empty CSV).
 */
export async function estimateAudienceCount(
  db: AudienceDb,
  audience: AudienceConfig,
): Promise<number | null> {
  let baseIds: Set<string> | null = null;

  if (audience.type === 'all') {
    // Fall through: total comes from a HEAD count, exclusion below.
  } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
    baseIds = await contactIdsForTags(db, audience.tagIds);
  } else if (
    audience.type === 'custom_field' &&
    audience.customField &&
    isCompleteCustomFieldFilter(audience.customField)
  ) {
    baseIds = await contactIdsForCustomField(db, audience.customField);
  } else if (audience.type === 'csv' && audience.csvContacts && audience.csvContacts.length > 0) {
    // Mirror upsertCsvContacts: blank phones are dropped, duplicates
    // collapse to one contact. Exclusion tags are applied at send
    // time once the CSV rows exist as contacts, so they are not
    // reflected here.
    return new Set(audience.csvContacts.map((r) => r.phone).filter(Boolean)).size;
  } else {
    return null;
  }

  const excluded =
    audience.excludeTagIds && audience.excludeTagIds.length > 0
      ? await contactIdsForTags(db, audience.excludeTagIds)
      : null;

  if (baseIds) {
    if (!excluded) return baseIds.size;
    let n = 0;
    for (const id of baseIds) if (!excluded.has(id)) n++;
    return n;
  }

  // "All": count server-side, then subtract the excluded set. Every
  // excluded id is a real contact (contact_tags cascades on delete),
  // so the subtraction is exact.
  const { count, error } = await db.from('contacts').select('*', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  const total = count ?? 0;
  return excluded ? Math.max(0, total - excluded.size) : total;
}
