import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';

// FEATURE_REQUEST.md entry 5: GET /api/admin/analytics/activity and
// GET /api/admin/analytics/dormant-channels — system-admin-only aggregate
// reads over messages.created_at/channel_id/user_id and channel_members,
// never messages.content, scoped to non-DM channels by construction.

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

async function createOrganization(name) {
  const [row] = await db('organizations').insert({ name }).returning('id');
  return row.id;
}

async function createWorkspace(user, organizationId) {
  const res = await request(app)
    .post('/api/workspaces')
    .set(authHeader(user.accessToken))
    .send({ name: 'W', organizationId });
  return res.body.id;
}

async function createChannel(user, workspaceId, name = 'general', type = 'PUBLIC') {
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/channels`)
    .set(authHeader(user.accessToken))
    .send({ name, type });
  return res.body.id;
}

async function sendMessage(user, channelId, content = 'hello') {
  const res = await request(app)
    .post(`/api/channels/${channelId}/messages`)
    .set(authHeader(user.accessToken))
    .send({ content });
  return res.body.id;
}

async function replyToMessage(user, channelId, parentMessageId, content = 'reply') {
  const res = await request(app)
    .post(`/api/channels/${channelId}/messages`)
    .set(authHeader(user.accessToken))
    .send({ content, parentMessageId });
  return res.body.id;
}

async function addChannelMember(channelId, userId) {
  await db('channel_members').insert({ channel_id: channelId, user_id: userId });
}

describe('GET /api/admin/analytics/activity', () => {
  test('a non-system-admin caller gets 403', async () => {
    const user = await signup('act-nonadmin0');
    const res = await request(app).get('/api/admin/analytics/activity').set(authHeader(user.accessToken));
    expect(res.status).toBe(403);
  });

  test('aggregates message and active user counts within the default window', async () => {
    const admin = await seedSystemAdmin('act-admin0');
    const orgId = await createOrganization('OrgA');
    const owner = await signup('act-owner0', { organizationId: orgId });
    const other = await signup('act-other0', { organizationId: orgId });
    const workspaceId = await createWorkspace(owner, orgId);
    const channelId = await createChannel(owner, workspaceId);
    await db('channel_members').insert({ channel_id: channelId, user_id: other.userId });
    await sendMessage(owner, channelId, 'first');
    await sendMessage(owner, channelId, 'second');
    await sendMessage(other, channelId, 'third');

    const res = await request(app)
      .get(`/api/admin/analytics/activity?scope=channel&scopeId=${channelId}`)
      .set(authHeader(admin.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.buckets).toHaveLength(1);
    expect(res.body.buckets[0].messageCount).toBe(3);
    expect(res.body.buckets[0].activeUserCount).toBe(2);
  });

  test('scope=workspace restricts counts to that workspace only', async () => {
    const admin = await seedSystemAdmin('act-admin1');
    const orgId = await createOrganization('OrgB');
    const owner = await signup('act-owner1', { organizationId: orgId });
    const workspaceA = await createWorkspace(owner, orgId);
    const workspaceB = await createWorkspace(owner, orgId);
    const channelA = await createChannel(owner, workspaceA, 'a-general');
    const channelB = await createChannel(owner, workspaceB, 'b-general');
    await sendMessage(owner, channelA, 'in A');
    await sendMessage(owner, channelB, 'in B');
    await sendMessage(owner, channelB, 'in B again');

    const res = await request(app)
      .get(`/api/admin/analytics/activity?scope=workspace&scopeId=${workspaceB}`)
      .set(authHeader(admin.accessToken));

    expect(res.body.buckets[0].messageCount).toBe(2);
  });

  test('scope=organization aggregates across every workspace in that organization, excluding others', async () => {
    const admin = await seedSystemAdmin('act-admin2');
    const orgA = await createOrganization('OrgC');
    const orgB = await createOrganization('OrgD');
    const ownerA = await signup('act-ownerA2', { organizationId: orgA });
    const ownerB = await signup('act-ownerB2', { organizationId: orgB });
    const workspaceA1 = await createWorkspace(ownerA, orgA);
    const workspaceA2 = await createWorkspace(ownerA, orgA);
    const workspaceB1 = await createWorkspace(ownerB, orgB);
    const channelA1 = await createChannel(ownerA, workspaceA1);
    const channelA2 = await createChannel(ownerA, workspaceA2);
    const channelB1 = await createChannel(ownerB, workspaceB1);
    await sendMessage(ownerA, channelA1, 'a1');
    await sendMessage(ownerA, channelA2, 'a2');
    await sendMessage(ownerB, channelB1, 'b1');

    const res = await request(app)
      .get(`/api/admin/analytics/activity?scope=organization&scopeId=${orgA}`)
      .set(authHeader(admin.accessToken));

    expect(res.body.buckets[0].messageCount).toBe(2);
  });

  test('omitting scope/scopeId reports across every organization', async () => {
    const admin = await seedSystemAdmin('act-admin3');
    const orgId = await createOrganization('OrgE');
    const owner = await signup('act-owner3', { organizationId: orgId });
    const workspaceId = await createWorkspace(owner, orgId);
    const channelId = await createChannel(owner, workspaceId);
    await sendMessage(owner, channelId, 'hi');

    const res = await request(app).get('/api/admin/analytics/activity').set(authHeader(admin.accessToken));
    expect(res.body.buckets[0].messageCount).toBeGreaterThanOrEqual(1);
  });

  test('a DM-only conversation contributes zero rows to any scope', async () => {
    const admin = await seedSystemAdmin('act-admin4');
    const orgId = await createOrganization('OrgF');
    const owner = await signup('act-owner4', { organizationId: orgId });
    const other = await signup('act-other4', { organizationId: orgId });
    const dmRes = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(owner.accessToken))
      .send({ targetUserId: other.userId });
    await sendMessage(owner, dmRes.body.id, 'a dm message, never counted here');

    const res = await request(app).get('/api/admin/analytics/activity').set(authHeader(admin.accessToken));
    expect(res.body.buckets).toEqual([]);
  });

  test('a message older than windowDays is excluded', async () => {
    const admin = await seedSystemAdmin('act-admin5');
    const orgId = await createOrganization('OrgG');
    const owner = await signup('act-owner5', { organizationId: orgId });
    const workspaceId = await createWorkspace(owner, orgId);
    const channelId = await createChannel(owner, workspaceId);
    const messageId = await sendMessage(owner, channelId, 'old');
    await db('messages')
      .where({ id: messageId })
      .update({ created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) });

    const res = await request(app)
      .get(`/api/admin/analytics/activity?scope=channel&scopeId=${channelId}`)
      .set(authHeader(admin.accessToken));
    expect(res.body.buckets).toEqual([]);
  });

  test.each([
    ['scope without scopeId', { scope: 'workspace' }],
    ['scopeId without scope', { scopeId: '11111111-1111-1111-1111-111111111111' }],
    ['an invalid scope value', { scope: 'bogus', scopeId: '11111111-1111-1111-1111-111111111111' }],
    ['a malformed scopeId', { scope: 'workspace', scopeId: 'not-a-uuid' }],
    ['windowDays out of bounds', { windowDays: '9999' }],
    ['a non-integer windowDays', { windowDays: 'abc' }],
    ['an invalid bucket', { bucket: 'month' }],
  ])('rejects %s with 400', async (_label, params) => {
    const admin = await seedSystemAdmin(`act-admin-bad-${Math.random().toString(36).slice(2, 8)}`);
    const qs = new URLSearchParams(params).toString();
    const res = await request(app)
      .get(`/api/admin/analytics/activity?${qs}`)
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/analytics/dormant-channels', () => {
  test('a non-system-admin caller gets 403', async () => {
    const user = await signup('dorm-nonadmin0');
    const res = await request(app).get('/api/admin/analytics/dormant-channels').set(authHeader(user.accessToken));
    expect(res.status).toBe(403);
  });

  test('a never-messaged channel older than windowDays is reported dormant, from its own created_at', async () => {
    const admin = await seedSystemAdmin('dorm-admin0');
    const orgId = await createOrganization('OrgH');
    const owner = await signup('dorm-owner0', { organizationId: orgId });
    const workspaceId = await createWorkspace(owner, orgId);
    const channelId = await createChannel(owner, workspaceId);
    await db('channels')
      .where({ id: channelId })
      .update({ created_at: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) });

    const res = await request(app)
      .get('/api/admin/analytics/dormant-channels?windowDays=30')
      .set(authHeader(admin.accessToken));

    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.channelId === channelId);
    expect(row).toBeTruthy();
    expect(row.daysSinceActivity).toBeGreaterThanOrEqual(44);
    expect(row.workspaceId).toBe(workspaceId);
    expect(row.organizationId).toBe(orgId);
  });

  test('a channel with a recent message is not reported dormant', async () => {
    const admin = await seedSystemAdmin('dorm-admin1');
    const orgId = await createOrganization('OrgI');
    const owner = await signup('dorm-owner1', { organizationId: orgId });
    const workspaceId = await createWorkspace(owner, orgId);
    const channelId = await createChannel(owner, workspaceId);
    await sendMessage(owner, channelId, 'fresh');

    const res = await request(app)
      .get('/api/admin/analytics/dormant-channels?windowDays=30')
      .set(authHeader(admin.accessToken));
    expect(res.body.find((r) => r.channelId === channelId)).toBeUndefined();
  });

  test('a fresh message reactivates a channel with an old prior message — dormancy is recomputed live, not stored', async () => {
    const admin = await seedSystemAdmin('dorm-admin2');
    const orgId = await createOrganization('OrgJ');
    const owner = await signup('dorm-owner2', { organizationId: orgId });
    const workspaceId = await createWorkspace(owner, orgId);
    const channelId = await createChannel(owner, workspaceId);
    const oldMessageId = await sendMessage(owner, channelId, 'old');
    await db('messages')
      .where({ id: oldMessageId })
      .update({ created_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) });
    await sendMessage(owner, channelId, 'new');

    const res = await request(app)
      .get('/api/admin/analytics/dormant-channels?windowDays=30')
      .set(authHeader(admin.accessToken));
    expect(res.body.find((r) => r.channelId === channelId)).toBeUndefined();
  });

  test('a channel whose most recent message exceeds windowDays is reported dormant', async () => {
    const admin = await seedSystemAdmin('dorm-admin3');
    const orgId = await createOrganization('OrgK');
    const owner = await signup('dorm-owner3', { organizationId: orgId });
    const workspaceId = await createWorkspace(owner, orgId);
    const channelId = await createChannel(owner, workspaceId);
    const messageId = await sendMessage(owner, channelId, 'stale');
    await db('messages')
      .where({ id: messageId })
      .update({ created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) });

    const res = await request(app)
      .get('/api/admin/analytics/dormant-channels?windowDays=30')
      .set(authHeader(admin.accessToken));
    const row = res.body.find((r) => r.channelId === channelId);
    expect(row).toBeTruthy();
    expect(row.daysSinceActivity).toBeGreaterThanOrEqual(39);
  });

  test('a DM/group-DM channel never appears, regardless of dormancy', async () => {
    const admin = await seedSystemAdmin('dorm-admin4');
    const orgId = await createOrganization('OrgL');
    const owner = await signup('dorm-owner4', { organizationId: orgId });
    const other = await signup('dorm-other4', { organizationId: orgId });
    const dmRes = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(owner.accessToken))
      .send({ targetUserId: other.userId });
    const dmMessageId = await sendMessage(owner, dmRes.body.id, 'old dm');
    await db('messages')
      .where({ id: dmMessageId })
      .update({ created_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) });

    const res = await request(app)
      .get('/api/admin/analytics/dormant-channels?windowDays=1')
      .set(authHeader(admin.accessToken));
    expect(res.body.find((r) => r.channelId === dmRes.body.id)).toBeUndefined();
  });

  test('rejects an out-of-bounds windowDays with 400', async () => {
    const admin = await seedSystemAdmin('dorm-admin5');
    const res = await request(app)
      .get('/api/admin/analytics/dormant-channels?windowDays=9999')
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/analytics/collaboration/membership-graph', () => {
  test('a non-system-admin caller gets 403', async () => {
    const user = await signup('mg-nonadmin0');
    const res = await request(app)
      .get('/api/admin/analytics/collaboration/membership-graph')
      .set(authHeader(user.accessToken));
    expect(res.status).toBe(403);
  });

  test('rejects scope=channel — not a valid scope for this endpoint — with 400', async () => {
    const admin = await seedSystemAdmin('mg-admin-bad0');
    const res = await request(app)
      .get('/api/admin/analytics/collaboration/membership-graph?scope=channel&scopeId=11111111-1111-1111-1111-111111111111')
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(400);
  });

  test('a pair sharing more channels than the threshold appears; a pair at or below it is absent entirely, including from nodes', async () => {
    const admin = await seedSystemAdmin('mg-admin0');
    const orgId = await createOrganization('MgOrgA');
    const owner = await signup('mg-owner0', { organizationId: orgId });
    const userB = await signup('mg-userB0', { organizationId: orgId });
    const userC = await signup('mg-userC0', { organizationId: orgId });
    const workspaceId = await createWorkspace(owner, orgId);
    const ch1 = await createChannel(owner, workspaceId, 'ch1');
    const ch2 = await createChannel(owner, workspaceId, 'ch2');
    const ch3 = await createChannel(owner, workspaceId, 'ch3');
    // owner+userB share all 3 channels (owner auto-joins each on creation);
    // owner+userC share only ch1.
    await addChannelMember(ch1, userB.userId);
    await addChannelMember(ch2, userB.userId);
    await addChannelMember(ch3, userB.userId);
    await addChannelMember(ch1, userC.userId);

    const res = await request(app)
      .get(`/api/admin/analytics/collaboration/membership-graph?scope=workspace&scopeId=${workspaceId}`)
      .set(authHeader(admin.accessToken));

    expect(res.status).toBe(200);
    const edgeAB = res.body.edges.find(
      (e) => [e.userA, e.userB].includes(owner.userId) && [e.userA, e.userB].includes(userB.userId),
    );
    expect(edgeAB).toBeTruthy();
    expect(edgeAB.sharedChannels).toBe(3);
    const edgeAC = res.body.edges.find((e) => [e.userA, e.userB].includes(userC.userId));
    expect(edgeAC).toBeUndefined();
    expect(res.body.nodes.some((n) => n.userId === userC.userId)).toBe(false);
  });

  test('?minSharedChannels=0 includes a pair sharing exactly one channel', async () => {
    const admin = await seedSystemAdmin('mg-admin1');
    const orgId = await createOrganization('MgOrgB');
    const owner = await signup('mg-owner1', { organizationId: orgId });
    const userB = await signup('mg-userB1', { organizationId: orgId });
    const workspaceId = await createWorkspace(owner, orgId);
    const ch1 = await createChannel(owner, workspaceId, 'ch1');
    await addChannelMember(ch1, userB.userId);

    const res = await request(app)
      .get(`/api/admin/analytics/collaboration/membership-graph?scope=workspace&scopeId=${workspaceId}&minSharedChannels=0`)
      .set(authHeader(admin.accessToken));
    expect(res.body.edges).toHaveLength(1);
    expect(res.body.edges[0].sharedChannels).toBe(1);
  });

  test('a DM-only shared membership never contributes an edge', async () => {
    const admin = await seedSystemAdmin('mg-admin2');
    const owner = await signup('mg-owner2');
    const other = await signup('mg-other2');
    const dmRes = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(owner.accessToken))
      .send({ targetUserId: other.userId });
    expect(dmRes.status).toBe(201);

    const res = await request(app)
      .get('/api/admin/analytics/collaboration/membership-graph?minSharedChannels=0')
      .set(authHeader(admin.accessToken));
    const edge = res.body.edges.find(
      (e) => [e.userA, e.userB].includes(owner.userId) && [e.userA, e.userB].includes(other.userId),
    );
    expect(edge).toBeUndefined();
  });

  test('scope=organization aggregates across that organization only, excluding another organization', async () => {
    const admin = await seedSystemAdmin('mg-admin3');
    const orgA = await createOrganization('MgOrgC');
    const orgB = await createOrganization('MgOrgD');
    const ownerA = await signup('mg-ownerA3', { organizationId: orgA });
    const userBA = await signup('mg-userBA3', { organizationId: orgA });
    const ownerB = await signup('mg-ownerB3', { organizationId: orgB });
    const userBB = await signup('mg-userBB3', { organizationId: orgB });
    const wsA = await createWorkspace(ownerA, orgA);
    const wsB = await createWorkspace(ownerB, orgB);
    const chA = await createChannel(ownerA, wsA, 'chA');
    const chB = await createChannel(ownerB, wsB, 'chB');
    await addChannelMember(chA, userBA.userId);
    await addChannelMember(chB, userBB.userId);

    const res = await request(app)
      .get(`/api/admin/analytics/collaboration/membership-graph?scope=organization&scopeId=${orgA}&minSharedChannels=0`)
      .set(authHeader(admin.accessToken));
    expect(res.body.edges.some((e) => [e.userA, e.userB].includes(ownerA.userId))).toBe(true);
    expect(res.body.edges.some((e) => [e.userA, e.userB].includes(ownerB.userId))).toBe(false);
  });
});

describe('GET /api/admin/analytics/collaboration/interaction-trend', () => {
  test('a non-system-admin caller gets 403', async () => {
    const user = await signup('it-nonadmin0');
    const res = await request(app)
      .get('/api/admin/analytics/collaboration/interaction-trend')
      .set(authHeader(user.accessToken));
    expect(res.status).toBe(403);
  });

  test('counts a reply from a different user; excludes a self-reply', async () => {
    const admin = await seedSystemAdmin('it-admin0');
    const orgId = await createOrganization('ItOrgA');
    const owner = await signup('it-owner0', { organizationId: orgId });
    const replier = await signup('it-replier0', { organizationId: orgId });
    const workspaceId = await createWorkspace(owner, orgId);
    const channelId = await createChannel(owner, workspaceId);
    await addChannelMember(channelId, replier.userId);
    const rootId = await sendMessage(owner, channelId, 'root');
    await replyToMessage(replier, channelId, rootId, 'a real reply');
    await replyToMessage(owner, channelId, rootId, 'a self-reply, never an interaction');

    const res = await request(app)
      .get(`/api/admin/analytics/collaboration/interaction-trend?scope=channel&scopeId=${channelId}`)
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.buckets).toHaveLength(1);
    expect(res.body.buckets[0].replyCount).toBe(1);
    expect(res.body.buckets[0].distinctPairCount).toBe(1);
  });

  test('a DM reply never contributes', async () => {
    const admin = await seedSystemAdmin('it-admin1');
    const owner = await signup('it-owner1');
    const other = await signup('it-other1');
    const dmRes = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(owner.accessToken))
      .send({ targetUserId: other.userId });
    const rootId = await sendMessage(owner, dmRes.body.id, 'root');
    await replyToMessage(other, dmRes.body.id, rootId, 'reply');

    const res = await request(app)
      .get('/api/admin/analytics/collaboration/interaction-trend')
      .set(authHeader(admin.accessToken));
    expect(res.body.buckets).toEqual([]);
  });

  test('malformed windowDays/bucket get 400', async () => {
    const admin = await seedSystemAdmin('it-admin2');
    const res1 = await request(app)
      .get('/api/admin/analytics/collaboration/interaction-trend?windowDays=abc')
      .set(authHeader(admin.accessToken));
    expect(res1.status).toBe(400);
    const res2 = await request(app)
      .get('/api/admin/analytics/collaboration/interaction-trend?bucket=month')
      .set(authHeader(admin.accessToken));
    expect(res2.status).toBe(400);
  });
});

describe('GET /api/admin/analytics/sentiment-trend', () => {
  test('a non-system-admin caller gets 403', async () => {
    const user = await signup('st-nonadmin0');
    const res = await request(app).get('/api/admin/analytics/sentiment-trend').set(authHeader(user.accessToken));
    expect(res.status).toBe(403);
  });

  test('aggregates avgScore/messageCount once a bucket has at least the minimum scored messages', async () => {
    const admin = await seedSystemAdmin('st-admin0');
    const orgId = await createOrganization('StOrgA');
    const owner = await signup('st-owner0', { organizationId: orgId });
    const workspaceId = await createWorkspace(owner, orgId);
    const channelId = await createChannel(owner, workspaceId);

    const threshold = config.sentiment.minBucketMessages;
    const scores = [];
    for (let i = 0; i < threshold; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const messageId = await sendMessage(owner, channelId, `msg ${i}`);
      const score = i % 2 === 0 ? 0.5 : -0.5;
      scores.push(score);
      // eslint-disable-next-line no-await-in-loop
      await db('message_sentiment_scores').insert({ message_id: messageId, score, model: 'test-model' });
    }

    const res = await request(app)
      .get(`/api/admin/analytics/sentiment-trend?scope=channel&scopeId=${channelId}`)
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.buckets).toHaveLength(1);
    expect(res.body.buckets[0].messageCount).toBe(threshold);
    const expectedAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
    expect(res.body.buckets[0].avgScore).toBeCloseTo(expectedAvg);
  });

  test('a bucket below the minimum scored-message count is dropped from the response entirely', async () => {
    const admin = await seedSystemAdmin('st-admin1');
    const orgId = await createOrganization('StOrgB');
    const owner = await signup('st-owner1', { organizationId: orgId });
    const workspaceId = await createWorkspace(owner, orgId);
    const channelId = await createChannel(owner, workspaceId);

    const belowThreshold = Math.max(0, config.sentiment.minBucketMessages - 1);
    for (let i = 0; i < belowThreshold; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const messageId = await sendMessage(owner, channelId, `msg ${i}`);
      // eslint-disable-next-line no-await-in-loop
      await db('message_sentiment_scores').insert({ message_id: messageId, score: 0.1, model: 'test-model' });
    }

    const res = await request(app)
      .get(`/api/admin/analytics/sentiment-trend?scope=channel&scopeId=${channelId}`)
      .set(authHeader(admin.accessToken));
    expect(res.body.buckets).toEqual([]);
  });

  test('a DM message with a sentiment score never contributes', async () => {
    const admin = await seedSystemAdmin('st-admin2');
    const owner = await signup('st-owner2');
    const other = await signup('st-other2');
    const dmRes = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(owner.accessToken))
      .send({ targetUserId: other.userId });
    const messageId = await sendMessage(owner, dmRes.body.id, 'dm message');
    await db('message_sentiment_scores').insert({ message_id: messageId, score: 1, model: 'test-model' });

    const res = await request(app).get('/api/admin/analytics/sentiment-trend').set(authHeader(admin.accessToken));
    expect(res.body.buckets).toEqual([]);
  });

  test('scope=user writes exactly one AI_SENTIMENT_TREND_VIEWED audit row; other scopes write none', async () => {
    const admin = await seedSystemAdmin('st-admin3');
    const orgId = await createOrganization('StOrgC');
    const owner = await signup('st-owner3', { organizationId: orgId });
    const workspaceId = await createWorkspace(owner, orgId);
    const channelId = await createChannel(owner, workspaceId);
    const messageId = await sendMessage(owner, channelId, 'msg');
    await db('message_sentiment_scores').insert({ message_id: messageId, score: 0.2, model: 'test-model' });

    await request(app)
      .get(`/api/admin/analytics/sentiment-trend?scope=channel&scopeId=${channelId}`)
      .set(authHeader(admin.accessToken));
    const channelScopedAuditRows = await db('audit_logs').where({ action_type: 'AI_SENTIMENT_TREND_VIEWED' });
    expect(channelScopedAuditRows).toHaveLength(0);

    await request(app)
      .get(`/api/admin/analytics/sentiment-trend?scope=user&scopeId=${owner.userId}`)
      .set(authHeader(admin.accessToken));
    const userScopedAuditRows = await db('audit_logs').where({ action_type: 'AI_SENTIMENT_TREND_VIEWED' });
    expect(userScopedAuditRows).toHaveLength(1);
    expect(userScopedAuditRows[0].target_resource).toBe(owner.userId);
  });

  test('rejects a malformed scope with 400', async () => {
    const admin = await seedSystemAdmin('st-admin4');
    const res = await request(app)
      .get('/api/admin/analytics/sentiment-trend?scope=bogus&scopeId=11111111-1111-1111-1111-111111111111')
      .set(authHeader(admin.accessToken));
    expect(res.status).toBe(400);
  });
});
