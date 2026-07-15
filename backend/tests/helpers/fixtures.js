import request from 'supertest';
import { app } from '../../src/index.js';
import { authHeader } from './testUsers.js';

// Shared HTTP-based fixture helpers (FEATURE_REQUEST.md entry 1, slice 4,
// SLICE_4_PLAN.md decision 10): organization/workspace *creation* stays
// real HTTP, not a direct-DB shortcut, because that behavior is itself
// under test in organizations.test.js/invitations.test.js/
// workspaceOrganizations.test.js — a direct-DB insert would silently stop
// exercising the code those files exist to test.
//
// Only createOrg is promoted here: its implementation was byte-identical
// across invitations.test.js and workspaceOrganizations.test.js (both use
// it purely as setup, returning res.body). organizations.test.js keeps its
// own local createOrg, which needs the full supertest response (status
// *and* body) since org creation is the thing under test there. The
// various createWorkspace/addMember local helpers across 8-9 files return
// inconsistent shapes (a bare workspace id string in most, a full body
// object in a couple) for no behavioral reason — deduplicating them would
// mean touching every one of ~90 call sites for a pure refactor with no
// test-coverage benefit, so they stay local per file (the explicitly
// sanctioned fallback for exactly this situation).
export async function createOrg(sysAdminAccessToken, name = 'Org') {
  const res = await request(app).post('/api/organizations').set(authHeader(sysAdminAccessToken)).send({ name });
  return res.body;
}
