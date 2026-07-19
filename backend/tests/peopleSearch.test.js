import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';
import { createOrg } from './helpers/fixtures.js';

// FEATURE_REQUEST.md's "unified people picker" entry: three scoped search
// endpoints backing the picker — GET /workspaces/:workspaceId/people-search
// (any account, for adding to a workspace/org), GET
// /workspaces/:workspaceId/members-search (current workspace members only,
// for private-channel invite and ownership transfer), and GET
// /organizations/:orgId/people-search (any account, for adding to an org).

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

async function createChannel(owner, workspaceId, type = 'PRIVATE') {
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/channels`)
    .set(authHeader(owner.accessToken))
    .send({ name: 'room', type });
  return res.body.id;
}

async function addToWorkspace(owner, workspaceId, member) {
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/members`)
    .set(authHeader(owner.accessToken))
    .send({ username: member.username });
  if (res.status >= 300) throw new Error(`add failed: ${res.status} ${JSON.stringify(res.body)}`);
}

describe('GET /workspaces/:workspaceId/people-search', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/workspaces/00000000-0000-0000-0000-000000000000/people-search');
    expect(res.status).toBe(401);
  });

  test('a non-member gets 404, never a 403 (existence-hiding)', async () => {
    const outsider = await signup('peoplesearchoutsider0');
    const owner = await signup('peoplesearchowner0');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/people-search`)
      .set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });

  test('a plain member without WORKSPACE_MANAGE_MEMBERS gets 403', async () => {
    const owner = await signup('peoplesearchowner1');
    const member = await signup('peoplesearchmember1');
    const workspaceId = await createWorkspace(owner);
    await addToWorkspace(owner, workspaceId, member);

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/people-search`)
      .set(authHeader(member.accessToken));
    expect(res.status).toBe(403);
  });

  test('matches by username, display name, and email prefix, and flags accounts already in the workspace', async () => {
    const owner = await signup('peoplesearchowner2');
    const workspaceId = await createWorkspace(owner);
    const alice = await signup('alicesearch2', { displayName: 'Alice Wonderland', email: 'alicesearch2@example.com' });
    const bob = await signup('bobsearch2', { email: 'zzz-findme@example.com' });
    await addToWorkspace(owner, workspaceId, alice);

    const byUsername = await request(app)
      .get(`/api/workspaces/${workspaceId}/people-search?q=alicesearch`)
      .set(authHeader(owner.accessToken));
    expect(byUsername.status).toBe(200);
    expect(byUsername.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: alice.userId, alreadyMember: true })]),
    );

    const byDisplayName = await request(app)
      .get(`/api/workspaces/${workspaceId}/people-search?q=Alice Wonder`)
      .set(authHeader(owner.accessToken));
    expect(byDisplayName.body.map((r) => r.userId)).toContain(alice.userId);

    const byEmail = await request(app)
      .get(`/api/workspaces/${workspaceId}/people-search?q=zzz-findme`)
      .set(authHeader(owner.accessToken));
    expect(byEmail.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: bob.userId, alreadyMember: false })]),
    );
  });

  test('rejects a query longer than the allowed length', async () => {
    const owner = await signup('peoplesearchowner3');
    const workspaceId = await createWorkspace(owner);
    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/people-search?q=${'a'.repeat(51)}`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(400);
  });
});

describe('GET /workspaces/:workspaceId/members-search', () => {
  test('a plain workspace member (not just an admin) can call it', async () => {
    const owner = await signup('membersearchowner0');
    const member = await signup('membersearchmember0');
    const workspaceId = await createWorkspace(owner);
    await addToWorkspace(owner, workspaceId, member);

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/members-search`)
      .set(authHeader(member.accessToken));
    expect(res.status).toBe(200);
  });

  test('a non-member gets 404', async () => {
    const outsider = await signup('membersearchoutsider0');
    const owner = await signup('membersearchowner1');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/members-search`)
      .set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });

  test('only returns current workspace members, never a stranger, and flags isSelf', async () => {
    const owner = await signup('membersearchowner2');
    const member = await signup('membersearchmember2');
    const stranger = await signup('membersearchstranger2');
    const workspaceId = await createWorkspace(owner);
    await addToWorkspace(owner, workspaceId, member);

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/members-search`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(200);
    const ids = res.body.map((r) => r.userId);
    expect(ids).toContain(owner.userId);
    expect(ids).toContain(member.userId);
    expect(ids).not.toContain(stranger.userId);
    expect(res.body).toEqual(expect.arrayContaining([expect.objectContaining({ userId: owner.userId, isSelf: true })]));
    expect(res.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: member.userId, isSelf: false })]),
    );
  });

  // FEATURE_REQUEST.md entry 1: this endpoint's loose requireWorkspaceMember
  // gate (no MANAGE_MEMBERS/admin privilege required) previously let any
  // plain member harvest every other member's email address. Also a
  // contract test on the response shape so a future change can't silently
  // reintroduce the field.
  test('never includes an email field, for a plain member with no MANAGE_MEMBERS/admin privilege', async () => {
    const owner = await signup('membersearchowner5');
    const member = await signup('membersearchmember5');
    const workspaceId = await createWorkspace(owner);
    await addToWorkspace(owner, workspaceId, member);

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/members-search`)
      .set(authHeader(member.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const row of res.body) {
      expect(row).not.toHaveProperty('email');
      expect(Object.keys(row).sort()).toEqual(['displayName', 'isSelf', 'userId', 'username']);
    }
  });

  test('with a channelId, flags alreadyInChannel and requires the caller be a member of that channel', async () => {
    const owner = await signup('membersearchowner3');
    const member = await signup('membersearchmember3');
    const notInChannel = await signup('membersearchnotinchannel3');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId, 'PRIVATE');
    await addToWorkspace(owner, workspaceId, member);
    await addToWorkspace(owner, workspaceId, notInChannel);
    await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${channelId}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: member.username });

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/members-search?channelId=${channelId}`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: member.userId, alreadyInChannel: true })]),
    );
    expect(res.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: notInChannel.userId, alreadyInChannel: false })]),
    );

    // notInChannel is a workspace member but never joined the private
    // channel — the same existence-hiding 404 requireChannelMember always
    // gives a non-member of the channel, extended here to this endpoint.
    const forbidden = await request(app)
      .get(`/api/workspaces/${workspaceId}/members-search?channelId=${channelId}`)
      .set(authHeader(notInChannel.accessToken));
    expect(forbidden.status).toBe(404);
  });

  test('a channelId from a different workspace 400s', async () => {
    const owner = await signup('membersearchowner4');
    const workspaceId = await createWorkspace(owner);
    const otherWorkspaceId = await createWorkspace(owner);
    const otherChannelId = await createChannel(owner, otherWorkspaceId, 'PRIVATE');

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/members-search?channelId=${otherChannelId}`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(400);
  });
});

describe('GET /organizations/:orgId/people-search', () => {
  test('rejects a non-org-admin', async () => {
    const admin = await seedSystemAdmin('orgpeoplesearchadmin0');
    const org = await createOrg(admin.accessToken);
    const plain = await signup('orgpeoplesearchplain0');

    const res = await request(app).get(`/api/organizations/${org.id}/people-search`).set(authHeader(plain.accessToken));
    expect(res.status).toBe(404);
  });

  test('matches by username/display name/email and flags accounts already in the organization', async () => {
    const admin = await seedSystemAdmin('orgpeoplesearchadmin1');
    const org = await createOrg(admin.accessToken);
    const target = await signup('orgpeoplesearchtarget1', { displayName: 'Findable Person' });

    const res = await request(app)
      .get(`/api/organizations/${org.id}/people-search?q=Findable`)
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: target.userId, alreadyMember: false })]),
    );

    await request(app)
      .post(`/api/organizations/${org.id}/members`)
      .set(authHeader(admin.accessToken))
      .send({ username: target.username });

    const res2 = await request(app)
      .get(`/api/organizations/${org.id}/people-search?q=Findable`)
      .set(authHeader(admin.accessToken));
    expect(res2.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: target.userId, alreadyMember: true })]),
    );
  });
});
