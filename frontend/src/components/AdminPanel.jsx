import { ShieldCheck, Sparkles, ScrollText, Building2, UserCog, BarChart3 } from 'lucide-react';
import Sheet from './Sheet.jsx';

// FEATURE_REQUEST.md's "dedicated admin/settings area" entry: a single,
// low-frequency entry point for every privileged surface — previously split
// between a dropdown "Admin Tools" menu (AI Settings, Audit Log, Manage
// Users, System Admin) and a separate "Manage organization members…" item
// buried in the org switcher. Each row here still opens the same existing
// panel unchanged (AiSettingsPanel, AuditDashboard, UserManagementPanel,
// OrgManagementPanel, SystemAdminPanel) — this hub only consolidates the
// *entry point*, not the panels themselves. Selecting a row closes this hub
// before opening its destination, rather than nesting the two open Sheets
// at once, so the admin hub itself doesn't stay a second dim backdrop layer
// behind the panel the caller actually came here for.
//
// AI Settings and Audit Log are grouped with System Admin under
// isSystemAdmin, not canManageWorkspaceUsers (Security.md, 2026-07-15, HIGH
// finding: those two are global, non-workspace-scoped surfaces that used to
// also open for any workspace OWNER/MANAGER, letting self-service workspace
// creation grant global access — see requireSystemAdmin's backend doc
// comment). Manage Users stays workspace-scoped and is offered independently
// via canManageWorkspaceUsers, since UserManagementPanel enforces its own
// per-workspace permission server-side regardless of system-admin status.
const styles = {
  list: { display: 'flex', flexDirection: 'column', gap: 4 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    minHeight: 52,
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: 'var(--surface-alt)',
    color: 'var(--text-1)',
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: 'var(--text-sm)',
  },
  icon: { color: 'var(--text-3)', flexShrink: 0 },
  rowText: { display: 'flex', flexDirection: 'column', gap: 2 },
  rowTitle: { fontWeight: 600 },
  rowDescription: { fontSize: 'var(--text-xs)', color: 'var(--text-3)' },
};

export default function AdminPanel({
  onClose,
  canManageWorkspaceUsers,
  canManageOrg,
  isSystemAdmin,
  onOpenUserManagement,
  onOpenAiSettings,
  onOpenAuditLog,
  onOpenOrgManagement,
  onOpenSystemAdmin,
  onOpenAdminAnalytics,
}) {
  const items = [
    ...(canManageWorkspaceUsers
      ? [
          {
            key: 'manage-users',
            icon: <UserCog size={18} aria-hidden="true" style={styles.icon} />,
            title: 'Manage Users',
            description: 'Roles, roster removal, and password reset for a workspace you administer.',
            onSelect: onOpenUserManagement,
          },
        ]
      : []),
    ...(canManageOrg
      ? [
          {
            key: 'manage-org',
            icon: <Building2 size={18} aria-hidden="true" style={styles.icon} />,
            title: 'Manage Organization',
            description: 'Members, roles, and invitations for an organization you administer.',
            onSelect: onOpenOrgManagement,
          },
        ]
      : []),
    ...(isSystemAdmin
      ? [
          {
            key: 'ai-settings',
            icon: <Sparkles size={18} aria-hidden="true" style={styles.icon} />,
            title: 'AI Settings',
            description: 'Provider health, model, and generation limits.',
            onSelect: onOpenAiSettings,
          },
          {
            key: 'audit-log',
            icon: <ScrollText size={18} aria-hidden="true" style={styles.icon} />,
            title: 'Audit Log',
            description: 'Recent security-relevant events and chain integrity.',
            onSelect: onOpenAuditLog,
          },
          {
            key: 'admin-analytics',
            icon: <BarChart3 size={18} aria-hidden="true" style={styles.icon} />,
            title: 'Admin Analytics',
            description: 'Message activity and dormant channels — metadata only, never content.',
            onSelect: onOpenAdminAnalytics,
          },
          {
            key: 'system-admin',
            icon: <ShieldCheck size={18} aria-hidden="true" style={styles.icon} />,
            title: 'System Admin',
            description: 'Account creation/disable, privileges, and cross-organization oversight.',
            onSelect: onOpenSystemAdmin,
          },
        ]
      : []),
  ];

  function handleSelect(item) {
    onClose();
    item.onSelect();
  }

  return (
    <Sheet title="Admin" ariaLabel="admin" onClose={onClose} width={420}>
      <div style={styles.list}>
        {items.map((item) => (
          <button key={item.key} type="button" style={styles.row} onClick={() => handleSelect(item)}>
            {item.icon}
            <span style={styles.rowText}>
              <span style={styles.rowTitle}>{item.title}</span>
              <span style={styles.rowDescription}>{item.description}</span>
            </span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
