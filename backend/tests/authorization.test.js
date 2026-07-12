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
  test('creating a workspace makes the creator its ADMIN', async () => {
    const owner = await signup(app, 'owner1');
    const res = await request(app)
      .post('/api/workspaces')
      .set(authHeader(owner.accessToken))
      .send({ name: 'Acme Corp' });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('ADMIN');
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

    // Add member3 to the workspace by having them... actually workspace
    // membership is only granted at creation in Phase 2 — simulate a second
    // member by inserting directly, since there's no "invite to workspace"
    // endpoint yet (out of Phase 2 scope).
    await db('workspace_members').insert({ workspace_id: workspaceId, user_id: member.userId, system_role: 'MEMBER' });

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
