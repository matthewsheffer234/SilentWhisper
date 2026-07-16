// FEATURE_REQUEST.md "Remove email-based invitations": no email server has
// ever existed in this deployment, so invitations.email was never validated
// by actually sending mail to it — it only forced the inviter to guess the
// invitee's future address up front, with no correction short of revoking
// and recreating the invitation. The invitee now supplies their own email
// at redemption time instead (backend/src/routes/invitations.js's
// POST /:token/accept), the same field POST /api/admin/users already
// collects directly from whoever is providing it.

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.raw('ALTER TABLE invitations DROP COLUMN email');
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // Lossy — matches this migration set's existing down() fidelity (0012's
  // own down() comment). No prior email values are recoverable; restored
  // nullable so existing rows don't violate a NOT NULL that never applied
  // to them post-rollback.
  await knex.raw('ALTER TABLE invitations ADD COLUMN email VARCHAR(255) NULL');
}
