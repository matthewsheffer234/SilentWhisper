import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';
import { extractEntityNames, normalizeEntityName, MAX_ENTITIES_PER_MESSAGE } from '../src/services/entityService.js';
import { _resetForTests as resetMessageRateLimiter } from '../src/ws/rateLimiter.js';
import { runMessageSideEffectsWorkerTick, _resetForTests as resetSideEffectsWorker } from '../src/workers/messageSideEffectsWorker.js';

beforeEach(async () => {
  await resetDb(db);
  resetMessageRateLimiter();
  resetSideEffectsWorker();
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

async function createWorkspaceAndChannel(user, { channelName = 'general', type = 'PUBLIC' } = {}) {
  const wsRes = await request(app).post('/api/workspaces').set(authHeader(user.accessToken)).send({ name: `${user.username} W` });
  const chRes = await request(app)
    .post(`/api/workspaces/${wsRes.body.id}/channels`)
    .set(authHeader(user.accessToken))
    .send({ name: channelName, type });
  return { workspace: wsRes.body, channel: chRes.body };
}

// Entity linking moved off the message-send path onto an async worker
// (FEATURE_REQUEST.md "hot path splitting" entry) — every call site below
// used to be able to assert on entities/message_entities immediately after
// sendMessage returned. Ticking the worker once here, in the one shared
// helper nearly every test in this file already goes through, keeps that
// true without touching each test individually.
async function sendMessage(user, channelId, content) {
  const res = await request(app).post(`/api/channels/${channelId}/messages`).set(authHeader(user.accessToken)).send({ content });
  await runMessageSideEffectsWorkerTick(db);
  return res;
}

describe('entity extraction helpers', () => {
  test('normalizes whitespace and case', () => {
    expect(normalizeEntityName('  Server   Alpha  ')).toBe('server alpha');
  });

  test('extracts complete bounded double-bracket tokens only', () => {
    expect(extractEntityNames('[[Server Alpha]] and [[   ]] and [[Project  Ares]]')).toEqual([
      { canonicalName: 'Server Alpha', normalizedName: 'server alpha' },
      { canonicalName: 'Project Ares', normalizedName: 'project ares' },
    ]);
  });
});

describe('message entity linking', () => {
  test('first mention creates an entity and a message link', async () => {
    const user = await signup('entityuser0');
    const { workspace, channel } = await createWorkspaceAndChannel(user);

    const res = await sendMessage(user, channel.id, 'Deploy [[Server Alpha]] today');
    expect(res.status).toBe(201);

    const entities = await db('entities').where({ workspace_id: workspace.id });
    expect(entities).toHaveLength(1);
    expect(entities[0].canonical_name).toBe('Server Alpha');
    expect(entities[0].normalized_name).toBe('server alpha');

    const links = await db('message_entities').where({ message_id: res.body.id, entity_id: entities[0].id });
    expect(links).toHaveLength(1);
  });

  test('case and spacing variants reuse the same workspace entity', async () => {
    const user = await signup('entityuser1');
    const { workspace, channel } = await createWorkspaceAndChannel(user);

    await sendMessage(user, channel.id, 'Deploy [[Server Alpha]] today');
    await sendMessage(user, channel.id, 'Check [[  server   alpha  ]] again');

    const entities = await db('entities').where({ workspace_id: workspace.id });
    expect(entities).toHaveLength(1);
    const links = await db('message_entities').where({ entity_id: entities[0].id });
    expect(links).toHaveLength(2);
  });

  test('two workspaces can independently use the same entity name', async () => {
    const userA = await signup('entityuser2a');
    const userB = await signup('entityuser2b');
    const a = await createWorkspaceAndChannel(userA);
    const b = await createWorkspaceAndChannel(userB);

    await sendMessage(userA, a.channel.id, 'A says [[Server Alpha]]');
    await sendMessage(userB, b.channel.id, 'B says [[server alpha]]');

    const entities = await db('entities').where({ normalized_name: 'server alpha' }).orderBy('workspace_id');
    expect(entities).toHaveLength(2);
    expect(new Set(entities.map((e) => e.workspace_id))).toEqual(new Set([a.workspace.id, b.workspace.id]));
  });

  test('only the first capped set of distinct entities is processed', async () => {
    const user = await signup('entityuser3');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const content = Array.from({ length: MAX_ENTITIES_PER_MESSAGE + 5 }, (_, i) => `[[Entity ${i}]]`).join(' ');

    await sendMessage(user, channel.id, content);

    const count = await db('entities').where({ workspace_id: workspace.id }).count({ count: '*' }).first();
    expect(Number(count.count)).toBe(MAX_ENTITIES_PER_MESSAGE);
  });

  test('repeating the same entity in one message creates one message link', async () => {
    const user = await signup('entityuser4');
    const { channel } = await createWorkspaceAndChannel(user);

    const res = await sendMessage(user, channel.id, '[[Server Alpha]] then [[server alpha]]');
    const links = await db('message_entities').where({ message_id: res.body.id });
    expect(links).toHaveLength(1);
  });

  test('direct and group DM messages do not create workspace entities', async () => {
    const alice = await signup('entityuser5a');
    const bob = await signup('entityuser5b');
    const carol = await signup('entityuser5c');

    const dm = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(alice.accessToken))
      .send({ targetUserId: bob.userId });
    const group = await request(app)
      .post('/api/group-direct-messages')
      .set(authHeader(alice.accessToken))
      .send({ memberIds: [bob.userId, carol.userId] });

    await sendMessage(alice, dm.body.id, 'Private [[Server Alpha]]');
    await sendMessage(alice, group.body.id, 'Group [[Project Ares]]');

    const entities = await db('entities');
    expect(entities).toHaveLength(0);
  });
});

describe('entity routes', () => {
  test('workspace members can search, resolve, and load details', async () => {
    const user = await signup('entityroute0');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    await sendMessage(user, channel.id, 'Deploy [[Server Alpha]] today');

    const search = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/search?q=Ser`)
      .set(authHeader(user.accessToken));
    expect(search.status).toBe(200);
    expect(search.body[0].canonicalName).toBe('Server Alpha');

    const resolve = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/resolve?name=server%20alpha`)
      .set(authHeader(user.accessToken));
    expect(resolve.status).toBe(200);
    expect(resolve.body.id).toBe(search.body[0].id);

    const detail = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${resolve.body.id}`)
      .set(authHeader(user.accessToken));
    expect(detail.status).toBe(200);
    expect(detail.body.referenceCount).toBe(1);
    expect(detail.body.recentReferences[0].content).toContain('Server Alpha');
  });

  test('non-members get 404 from search and detail', async () => {
    const owner = await signup('entityroute1owner');
    const outsider = await signup('entityroute1out');
    const { workspace, channel } = await createWorkspaceAndChannel(owner);
    await sendMessage(owner, channel.id, 'Deploy [[Server Alpha]] today');
    const entity = await db('entities').where({ workspace_id: workspace.id }).first();

    const search = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/search?q=Ser`)
      .set(authHeader(outsider.accessToken));
    expect(search.status).toBe(404);

    const detail = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(outsider.accessToken));
    expect(detail.status).toBe(404);
  });

  test('entity ids do not cross workspace boundaries', async () => {
    const userA = await signup('entityroute2a');
    const userB = await signup('entityroute2b');
    const a = await createWorkspaceAndChannel(userA);
    const b = await createWorkspaceAndChannel(userB);
    await sendMessage(userA, a.channel.id, 'A says [[Server Alpha]]');
    await sendMessage(userB, b.channel.id, 'B says [[Server Alpha]]');
    const entityA = await db('entities').where({ workspace_id: a.workspace.id }).first();

    const res = await request(app)
      .get(`/api/workspaces/${b.workspace.id}/entities/${entityA.id}`)
      .set(authHeader(userB.accessToken));
    expect(res.status).toBe(404);
  });

  test('references are paginated newest first', async () => {
    const user = await signup('entityroute3');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    await sendMessage(user, channel.id, 'one [[Server Alpha]]');
    await sendMessage(user, channel.id, 'two [[Server Alpha]]');
    await sendMessage(user, channel.id, 'three [[Server Alpha]]');
    const entity = await db('entities').where({ workspace_id: workspace.id }).first();

    const page1 = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}/references?limit=2`)
      .set(authHeader(user.accessToken));
    expect(page1.status).toBe(200);
    expect(page1.body.map((r) => r.content)).toEqual(['three [[Server Alpha]]', 'two [[Server Alpha]]']);

    const page2 = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}/references?limit=2&before=${encodeURIComponent(page1.body[1].createdAt)}`)
      .set(authHeader(user.accessToken));
    expect(page2.body.map((r) => r.content)).toEqual(['one [[Server Alpha]]']);
  });

  test('private-channel references are omitted for workspace members outside that channel', async () => {
    const owner = await signup('entityroute4owner');
    const bob = await signup('entityroute4bob');
    const { workspace, channel: publicChannel } = await createWorkspaceAndChannel(owner);
    await request(app)
      .post(`/api/workspaces/${workspace.id}/members`)
      .set(authHeader(owner.accessToken))
      .send({ username: bob.username, role: 'MEMBER' });
    await request(app)
      .post(`/api/workspaces/${workspace.id}/channels/${publicChannel.id}/join`)
      .set(authHeader(bob.accessToken));
    const privateRes = await request(app)
      .post(`/api/workspaces/${workspace.id}/channels`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'private', type: 'PRIVATE' });

    await sendMessage(owner, publicChannel.id, 'public [[Server Alpha]]');
    await sendMessage(owner, privateRes.body.id, 'private [[Server Alpha]]');
    const entity = await db('entities').where({ workspace_id: workspace.id }).first();

    const ownerDetail = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(owner.accessToken));
    expect(ownerDetail.body.referenceCount).toBe(2);

    const bobDetail = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(bob.accessToken));
    expect(bobDetail.status).toBe(200);
    expect(bobDetail.body.referenceCount).toBe(1);
    expect(bobDetail.body.recentReferences.map((r) => r.content)).toEqual(['public [[Server Alpha]]']);
  });

  test('overlong search query 400s', async () => {
    const user = await signup('entityroute5');
    const { workspace } = await createWorkspaceAndChannel(user);
    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/search?q=${'x'.repeat(256)}`)
      .set(authHeader(user.accessToken));
    expect(res.status).toBe(400);
  });
});
