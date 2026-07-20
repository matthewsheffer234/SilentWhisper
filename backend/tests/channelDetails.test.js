import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';

// FEATURE_REQUEST.md's "channel details panel with private-channel member
// management" entry: GET /:workspaceId/channels gained `memberCount` (no
// extra fetch needed for the header badge), and a new, uncapped
// GET /:workspaceId/channels/:channelId/members backs the details panel's
// full roster — distinct from messages.js's GET /channels/:channelId/members,
// which is the search-driven, 8-result-capped mention-autocomplete endpoint.

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

async function createWorkspace(owner) {
  const res = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
  return res.body.id;
}

async function createChannel(owner, workspaceId, type = 'PRIVATE', name = 'room') {
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/channels`)
    .set(authHeader(owner.accessToken))
    .send({ name, type });
  return res.body.id;
}

async function addToWorkspace(owner, workspaceId, member) {
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/members`)
    .set(authHeader(owner.accessToken))
    .send({ username: member.username });
  if (res.status >= 300) throw new Error(`add failed: ${res.status} ${JSON.stringify(res.body)}`);
}

describe('GET /workspaces/:workspaceId/channels memberCount', () => {
  test('reflects the real channel_members count, including after another member joins', async () => {
    const owner = await signup('memcountowner0');
    const member = await signup('memcountmember0');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId, 'PUBLIC', 'general');
    await addToWorkspace(owner, workspaceId, member);

    let res = await request(app).get(`/api/workspaces/${workspaceId}/channels`).set(authHeader(owner.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.channels.find((c) => c.id === channelId)).toMatchObject({ memberCount: 1 });

    await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${channelId}/join`)
      .set(authHeader(member.accessToken));

    res = await request(app).get(`/api/workspaces/${workspaceId}/channels`).set(authHeader(owner.accessToken));
    expect(res.body.channels.find((c) => c.id === channelId)).toMatchObject({ memberCount: 2 });
  });
});

describe('GET /workspaces/:workspaceId/channels pagination', () => {
  test('rejects malformed pagination params and returns a correctly bounded page', async () => {
    const owner = await signup('chanlistpaging0');
    const workspaceId = await createWorkspace(owner);
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await createChannel(owner, workspaceId, 'PUBLIC', `paging-room-${i}`);
    }

    const badLimit = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels?limit=0`)
      .set(authHeader(owner.accessToken));
    expect(badLimit.status).toBe(400);

    const badOffset = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels?offset=-1`)
      .set(authHeader(owner.accessToken));
    expect(badOffset.status).toBe(400);

    const page = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels?limit=2&offset=0`)
      .set(authHeader(owner.accessToken));
    expect(page.status).toBe(200);
    expect(page.body.channels).toHaveLength(2);
    expect(page.body.total).toBe(3);
  });
});

describe('GET /workspaces/:workspaceId/channels/:channelId/members', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).get(
      '/api/workspaces/00000000-0000-0000-0000-000000000000/channels/00000000-0000-0000-0000-000000000000/members',
    );
    expect(res.status).toBe(401);
  });

  test('a non-member of the channel gets 404, never a 403 (existence-hiding), even as a workspace member', async () => {
    const owner = await signup('chandetailowner0');
    const workspaceMember = await signup('chandetailwsmember0');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId, 'PRIVATE');
    await addToWorkspace(owner, workspaceId, workspaceMember);

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels/${channelId}/members`)
      .set(authHeader(workspaceMember.accessToken));
    expect(res.status).toBe(404);
  });

  test('returns the full roster with display names, uncapped', async () => {
    const owner = await signup('chandetailowner1');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId, 'PRIVATE');

    const members = [];
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const m = await signup(`chandetailmember1_${i}`, { displayName: `Member ${i}` });
      // eslint-disable-next-line no-await-in-loop
      await addToWorkspace(owner, workspaceId, m);
      // eslint-disable-next-line no-await-in-loop
      await request(app)
        .post(`/api/workspaces/${workspaceId}/channels/${channelId}/members`)
        .set(authHeader(owner.accessToken))
        .send({ username: m.username });
      members.push(m);
    }

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels/${channelId}/members`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(200);
    // The owner (auto-added on channel creation) plus all 10 invited members
    // — all fit within the default page size (50), so this still proves
    // "the whole roster, not artificially truncated," while the roster's
    // now-offset-paginated shape (FEATURE_REQUEST.md entry 2) is exercised
    // directly by the "pagination" describe block below.
    expect(res.body.total).toBe(11);
    expect(res.body.members).toHaveLength(11);
    for (const m of members) {
      expect(res.body.members).toEqual(
        expect.arrayContaining([expect.objectContaining({ userId: m.userId, displayName: m.displayName })]),
      );
    }
  });

  test('a channelId from a different workspace 400s', async () => {
    const owner = await signup('chandetailowner2');
    const workspaceId = await createWorkspace(owner);
    const otherWorkspaceId = await createWorkspace(owner);
    const otherChannelId = await createChannel(owner, otherWorkspaceId, 'PRIVATE');

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels/${otherChannelId}/members`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(400);
  });

  test('rejects malformed pagination params and returns a correctly bounded page', async () => {
    const owner = await signup('chandetailpaging0');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId, 'PRIVATE');
    for (let i = 0; i < 3; i += 1) {
      const m = await signup(`chandetailpagingmember${i}`);
      // eslint-disable-next-line no-await-in-loop
      await addToWorkspace(owner, workspaceId, m);
      // eslint-disable-next-line no-await-in-loop
      await request(app)
        .post(`/api/workspaces/${workspaceId}/channels/${channelId}/members`)
        .set(authHeader(owner.accessToken))
        .send({ username: m.username });
    }

    const badLimit = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels/${channelId}/members?limit=0`)
      .set(authHeader(owner.accessToken));
    expect(badLimit.status).toBe(400);

    const badOffset = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels/${channelId}/members?offset=-1`)
      .set(authHeader(owner.accessToken));
    expect(badOffset.status).toBe(400);

    const page = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels/${channelId}/members?limit=2&offset=0`)
      .set(authHeader(owner.accessToken));
    expect(page.status).toBe(200);
    expect(page.body.members).toHaveLength(2);
    // owner (auto-added on channel creation) + 3 invited members = 4 total.
    expect(page.body.total).toBe(4);
  });
});

// Security.md, 2026-07-15, HIGH: "Cross-Workspace Channel Membership
// Injection" — the route used to validate the caller against `channelId`
// but the *target's* workspace membership against the independent
// `workspaceId` path parameter, never checking the two belonged together.
describe('POST /workspaces/:workspaceId/channels/:channelId/members', () => {
  test('adds an existing workspace member to the channel', async () => {
    const owner = await signup('chanaddowner0');
    const member = await signup('chanaddmember0');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId, 'PRIVATE');
    await addToWorkspace(owner, workspaceId, member);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${channelId}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: member.username });
    expect(res.status).toBe(204);

    const row = await db('channel_members').where({ channel_id: channelId, user_id: member.userId }).first();
    expect(row).toBeTruthy();
  });

  test('a channelId/workspaceId pair from different workspaces 400s and inserts nothing', async () => {
    const ownerA = await signup('chaninjectownerA0');
    const workspaceA = await createWorkspace(ownerA);
    const channelA = await createChannel(ownerA, workspaceA, 'PRIVATE');

    const ownerB = await signup('chaninjectownerB0');
    const workspaceB = await createWorkspace(ownerB);
    // The account being smuggled into channelA is a real member of
    // workspaceB, not workspaceA — the pre-fix code would find this row
    // under `workspaceId` (workspaceB, from the path) and let it through.
    const targetInB = await signup('chaninjecttarget0');
    await addToWorkspace(ownerB, workspaceB, targetInB);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceB}/channels/${channelA}/members`)
      .set(authHeader(ownerA.accessToken))
      .send({ username: targetInB.username });
    expect(res.status).toBe(400);

    const row = await db('channel_members').where({ channel_id: channelA, user_id: targetInB.userId }).first();
    expect(row).toBeFalsy();
  });

  test('a target user who is not a member of the channel’s actual workspace 400s, even if workspaceId in the path names a workspace they do belong to', async () => {
    const ownerA = await signup('chaninjectownerA1');
    const workspaceA = await createWorkspace(ownerA);
    const channelA = await createChannel(ownerA, workspaceA, 'PRIVATE');

    const ownerB = await signup('chaninjectownerB1');
    const workspaceB = await createWorkspace(ownerB);
    const targetInB = await signup('chaninjecttarget1');
    await addToWorkspace(ownerB, workspaceB, targetInB);
    // Attacker (ownerA) also happens to be a member of workspaceB, which is
    // what makes `requireChannelMember`/`requireWorkspaceNotArchived` alone
    // insufficient — only the explicit channel.workspace_id === workspaceId
    // check catches this.
    await addToWorkspace(ownerB, workspaceB, ownerA);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceB}/channels/${channelA}/members`)
      .set(authHeader(ownerA.accessToken))
      .send({ username: targetInB.username });
    expect(res.status).toBe(400);

    const row = await db('channel_members').where({ channel_id: channelA, user_id: targetInB.userId }).first();
    expect(row).toBeFalsy();
  });
});
