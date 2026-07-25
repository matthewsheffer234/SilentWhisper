import { jest } from '@jest/globals';
import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';
import { extractEntityNames, normalizeEntityName, MAX_ENTITIES_PER_MESSAGE } from '../src/services/entityService.js';
import { _resetForTests as resetMessageRateLimiter } from '../src/ws/rateLimiter.js';
import { runMessageSideEffectsWorkerTick, _resetForTests as resetSideEffectsWorker } from '../src/workers/messageSideEffectsWorker.js';
import { LLM_SETTING_KEYS, validateSettingsPatch, updateSettings } from '../src/llm/settingsService.js';
import { _resetForTests as resetConcurrencyGate } from '../src/llm/concurrencyGate.js';

function makeJsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(async () => {
  // Must run before resetDb(): a PATCH /api/ai/settings in a previous test
  // may have left an app_settings row with updated_by pointing at a user
  // resetDb is about to delete (matching aiRoutes.test.js's own established
  // ordering for this exact FK hazard).
  await db('app_settings').whereIn('key', LLM_SETTING_KEYS).del();
  await resetDb(db);
  resetMessageRateLimiter();
  resetSideEffectsWorker();
  resetConcurrencyGate();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await db('app_settings').whereIn('key', LLM_SETTING_KEYS).del();
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

  // FEATURE_REQUEST.md entry 2 (Knowledge Explorer, Citation History):
  // serializeReference's new parentMessage field, mirroring how
  // GET /api/search/semantic already embeds it for a threaded-reply hit.
  test('a threaded reference includes its parent message; a top-level reference has parentMessage: null', async () => {
    const user = await signup('entitycite0');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const root = await sendMessage(user, channel.id, 'kicking off discussion');
    const replyRes = await request(app)
      .post(`/api/channels/${channel.id}/messages`)
      .set(authHeader(user.accessToken))
      .send({ content: 'follow-up about [[Server Alpha]]', parentMessageId: root.body.id });
    await runMessageSideEffectsWorkerTick(db);
    await sendMessage(user, channel.id, 'top-level mention of [[Server Alpha]] too');
    const entity = await db('entities').where({ workspace_id: workspace.id }).first();

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}/references`)
      .set(authHeader(user.accessToken));
    expect(res.status).toBe(200);

    const reply = res.body.find((r) => r.messageId === replyRes.body.id);
    expect(reply.parentMessageId).toBe(root.body.id);
    expect(reply.parentMessage).toMatchObject({
      id: root.body.id,
      content: 'kicking off discussion',
      username: user.username,
    });

    const topLevel = res.body.find((r) => r.content === 'top-level mention of [[Server Alpha]] too');
    expect(topLevel.parentMessageId).toBeNull();
    expect(topLevel.parentMessage).toBeNull();
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

async function addWorkspaceMember(owner, workspaceId, member, role = 'MEMBER') {
  await request(app)
    .post(`/api/workspaces/${workspaceId}/members`)
    .set(authHeader(owner.accessToken))
    .send({ username: member.username, role });
}

// A workspace member must already exist (addWorkspaceMember above) before
// they can be added to a PRIVATE channel this way — matching
// channelDetails.test.js's own POST .../channels/:channelId/members
// precedent.
async function addChannelMember(owner, workspaceId, channelId, member) {
  await request(app)
    .post(`/api/workspaces/${workspaceId}/channels/${channelId}/members`)
    .set(authHeader(owner.accessToken))
    .send({ username: member.username });
}

async function createEntity(user, workspaceId, channelId, name) {
  await sendMessage(user, channelId, `Discussing [[${name}]]`);
  return db('entities').where({ workspace_id: workspaceId, normalized_name: normalizeEntityName(name) }).first();
}

// FEATURE_REQUEST.md entry 4: editable entity metadata.
describe('entity metadata', () => {
  test('a workspace member can update description, status, tags, aliases, ownerId, and referenceUrl, and it is audited', async () => {
    const user = await signup('entitymeta0');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const entity = await createEntity(user, workspace.id, channel.id, 'Server Alpha');

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(user.accessToken))
      .send({
        description: 'The primary staging server.',
        status: 'DEPRECATED',
        tags: ['Infra', 'infra', 'staging'],
        aliases: ['Alpha Box', 'alpha box'],
        ownerId: user.userId,
        referenceUrl: 'https://runbook.example.com/server-alpha',
      });

    expect(res.status).toBe(200);
    expect(res.body.description).toBe('The primary staging server.');
    expect(res.body.status).toBe('DEPRECATED');
    expect(res.body.tags).toEqual(['infra', 'staging']);
    expect(res.body.aliases).toEqual(['alpha box']);
    expect(res.body.ownerId).toBe(user.userId);
    expect(res.body.ownerUsername).toBe(user.username);
    expect(res.body.referenceUrl).toBe('https://runbook.example.com/server-alpha');

    const auditRow = await db('audit_logs').where({ action_type: 'ENTITY_METADATA_UPDATED' }).first();
    expect(auditRow).toBeTruthy();
    expect(auditRow.target_resource).toBe(entity.id);
    expect(auditRow.payload.fieldsChanged.sort()).toEqual(
      ['description', 'status', 'tags', 'aliases', 'ownerId', 'referenceUrl'].sort(),
    );
    // Never the raw description/alias/tag text itself in the audit payload.
    expect(JSON.stringify(auditRow.payload)).not.toContain('primary staging server');
  });

  test('clearing description and ownerId with null works', async () => {
    const user = await signup('entitymeta1');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const entity = await createEntity(user, workspace.id, channel.id, 'Server Alpha');
    await request(app)
      .patch(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(user.accessToken))
      .send({ description: 'temp', ownerId: user.userId });

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(user.accessToken))
      .send({ description: null, ownerId: null });
    expect(res.status).toBe(200);
    expect(res.body.description).toBeNull();
    expect(res.body.ownerId).toBeNull();
  });

  test('an ownerId that is not a workspace member 400s', async () => {
    const owner = await signup('entitymeta2owner');
    const outsider = await signup('entitymeta2out');
    const { workspace, channel } = await createWorkspaceAndChannel(owner);
    const entity = await createEntity(owner, workspace.id, channel.id, 'Server Alpha');

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(owner.accessToken))
      .send({ ownerId: outsider.userId });
    expect(res.status).toBe(400);
  });

  test('an invalid status value 400s', async () => {
    const user = await signup('entitymeta3');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const entity = await createEntity(user, workspace.id, channel.id, 'Server Alpha');

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(user.accessToken))
      .send({ status: 'ON_FIRE' });
    expect(res.status).toBe(400);
  });

  test('an alias that collides with another entity in the same workspace 409s', async () => {
    const user = await signup('entitymeta4');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const alpha = await createEntity(user, workspace.id, channel.id, 'Server Alpha');
    await createEntity(user, workspace.id, channel.id, 'Server Beta');

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/entities/${alpha.id}`)
      .set(authHeader(user.accessToken))
      .send({ aliases: ['server beta'] });
    expect(res.status).toBe(409);
  });

  test('an empty patch body 400s', async () => {
    const user = await signup('entitymeta5');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const entity = await createEntity(user, workspace.id, channel.id, 'Server Alpha');

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(user.accessToken))
      .send({});
    expect(res.status).toBe(400);
  });

  test('a non-member gets 404, never a 403', async () => {
    const owner = await signup('entitymeta6owner');
    const outsider = await signup('entitymeta6out');
    const { workspace, channel } = await createWorkspaceAndChannel(owner);
    const entity = await createEntity(owner, workspace.id, channel.id, 'Server Alpha');

    const res = await request(app)
      .patch(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(outsider.accessToken))
      .send({ status: 'ARCHIVED' });
    expect(res.status).toBe(404);
  });
});

// FEATURE_REQUEST.md entry 4: entity_relationships.
describe('entity relationships', () => {
  test('a workspace member can create a relationship, it is audited, and appears on both entities in the correct direction', async () => {
    const user = await signup('entityrel0');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const alpha = await createEntity(user, workspace.id, channel.id, 'Server Alpha');
    const beta = await createEntity(user, workspace.id, channel.id, 'Server Beta');

    const createRes = await request(app)
      .post(`/api/workspaces/${workspace.id}/entities/${alpha.id}/relationships`)
      .set(authHeader(user.accessToken))
      .send({ targetEntityId: beta.id, relationshipType: 'DEPENDS_ON' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.direction).toBe('outgoing');
    expect(createRes.body.relatedEntity.id).toBe(beta.id);

    const auditRow = await db('audit_logs').where({ action_type: 'ENTITY_RELATIONSHIP_CREATED' }).first();
    expect(auditRow).toBeTruthy();
    expect(auditRow.payload).toMatchObject({ sourceEntityId: alpha.id, targetEntityId: beta.id, relationshipType: 'DEPENDS_ON' });

    const alphaDetail = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${alpha.id}`)
      .set(authHeader(user.accessToken));
    expect(alphaDetail.body.relationships).toHaveLength(1);
    expect(alphaDetail.body.relationships[0]).toMatchObject({ direction: 'outgoing', relationshipType: 'DEPENDS_ON' });

    const betaDetail = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${beta.id}`)
      .set(authHeader(user.accessToken));
    expect(betaDetail.body.relationships).toHaveLength(1);
    expect(betaDetail.body.relationships[0]).toMatchObject({ direction: 'incoming', relationshipType: 'DEPENDS_ON' });
    expect(betaDetail.body.relationships[0].relatedEntity.id).toBe(alpha.id);
  });

  test('an entity cannot have a relationship with itself', async () => {
    const user = await signup('entityrel1');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const alpha = await createEntity(user, workspace.id, channel.id, 'Server Alpha');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/entities/${alpha.id}/relationships`)
      .set(authHeader(user.accessToken))
      .send({ targetEntityId: alpha.id, relationshipType: 'RELATED_TO' });
    expect(res.status).toBe(400);
  });

  test('duplicate relationships (same source, target, type) 409', async () => {
    const user = await signup('entityrel2');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const alpha = await createEntity(user, workspace.id, channel.id, 'Server Alpha');
    const beta = await createEntity(user, workspace.id, channel.id, 'Server Beta');
    await request(app)
      .post(`/api/workspaces/${workspace.id}/entities/${alpha.id}/relationships`)
      .set(authHeader(user.accessToken))
      .send({ targetEntityId: beta.id, relationshipType: 'RELATED_TO' });

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/entities/${alpha.id}/relationships`)
      .set(authHeader(user.accessToken))
      .send({ targetEntityId: beta.id, relationshipType: 'RELATED_TO' });
    expect(res.status).toBe(409);
  });

  test('a target entity from a different workspace 404s', async () => {
    const userA = await signup('entityrel3a');
    const userB = await signup('entityrel3b');
    const a = await createWorkspaceAndChannel(userA);
    const b = await createWorkspaceAndChannel(userB);
    const alpha = await createEntity(userA, a.workspace.id, a.channel.id, 'Server Alpha');
    const foreign = await createEntity(userB, b.workspace.id, b.channel.id, 'Server Beta');

    const res = await request(app)
      .post(`/api/workspaces/${a.workspace.id}/entities/${alpha.id}/relationships`)
      .set(authHeader(userA.accessToken))
      .send({ targetEntityId: foreign.id, relationshipType: 'RELATED_TO' });
    expect(res.status).toBe(404);
  });

  test('an invalid relationshipType 400s', async () => {
    const user = await signup('entityrel4');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const alpha = await createEntity(user, workspace.id, channel.id, 'Server Alpha');
    const beta = await createEntity(user, workspace.id, channel.id, 'Server Beta');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/entities/${alpha.id}/relationships`)
      .set(authHeader(user.accessToken))
      .send({ targetEntityId: beta.id, relationshipType: 'FRIENDS_WITH' });
    expect(res.status).toBe(400);
  });

  test('a workspace member can delete a relationship, it is audited, and it disappears from both entities', async () => {
    const user = await signup('entityrel5');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const alpha = await createEntity(user, workspace.id, channel.id, 'Server Alpha');
    const beta = await createEntity(user, workspace.id, channel.id, 'Server Beta');
    const created = await request(app)
      .post(`/api/workspaces/${workspace.id}/entities/${alpha.id}/relationships`)
      .set(authHeader(user.accessToken))
      .send({ targetEntityId: beta.id, relationshipType: 'RELATED_TO' });

    const delRes = await request(app)
      .delete(`/api/workspaces/${workspace.id}/entities/${alpha.id}/relationships/${created.body.id}`)
      .set(authHeader(user.accessToken));
    expect(delRes.status).toBe(204);

    const auditRow = await db('audit_logs').where({ action_type: 'ENTITY_RELATIONSHIP_REMOVED' }).first();
    expect(auditRow).toBeTruthy();

    const alphaDetail = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${alpha.id}`)
      .set(authHeader(user.accessToken));
    expect(alphaDetail.body.relationships).toHaveLength(0);
    const betaDetail = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${beta.id}`)
      .set(authHeader(user.accessToken));
    expect(betaDetail.body.relationships).toHaveLength(0);
  });

  test('non-members get 404 creating and deleting relationships', async () => {
    const owner = await signup('entityrel6owner');
    const outsider = await signup('entityrel6out');
    const { workspace, channel } = await createWorkspaceAndChannel(owner);
    const alpha = await createEntity(owner, workspace.id, channel.id, 'Server Alpha');
    const beta = await createEntity(owner, workspace.id, channel.id, 'Server Beta');

    const createRes = await request(app)
      .post(`/api/workspaces/${workspace.id}/entities/${alpha.id}/relationships`)
      .set(authHeader(outsider.accessToken))
      .send({ targetEntityId: beta.id, relationshipType: 'RELATED_TO' });
    expect(createRes.status).toBe(404);

    const real = await request(app)
      .post(`/api/workspaces/${workspace.id}/entities/${alpha.id}/relationships`)
      .set(authHeader(owner.accessToken))
      .send({ targetEntityId: beta.id, relationshipType: 'RELATED_TO' });

    const delRes = await request(app)
      .delete(`/api/workspaces/${workspace.id}/entities/${alpha.id}/relationships/${real.body.id}`)
      .set(authHeader(outsider.accessToken));
    expect(delRes.status).toBe(404);
  });
});

// FEATURE_REQUEST.md entry 4: "surface... owner-tagged tasks as linked
// action items."
describe('entity linked action items', () => {
  test('an inline checkbox task in a referencing message is surfaced on the entity detail', async () => {
    const user = await signup('entitytask0');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    await sendMessage(user, channel.id, `- [ ] fix the disk alert [owner:: @${user.username}]\nabout [[Server Alpha]]`);
    const entity = await db('entities').where({ workspace_id: workspace.id }).first();

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(user.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.linkedActionItems).toHaveLength(1);
    expect(res.body.linkedActionItems[0]).toMatchObject({ checked: false, text: 'fix the disk alert', owner: user.username });
  });

  test('a private-channel reference contributes no linked action item for a member outside that channel', async () => {
    const owner = await signup('entitytask1owner');
    const bob = await signup('entitytask1bob');
    const { workspace, channel: publicChannel } = await createWorkspaceAndChannel(owner);
    await addWorkspaceMember(owner, workspace.id, bob);
    await request(app).post(`/api/workspaces/${workspace.id}/channels/${publicChannel.id}/join`).set(authHeader(bob.accessToken));
    const privateRes = await request(app)
      .post(`/api/workspaces/${workspace.id}/channels`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'private', type: 'PRIVATE' });

    await sendMessage(owner, privateRes.body.id, `- [ ] private task [[Server Alpha]]`);
    const entity = await db('entities').where({ workspace_id: workspace.id }).first();

    const bobDetail = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(bob.accessToken));
    expect(bobDetail.body.linkedActionItems).toHaveLength(0);

    const ownerDetail = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(owner.accessToken));
    expect(ownerDetail.body.linkedActionItems).toHaveLength(1);
  });
});

// FEATURE_REQUEST.md entry 4: AI-generated "What we know" entity summary.
describe('entity AI summary', () => {
  test('generates a summary from authorized references, caches it, and audits AI_ENTITY_SUMMARY_REQUESTED', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ response: 'Server Alpha is the staging box.' }));
    const user = await signup('entitysum0');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const entity = await createEntity(user, workspace.id, channel.id, 'Server Alpha');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/entities/${entity.id}/ai/summary`)
      .set(authHeader(user.accessToken));
    expect(res.status).toBe(201);
    expect(res.body.text).toBe('Server Alpha is the staging box.');
    expect(res.body.provider).toBe('ollama');
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.generatedAt).toBeTruthy();

    const auditRow = await db('audit_logs').where({ action_type: 'AI_ENTITY_SUMMARY_REQUESTED' }).first();
    expect(auditRow).toBeTruthy();
    expect(auditRow.target_resource).toBe(entity.id);
    expect(auditRow.payload.referenceCount).toBe(1);
    // Never the summary text itself in the audit payload.
    expect(JSON.stringify(auditRow.payload)).not.toContain('staging box');

    const getRes = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}/ai/summary`)
      .set(authHeader(user.accessToken));
    expect(getRes.status).toBe(200);
    expect(getRes.body.text).toBe('Server Alpha is the staging box.');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const detailRes = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(user.accessToken));
    expect(detailRes.body.summary.text).toBe('Server Alpha is the staging box.');
  });

  test('regenerating creates a new revision; GET reflects the latest one', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(makeJsonResponse({ response: 'first summary' }))
      .mockResolvedValueOnce(makeJsonResponse({ response: 'second summary' }));
    const user = await signup('entitysum1');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const entity = await createEntity(user, workspace.id, channel.id, 'Server Alpha');

    await request(app).post(`/api/workspaces/${workspace.id}/entities/${entity.id}/ai/summary`).set(authHeader(user.accessToken));
    await request(app).post(`/api/workspaces/${workspace.id}/entities/${entity.id}/ai/summary`).set(authHeader(user.accessToken));

    const revisions = await db('entity_summaries').where({ entity_id: entity.id });
    expect(revisions).toHaveLength(2);

    const getRes = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}/ai/summary`)
      .set(authHeader(user.accessToken));
    expect(getRes.body.text).toBe('second summary');
  });

  test('an entity with no authorized references 400s and calls no provider', async () => {
    jest.spyOn(global, 'fetch');
    const user = await signup('entitysum2');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    // resolve/search create no entity; insert one directly with zero references.
    const [entity] = await db('entities')
      .insert({ workspace_id: workspace.id, canonical_name: 'Ghost', normalized_name: 'ghost', created_by: user.userId })
      .returning('*');
    void channel;

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/entities/${entity.id}/ai/summary`)
      .set(authHeader(user.accessToken));
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a private-channel reference is never sent to the provider or cited for a member outside that channel', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ response: 'summary' }));
    const owner = await signup('entitysum3owner');
    const bob = await signup('entitysum3bob');
    const { workspace, channel: publicChannel } = await createWorkspaceAndChannel(owner);
    await addWorkspaceMember(owner, workspace.id, bob);
    await request(app).post(`/api/workspaces/${workspace.id}/channels/${publicChannel.id}/join`).set(authHeader(bob.accessToken));
    const privateRes = await request(app)
      .post(`/api/workspaces/${workspace.id}/channels`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'private', type: 'PRIVATE' });
    await sendMessage(owner, privateRes.body.id, 'secret detail about [[Server Alpha]]');
    await sendMessage(owner, publicChannel.id, 'public detail about [[Server Alpha]]');
    const entity = await db('entities').where({ workspace_id: workspace.id }).first();

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/entities/${entity.id}/ai/summary`)
      .set(authHeader(bob.accessToken));
    expect(res.status).toBe(201);
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.citations[0].channelId).toBe(publicChannel.id);

    const [, requestInit] = global.fetch.mock.calls[0];
    expect(JSON.parse(requestInit.body).prompt).not.toContain('secret detail');
  });

  test('a summary generated from a private-channel reference is hidden (not 403) from a workspace member outside that channel', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(makeJsonResponse({ response: 'Server Alpha summary citing the private channel.' }));
    const owner = await signup('entitysum6owner');
    const bob = await signup('entitysum6bob');
    const { workspace, channel: publicChannel } = await createWorkspaceAndChannel(owner);
    await addWorkspaceMember(owner, workspace.id, bob);
    await request(app).post(`/api/workspaces/${workspace.id}/channels/${publicChannel.id}/join`).set(authHeader(bob.accessToken));
    const privateRes = await request(app)
      .post(`/api/workspaces/${workspace.id}/channels`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'private', type: 'PRIVATE' });
    // Owner can see the private channel, so generating from it is legitimate
    // for the owner — the bug is in what a *different*, narrower-access
    // reader gets back afterward, not in generation itself (already covered
    // by the "never sent to the provider" test above).
    await sendMessage(owner, privateRes.body.id, 'secret detail about [[Server Alpha]]');
    const entity = await db('entities').where({ workspace_id: workspace.id }).first();

    const genRes = await request(app)
      .post(`/api/workspaces/${workspace.id}/entities/${entity.id}/ai/summary`)
      .set(authHeader(owner.accessToken));
    expect(genRes.status).toBe(201);
    expect(genRes.body.citations[0].channelId).toBe(privateRes.body.id);

    // Owner (still a private-channel member) keeps seeing it.
    const ownerGetRes = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}/ai/summary`)
      .set(authHeader(owner.accessToken));
    expect(ownerGetRes.body.text).toBe('Server Alpha summary citing the private channel.');

    // Bob is a workspace member and can open the entity, but was never in
    // the private channel the cached summary cites — the dedicated summary
    // route must not return it to him.
    const bobGetRes = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}/ai/summary`)
      .set(authHeader(bob.accessToken));
    expect(bobGetRes.status).toBe(200);
    expect(bobGetRes.body).toBeNull();

    // Nor should it leak through the entity detail route's embedded summary.
    const bobDetailRes = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}`)
      .set(authHeader(bob.accessToken));
    expect(bobDetailRes.status).toBe(200);
    expect(bobDetailRes.body.summary).toBeNull();
  });

  test('returns 503 and creates no summary or audit row when the provider is disabled', async () => {
    jest.spyOn(global, 'fetch');
    const user = await signup('entitysum4');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    const entity = await createEntity(user, workspace.id, channel.id, 'Server Alpha');
    await updateSettings(db, validateSettingsPatch({ provider: 'disabled' }), user.userId);

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/entities/${entity.id}/ai/summary`)
      .set(authHeader(user.accessToken));
    expect(res.status).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
    const revisions = await db('entity_summaries').where({ entity_id: entity.id });
    expect(revisions).toHaveLength(0);
    const auditRow = await db('audit_logs').where({ action_type: 'AI_ENTITY_SUMMARY_REQUESTED' }).first();
    expect(auditRow).toBeFalsy();
  });

  test('a non-member gets 404, never a 403', async () => {
    const owner = await signup('entitysum5owner');
    const outsider = await signup('entitysum5out');
    const { workspace, channel } = await createWorkspaceAndChannel(owner);
    const entity = await createEntity(owner, workspace.id, channel.id, 'Server Alpha');

    const res = await request(app)
      .post(`/api/workspaces/${workspace.id}/entities/${entity.id}/ai/summary`)
      .set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });
});

// FEATURE_REQUEST.md entry 2 (Knowledge Explorer, Trending Entities).
describe('entity trending', () => {
  test('trending is ordered by reference count, and an entity referenced only in a private channel is absent (not zeroed) for a caller outside it', async () => {
    const owner = await signup('entitytrend0owner');
    const bob = await signup('entitytrend0bob');
    const { workspace, channel: publicChannel } = await createWorkspaceAndChannel(owner);
    await addWorkspaceMember(owner, workspace.id, bob);
    await request(app).post(`/api/workspaces/${workspace.id}/channels/${publicChannel.id}/join`).set(authHeader(bob.accessToken));
    const privateRes = await request(app)
      .post(`/api/workspaces/${workspace.id}/channels`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'private', type: 'PRIVATE' });

    await sendMessage(owner, publicChannel.id, 'one [[Public Entity]]');
    await sendMessage(owner, publicChannel.id, 'two [[Public Entity]]');
    await sendMessage(owner, privateRes.body.id, 'about [[Private Entity]]');

    const ownerTrending = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/trending`)
      .set(authHeader(owner.accessToken));
    expect(ownerTrending.status).toBe(200);
    expect(ownerTrending.body.total).toBe(2);
    expect(ownerTrending.body.entities.map((e) => e.canonicalName)).toEqual(['Public Entity', 'Private Entity']);
    expect(ownerTrending.body.entities.find((e) => e.canonicalName === 'Public Entity').referenceCount).toBe(2);

    const bobTrending = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/trending`)
      .set(authHeader(bob.accessToken));
    expect(bobTrending.status).toBe(200);
    expect(bobTrending.body.total).toBe(1);
    expect(bobTrending.body.entities).toEqual([
      expect.objectContaining({ canonicalName: 'Public Entity', referenceCount: 2 }),
    ]);
    expect(bobTrending.body.entities.some((e) => e.canonicalName === 'Private Entity')).toBe(false);
  });

  test('two workspaces can independently trend the same entity name', async () => {
    const userA = await signup('entitytrend1a');
    const userB = await signup('entitytrend1b');
    const a = await createWorkspaceAndChannel(userA);
    const b = await createWorkspaceAndChannel(userB);
    await sendMessage(userA, a.channel.id, 'A discusses [[Server Alpha]]');
    await sendMessage(userB, b.channel.id, 'B discusses [[Server Alpha]]');
    await sendMessage(userB, b.channel.id, 'B discusses [[Server Alpha]] again');

    const trendingA = await request(app)
      .get(`/api/workspaces/${a.workspace.id}/entities/trending`)
      .set(authHeader(userA.accessToken));
    expect(trendingA.body.entities).toEqual([expect.objectContaining({ canonicalName: 'Server Alpha', referenceCount: 1 })]);

    const trendingB = await request(app)
      .get(`/api/workspaces/${b.workspace.id}/entities/trending`)
      .set(authHeader(userB.accessToken));
    expect(trendingB.body.entities).toEqual([expect.objectContaining({ canonicalName: 'Server Alpha', referenceCount: 2 })]);
  });

  test('respects windowDays, limit, and offset, and rejects malformed values with 400', async () => {
    const user = await signup('entitytrend2');
    const { workspace, channel } = await createWorkspaceAndChannel(user);
    await sendMessage(user, channel.id, 'discussing [[Old Entity]]');
    // Backdate the old-entity message itself so it falls outside a narrow
    // trending window — windowDays bounds `messages.created_at`, not
    // message_entities (which carries no timestamp of its own).
    await db('messages')
      .whereIn(
        'id',
        db('message_entities as me').join('entities as e', 'e.id', 'me.entity_id').where('e.workspace_id', workspace.id).select('me.message_id'),
      )
      .update({ created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) });
    await sendMessage(user, channel.id, 'discussing [[New Entity]]');

    const narrowWindow = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/trending?windowDays=1`)
      .set(authHeader(user.accessToken));
    expect(narrowWindow.body.entities.map((e) => e.canonicalName)).toEqual(['New Entity']);

    const paged = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/trending?windowDays=365&limit=1&offset=1`)
      .set(authHeader(user.accessToken));
    expect(paged.status).toBe(200);
    expect(paged.body.limit).toBe(1);
    expect(paged.body.offset).toBe(1);
    expect(paged.body.entities).toHaveLength(1);

    const badWindow = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/trending?windowDays=9999`)
      .set(authHeader(user.accessToken));
    expect(badWindow.status).toBe(400);

    const badOffset = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/trending?offset=-1`)
      .set(authHeader(user.accessToken));
    expect(badOffset.status).toBe(400);
  });

  test('a non-member gets 404, never a 403', async () => {
    const owner = await signup('entitytrend3owner');
    const outsider = await signup('entitytrend3out');
    const { workspace } = await createWorkspaceAndChannel(owner);

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/trending`)
      .set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });
});

// FEATURE_REQUEST.md entry 2 (Knowledge Explorer, Subject Matter Experts).
describe('entity experts', () => {
  test('experts are ordered by reference count, and a contributor whose only messages are in a private channel is absent for a caller outside it', async () => {
    const owner = await signup('entityexp0owner');
    const bob = await signup('entityexp0bob');
    const carol = await signup('entityexp0carol');
    const { workspace, channel: publicChannel } = await createWorkspaceAndChannel(owner);
    await addWorkspaceMember(owner, workspace.id, bob);
    await addWorkspaceMember(owner, workspace.id, carol);
    await request(app).post(`/api/workspaces/${workspace.id}/channels/${publicChannel.id}/join`).set(authHeader(bob.accessToken));
    const privateRes = await request(app)
      .post(`/api/workspaces/${workspace.id}/channels`)
      .set(authHeader(owner.accessToken))
      .send({ name: 'private', type: 'PRIVATE' });
    await addChannelMember(owner, workspace.id, privateRes.body.id, carol);

    await sendMessage(owner, publicChannel.id, 'owner on [[Server Alpha]]');
    await sendMessage(bob, publicChannel.id, 'bob on [[Server Alpha]]');
    await sendMessage(carol, privateRes.body.id, 'carol on [[Server Alpha]] privately');
    const entity = await db('entities').where({ workspace_id: workspace.id }).first();

    const ownerExperts = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}/experts`)
      .set(authHeader(owner.accessToken));
    expect(ownerExperts.status).toBe(200);
    expect(ownerExperts.body).toHaveLength(3);
    expect(ownerExperts.body.map((e) => e.username).sort()).toEqual([bob.username, carol.username, owner.username].sort());

    const bobExperts = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}/experts`)
      .set(authHeader(bob.accessToken));
    expect(bobExperts.status).toBe(200);
    expect(bobExperts.body.map((e) => e.username).sort()).toEqual([bob.username, owner.username].sort());
    expect(bobExperts.body.some((e) => e.username === carol.username)).toBe(false);
  });

  test('respects limit and rejects a malformed limit with 400', async () => {
    const owner = await signup('entityexp1owner');
    const bob = await signup('entityexp1bob');
    const { workspace, channel } = await createWorkspaceAndChannel(owner);
    await addWorkspaceMember(owner, workspace.id, bob);
    await request(app).post(`/api/workspaces/${workspace.id}/channels/${channel.id}/join`).set(authHeader(bob.accessToken));
    await sendMessage(owner, channel.id, 'owner on [[Server Alpha]]');
    await sendMessage(bob, channel.id, 'bob on [[Server Alpha]]');
    const entity = await db('entities').where({ workspace_id: workspace.id }).first();

    const limited = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}/experts?limit=1`)
      .set(authHeader(owner.accessToken));
    expect(limited.status).toBe(200);
    expect(limited.body).toHaveLength(1);

    const badLimit = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}/experts?limit=100`)
      .set(authHeader(owner.accessToken));
    expect(badLimit.status).toBe(400);
  });

  test('a non-member gets 404, never a 403', async () => {
    const owner = await signup('entityexp2owner');
    const outsider = await signup('entityexp2out');
    const { workspace, channel } = await createWorkspaceAndChannel(owner);
    const entity = await createEntity(owner, workspace.id, channel.id, 'Server Alpha');

    const res = await request(app)
      .get(`/api/workspaces/${workspace.id}/entities/${entity.id}/experts`)
      .set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });
});
