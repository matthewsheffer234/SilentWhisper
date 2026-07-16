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
    expect(res.body.find((c) => c.id === channelId)).toMatchObject({ memberCount: 1 });

    await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${channelId}/join`)
      .set(authHeader(member.accessToken));

    res = await request(app).get(`/api/workspaces/${workspaceId}/channels`).set(authHeader(owner.accessToken));
    expect(res.body.find((c) => c.id === channelId)).toMatchObject({ memberCount: 2 });
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
    // The owner (auto-added on channel creation) plus all 10 invited members.
    expect(res.body).toHaveLength(11);
    for (const m of members) {
      expect(res.body).toEqual(
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
});
