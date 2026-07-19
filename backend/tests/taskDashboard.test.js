import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, authHeader } from './helpers/testUsers.js';

// FEATURE_REQUEST.md entry 3: GET /api/workspaces/:workspaceId/tasks — a
// bounded, workspace-scoped projection of every task line the caller is
// authorized to see, recomputed live from messages.content via
// parseTasks() rather than a second system of record.

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

async function createWorkspace(user) {
  const res = await request(app).post('/api/workspaces').set(authHeader(user.accessToken)).send({ name: 'W' });
  return res.body.id;
}

async function createChannel(user, workspaceId, name = 'general', type = 'PUBLIC') {
  const res = await request(app)
    .post(`/api/workspaces/${workspaceId}/channels`)
    .set(authHeader(user.accessToken))
    .send({ name, type });
  return res.body.id;
}

async function addWorkspaceMember(workspaceId, user) {
  await db('workspace_members').insert({ workspace_id: workspaceId, user_id: user.userId, system_role: 'MEMBER' });
}

async function sendMessage(user, channelId, content) {
  const res = await request(app)
    .post(`/api/channels/${channelId}/messages`)
    .set(authHeader(user.accessToken))
    .send({ content });
  return res.body.id;
}

describe('GET /workspaces/:workspaceId/tasks', () => {
  test('returns task rows parsed from messages in channels the caller belongs to', async () => {
    const owner = await signup('dashowner0');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    await sendMessage(owner, channelId, '- [ ] first task\n- [x] second task [owner:: @dashowner0]');

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/tasks`)
      .set(authHeader(owner.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(2);
    const [first, second] = res.body.tasks;
    expect(first).toMatchObject({ channelId, taskIndex: 0, checked: false, text: 'first task', owner: null });
    expect(second).toMatchObject({ channelId, taskIndex: 1, checked: true, text: 'second task', owner: 'dashowner0' });
  });

  test('a message with no checkbox syntax contributes no rows', async () => {
    const owner = await signup('dashowner1');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    await sendMessage(owner, channelId, 'just a normal message');

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/tasks`)
      .set(authHeader(owner.accessToken));
    expect(res.body.tasks).toEqual([]);
  });

  test('a non-member of the workspace gets the existing existence-hiding 404', async () => {
    const owner = await signup('dashowner2');
    const outsider = await signup('dashoutsider0');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/tasks`)
      .set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });

  test('a private-channel task never appears for a workspace member who is not a member of that channel', async () => {
    const owner = await signup('dashowner3');
    const workspaceMemberOnly = await signup('dashmember0');
    const workspaceId = await createWorkspace(owner);
    await addWorkspaceMember(workspaceId, workspaceMemberOnly);
    const privateChannelId = await createChannel(owner, workspaceId, 'secret', 'PRIVATE');
    await sendMessage(owner, privateChannelId, '- [ ] a private task');

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/tasks`)
      .set(authHeader(workspaceMemberOnly.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([]);
  });

  test('a public-channel task is invisible to a workspace member who never joined that channel — dashboard visibility is channel_members-scoped, not workspace-wide', async () => {
    const owner = await signup('dashowner4');
    const member = await signup('dashmember1');
    const workspaceId = await createWorkspace(owner);
    await addWorkspaceMember(workspaceId, member);
    const channelId = await createChannel(owner, workspaceId);
    // Membership in a PUBLIC channel is required for the toggle endpoint,
    // but the dashboard's own visibility is scoped by channel_members just
    // like every other channel-content query in this app — a workspace
    // member who never joined this particular public channel is expected to
    // see zero rows from it, mirroring requireChannelMember's own gate
    // elsewhere rather than granting a wider "any public channel" carve-out.
    await sendMessage(owner, channelId, '- [ ] task in a channel the member never joined');

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/tasks`)
      .set(authHeader(member.accessToken));
    expect(res.body.tasks).toEqual([]);
  });

  test('a task from a different workspace never leaks in, even for the same user', async () => {
    const owner = await signup('dashowner5');
    const workspaceIdA = await createWorkspace(owner);
    const workspaceIdB = await createWorkspace(owner);
    const channelA = await createChannel(owner, workspaceIdA, 'a-general');
    const channelB = await createChannel(owner, workspaceIdB, 'b-general');
    await sendMessage(owner, channelA, '- [ ] task in workspace A');
    await sendMessage(owner, channelB, '- [ ] task in workspace B');

    const res = await request(app)
      .get(`/api/workspaces/${workspaceIdA}/tasks`)
      .set(authHeader(owner.accessToken));
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0].text).toBe('task in workspace A');
  });

  test('a message older than the rolling window is excluded', async () => {
    const owner = await signup('dashowner6');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    const messageId = await sendMessage(owner, channelId, '- [ ] an old task');
    const outsideWindow = new Date(Date.now() - (config.tasks.dashboardWindowDays + 1) * 24 * 60 * 60 * 1000);
    await db('messages').where({ id: messageId }).update({ created_at: outsideWindow });

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/tasks`)
      .set(authHeader(owner.accessToken));
    expect(res.body.tasks).toEqual([]);
  });

  test('?windowDays widens the window beyond the configured default', async () => {
    const owner = await signup('dashowner7');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    const messageId = await sendMessage(owner, channelId, '- [ ] an old task');
    const daysAgo = config.tasks.dashboardWindowDays + 5;
    await db('messages')
      .where({ id: messageId })
      .update({ created_at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000) });

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/tasks?windowDays=${daysAgo + 1}`)
      .set(authHeader(owner.accessToken));
    expect(res.body.tasks).toHaveLength(1);
  });

  test('rejects a windowDays outside the allowed bound', async () => {
    const owner = await signup('dashowner8');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/tasks?windowDays=99999`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(400);
  });

  test('rejects a malformed cursor', async () => {
    const owner = await signup('dashowner9');
    const workspaceId = await createWorkspace(owner);

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/tasks?cursor=not-a-date`)
      .set(authHeader(owner.accessToken));
    expect(res.status).toBe(400);
  });

  test('pagination: limit bounds the number of source messages scanned, and nextCursor allows resuming', async () => {
    const owner = await signup('dashowner10');
    const workspaceId = await createWorkspace(owner);
    const channelId = await createChannel(owner, workspaceId);
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sendMessage(owner, channelId, `- [ ] task ${i}`);
    }

    const page1 = await request(app)
      .get(`/api/workspaces/${workspaceId}/tasks?limit=2`)
      .set(authHeader(owner.accessToken));
    expect(page1.body.tasks).toHaveLength(2);
    expect(page1.body.tasks.map((t) => t.text)).toEqual(['task 2', 'task 1']);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await request(app)
      .get(`/api/workspaces/${workspaceId}/tasks?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set(authHeader(owner.accessToken));
    expect(page2.body.tasks.map((t) => t.text)).toEqual(['task 0']);
    expect(page2.body.nextCursor).toBeNull();
  });

  test('DM/group-DM content is out of scope by construction — never surfaces in any workspace dashboard', async () => {
    const owner = await signup('dashowner11');
    const other = await signup('dashother0');
    const workspaceId = await createWorkspace(owner);

    const dmRes = await request(app)
      .post('/api/direct-messages')
      .set(authHeader(owner.accessToken))
      .send({ targetUserId: other.userId });
    await sendMessage(owner, dmRes.body.id, '- [ ] a DM task, never a workspace task');

    const res = await request(app)
      .get(`/api/workspaces/${workspaceId}/tasks`)
      .set(authHeader(owner.accessToken));
    expect(res.body.tasks).toEqual([]);
  });
});
