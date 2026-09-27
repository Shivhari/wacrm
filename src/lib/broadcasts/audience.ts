// ============================================================
// Broadcast audience definition, shared by the wizard steps and the
// send hook so every reader of `AudienceConfig` sees the same shape.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/** The slice of a Supabase client the audience readers need. */
export type AudienceDb = Pick<SupabaseClient, 'from'>;
