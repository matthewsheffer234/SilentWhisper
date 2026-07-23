import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';

// A system admin should be able to fully *manage* any workspace's
// structure — channels and channel membership — without being a member of
// it, the same "bypass the resource's own role map, still 404 on a resource
// that doesn't exist" shape requireWorkspacePermission's system-admin bypass
// already established for workspace settings/members/archive/ownership
// (systemAdminOverride.test.js covers that side; this file covers the
// channel-route gap that used to be plain requireWorkspaceMember/
// requireChannelMember with no bypass at all).
//
// Deliberately narrower than "read everything": this is a structural-
// management bypass only. It must never let a non-member system admin read
// message content in a private channel — that boundary is proven directly
// below, not just assumed.

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

async function createWorkspaceWithPrivateChannel(owner) {
  const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'Owner Workspace' });
  const workspaceId = wsRes.body.id;
  const pubRes = await request(app)
    .post(`/api/workspaces/${workspaceId}/channels`)
    .set(authHeader(owner.accessToken))
    .send({ name: 'general', type: 'PUBLIC' });
  const privRes = await request(app)
    .post(`/api/workspaces/${workspaceId}/channels`)
    .set(authHeader(owner.accessToken))
    .send({ name: 'secret', type: 'PRIVATE' });
  return { workspaceId, publicChannelId: pubRes.body.id, privateChannelId: privRes.body.id };
}

describe('system admin structural workspace management (not a member)', () => {
  test('can create a channel in a workspace they do not belong to, without being silently auto-joined to it', async () => {
    const owner = await signup('sawmowner0');
    const admin = await seedSystemAdmin('sawmadmin0');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'Owner Workspace' });

    const res = await request(app)
      .post(`/api/workspaces/${wsRes.body.id}/channels`)
      .set(authHeader(admin.accessToken))
      .send({ name: 'admin-made', type: 'PUBLIC' });
    expect(res.status).toBe(201);
    expect(res.body.isMember).toBe(false);

    const row = await db('audit_logs').where({ action_type: 'CHANNEL_CREATED', target_resource: res.body.id }).first();
    expect(row).toBeDefined();

    const memberRow = await db('channel_members').where({ channel_id: res.body.id, user_id: admin.userId }).first();
    expect(memberRow).toBeUndefined();
  });

  // Finding 1, docs/reviews/security-performance-review-2026-07-20.md: the
  // gap wasn't merely "can the admin read a pre-existing private channel
  // they never joined" (proven below by the sibling test using a channel
  // the *owner* created) — it was that creating a channel used to insert a
  // real channel_members row for the admin, converting a structural action
  // into standing content-read access. Prove the exact just-created case.
  test('creating a PRIVATE channel does not grant read access to its messages', async () => {
    const owner = await signup('sawmowner0b');
    const admin = await seedSystemAdmin('sawmadmin0b');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'Owner Workspace' });

    const createRes = await request(app)
      .post(`/api/workspaces/${wsRes.body.id}/channels`)
      .set(authHeader(admin.accessToken))
      .send({ name: 'admin-made-private', type: 'PRIVATE' });
    expect(createRes.status).toBe(201);
    const channelId = createRes.body.id;

    const memberRow = await db('channel_members').where({ channel_id: channelId, user_id: admin.userId }).first();
    expect(memberRow).toBeUndefined();

    const messagesRes = await request(app).get(`/api/channels/${channelId}/messages`).set(authHeader(admin.accessToken));
    expect(messagesRes.status).toBe(404);
  });

  test('can list every channel, including PRIVATE ones, unlike a plain non-member', async () => {
    const owner = await signup('sawmowner1');
    const admin = await seedSystemAdmin('sawmadmin1');
    const { workspaceId, privateChannelId } = await createWorkspaceWithPrivateChannel(owner);

    const adminRes = await request(app).get(`/api/workspaces/${workspaceId}/channels`).set(authHeader(admin.accessToken));
    expect(adminRes.status).toBe(200);
    const names = adminRes.body.channels.map((c) => c.id);
    expect(names).toContain(privateChannelId);
    const privateRow = adminRes.body.channels.find((c) => c.id === privateChannelId);
    expect(privateRow.isMember).toBe(false);

    const outsider = await signup('sawmoutsider1');
    const outsiderRes = await request(app).get(`/api/workspaces/${workspaceId}/channels`).set(authHeader(outsider.accessToken));
    expect(outsiderRes.status).toBe(404);
  });

  test('can view a PRIVATE channel roster and add an existing workspace member to it', async () => {
    const owner = await signup('sawmowner2');
    const admin = await seedSystemAdmin('sawmadmin2');
    const { workspaceId, privateChannelId } = await createWorkspaceWithPrivateChannel(owner);
    const target = await signup('sawmtarget2');
    await request(app).post(`/api/workspaces/${workspaceId}/members`).set(authHeader(owner.accessToken)).send({ username: 'sawmtarget2' });

    const rosterRes = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels/${privateChannelId}/members`)
      .set(authHeader(admin.accessToken));
    expect(rosterRes.status).toBe(200);
    expect(rosterRes.body.members.map((m) => m.userId)).toContain(owner.userId);

    const addRes = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${privateChannelId}/members`)
      .set(authHeader(admin.accessToken))
      .send({ username: 'sawmtarget2' });
    expect(addRes.status).toBe(204);

    const memberRow = await db('channel_members').where({ channel_id: privateChannelId, user_id: target.userId }).first();
    expect(memberRow).toBeDefined();

    const auditRow = await db('audit_logs')
      .where({ action_type: 'CHANNEL_MEMBERSHIP_CHANGE', target_resource: privateChannelId, actor_id: admin.userId })
      .first();
    expect(auditRow).toBeDefined();
    expect(auditRow.payload).toMatchObject({ action: 'add', addedUserId: target.userId });
  });

  test('can self-join a PUBLIC channel', async () => {
    const owner = await signup('sawmowner3');
    const admin = await seedSystemAdmin('sawmadmin3');
    const { workspaceId, publicChannelId } = await createWorkspaceWithPrivateChannel(owner);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${publicChannelId}/join`)
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(204);

    const memberRow = await db('channel_members').where({ channel_id: publicChannelId, user_id: admin.userId }).first();
    expect(memberRow).toBeDefined();
  });

  test('members-search works for the admin, including scoped to a PRIVATE channel', async () => {
    const owner = await signup('sawmowner4');
    const admin = await seedSystemAdmin('sawmadmin4');
    const { workspaceId, privateChannelId } = await createWorkspaceWithPrivateChannel(owner);

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/members-search?channelId=${privateChannelId}`)
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.userId === owner.userId)).toBe(true);
  });

  // The whole point of the "structural, not content" boundary: none of the
  // above should have made the admin able to read messages in the private
  // channel they administered but never joined.
  test('still cannot read message content in a PRIVATE channel they never joined', async () => {
    const owner = await signup('sawmowner5');
    const admin = await seedSystemAdmin('sawmadmin5');
    const { privateChannelId } = await createWorkspaceWithPrivateChannel(owner);
    await request(app)
      .post(`/api/channels/${privateChannelId}/messages`)
      .set(authHeader(owner.accessToken))
      .send({ content: 'this is private' });

    // Confirm the admin genuinely has no channel_members row here — this
    // isn't testing a coincidental membership from an earlier action.
    const memberRow = await db('channel_members').where({ channel_id: privateChannelId, user_id: admin.userId }).first();
    expect(memberRow).toBeUndefined();

    const res = await request(app).get(`/api/channels/${privateChannelId}/messages`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(404);
  });

  test('a plain non-admin, non-member still gets 404 on every one of these routes (existence-hiding preserved)', async () => {
    const owner = await signup('sawmowner6');
    const outsider = await signup('sawmoutsider6');
    const { workspaceId, publicChannelId, privateChannelId } = await createWorkspaceWithPrivateChannel(owner);

    const createRes = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels`)
      .set(authHeader(outsider.accessToken))
      .send({ name: 'nope', type: 'PUBLIC' });
    expect(createRes.status).toBe(404);

    const listRes = await request(app).get(`/api/workspaces/${workspaceId}/channels`).set(authHeader(outsider.accessToken));
    expect(listRes.status).toBe(404);

    const joinRes = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${publicChannelId}/join`)
      .set(authHeader(outsider.accessToken));
    expect(joinRes.status).toBe(404);

    const rosterRes = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels/${privateChannelId}/members`)
      .set(authHeader(outsider.accessToken));
    expect(rosterRes.status).toBe(404);

    const addRes = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${privateChannelId}/members`)
      .set(authHeader(outsider.accessToken))
      .send({ username: 'sawmowner6' });
    expect(addRes.status).toBe(404);

    const searchRes = await request(app)
      .get(`/api/workspaces/${workspaceId}/members-search`)
      .set(authHeader(outsider.accessToken));
    expect(searchRes.status).toBe(404);
  });
});

// A system admin who is *also* a genuine workspace member (most commonly:
// they created the workspace themselves, which auto-enrolls the creator as
// OWNER in workspace_members regardless of admin status) must be treated as
// that genuine member, not funneled through the non-member structural
// override above. Regression coverage for a real bug: requireWorkspaceMemberOrSystemAdmin
// used to check isSystemAdminUser first and return viaSystemAdminOverride:
// true unconditionally for any system admin, even in a workspace they own —
// so POST .../channels (which skips the channel_members insert specifically
// for viaSystemAdminOverride, per Finding 1 above) never auto-joined the
// admin to a channel they just created in their own workspace, leaving the
// composer stuck indefinitely on "Joining channel…".
describe('system admin who is a genuine workspace member (owns the workspace)', () => {
  test('creating a channel in a workspace they own auto-joins them, same as any other owner', async () => {
    const admin = await seedSystemAdmin('sawmselfowner0');
    const wsRes = await request(app)
      .post('/api/workspaces')
      .set(authHeader(admin.accessToken))
      .send({ name: 'Admin Own Workspace' });
    expect(wsRes.status).toBe(201);

    const chRes = await request(app)
      .post(`/api/workspaces/${wsRes.body.id}/channels`)
      .set(authHeader(admin.accessToken))
      .send({ name: 'general', type: 'PUBLIC' });
    expect(chRes.status).toBe(201);
    expect(chRes.body.isMember).toBe(true);

    const memberRow = await db('channel_members').where({ channel_id: chRes.body.id, user_id: admin.userId }).first();
    expect(memberRow).toBeDefined();
  });
});
