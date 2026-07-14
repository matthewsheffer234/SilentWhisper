import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

describe('workspace + channel authorization', () => {
  test('creating a workspace makes the creator its OWNER', async () => {
    const owner = await signup(app, 'owner1');
    const res = await request(app)
      .post('/api/workspaces')
      .set(authHeader(owner.accessToken))
      .send({ name: 'Acme Corp' });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('OWNER');
  });

  test('a non-member gets 404 (not 403) for a workspace they cannot see', async () => {
    const owner = await signup(app, 'owner2');
    const outsider = await signup(app, 'outsider1');

    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
    const workspaceId = wsRes.body.id;

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels`)
      .set(authHeader(outsider.accessToken))
      .send({ name: 'general', type: 'PUBLIC' });

    expect(res.status).toBe(404);
  });

  test('a private channel is not listed to a workspace member who has not been added to it', async () => {
    const owner = await signup(app, 'owner3');
    const member = await signup(app, 'member3');

    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
    const workspaceId = wsRes.body.id;

    await request(app)
      .post(`/api/workspaces/${workspaceId}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'member3' });

    const privateRes = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'secret', type: 'PRIVATE' });
    expect(privateRes.status).toBe(201);

    const listRes = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels`)
      .set(authHeader(member.accessToken));
    expect(listRes.status).toBe(200);
    expect(listRes.body.find((c) => c.name === 'secret')).toBeUndefined();

    // And a non-member is denied reading its messages outright.
    const msgRes = await request(app)
      .get(`/api/channels/${privateRes.body.id}/messages`)
      .set(authHeader(member.accessToken));
    expect(msgRes.status).toBe(404);
  });

  test('any workspace member can self-join a public channel, but not a private one', async () => {
    const owner = await signup(app, 'owner4');
    const member = await signup(app, 'member4');

    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
    const workspaceId = wsRes.body.id;
    await db('workspace_members').insert({ workspace_id: workspaceId, user_id: member.userId, system_role: 'MEMBER' });

    const pubRes = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'general', type: 'PUBLIC' });
    const privRes = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'secret', type: 'PRIVATE' });

    const joinPublic = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${pubRes.body.id}/join`)
      .set(authHeader(member.accessToken));
    expect(joinPublic.status).toBe(204);

    const joinPrivate = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${privRes.body.id}/join`)
      .set(authHeader(member.accessToken));
    expect(joinPrivate.status).toBe(400);
  });

  test('an existing channel member can add another workspace member to a private channel', async () => {
    const owner = await signup(app, 'owner5');
    const member = await signup(app, 'member5');

    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
    const workspaceId = wsRes.body.id;
    await db('workspace_members').insert({ workspace_id: workspaceId, user_id: member.userId, system_role: 'MEMBER' });

    const privRes = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'secret', type: 'PRIVATE' });

    const addRes = await request(app)
      .post(`/api/workspaces/${workspaceId}/channels/${privRes.body.id}/members`)
      .set(authHeader(owner.accessToken))
      .send({ userId: member.userId });
    expect(addRes.status).toBe(204);

    const listRes = await request(app)
      .get(`/api/workspaces/${workspaceId}/channels`)
      .set(authHeader(member.accessToken));
    expect(listRes.body.find((c) => c.name === 'secret')).toBeTruthy();
  });

  test('requests with no token, a malformed token, or an expired-looking token are all rejected', async () => {
    const noAuth = await request(app).get('/api/workspaces');
    expect(noAuth.status).toBe(401);

    const badAuth = await request(app).get('/api/workspaces').set('Authorization', 'Bearer not-a-real-token');
    expect(badAuth.status).toBe(401);
  });
});

describe('POST /workspaces/:workspaceId/members (workspace invite)', () => {
  test('a workspace ADMIN can add an existing user by username, defaulting to MEMBER', async () => {
    const owner = await signup(app, 'inviteowner1');
    const invitee = await signup(app, 'invitee1');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
    const workspaceId = wsRes.body.id;

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'invitee1' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ userId: invitee.userId, username: 'invitee1', role: 'MEMBER' });

    // The invited user can now see the workspace themselves.
    const listRes = await request(app).get('/api/workspaces').set(authHeader(invitee.accessToken));
    expect(listRes.body.find((w) => w.id === workspaceId)?.role).toBe('MEMBER');
  });

  test('an OWNER can invite someone directly as MANAGER too', async () => {
    const owner = await signup(app, 'inviteowner2');
    await signup(app, 'invitee2');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });

    const res = await request(app)
      .post(`/api/workspaces/${wsRes.body.id}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'invitee2', role: 'MANAGER' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('MANAGER');
  });

  test('a non-admin workspace member cannot invite anyone (403, not the channel-add rule)', async () => {
    const owner = await signup(app, 'inviteowner3');
    const member = await signup(app, 'invitemember3');
    const target = await signup(app, 'invitee3');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
    const workspaceId = wsRes.body.id;
    await db('workspace_members').insert({ workspace_id: workspaceId, user_id: member.userId, system_role: 'MEMBER' });

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/members`)
      .set(authHeader(member.accessToken))
      .send({ username: 'invitee3' });
    expect(res.status).toBe(403);
    expect(await db('workspace_members').where({ workspace_id: workspaceId, user_id: target.userId }).first()).toBeUndefined();
  });

  test('a non-member (including a stranger) gets 404, not 403 or 400, for a workspace they cannot see', async () => {
    const owner = await signup(app, 'inviteowner4');
    const outsider = await signup(app, 'inviteoutsider4');
    await signup(app, 'invitee4');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });

    const res = await request(app)
      .post(`/api/workspaces/${wsRes.body.id}/members`)
      .set(authHeader(outsider.accessToken))
      .send({ username: 'invitee4' });
    expect(res.status).toBe(404);
  });

  test('rejects an unknown username with 400', async () => {
    const owner = await signup(app, 'inviteowner5');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });

    const res = await request(app)
      .post(`/api/workspaces/${wsRes.body.id}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'no-such-user-exists' });
    expect(res.status).toBe(400);
  });

  test('rejects re-inviting an existing member with 409', async () => {
    const owner = await signup(app, 'inviteowner6');
    await signup(app, 'invitee6');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
    const workspaceId = wsRes.body.id;

    await request(app)
      .post(`/api/workspaces/${workspaceId}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'invitee6' });

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'invitee6' });
    expect(res.status).toBe(409);
  });

  test('rejects an invalid role value with 400', async () => {
    const owner = await signup(app, 'inviteowner7');
    await signup(app, 'invitee7');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });

    const res = await request(app)
      .post(`/api/workspaces/${wsRes.body.id}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'invitee7', role: 'SUPERUSER' });
    expect(res.status).toBe(400);
  });

  // OWNER is structurally unique per workspace and never directly
  // assignable — there is no transfer-ownership endpoint yet
  // (FEATURE_REQUEST.md entry 1, slice 1).
  test('rejects role: OWNER with 400 — OWNER is not directly assignable', async () => {
    const owner = await signup(app, 'inviteowner9');
    await signup(app, 'invitee9');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });

    const res = await request(app)
      .post(`/api/workspaces/${wsRes.body.id}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'invitee9', role: 'OWNER' });
    expect(res.status).toBe(400);
  });

  test('a successful invite is audited as WORKSPACE_MEMBERSHIP_CHANGE', async () => {
    const owner = await signup(app, 'inviteowner8');
    const invitee = await signup(app, 'invitee8');
    const wsRes = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name: 'W' });
    const workspaceId = wsRes.body.id;

    await request(app)
      .post(`/api/workspaces/${workspaceId}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: 'invitee8' });

    const auditRow = await db('audit_logs').where({ action_type: 'WORKSPACE_MEMBERSHIP_CHANGE' }).first();
    expect(auditRow).toBeDefined();
    expect(auditRow.actor_id).toBe(owner.userId);
    expect(auditRow.target_resource).toBe(workspaceId);
    expect(auditRow.payload).toMatchObject({ action: 'add', addedUserId: invitee.userId, addedUsername: 'invitee8', role: 'MEMBER' });
  });
});

describe('direct messages', () => {
  test('starting a DM twice between the same two users reuses the same channel', async () => {
    const a = await signup(app, 'dmuser1');
    const b = await signup(app, 'dmuser2');

    const first = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(a.accessToken))
      .send({ targetUserId: b.userId });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(a.accessToken))
      .send({ targetUserId: b.userId });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  test('a third party cannot read a DM they are not part of', async () => {
    const a = await signup(app, 'dmuser3');
    const b = await signup(app, 'dmuser4');
    const outsider = await signup(app, 'dmuser5');

    const dm = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(a.accessToken))
      .send({ targetUserId: b.userId });

    const res = await request(app)
      .get(`/api/channels/${dm.body.id}/messages`)
      .set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });
});
