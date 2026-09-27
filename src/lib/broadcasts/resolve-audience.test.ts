import { describe, expect, it } from 'vitest';

import { resolveAudienceContacts } from './resolve-audience';
import { fakeContacts, fakePostgrest, FAKE_MAX_ROWS } from './testing/fake-postgrest';

type Db = Parameters<typeof resolveAudienceContacts>[0];

function tagRows(tagId: string, contactIds: string[]) {
  return contactIds.map((contact_id) => ({ id: `${tagId}:${contact_id}`, contact_id, tag_id: tagId }));
}

describe('resolveAudienceContacts', () => {
  it('returns every contact for "all" when there are more than one page', async () => {
    const contacts = fakeContacts(2270);
    const { client } = fakePostgrest({ contacts });

    const out = await resolveAudienceContacts(client as unknown as Db, { type: 'all' });

    expect(out).toHaveLength(2270);
    expect(new Set(out.map((c) => c.id)).size).toBe(2270);
  });

  it('subtracts excluded tags across the whole audience, not just the first page', async () => {
    const contacts = fakeContacts(2443);
    // Tag the *last* 1000 contacts: a first-page-only read would never
    // see them, and the exclusion would silently no-op.
    const sentIds = contacts.slice(1443).map((c) => c.id as string);
    const { client } = fakePostgrest({
      contacts,
      contact_tags: tagRows('sent-temp', sentIds),
    });

    const out = await resolveAudienceContacts(client as unknown as Db, {
      type: 'all',
      excludeTagIds: ['sent-temp'],
    });

    expect(out).toHaveLength(1443);
    expect(out.some((c) => sentIds.includes(c.id))).toBe(false);
  });

  it('reads every tagged contact for a tag audience, past the row cap', async () => {
    const contacts = fakeContacts(1500);
    const { client } = fakePostgrest({
      contacts,
      contact_tags: tagRows('t1', contacts.map((c) => c.id as string)),
    });

    const out = await resolveAudienceContacts(client as unknown as Db, {
      type: 'tags',
      tagIds: ['t1'],
    });

    expect(out).toHaveLength(1500);
  });

  it('de-duplicates a contact carrying several of the selected tags', async () => {
    const contacts = fakeContacts(3);
    const ids = contacts.map((c) => c.id as string);
    const { client } = fakePostgrest({
      contacts,
      contact_tags: [...tagRows('t1', ids), ...tagRows('t2', ids)],
    });

    const out = await resolveAudienceContacts(client as unknown as Db, {
      type: 'tags',
      tagIds: ['t1', 't2'],
    });

    expect(out).toHaveLength(3);
  });

  it('reads every matching contact for a custom-field audience, past the row cap', async () => {
    const contacts = fakeContacts(1200);
    const { client } = fakePostgrest({
      contacts,
      contact_custom_values: contacts.map((c) => ({
        id: `v-${c.id}`,
        contact_id: c.id,
        custom_field_id: 'f1',
        value: 'Chennai',
      })),
    });

    const out = await resolveAudienceContacts(client as unknown as Db, {
      type: 'custom_field',
      customField: { fieldId: 'f1', operator: 'is', value: 'Chennai' },
    });

    expect(out).toHaveLength(1200);
  });

  it('applies the custom-field operator', async () => {
    const contacts = fakeContacts(3);
    const { client } = fakePostgrest({
      contacts,
      contact_custom_values: [
        { id: 'v0', contact_id: contacts[0].id, custom_field_id: 'f1', value: 'Chennai' },
        { id: 'v1', contact_id: contacts[1].id, custom_field_id: 'f1', value: 'Mumbai' },
        { id: 'v2', contact_id: contacts[2].id, custom_field_id: 'f1', value: 'New Chennai' },
      ],
    });
    const db = client as unknown as Db;

    const is = await resolveAudienceContacts(db, {
      type: 'custom_field',
      customField: { fieldId: 'f1', operator: 'is', value: 'Chennai' },
    });
    expect(is.map((c) => c.id)).toEqual([contacts[0].id]);

    const isNot = await resolveAudienceContacts(db, {
      type: 'custom_field',
      customField: { fieldId: 'f1', operator: 'is_not', value: 'Chennai' },
    });
    expect(isNot.map((c) => c.id).sort()).toEqual([contacts[1].id, contacts[2].id]);

    const contains = await resolveAudienceContacts(db, {
      type: 'custom_field',
      customField: { fieldId: 'f1', operator: 'contains', value: 'chennai' },
    });
    expect(contains.map((c) => c.id).sort()).toEqual([contacts[0].id, contacts[2].id]);
  });

  it('returns nothing for a tag audience with no tags selected', async () => {
    const { client } = fakePostgrest({ contacts: fakeContacts(5) });
    const out = await resolveAudienceContacts(client as unknown as Db, {
      type: 'tags',
      tagIds: [],
    });
    expect(out).toEqual([]);
  });

  it('never returns the same contact twice, even when contacts are inserted mid-read', async () => {
    const contacts = fakeContacts(2000);
    const { client } = fakePostgrest(
      { contacts },
      {
        afterQuery: (table, rows) => {
          // Inbound webhook creates a contact whose id sorts first while
          // page one is in flight — an offset window would re-serve row 999.
          if (table === 'contacts' && rows.length === 2000) {
            rows.push({ id: 'a-first', account_id: 'acc-1', user_id: 'user-1', phone: '+19' });
          }
        },
      },
    );

    const out = await resolveAudienceContacts(client as unknown as Db, { type: 'all' });

    expect(new Set(out.map((c) => c.id)).size).toBe(out.length);
  });

  it('treats an incomplete custom-field rule as no audience, like the estimator', async () => {
    const contacts = fakeContacts(3);
    const { client } = fakePostgrest({
      contacts,
      contact_custom_values: contacts.map((c) => ({
        id: `v-${c.id}`,
        contact_id: c.id,
        custom_field_id: 'f1',
        value: 'x',
      })),
    });
    const db = client as unknown as Db;

    expect(
      await resolveAudienceContacts(db, {
        type: 'custom_field',
        customField: { fieldId: 'f1', operator: 'contains', value: '' },
      }),
    ).toEqual([]);
    expect(
      await resolveAudienceContacts(db, {
        type: 'custom_field',
        customField: { fieldId: '', operator: 'is', value: 'x' },
      }),
    ).toEqual([]);
  });

  it('never issues a single read bigger than the server cap', async () => {
    const { client, log } = fakePostgrest({ contacts: fakeContacts(2270) });
    await resolveAudienceContacts(client as unknown as Db, { type: 'all' });
    const sizes = log
      .filter((l) => l.startsWith('contacts:') && !l.endsWith(':head'))
      .map((l) => Number(l.split(':')[1]));
    expect(sizes.every((n) => n <= FAKE_MAX_ROWS)).toBe(true);
  });
});
