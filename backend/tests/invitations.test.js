import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';
import { createOrg } from './helpers/fixtures.js';

// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 2.

beforeEach(async () => {
  await resetDb(db);
});

afterAll(async () => {
  await db.destroy();
  await destroyResetDbConnection();
});

async function createWorkspace(owner, name = 'Invite Workspace') {
  const res = await request(app).post('/api/workspaces').set(authHeader(owner.accessToken)).send({ name });
  return res.body;
}

describe('POST /api/organizations/:orgId/invitations', () => {
  test('an ORG_ADMIN can create an invitation and gets a raw token back once', async () => {
    const admin = await seedSystemAdmin('orginviter0');
    const org = await createOrg(admin.accessToken);

    const res = await request(app)
      .post(`/api/organizations/${org.id}/invitations`)
      .set(authHeader(admin.accessToken))
      .send({ email: 'invitee@example.com', role: 'ORG_MEMBER' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: 'invitee@example.com', role: 'ORG_MEMBER' });
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(20);

    const row = await db('audit_logs').where({ action_type: 'INVITATION_CREATED' }).first();
    expect(row.payload).toMatchObject({ scopeType: 'ORGANIZATION', organizationId: org.id });
  });

  test('a plain ORG_MEMBER cannot create an invitation', async () => {
    const admin = await seedSystemAdmin('orginviter1');
    const org = await createOrg(admin.accessToken);

    const member = await signup('orginvitermember1');
    await request(app).post(`/api/organizations/${org.id}/members`).set(authHeader(admin.accessToken)).send({ username: 'orginvitermember1' });

    const res = await request(app)
      .post(`/api/organizations/${org.id}/invitations`)
      .set(authHeader(member.accessToken))
      .send({ email: 'x@example.com' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/workspaces/:workspaceId/invitations', () => {
  test('a workspace OWNER can create an invitation, OWNER role is rejected as invited_role', async () => {
    const owner = await signup('wsinviter0');
    const ws = await createWorkspace(owner);

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ email: 'wsinvitee@example.com', role: 'MANAGER' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('MANAGER');

    const ownerRoleRejected = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ email: 'wsinvitee2@example.com', role: 'OWNER' });
    expect(ownerRoleRejected.status).toBe(400);
  });

  test('a plain workspace MEMBER cannot create an invitation', async () => {
    const owner = await signup('wsinviter1');
    const ws = await createWorkspace(owner);
    const member = await signup('wsinvitermember1');
    await request(app).post(`/api/workspaces/${ws.id}/members`).set(authHeader(owner.accessToken)).send({ username: 'wsinvitermember1' });

    const res = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(member.accessToken))
      .send({ email: 'x@example.com' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/organizations/:orgId/invitations', () => {
  test('lists only PENDING, non-expired invitations for that org', async () => {
    const admin = await seedSystemAdmin('orginvitelist0');
    const org = await createOrg(admin.accessToken);

    const pending = await request(app)
      .post(`/api/organizations/${org.id}/invitations`)
      .set(authHeader(admin.accessToken))
      .send({ email: 'pending0@example.com' });

    const acceptedSource = await request(app)
      .post(`/api/organizations/${org.id}/invitations`)
      .set(authHeader(admin.accessToken))
      .send({ email: 'accepted0@example.com' });
    await request(app)
      .post(`/api/invitations/${acceptedSource.body.token}/accept`)
      .send({ username: 'orginviteaccepted0', password: 'correct-horse-battery' });

    const revoked = await request(app)
      .post(`/api/organizations/${org.id}/invitations`)
      .set(authHeader(admin.accessToken))
      .send({ email: 'revoked0@example.com' });
    await request(app).post(`/api/invitations/${revoked.body.id}/revoke`).set(authHeader(admin.accessToken));

    const expired = await request(app)
      .post(`/api/organizations/${org.id}/invitations`)
      .set(authHeader(admin.accessToken))
      .send({ email: 'expired0@example.com' });
    await db('invitations').where({ id: expired.body.id }).update({ expires_at: new Date(Date.now() - 1000) });

    const res = await request(app).get(`/api/organizations/${org.id}/invitations`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: pending.body.id,
      email: 'pending0@example.com',
      invitedByUsername: 'orginvitelist0',
      // FEATURE_REQUEST.md's "display names as the primary identity" entry.
      invitedByDisplayName: 'orginvitelist0',
    });
  });

  test('a non-member gets 404 for a real org, not 403', async () => {
    const admin = await seedSystemAdmin('orginvitelist1');
    const org = await createOrg(admin.accessToken);

    const outsider = await signup('orginvitelistoutsider1');
    const res = await request(app).get(`/api/organizations/${org.id}/invitations`).set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/workspaces/:workspaceId/invitations', () => {
  test('lists only PENDING, non-expired invitations for that workspace', async () => {
    const owner = await signup('wsinvitelist0');
    const ws = await createWorkspace(owner);

    const pending = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ email: 'wspending0@example.com' });

    const revoked = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ email: 'wsrevoked0@example.com' });
    await request(app).post(`/api/invitations/${revoked.body.id}/revoke`).set(authHeader(owner.accessToken));

    const res = await request(app).get(`/api/workspaces/${ws.id}/invitations`).set(authHeader(owner.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: pending.body.id,
      email: 'wspending0@example.com',
      invitedByUsername: 'wsinvitelist0',
      invitedByDisplayName: 'wsinvitelist0',
    });
  });

  test('a plain member without WORKSPACE_MANAGE_MEMBERS gets 403', async () => {
    const owner = await signup('wsinvitelist1');
    const ws = await createWorkspace(owner);
    const member = await signup('wsinvitelistmember1');
    await request(app).post(`/api/workspaces/${ws.id}/members`).set(authHeader(owner.accessToken)).send({ username: 'wsinvitelistmember1' });

    const res = await request(app).get(`/api/workspaces/${ws.id}/invitations`).set(authHeader(member.accessToken));
    expect(res.status).toBe(403);
  });
});

describe('GET /api/invitations/:token', () => {
  test('a valid pending invitation shows context', async () => {
    const owner = await signup('wsinvitepreview0');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ email: 'previewee@example.com', role: 'MEMBER' });

    const res = await request(app).get(`/api/invitations/${createRes.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      scopeType: 'WORKSPACE',
      scopeName: ws.name,
      invitedRole: 'MEMBER',
      invitedByUsername: 'wsinvitepreview0',
      invitedByDisplayName: 'wsinvitepreview0',
    });
  });

  test('a made-up token 404s, indistinguishable from a real-but-invalid one', async () => {
    const res = await request(app).get('/api/invitations/not-a-real-token-at-all');
    expect(res.status).toBe(404);
  });

  test('an expired invitation 404s the same way as a made-up token', async () => {
    const owner = await signup('wsinvitepreview1');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ email: 'expiredpreview@example.com' });

    await db('invitations').where({ id: createRes.body.id }).update({ expires_at: new Date(Date.now() - 1000) });

    const res = await request(app).get(`/api/invitations/${createRes.body.token}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/invitations/:token/accept', () => {
  test('creates an account, attaches the invited-role membership, and logs in atomically', async () => {
    const owner = await signup('wsaccept0');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ email: 'accepted0@example.com', role: 'MANAGER' });

    const res = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'accepteduser0', password: 'correct-horse-battery' });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({
      username: 'accepteduser0',
      displayName: 'accepteduser0',
      email: 'accepted0@example.com',
      isSystemAdmin: false,
    });
    expect(res.headers['set-cookie']?.[0]).toMatch(/refresh_token=/);

    const membership = await db('workspace_members').where({ workspace_id: ws.id, user_id: res.body.user.id }).first();
    expect(membership.system_role).toBe('MANAGER');

    // Signup-parity auto-enrollment: a workspace-invited account still gets
    // a default org membership too.
    const orgMembership = await db('organization_members').where({ user_id: res.body.user.id });
    expect(orgMembership).toHaveLength(1);

    const invitationRow = await db('invitations').where({ id: createRes.body.id }).first();
    expect(invitationRow.status).toBe('ACCEPTED');
    expect(invitationRow.accepted_by).toBe(res.body.user.id);

    const auditRow = await db('audit_logs').where({ action_type: 'INVITATION_REDEEMED' }).first();
    expect(auditRow.actor_id).toBe(res.body.user.id);
  });

  test('an org-scoped invitation attaches org membership directly, no double org row', async () => {
    const admin = await seedSystemAdmin('orgaccept0');
    const org = await createOrg(admin.accessToken);
    const createRes = await request(app)
      .post(`/api/organizations/${org.id}/invitations`)
      .set(authHeader(admin.accessToken))
      .send({ email: 'orgaccepted0@example.com', role: 'ORG_ADMIN' });

    const res = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'orgaccepteduser0', password: 'correct-horse-battery' });
    expect(res.status).toBe(201);

    const memberships = await db('organization_members').where({ user_id: res.body.user.id });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ organization_id: org.id, org_role: 'ORG_ADMIN' });
  });

  test('an email/username collision 409s', async () => {
    await signup('collideduser0');
    const owner = await signup('wsacceptcollide0');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ email: 'collideduser0@example.com' });

    const res = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'collideduser0', password: 'correct-horse-battery' });
    expect(res.status).toBe(409);
  });

  test('accepting the same token twice 404s the second time', async () => {
    const owner = await signup('wsacceptreuse0');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ email: 'reuse0@example.com' });

    const first = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'reuseuser0', password: 'correct-horse-battery' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'reuseuser0-again', password: 'correct-horse-battery' });
    expect(second.status).toBe(404);
  });

  test('an expired token 404s at accept time too', async () => {
    const owner = await signup('wsacceptexpired0');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ email: 'expiredaccept0@example.com' });
    await db('invitations').where({ id: createRes.body.id }).update({ expires_at: new Date(Date.now() - 1000) });

    const res = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'expiredacceptuser0', password: 'correct-horse-battery' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/invitations/:id/revoke', () => {
  test('the inviter can revoke a pending invitation, and it can no longer be accepted', async () => {
    const owner = await signup('wsrevoke0');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ email: 'revoked0@example.com' });

    const revokeRes = await request(app).post(`/api/invitations/${createRes.body.id}/revoke`).set(authHeader(owner.accessToken));
    expect(revokeRes.status).toBe(204);

    const acceptRes = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'revokeduser0', password: 'correct-horse-battery' });
    expect(acceptRes.status).toBe(404);
  });

  test('an unrelated workspace member (not the inviter, no manage-members permission) cannot revoke', async () => {
    const owner = await signup('wsrevoke1');
    const ws = await createWorkspace(owner);
    const otherMember = await signup('wsrevokemember1');
    await request(app).post(`/api/workspaces/${ws.id}/members`).set(authHeader(owner.accessToken)).send({ username: 'wsrevokemember1' });
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ email: 'revoked1@example.com' });

    const res = await request(app).post(`/api/invitations/${createRes.body.id}/revoke`).set(authHeader(otherMember.accessToken));
    expect(res.status).toBe(403);
  });

  test('a total outsider (not even a workspace member) gets 404, not 403', async () => {
    const owner = await signup('wsrevoke1b');
    const ws = await createWorkspace(owner);
    const outsider = await signup('wsrevokeoutsider1b');
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ email: 'revoked1b@example.com' });

    const res = await request(app).post(`/api/invitations/${createRes.body.id}/revoke`).set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });

  test('revoking an already-accepted invitation is an idempotent no-op 204, not a re-revocation error', async () => {
    const owner = await signup('wsrevoke2');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ email: 'revoked2@example.com' });
    await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'revoked2user', password: 'correct-horse-battery' });

    const res = await request(app).post(`/api/invitations/${createRes.body.id}/revoke`).set(authHeader(owner.accessToken));
    expect(res.status).toBe(204);

    const row = await db('invitations').where({ id: createRes.body.id }).first();
    expect(row.status).toBe('ACCEPTED'); // unchanged — revoke doesn't overwrite a terminal ACCEPTED state
  });
});
