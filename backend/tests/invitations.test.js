import request from 'supertest';
import { app } from '../src/index.js';
import { db } from '../src/db.js';
import { resetDb, destroyResetDbConnection } from './helpers/resetDb.js';
import { signup, seedSystemAdmin, authHeader } from './helpers/testUsers.js';
import { createOrg } from './helpers/fixtures.js';

// FEATURE_REQUEST.md entry 1 (Enterprise authorization model), slice 2, and
// the later "Remove email-based invitations" entry: creation no longer
// collects/echoes an email — the invitee supplies their own at redemption
// time instead (POST /:token/accept).

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
      .send({ role: 'ORG_MEMBER' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ role: 'ORG_MEMBER' });
    expect(res.body.email).toBeUndefined();
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(20);

    const row = await db('audit_logs').where({ action_type: 'INVITATION_CREATED' }).first();
    expect(row.payload).toMatchObject({ scopeType: 'ORGANIZATION', organizationId: org.id });
    expect(row.payload.email).toBeUndefined();
  });

  test('a plain ORG_MEMBER cannot create an invitation', async () => {
    const admin = await seedSystemAdmin('orginviter1');
    const org = await createOrg(admin.accessToken);

    const member = await signup('orginvitermember1');
    await request(app).post(`/api/organizations/${org.id}/members`).set(authHeader(admin.accessToken)).send({ username: 'orginvitermember1' });

    const res = await request(app)
      .post(`/api/organizations/${org.id}/invitations`)
      .set(authHeader(member.accessToken))
      .send({});
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
      .send({ role: 'MANAGER' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('MANAGER');

    const ownerRoleRejected = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ role: 'OWNER' });
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
      .send({});
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
      .send({});

    const acceptedSource = await request(app)
      .post(`/api/organizations/${org.id}/invitations`)
      .set(authHeader(admin.accessToken))
      .send({});
    await request(app)
      .post(`/api/invitations/${acceptedSource.body.token}/accept`)
      .send({ username: 'orginviteaccepted0', email: 'orginviteaccepted0@example.com', password: 'correct-horse-battery' });

    const revoked = await request(app)
      .post(`/api/organizations/${org.id}/invitations`)
      .set(authHeader(admin.accessToken))
      .send({});
    await request(app).post(`/api/invitations/${revoked.body.id}/revoke`).set(authHeader(admin.accessToken));

    const expired = await request(app)
      .post(`/api/organizations/${org.id}/invitations`)
      .set(authHeader(admin.accessToken))
      .send({});
    await db('invitations').where({ id: expired.body.id }).update({ expires_at: new Date(Date.now() - 1000) });

    const res = await request(app).get(`/api/organizations/${org.id}/invitations`).set(authHeader(admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: pending.body.id,
      invitedByUsername: 'orginvitelist0',
      // FEATURE_REQUEST.md's "display names as the primary identity" entry.
      invitedByDisplayName: 'orginvitelist0',
    });
    expect(res.body[0].email).toBeUndefined();
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
      .send({});

    const revoked = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({});
    await request(app).post(`/api/invitations/${revoked.body.id}/revoke`).set(authHeader(owner.accessToken));

    const res = await request(app).get(`/api/workspaces/${ws.id}/invitations`).set(authHeader(owner.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: pending.body.id,
      invitedByUsername: 'wsinvitelist0',
      invitedByDisplayName: 'wsinvitelist0',
    });
    expect(res.body[0].email).toBeUndefined();
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
      .send({ role: 'MEMBER' });

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
      .send({});

    await db('invitations').where({ id: createRes.body.id }).update({ expires_at: new Date(Date.now() - 1000) });

    const res = await request(app).get(`/api/invitations/${createRes.body.token}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/invitations/:token/accept', () => {
  test('creates an account with the invitee-supplied email, attaches the invited-role membership, and logs in atomically', async () => {
    const owner = await signup('wsaccept0');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ role: 'MANAGER' });

    const res = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'accepteduser0', email: 'accepted0@example.com', password: 'correct-horse-battery' });
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

  test('missing or malformed email 400s at accept time', async () => {
    const owner = await signup('wsacceptnoemail0');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({});

    const missing = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'noemailuser0', password: 'correct-horse-battery' });
    expect(missing.status).toBe(400);

    const malformed = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'noemailuser0', email: 'not-an-email', password: 'correct-horse-battery' });
    expect(malformed.status).toBe(400);
  });

  test('an org-scoped invitation attaches org membership directly, no double org row', async () => {
    const admin = await seedSystemAdmin('orgaccept0');
    const org = await createOrg(admin.accessToken);
    const createRes = await request(app)
      .post(`/api/organizations/${org.id}/invitations`)
      .set(authHeader(admin.accessToken))
      .send({ role: 'ORG_ADMIN' });

    const res = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'orgaccepteduser0', email: 'orgaccepted0@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(201);

    const memberships = await db('organization_members').where({ user_id: res.body.user.id });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ organization_id: org.id, org_role: 'ORG_ADMIN' });
  });

  test('a username collision 409s', async () => {
    await signup('collideduser0');
    const owner = await signup('wsacceptcollide0');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({});

    const res = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'collideduser0', email: 'newemail-collide0@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(409);
  });

  // Now that email is invitee-supplied rather than pre-declared on the
  // invitation row, the collision can happen on the *redeemer's own chosen
  // email* colliding with an existing account — a case that couldn't even
  // occur under the old design (the inviter's guessed email was fixed at
  // creation time, not chosen by the redeemer).
  test('a self-supplied email colliding with an existing account 409s', async () => {
    await signup('emailcollideexisting0', { email: 'existing-email0@example.com' });
    const owner = await signup('wsacceptemailcollide0');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({});

    const res = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'brandnewusername0', email: 'existing-email0@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(409);
  });

  test('two distinct invitations can each be redeemed with a distinct, self-chosen email', async () => {
    const owner = await signup('wsacceptdistinct0');
    const ws = await createWorkspace(owner);
    const first = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ role: 'MEMBER' });
    const second = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({ role: 'MEMBER' });

    const firstRes = await request(app)
      .post(`/api/invitations/${first.body.token}/accept`)
      .send({ username: 'distinctuser0a', email: 'distinct0a@example.com', password: 'correct-horse-battery' });
    expect(firstRes.status).toBe(201);
    expect(firstRes.body.user.email).toBe('distinct0a@example.com');

    const secondRes = await request(app)
      .post(`/api/invitations/${second.body.token}/accept`)
      .send({ username: 'distinctuser0b', email: 'distinct0b@example.com', password: 'correct-horse-battery' });
    expect(secondRes.status).toBe(201);
    expect(secondRes.body.user.email).toBe('distinct0b@example.com');
  });

  test('accepting the same token twice 404s the second time', async () => {
    const owner = await signup('wsacceptreuse0');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({});

    const first = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'reuseuser0', email: 'reuse0@example.com', password: 'correct-horse-battery' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'reuseuser0-again', email: 'reuse0-again@example.com', password: 'correct-horse-battery' });
    expect(second.status).toBe(404);
  });

  test('an expired token 404s at accept time too', async () => {
    const owner = await signup('wsacceptexpired0');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({});
    await db('invitations').where({ id: createRes.body.id }).update({ expires_at: new Date(Date.now() - 1000) });

    const res = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'expiredacceptuser0', email: 'expiredaccept0@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(404);
  });

  // Security.md (2026-07-15, MEDIUM: "Archived Workspace/Organization
  // Invitations Remain Redeemable") — creation-time archived checks don't
  // help a token created while the resource was still active; redemption
  // must re-check current state, not just what was true at invite time.
  test('a workspace archived after the invitation was created can no longer be joined via that token', async () => {
    const owner = await signup('wsacceptarchived0');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({});

    const archiveRes = await request(app).post(`/api/workspaces/${ws.id}/archive`).set(authHeader(owner.accessToken));
    expect(archiveRes.status).toBe(200);

    const res = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'wsarchivedaccept0', email: 'wsarchivedaccept0@example.com', password: 'correct-horse-battery' });
    // Same generic 404 as every other invalid-token case — a public
    // endpoint must not leak that the token was otherwise fine but its
    // target got archived.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invitation not found');

    const user = await db('users').where({ username: 'wsarchivedaccept0' }).first();
    expect(user).toBeUndefined();
    const invitationRow = await db('invitations').where({ id: createRes.body.id }).first();
    expect(invitationRow.status).toBe('PENDING');
  });

  test('an organization archived after the invitation was created can no longer be joined via that token', async () => {
    const admin = await seedSystemAdmin('orgacceptarchived0');
    const org = await createOrg(admin.accessToken);
    const createRes = await request(app)
      .post(`/api/organizations/${org.id}/invitations`)
      .set(authHeader(admin.accessToken))
      .send({ role: 'ORG_MEMBER' });

    const archiveRes = await request(app).post(`/api/organizations/${org.id}/archive`).set(authHeader(admin.accessToken));
    expect(archiveRes.status).toBe(200);

    const res = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'orgarchivedaccept0', email: 'orgarchivedaccept0@example.com', password: 'correct-horse-battery' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Invitation not found');

    const user = await db('users').where({ username: 'orgarchivedaccept0' }).first();
    expect(user).toBeUndefined();
  });
});

describe('POST /api/invitations/:id/revoke', () => {
  test('the inviter can revoke a pending invitation, and it can no longer be accepted', async () => {
    const owner = await signup('wsrevoke0');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({});

    const revokeRes = await request(app).post(`/api/invitations/${createRes.body.id}/revoke`).set(authHeader(owner.accessToken));
    expect(revokeRes.status).toBe(204);

    const acceptRes = await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'revokeduser0', email: 'revoked0@example.com', password: 'correct-horse-battery' });
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
      .send({});

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
      .send({});

    const res = await request(app).post(`/api/invitations/${createRes.body.id}/revoke`).set(authHeader(outsider.accessToken));
    expect(res.status).toBe(404);
  });

  test('revoking an already-accepted invitation is an idempotent no-op 204, not a re-revocation error', async () => {
    const owner = await signup('wsrevoke2');
    const ws = await createWorkspace(owner);
    const createRes = await request(app)
      .post(`/api/workspaces/${ws.id}/invitations`)
      .set(authHeader(owner.accessToken))
      .send({});
    await request(app)
      .post(`/api/invitations/${createRes.body.token}/accept`)
      .send({ username: 'revoked2user', email: 'revoked2@example.com', password: 'correct-horse-battery' });

    const res = await request(app).post(`/api/invitations/${createRes.body.id}/revoke`).set(authHeader(owner.accessToken));
    expect(res.status).toBe(204);

    const row = await db('invitations').where({ id: createRes.body.id }).first();
    expect(row.status).toBe('ACCEPTED'); // unchanged — revoke doesn't overwrite a terminal ACCEPTED state
  });
});
