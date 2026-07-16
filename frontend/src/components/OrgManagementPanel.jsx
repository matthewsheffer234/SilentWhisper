import { useEffect, useState } from 'react';
import Sheet from './Sheet.jsx';
import PeoplePicker from './PeoplePicker.jsx';
import {
  listOrgMembers,
  changeOrgMemberRole,
  removeOrgMember,
  addOrgMember,
  createOrgInvitation,
  listOrgInvitations,
  searchOrgPeople,
} from '../api/organizations.js';
import { revokeInvitation } from '../api/invitations.js';
import { hasOrgManagementAccess } from '../authz/permissions.js';

// FEATURE_REQUEST.md entry 1, slice 3 — structurally cloned from
// UserManagementPanel.jsx's workspace-scoped pattern. Orgs have no
// OWNER-equivalent tier (ORG_ROLE_PERMISSIONS: ORG_ADMIN / ORG_MEMBER), so
// the org selector filters on ORG_MANAGE_MEMBERS rather than mirroring that
// file's ['OWNER','MANAGER'] set. All server calls redundantly re-check
// authorization server-side (requireOrgPermission) — this panel only ever
// being rendered for an admin is a UI convenience, never the actual
// enforcement boundary, same as UserManagementPanel already documents.

const styles = {
  field: { marginBottom: 14 },
  label: {
    display: 'block',
    fontSize: 'var(--text-xs)',
    fontWeight: 700,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginBottom: 4,
  },
  select: {
    width: '100%',
    minHeight: 44,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
  },
  input: {
    width: '100%',
    minHeight: 44,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-sm)',
    boxSizing: 'border-box',
  },
  error: { color: '#c0392b', fontSize: 'var(--text-sm)', marginBottom: 12 },
  sectionTitle: { fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-1)', margin: '18px 0 8px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)', marginBottom: 8 },
  th: {
    textAlign: 'left',
    padding: '6px 8px',
    background: 'var(--surface-alt)',
    color: 'var(--text-3)',
    fontWeight: 700,
    fontSize: 'var(--text-xs)',
    textTransform: 'uppercase',
  },
  td: { padding: '6px 8px', borderTop: '1px solid var(--border)', color: 'var(--text-1)', verticalAlign: 'middle' },
  secondaryUsername: { color: 'var(--text-3)', fontSize: 'var(--text-xs)', marginLeft: 6 },
  rowSelect: {
    minHeight: 36,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--surface)',
    color: 'var(--text-1)',
    fontSize: 'var(--text-xs)',
  },
  rowButton: {
    minHeight: 36,
    padding: '0 10px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'none',
    color: 'var(--text-2)',
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  submitButton: {
    marginTop: 6,
    minHeight: 44,
    padding: '0 20px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--brg)',
    color: '#fff',
    fontWeight: 600,
    cursor: 'pointer',
  },
  row: { display: 'flex', gap: 12 },
  empty: { color: 'var(--text-3)', fontSize: 'var(--text-sm)', padding: '8px 0' },
};

// FEATURE_REQUEST.md's "unified people picker" entry replaced the raw
// exact-username input with PeoplePicker, matching
// UserManagementPanel/WorkspaceSidebar's equivalent forms.
function AddMemberForm({ onSubmit, orgId }) {
  const [person, setPerson] = useState(null);
  const [role, setRole] = useState('ORG_MEMBER');
  const [status, setStatus] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!person) return;
    setStatus(null);
    try {
      await onSubmit(person.username, role);
      setStatus({ type: 'success', message: `Added ${person.displayName || person.username} to the organization` });
      setPerson(null);
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to add member' });
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div style={styles.row}>
        <div style={{ ...styles.field, flex: 1 }}>
          {/* PeoplePicker's input carries its own aria-label (below) — this
              is purely a visual heading, not a <label htmlFor> association,
              since PeoplePicker owns its own input id/aria wiring. */}
          <span style={styles.label}>Person</span>
          <PeoplePicker
            searchFn={(q) => searchOrgPeople(orgId, q)}
            value={person}
            onChange={setPerson}
            placeholder="Search people to add"
            ariaLabel="Search people to add to organization"
            isIneligible={(p) => (p.alreadyMember ? 'Already a member' : null)}
          />
        </div>
        <div style={{ ...styles.field, flex: 1 }}>
          <label style={styles.label} htmlFor="org-add-role">Role</label>
          <select id="org-add-role" style={styles.select} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="ORG_MEMBER">Member</option>
            <option value="ORG_ADMIN">Admin</option>
          </select>
        </div>
      </div>
      <button type="submit" style={styles.submitButton} disabled={!person}>Add member</button>
      {status && (
        <div style={{ marginTop: 8, fontSize: 'var(--text-sm)', color: status.type === 'error' ? '#c0392b' : 'var(--brg)' }}>
          {status.message}
        </div>
      )}
    </form>
  );
}

// Token-based invitation (coexists with AddMemberForm above — direct-add of
// an existing user, doesn't replace it). No email infra exists in this
// project, so the raw link is shown once for the admin to copy/share
// out-of-band, same convention as WorkspaceSidebar's InviteLinkForm.
function CreateInvitationForm({ onSubmit }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('ORG_MEMBER');
  const [status, setStatus] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setStatus(null);
    try {
      const invitation = await onSubmit(trimmed, role);
      const link = `${window.location.origin}/invite/${invitation.token}`;
      setStatus({ type: 'success', message: link });
      setEmail('');
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Failed to create invitation' });
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div style={styles.row}>
        <div style={{ ...styles.field, flex: 1 }}>
          <label style={styles.label} htmlFor="org-invite-email">Email</label>
          <input id="org-invite-email" type="email" style={styles.input} value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div style={{ ...styles.field, flex: 1 }}>
          <label style={styles.label} htmlFor="org-invite-role">Role</label>
          <select id="org-invite-role" style={styles.select} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="ORG_MEMBER">Member</option>
            <option value="ORG_ADMIN">Admin</option>
          </select>
        </div>
      </div>
      <button type="submit" style={styles.submitButton}>Create invitation</button>
      {status && (
        <div style={{ marginTop: 8, fontSize: 'var(--text-sm)', color: status.type === 'error' ? '#c0392b' : 'var(--brg)' }}>
          {status.type === 'success' ? (
            <>
              <span>{status.message}</span>{' '}
              <button type="button" style={styles.rowButton} onClick={() => navigator.clipboard?.writeText(status.message)}>
                Copy
              </button>
            </>
          ) : (
            status.message
          )}
        </div>
      )}
    </form>
  );
}

export default function OrgManagementPanel({ organizations, initialOrgId, isSystemAdmin, onClose }) {
  const manageableOrgs = organizations.filter((o) => hasOrgManagementAccess(isSystemAdmin, o.role));
  const [selectedOrgId, setSelectedOrgId] = useState(
    manageableOrgs.some((o) => o.id === initialOrgId) ? initialOrgId : (manageableOrgs[0]?.id ?? null),
  );
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [invitations, setInvitations] = useState([]);

  function loadMembers(orgId) {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    listOrgMembers(orgId)
      .then(setMembers)
      .catch((err) => setError(err.message || 'Failed to load members'))
      .finally(() => setLoading(false));
  }

  function loadInvitations(orgId) {
    if (!orgId) return;
    listOrgInvitations(orgId)
      .then(setInvitations)
      .catch(() => setInvitations([]));
  }

  useEffect(() => {
    loadMembers(selectedOrgId);
    loadInvitations(selectedOrgId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrgId]);

  async function handleRoleChange(userId, role) {
    try {
      await changeOrgMemberRole(selectedOrgId, userId, role);
      loadMembers(selectedOrgId);
    } catch (err) {
      setError(err.message || 'Failed to change role');
    }
  }

  async function handleRemove(userId) {
    try {
      await removeOrgMember(selectedOrgId, userId);
      loadMembers(selectedOrgId);
    } catch (err) {
      setError(err.message || 'Failed to remove member');
    }
  }

  async function handleAddMember(username, role) {
    await addOrgMember(selectedOrgId, username, role);
    loadMembers(selectedOrgId);
  }

  async function handleCreateInvitation(email, role) {
    const invitation = await createOrgInvitation(selectedOrgId, email, role);
    loadInvitations(selectedOrgId);
    return invitation;
  }

  async function handleRevokeInvitation(invitationId) {
    await revokeInvitation(invitationId);
    loadInvitations(selectedOrgId);
  }

  return (
    <Sheet
      title="Manage Organization"
      ariaLabel="manage organization"
      subtitle="Assign roles, add members, and manage invitations for an organization you administer."
      onClose={onClose}
      width={640}
      maxHeight="86vh"
    >
        <div style={styles.field}>
          <label style={styles.label} htmlFor="manage-org-select">Organization</label>
          <select
            id="manage-org-select"
            style={styles.select}
            value={selectedOrgId ?? ''}
            onChange={(e) => setSelectedOrgId(e.target.value)}
          >
            {manageableOrgs.map((org) => (
              <option key={org.id} value={org.id}>{org.name}</option>
            ))}
          </select>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.sectionTitle}>Members</div>
        {loading ? (
          <div style={styles.empty}>Loading…</div>
        ) : members.length === 0 ? (
          <div style={styles.empty}>No members yet.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Member</th>
                <th style={styles.th}>Role</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId}>
                  <td style={styles.td}>
                    {m.displayName || m.username}
                    {m.displayName && m.displayName !== m.username && (
                      <span style={styles.secondaryUsername}>@{m.username}</span>
                    )}
                  </td>
                  <td style={styles.td}>
                    <select
                      style={styles.rowSelect}
                      value={m.role}
                      onChange={(e) => handleRoleChange(m.userId, e.target.value)}
                      aria-label={`Role for ${m.username}`}
                    >
                      <option value="ORG_MEMBER">Member</option>
                      <option value="ORG_ADMIN">Admin</option>
                    </select>
                  </td>
                  <td style={styles.td}>
                    <button type="button" style={styles.rowButton} onClick={() => handleRemove(m.userId)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={styles.sectionTitle}>Add an existing member</div>
        <AddMemberForm orgId={selectedOrgId} onSubmit={handleAddMember} />

        <div style={styles.sectionTitle}>Create invitation</div>
        <CreateInvitationForm onSubmit={handleCreateInvitation} />

        <div style={styles.sectionTitle}>Pending invitations</div>
        {invitations.length === 0 ? (
          <div style={styles.empty}>No pending invitations.</div>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Email</th>
                <th style={styles.th}>Role</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => (
                <tr key={inv.id}>
                  <td style={styles.td}>{inv.email}</td>
                  <td style={styles.td}>{inv.invitedRole}</td>
                  <td style={styles.td}>
                    <button type="button" style={styles.rowButton} onClick={() => handleRevokeInvitation(inv.id)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </Sheet>
  );
}
