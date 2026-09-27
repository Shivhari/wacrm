import { describe, expect, it } from 'vitest';

import { estimateAudienceCount } from './audience-estimate';
import { fakeContacts, fakePostgrest } from './testing/fake-postgrest';

type Db = Parameters<typeof estimateAudienceCount>[0];

function tagRows(tagId: string, contactIds: string[]) {
  return contactIds.map((contact_id) => ({ id: `${tagId}:${contact_id}`, contact_id, tag_id: tagId }));
}

describe('estimateAudienceCount', () => {
  it('counts every contact for "all" without reading them', async () => {
    const { client, log } = fakePostgrest({ contacts: fakeContacts(2443) });
    const n = await estimateAudienceCount(client as unknown as Db, { type: 'all' });
    expect(n).toBe(2443);
    expect(log).toEqual(['contacts:head']);
  });

  it('subtracts excluded tags from "all", even past the row cap', async () => {
    const contacts = fakeContacts(2443);
    const sentIds = contacts.slice(0, 1000).map((c) => c.id as string);
    // 1000 exact: an unpaginated read gets exactly one page and looks right,
    // so push past it with a second tag on 200 of the same contacts plus
    // 300 others — 1300 rows, 1300 distinct contacts excluded.
    const moreIds = contacts.slice(1000, 1300).map((c) => c.id as string);
    const { client } = fakePostgrest({
      contacts,
      contact_tags: [
        ...tagRows('sent-temp', sentIds),
        ...tagRows('other', moreIds),
      ],
    });

    const n = await estimateAudienceCount(client as unknown as Db, {
      type: 'all',
      excludeTagIds: ['sent-temp', 'other'],
    });

    expect(n).toBe(2443 - 1300);
  });

  it('counts distinct contacts for a tag audience, past the row cap', async () => {
    const contacts = fakeContacts(1500);
    const ids = contacts.map((c) => c.id as string);
    const { client } = fakePostgrest({
      contacts,
      contact_tags: [...tagRows('t1', ids), ...tagRows('t2', ids.slice(0, 10))],
    });

    const n = await estimateAudienceCount(client as unknown as Db, {
      type: 'tags',
      tagIds: ['t1', 't2'],
    });

    expect(n).toBe(1500);
  });

  it('counts custom-field matches past the row cap', async () => {
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

    const n = await estimateAudienceCount(client as unknown as Db, {
      type: 'custom_field',
      customField: { fieldId: 'f1', operator: 'is', value: 'Chennai' },
    });

    expect(n).toBe(1200);
  });

  it('applies exclude tags to a tag audience', async () => {
    const contacts = fakeContacts(10);
    const ids = contacts.map((c) => c.id as string);
    const { client } = fakePostgrest({
      contacts,
      contact_tags: [...tagRows('t1', ids), ...tagRows('skip', ids.slice(0, 4))],
    });

    const n = await estimateAudienceCount(client as unknown as Db, {
      type: 'tags',
      tagIds: ['t1'],
      excludeTagIds: ['skip'],
    });

    expect(n).toBe(6);
  });

  it('uses the CSV row count for a CSV audience', async () => {
    const { client, log } = fakePostgrest({});
    const n = await estimateAudienceCount(client as unknown as Db, {
      type: 'csv',
      csvContacts: [{ phone: '+1' }, { phone: '+2' }],
    });
    expect(n).toBe(2);
    expect(log).toEqual([]);
  });

  it('counts distinct non-blank phones for a CSV audience, like the send does', async () => {
    const { client } = fakePostgrest({});
    const n = await estimateAudienceCount(client as unknown as Db, {
      type: 'csv',
      csvContacts: [{ phone: '+1' }, { phone: '+1' }, { phone: '' }, { phone: '+2' }],
    });
    expect(n).toBe(2);
  });

  it('returns null while the audience is only partly configured', async () => {
    const { client } = fakePostgrest({});
    const db = client as unknown as Db;
    expect(await estimateAudienceCount(db, { type: 'tags', tagIds: [] })).toBeNull();
    expect(
      await estimateAudienceCount(db, {
        type: 'custom_field',
        customField: { fieldId: 'f1', operator: 'is', value: '' },
      }),
    ).toBeNull();
    expect(await estimateAudienceCount(db, { type: 'csv', csvContacts: [] })).toBeNull();
  });
});
