import { test, expect } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', 'backend', '.env') });

// PROJECT_PLAN.md Section 8, Phase 5: "Add integration tests for key user
// workflows." Runs against the real Docker Compose stack (frontend, backend,
// Postgres, and — for the AI tests — a real Ollama instance), not mocks;
// see RUNBOOK.md for how to bring the stack up first. This is the committed,
// re-runnable version of the throwaway Playwright scripts used to verify
// Phases 3 and 4 by hand.

// Matches playwright.config.js's baseURL default — see its comment on why
// this must be the same origin the frontend build itself talks to.
const API_BASE = process.env.E2E_API_BASE || 'https://whisper.silentlattice.dev/api';

function uniqueUsername(label) {
  return `e2e_${label}_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
}

// Seeds a user, workspace, and channel directly over the REST API — faster
// and more deterministic than driving signup/workspace/channel creation
// through the UI for every test that just needs a starting point, while
// still exercising the real backend (unlike the DB-seeding load test script,
// this goes through the actual HTTP API).
async function seedUserWithChannel(label) {
  const username = uniqueUsername(label);
  const signupRes = await fetch(`${API_BASE}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@example.com`, password: 'correct-horse-battery' }),
  });
  const { accessToken, user } = await signupRes.json();

  const wsRes = await fetch(`${API_BASE}/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ name: `${username} workspace` }),
  });
  const workspace = await wsRes.json();

  const chRes = await fetch(`${API_BASE}/workspaces/${workspace.id}/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ name: 'general', type: 'PUBLIC' }),
  });
  const channel = await chRes.json();

  return { username, password: 'correct-horse-battery', accessToken, userId: user.id, workspace, channel };
}

// Self-service workspace subscription (FEATURE_REQUEST.md): a workspace
// created with visibility: 'PUBLIC', distinct from seedUserWithChannel's
// default PRIVATE workspace.
async function createWorkspaceApi(accessToken, name, visibility) {
  const res = await fetch(`${API_BASE}/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(visibility ? { name, visibility } : { name }),
  });
  return res.json();
}

// A plain signup with no workspace of their own — used as the invite
// target for the workspace-invite tests below.
async function seedPlainUser(label) {
  const username = uniqueUsername(label);
  const res = await fetch(`${API_BASE}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email: `${username}@example.com`, password: 'correct-horse-battery' }),
  });
  const { accessToken, user } = await res.json();
  return { username, password: 'correct-horse-battery', userId: user.id, accessToken };
}

async function sendMessage(accessToken, channelId, content) {
  const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

async function inviteToWorkspace(accessToken, workspaceId, username) {
  const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ username }),
  });
  return res.json();
}

// Self-service join for a PUBLIC channel, over the API — used so a second
// user can appear in the same channel as the page's own logged-in session
// without needing a second browser context just to click "Join".
async function joinChannelApi(accessToken, workspaceId, channelId) {
  const res = await fetch(`${API_BASE}/workspaces/${workspaceId}/channels/${channelId}/join`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    throw new Error(`joinChannelApi failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

// Replaces window.Notification entirely rather than relying on the real OS
// popup (which isn't part of the page DOM and can't be asserted on
// directly) — captures constructor calls in window.__notificationCalls so
// the test can assert on title/body, and stubs .permission directly since
// ChatShell.jsx's mention handler reads it synchronously. document.hasFocus
// is also overridden here so the "is the tab backgrounded" gate is
// deterministic instead of depending on real OS/window focus, which
// headless multi-context runs can't reliably control.
async function stubNotifications(page, { focused }) {
  await page.addInitScript((isFocused) => {
    window.__notificationCalls = [];
    class FakeNotification {
      constructor(title, options) {
        window.__notificationCalls.push({ title, body: options?.body });
      }
    }
    FakeNotification.permission = 'granted';
    FakeNotification.requestPermission = async () => 'granted';
    window.Notification = FakeNotification;
    document.hasFocus = () => isFocused;
  }, focused);
}

async function loginViaUi(page, username, password) {
  await page.goto('/');
  await page.waitForSelector('text=Silent Whisper', { timeout: 15_000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('button:has-text("Sign In")');
  await page.waitForSelector('text=Workspaces', { timeout: 15_000 });
}

test.describe('core messaging workflow', () => {
  test('signup, workspace, channel, message, thread reply, and session restore across reload', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const username = uniqueUsername('core');

    await page.goto('/');
    await page.waitForSelector('text=Silent Whisper', { timeout: 15_000 });
    await page.click('text=Sign up');
    await page.fill('#username', username);
    await page.fill('#email', `${username}@example.com`);
    await page.fill('#password', 'correct-horse-battery');
    await page.click('button:has-text("Sign Up")');
    await page.waitForSelector('text=Workspaces', { timeout: 15_000 });

    await page.click('text=+ New workspace');
    await page.fill('input[placeholder="Workspace name"]', 'E2E Core Co');
    await page.keyboard.press('Enter');
    await page.waitForSelector('text=E2E Core Co', { timeout: 10_000 });

    await page.click('text=+ New channel');
    await page.fill('input[placeholder="Channel name"]', 'general');
    await page.keyboard.press('Enter');
    await page.waitForSelector('input[placeholder^="Message #"]', { timeout: 10_000 });

    await page.fill('input[placeholder^="Message #"]', 'Hello from the e2e suite');
    await page.click('button:has-text("Send")');
    await expect(page.locator('text=Hello from the e2e suite')).toBeVisible({ timeout: 10_000 });

    await page.click('button:has-text("Reply in thread")');
    await page.waitForSelector('text=Thread', { timeout: 10_000 });
    await page.fill('input[placeholder="Reply in thread"]', 'A threaded reply');
    await page.click('button:text-is("Reply")');
    await expect(page.locator('text=A threaded reply')).toBeVisible({ timeout: 10_000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator(`text=${username}`)).toBeVisible({ timeout: 15_000 });

    // A 401 on the first request after reload is expected, not a bug: the
    // in-memory access token (Section 3 — never persisted across reloads by
    // design) is gone, so api/client.js's silent-refresh-and-retry-once
    // pattern deliberately lets the first call 401 before recovering via
    // the httpOnly refresh cookie. Chromium logs every non-2xx fetch to the
    // console regardless of whether the app handles it gracefully — the app
    // has no way to suppress that browser-level log line.
    const unexpectedErrors = consoleErrors.filter(
      (e) => !e.includes('WebSocket') && !e.includes('HMR') && !e.includes('401'),
    );
    expect(unexpectedErrors).toEqual([]);
  });
});

test.describe('markdown formatting', () => {
  // FEATURE_REQUEST.md's Basic Markdown formatting entry. The tokenizer's
  // own logic is covered by frontend/src/markdown.test.jsx's unit tests
  // (Vitest) — this checks the real end-to-end path: a message typed
  // through the actual composer, sent through the real WebSocket path, and
  // rendered by the real feed, not the tokenizer function called directly.
  test('bold, italic, and a link all render as real elements, and an unsafe link scheme renders as plain text', async ({
    page,
  }) => {
    const seeded = await seedUserWithChannel('markdown');
    await loginViaUi(page, seeded.username, seeded.password);
    await page.click(`text=${seeded.workspace.name}`);
    await page.click('text=general');
    await page.waitForSelector('input[placeholder^="Message #"]', { timeout: 10_000 });

    await page.fill(
      'input[placeholder^="Message #"]',
      'This is **bold**, this is *italic*, and here is [a link](https://example.com).',
    );
    await page.click('button:has-text("Send")');

    await expect(page.locator('strong:has-text("bold")')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('em:has-text("italic")')).toBeVisible({ timeout: 10_000 });
    const link = page.locator('a:has-text("a link")');
    await expect(link).toBeVisible({ timeout: 10_000 });
    await expect(link).toHaveAttribute('href', 'https://example.com');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    // A javascript: URL must never become a clickable anchor — the label
    // renders as plain text instead (Section 3, LLM-Specific/user-content
    // XSS rules: a rendered `<a href>` is a live vector regardless of
    // dangerouslySetInnerHTML never being used).
    await page.fill('input[placeholder^="Message #"]', 'click [here](javascript:alert(1)) if you dare');
    await page.click('button:has-text("Send")');
    await expect(page.locator('text=click here if you dare')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('a:has-text("here")')).toHaveCount(0);
  });

  test('a mention still highlights inside bold text, in the real rendered feed', async ({ page }) => {
    const seeded = await seedUserWithChannel('markdownmention');
    await loginViaUi(page, seeded.username, seeded.password);
    await page.click(`text=${seeded.workspace.name}`);
    await page.click('text=general');
    await page.waitForSelector('input[placeholder^="Message #"]', { timeout: 10_000 });

    await page.fill('input[placeholder^="Message #"]', `**hey @${seeded.username} check this out**`);
    await page.click('button:has-text("Send")');

    const strong = page.locator('strong', { hasText: `@${seeded.username}` });
    await expect(strong).toBeVisible({ timeout: 10_000 });
    await expect(strong.locator('span', { hasText: `@${seeded.username}` })).toBeVisible();
  });
});

test.describe('iMessage-style message bubble layout', () => {
  test('own messages render right-aligned filled with no author name; others render left-aligned with their username; a mention inside a "mine" bubble stays legible; consecutive same-sender messages group tighter', async ({
    page,
  }) => {
    const me = await seedUserWithChannel('bubbleme');
    const other = await seedPlainUser('bubbleother');
    await inviteToWorkspace(me.accessToken, me.workspace.id, other.username);
    await joinChannelApi(other.accessToken, me.workspace.id, me.channel.id);

    await loginViaUi(page, me.username, me.password);
    await page.click(`text=${me.workspace.name}`);
    await page.click('text=general');
    await page.waitForSelector('input[placeholder^="Message #"]', { timeout: 10_000 });

    // Two consecutive messages from "me" (for the grouping check below),
    // the second containing a mention (for the contrast check below).
    await page.fill('input[placeholder^="Message #"]', 'first mine message');
    await page.click('button:has-text("Send")');
    await expect(page.locator('text=first mine message')).toBeVisible({ timeout: 10_000 });
    await page.fill('input[placeholder^="Message #"]', `hey @${other.username} second mine message`);
    await page.click('button:has-text("Send")');
    await expect(page.locator('text=second mine message')).toBeVisible({ timeout: 10_000 });

    // A message from someone else, sent over the API — avoids needing a
    // second browser context just to prove the "theirs" rendering path.
    await sendMessage(other.accessToken, me.channel.id, 'a message from someone else');
    await expect(page.locator('text=a message from someone else')).toBeVisible({ timeout: 10_000 });

    const mineBubbles = page.locator('.sl-bubble-mine');
    const theirsBubble = page.locator('.sl-bubble-theirs', { hasText: 'a message from someone else' });

    // Right-aligned: the outer row's justify-content is flex-end for mine,
    // flex-start for theirs.
    await expect(mineBubbles.first().locator('..')).toHaveCSS('justify-content', 'flex-end');
    await expect(theirsBubble.locator('..')).toHaveCSS('justify-content', 'flex-start');

    // No author name inside a "mine" bubble; the sender's username *is*
    // shown inside "theirs".
    await expect(mineBubbles.first().getByText(me.username, { exact: true })).toHaveCount(0);
    await expect(theirsBubble.getByText(other.username, { exact: true })).toBeVisible();

    // Filled vs. plain: the two bubble variants must not share a background
    // color — a structural check rather than hardcoding either theme's
    // exact resolved --brg/--surface-alt RGB value.
    const mineBg = await mineBubbles.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const theirsBg = await theirsBubble.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(mineBg).not.toBe(theirsBg);

    // A rendered contrast check, not just "the mention text exists": the
    // mention span's own color must differ from the filled bubble's
    // background it sits on top of — this is exactly the green-on-green bug
    // the design called out, caught here rather than only by eye.
    const secondMineBubble = page.locator('.sl-bubble-mine', { hasText: 'second mine message' });
    const mentionSpan = secondMineBubble.locator('span', { hasText: `@${other.username}` });
    await expect(mentionSpan).toBeVisible();
    const mentionColor = await mentionSpan.evaluate((el) => getComputedStyle(el).color);
    const bubbleBg = await secondMineBubble.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(mentionColor).not.toBe(bubbleBg);

    // Consecutive same-sender grouping: the gap between the two "mine"
    // messages (grouped) must be smaller than the gap before the
    // different-sender message that follows them (not grouped).
    const firstMineRow = page.locator('text=first mine message').locator('../..');
    const secondMineRow = page.locator('text=second mine message').locator('../..');
    const groupedPaddingBottom = await firstMineRow.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
    const ungroupedPaddingBottom = await secondMineRow.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
    expect(groupedPaddingBottom).toBeLessThan(ungroupedPaddingBottom);
  });
});

test.describe('@mention autocomplete', () => {
  test('typing "@" plus a partial username shows matching suggestions; Enter and a mouse click both insert the full mention and close the dropdown; Escape dismisses without altering the draft or submitting; a non-matching partial shows no suggestions', async ({
    page,
  }) => {
    const me = await seedUserWithChannel('mentionacme');
    const other = await seedPlainUser('mentionacother');
    await inviteToWorkspace(me.accessToken, me.workspace.id, other.username);
    await joinChannelApi(other.accessToken, me.workspace.id, me.channel.id);

    await loginViaUi(page, me.username, me.password);
    await page.click(`text=${me.workspace.name}`);
    await page.click('text=general');
    const input = page.locator('input[placeholder^="Message #"]');
    await input.waitFor({ timeout: 10_000 });
    const partial = other.username.slice(0, 6);
    const option = page.locator('[role="option"]', { hasText: other.username });
    const listbox = page.locator('#mention-suggestions');

    // React's controlled-input value tracker treats setting a field to its
    // *current* value as a no-op and never fires onChange, so a bare
    // Locator.fill() of the same string as what's already in the box
    // (re-triggering the dropdown after Escape, for instance) silently does
    // nothing. Clearing first avoids that footgun.
    async function typeInComposer(value) {
      await input.fill('');
      await input.fill(value);
    }

    // A non-matching partial shows no suggestions and never errors — the
    // dropdown simply stays absent, and the draft keeps whatever was typed.
    await typeInComposer('@zzzznomatchzzzz');
    await page.waitForTimeout(500); // let the 200ms debounce + request settle
    await expect(listbox).toHaveCount(0);

    // Escape dismisses the dropdown without altering the draft or submitting.
    await typeInComposer(`@${partial}`);
    await expect(option).toBeVisible({ timeout: 5_000 });
    await input.press('Escape');
    await expect(listbox).toHaveCount(0);
    await expect(input).toHaveValue(`@${partial}`);

    // A mouse click on a suggestion inserts the full "@username " and closes
    // the dropdown.
    await typeInComposer(`@${partial}`);
    await expect(option).toBeVisible({ timeout: 5_000 });
    await option.click();
    await expect(input).toHaveValue(`@${other.username} `);
    await expect(listbox).toHaveCount(0);

    // Enter inserts the full mention, closes the dropdown, and — critically —
    // must not also submit the message (Enter is also the form's submit key).
    await typeInComposer(`hey @${partial}`);
    await expect(option).toBeVisible({ timeout: 5_000 });
    await input.press('Enter');
    await expect(input).toHaveValue(`hey @${other.username} `);
    await expect(listbox).toHaveCount(0);
    await expect(page.locator(`text=hey @${other.username}`)).toHaveCount(0);
  });
});

test.describe('AI features (real Ollama inference — allow extra time)', () => {
  test.slow();

  test('summarize a channel and extract tasks from a thread', async ({ page }) => {
    const seeded = await seedUserWithChannel('ai');
    await sendMessage(seeded.accessToken, seeded.channel.id, 'We decided to ship the release on Friday.');
    const root = await sendMessage(seeded.accessToken, seeded.channel.id, 'Someone needs to update the changelog.');
    await sendMessage(seeded.accessToken, seeded.channel.id, 'I will handle the changelog.');

    await loginViaUi(page, seeded.username, seeded.password);
    await page.click(`text=${seeded.workspace.name}`);
    await page.click('text=general');
    await page.waitForSelector('input[placeholder^="Message #"]', { timeout: 10_000 });

    await page.click('button:has-text("Summarize")');
    await page.waitForSelector('text=Channel summary', { timeout: 5_000 });
    await page.waitForFunction(
      () => document.body.textContent.includes('Channel summary') && !document.body.textContent.includes('Reading recent messages'),
      { timeout: 45_000 },
    );
    const summaryPanelText = await page.locator('text=Channel summary').locator('..').locator('..').textContent();
    expect(summaryPanelText.length).toBeGreaterThan('Channel summary'.length + 10);

    // Open the thread rooted at the "changelog" message specifically (not
    // just whichever "Reply in thread" button happens to be first in the DOM).
    const rootRow = page.locator('text=Someone needs to update the changelog.').locator('..');
    await rootRow.locator('button:has-text("Reply in thread")').click();
    await page.waitForSelector('text=Thread', { timeout: 10_000 });

    await page.click('button:has-text("Extract Tasks")');
    await page.waitForSelector('text=Action items', { timeout: 5_000 });
    await page.waitForFunction(
      () => document.body.textContent.includes('Action items') && !document.body.textContent.includes('Reading thread'),
      { timeout: 45_000 },
    );
  });
});

test.describe('admin surfaces', () => {
  test('AI settings panel: view health, edit, and save', async ({ page }) => {
    const seeded = await seedUserWithChannel('aiadmin');
    await loginViaUi(page, seeded.username, seeded.password);

    // FEATURE_REQUEST.md's Apple HIG overhaul entry: AI Settings/Audit
    // Log/Manage Users now live behind a single "Admin Tools" pull-down
    // button rather than three standalone always-visible buttons.
    await page.click('button:has-text("Admin Tools")');
    await page.click('[role="menuitem"]:has-text("AI Settings")');
    await page.waitForSelector('text=AI Settings', { timeout: 10_000 });
    await page.waitForSelector('text=/Provider (reachable|unreachable)/', { timeout: 15_000 });

    await page.fill('#ai-model', 'mistral');
    await page.click('button:has-text("Save changes")');
    await expect(page.locator('text=Saved')).toBeVisible({ timeout: 10_000 });

    await page.click('button[aria-label="Close AI settings"]');
    // The modal's subtitle text is unique to it — unlike before, "AI
    // Settings" is no longer a permanently-present sidebar button that a
    // bare `text=AI Settings` locator could ambiguously match.
    await expect(page.locator('text=Configure the local LLM provider')).not.toBeVisible();
  });

  test('audit dashboard: view recent events and verify chain integrity', async ({ page }) => {
    const seeded = await seedUserWithChannel('auditadmin');
    await loginViaUi(page, seeded.username, seeded.password);

    await page.click('button:has-text("Admin Tools")');
    await page.click('[role="menuitem"]:has-text("Audit Log")');
    await page.waitForSelector('text=Audit Log', { timeout: 10_000 });
    // The signup + workspace + channel creation above already produced
    // AUTH_SIGNUP/WORKSPACE_CREATED/CHANNEL_CREATED rows.
    await expect(page.locator('text=AUTH_SIGNUP').first()).toBeVisible({ timeout: 10_000 });

    await page.click('button:has-text("Verify Integrity")');
    await expect(page.locator('text=/Log Integrity Verified/')).toBeVisible({ timeout: 10_000 });

    await page.click('button[aria-label="Close audit log"]');
  });
});

test.describe('workspace invite', () => {
  test('a workspace admin can invite an existing user by username, and the invitee sees the workspace after logging in', async ({
    page,
  }) => {
    const admin = await seedUserWithChannel('inviteadmin');
    const invitee = await seedPlainUser('inviteuser');

    await loginViaUi(page, admin.username, admin.password);
    await page.click(`text=${admin.workspace.name}`);

    // FEATURE_REQUEST.md's Apple HIG overhaul entry: Invite now lives behind
    // the workspace row's own "•••" overflow menu (a pull-down button, in
    // Apple's terms) rather than a standalone always-visible button.
    await page.click(`button[aria-label="${admin.workspace.name} options"]`);
    await page.click('text=Invite member…');
    await page.fill('input[placeholder="Username to invite"]', invitee.username);
    await page.click('button:has-text("Add")');
    await expect(page.locator(`text=Added ${invitee.username} to the workspace`)).toBeVisible({ timeout: 10_000 });

    // The sidebar's own admin-only invite control must not be visible to a
    // plain member — verified by actually logging in as the invitee, not
    // just asserting on the admin's own screen. A plain member gets no
    // overflow trigger at all on a workspace they can't administer (the
    // component never renders the Menu when workspaceMenuItems is empty).
    await page.click('button[aria-label="User menu"]');
    await page.click('text=Sign out');
    await loginViaUi(page, invitee.username, invitee.password);
    await expect(page.locator(`text=${admin.workspace.name}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`button[aria-label="${admin.workspace.name} options"]`)).not.toBeVisible();
  });

  test('inviting an unknown username shows an inline error, not a silent failure', async ({ page }) => {
    const admin = await seedUserWithChannel('inviteadmin2');
    await loginViaUi(page, admin.username, admin.password);
    await page.click(`text=${admin.workspace.name}`);

    await page.click(`button[aria-label="${admin.workspace.name} options"]`);
    await page.click('text=Invite member…');
    await page.fill('input[placeholder="Username to invite"]', 'no-such-user-anywhere');
    await page.click('button:has-text("Add")');
    await expect(page.locator('text=No user with that username exists')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('workspace discovery / self-service subscribe', () => {
  test('a public workspace is discoverable and joinable with no invite; a private one never appears', async ({ page }) => {
    const owner = await seedPlainUser('discoowner');
    const publicWs = await createWorkspaceApi(owner.accessToken, `${owner.username} public ws`, 'DISCOVERABLE');
    const privateWs = await createWorkspaceApi(owner.accessToken, `${owner.username} private ws`, 'PRIVATE');
    const seeker = await seedPlainUser('discoseeker');

    await loginViaUi(page, seeker.username, seeker.password);
    await page.click('button:has-text("Browse workspaces")');

    const subscribeButton = page.locator(`button[aria-label="Subscribe to ${publicWs.name}"]`);
    await expect(page.locator(`text=${publicWs.name}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`text=${privateWs.name}`)).not.toBeVisible();

    await subscribeButton.click();
    // Subscribed successfully -> this specific row drops out of the
    // discoverable list, matching BrowseWorkspacesPanel's local filter on a
    // successful subscribe. Scoped to this row's own aria-labeled button
    // (not a bare "Subscribe" text/global-emptiness check) since this
    // stack has no per-test data reset — other DISCOVERABLE workspaces from
    // earlier runs may still legitimately be listed, and subscribing here
    // also immediately adds/selects publicWs in the sidebar behind the
    // still-open modal (ChatShell's onSubscribed), so its name alone
    // staying in the DOM doesn't mean this row didn't disappear.
    await expect(subscribeButton).not.toBeVisible({ timeout: 10_000 });

    await page.click('button[aria-label="Close browse workspaces"]');
    // Now shows up in the sidebar's own Workspaces list, with zero
    // involvement from the owner/admin.
    await expect(page.locator(`[role="button"]:has-text("${publicWs.name}")`)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('accessibility', () => {
  test('skip link is keyboard-reachable and moves focus to the message feed', async ({ page }) => {
    const seeded = await seedUserWithChannel('a11y');
    await loginViaUi(page, seeded.username, seeded.password);

    // index.html's static skip link (present before React even mounts) is
    // the first element in <body> DOM order, and is a real, natively
    // focusable <a href>. On the login screen a single Tab press reaches it
    // (verified directly). On the denser ChatShell layout, this specific
    // Chromium build's sequential-focus-navigation algorithm was observed
    // (via direct investigation, not assumed) to place a position:absolute,
    // high-z-index element like this skip link *after* the in-flow
    // focusable content in Tab order, rather than honoring raw DOM
    // position — Tab still cycles through it correctly (confirmed:
    // Sign-out -> +New workspace -> skip link -> wraps), just not as the
    // literal first stop. That's a real, if surprising, browser-specific
    // navigation-order quirk with this exact "absolutely positioned,
    // hidden-until-focused" pattern, not evidence the link itself is
    // unreachable or broken — so this asserts it's reachable within a
    // bounded number of Tab presses rather than pinning to exactly one.
    await page.locator('body').click({ position: { x: 5, y: 5 } }); // ensure body, not an input, has focus first
    const skipLink = page.locator('.sl-skip-link');
    let reached = false;
    // Bound generous enough to cover a full lap of the sidebar's other
    // focusable content (workspace/channel rows, +New buttons, and — since
    // this seeded user is an ADMIN of their own workspace — the AI
    // Settings/Audit Log links too) before concluding it's genuinely
    // unreachable rather than just further around this browser's
    // observed non-DOM-order cycle (see comment above).
    for (let i = 0; i < 20 && !reached; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await page.keyboard.press('Tab');
      // eslint-disable-next-line no-await-in-loop
      reached = await skipLink.evaluate((el) => el === document.activeElement);
    }
    expect(reached).toBe(true);
    await expect(skipLink).toHaveAttribute('href', '#main');

    await page.keyboard.press('Enter');
    const mainContent = page.locator('#main');
    await expect(mainContent).toBeFocused();
  });

  test('workspace and channel rows are reachable and activatable via keyboard, not just mouse', async ({ page }) => {
    const seeded = await seedUserWithChannel('a11ykbd');
    await loginViaUi(page, seeded.username, seeded.password);

    const channelRow = page.locator('[role="button"]:has-text("general")');
    await channelRow.focus();
    await expect(channelRow).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('input[placeholder^="Message #"]')).toBeVisible({ timeout: 10_000 });
  });

  test('a focused button shows a visible outline (keyboard focus ring)', async ({ page }) => {
    const seeded = await seedUserWithChannel('a11yfocus');
    await loginViaUi(page, seeded.username, seeded.password);

    // Real Tab navigation, not a programmatic .focus() call — Chromium's
    // :focus-visible heuristic (which the app's own focus ring CSS relies
    // on) doesn't reliably match a purely scripted focus() the way it
    // matches actual keyboard-driven focus. Targets the user-menu trigger
    // rather than "Sign out" (FEATURE_REQUEST.md's Apple HIG overhaul entry
    // moved Sign out behind that menu, so it's no longer a permanently
    // tabbable element) — the trigger is itself one of this entry's new
    // always-visible, always-tabbable controls.
    const userMenuTrigger = page.locator('button[aria-label="User menu"]');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    let guard = 0;
    while (!(await userMenuTrigger.evaluate((el) => el === document.activeElement)) && guard < 15) {
      // eslint-disable-next-line no-await-in-loop
      await page.keyboard.press('Tab');
      guard += 1;
    }
    await expect(userMenuTrigger).toBeFocused();
    const outlineStyle = await userMenuTrigger.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outlineStyle).not.toBe('none');
  });
});

test.describe('mentions', () => {
  // One seeded sender/recipient pair covers both the unfocused (OS
  // notification fires) and focused (OS notification suppressed) cases —
  // deliberately not two separate tests each calling seedUserWithChannel/
  // seedPlainUser, per this file's own signup-budget note above
  // (signupIpLimiter: 10/hour/IP, and a full suite run is already close to
  // that ceiling without doubling up on fresh signups here too).
  test('a mentioned user always gets an in-app toast, and an OS notification only while the tab is unfocused', async ({
    page,
    context,
  }) => {
    const sender = await seedUserWithChannel('mentionsender');
    const recipient = await seedPlainUser('mentionrecipient');
    await inviteToWorkspace(sender.accessToken, sender.workspace.id, recipient.username);

    await context.grantPermissions(['notifications']);
    await stubNotifications(page, { focused: false });

    await loginViaUi(page, recipient.username, recipient.password);
    await page.click(`text=${sender.workspace.name}`);
    await page.click('button:has-text("Join")');
    await page.waitForSelector('input[placeholder^="Message #"]', { timeout: 10_000 });

    await sendMessage(sender.accessToken, sender.channel.id, `hey @${recipient.username} check this out`);

    // In-app fallback always renders — this is the mechanism a user who
    // never granted OS-level permission still relies on.
    await expect(page.locator('text=mentioned you')).toBeVisible({ timeout: 10_000 });

    await page.waitForFunction(() => window.__notificationCalls?.length > 0, { timeout: 10_000 });
    let calls = await page.evaluate(() => window.__notificationCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toContain(sender.username);
    expect(calls[0].body).toContain('check this out');

    // Flip the tab to "focused" on the same page/session (no new signup) and
    // confirm a second mention still toasts in-app but does not add a
    // second OS notification call — an already-visible tab doesn't need an
    // OS popup on top of what's already on screen.
    await page.evaluate(() => {
      document.hasFocus = () => true;
    });
    await sendMessage(sender.accessToken, sender.channel.id, `hey @${recipient.username} focused test`);
    // .first() — "focused test" legitimately appears twice once this lands
    // (the feed row and the toast text both contain it), which is exactly
    // the expected behavior, not a bug to disambiguate around.
    await expect(page.locator('text=focused test').first()).toBeVisible({ timeout: 10_000 });
    // Give the (expected-absent) second notification a moment it would have needed to fire.
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(500);
    calls = await page.evaluate(() => window.__notificationCalls);
    expect(calls).toHaveLength(1);
  });
});

test.describe('change password', () => {
  test('wrong current password shows an inline error; the correct flow changes the password and the new one works on next login', async ({
    page,
  }) => {
    const seeded = await seedUserWithChannel('changepw');
    await loginViaUi(page, seeded.username, seeded.password);

    // FEATURE_REQUEST.md's Apple HIG overhaul entry: Change Password now
    // lives behind the user menu rather than a standalone sidebar button.
    await page.click('button[aria-label="User menu"]');
    await page.click('[role="menuitem"]:has-text("Change Password")');
    await page.waitForSelector('text=Change Password', { timeout: 10_000 });

    // button[type="submit"] specifically — the modal's own submit button,
    // distinct from the menu item that opened it.
    const submitButton = page.locator('button[type="submit"]:has-text("Change password")');

    await page.fill('#current-password', 'totally-wrong-password');
    await page.fill('#new-password', 'a-brand-new-password');
    await submitButton.click();
    await expect(page.locator('text=Current password is incorrect')).toBeVisible({ timeout: 10_000 });

    await page.fill('#current-password', seeded.password);
    await page.fill('#new-password', 'a-brand-new-password');
    await submitButton.click();
    await expect(page.locator('text=Saved')).toBeVisible({ timeout: 10_000 });

    await page.click('button[aria-label="Close change password"]');
    await page.click('button[aria-label="User menu"]');
    await page.click('[role="menuitem"]:has-text("Sign out")');

    // Old password no longer works.
    await page.waitForSelector('text=Silent Whisper', { timeout: 15_000 });
    await page.fill('#username', seeded.username);
    await page.fill('#password', seeded.password);
    await page.click('button:has-text("Sign In")');
    await expect(page.locator('text=Invalid username or password')).toBeVisible({ timeout: 10_000 });

    // New password does.
    await page.fill('#password', 'a-brand-new-password');
    await page.click('button:has-text("Sign In")');
    await page.waitForSelector('text=Workspaces', { timeout: 15_000 });
  });
});

test.describe('admin user management', () => {
  test('an admin can add a user, promote them to manager, and reset their password — all through the panel', async ({ page }) => {
    const admin = await seedUserWithChannel('usermgmt');
    await loginViaUi(page, admin.username, admin.password);

    await page.click('button:has-text("Admin Tools")');
    await page.click('[role="menuitem"]:has-text("Manage Users")');
    await page.waitForSelector('text=Manage Users', { timeout: 10_000 });

    const newUsername = `mgmt_created_${Date.now()}`;
    await page.fill('#new-user-username', newUsername);
    await page.fill('#new-user-email', `${newUsername}@example.com`);
    await page.fill('#new-user-password', 'correct-horse-battery');
    await page.click('button:has-text("Add user")');
    await expect(page.locator(`text=Created ${newUsername}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`td:has-text("${newUsername}")`)).toBeVisible({ timeout: 10_000 });

    await page.selectOption(`select[aria-label="Role for ${newUsername}"]`, 'MANAGER');
    // The role <select> reflects the change immediately from local state;
    // give the PATCH a moment to land before proceeding to reset-password
    // against the same row.
    await expect(page.locator(`select[aria-label="Role for ${newUsername}"]`)).toHaveValue('MANAGER', { timeout: 10_000 });

    const memberRow = page.locator('tr', { has: page.locator(`td:has-text("${newUsername}")`) });
    await memberRow.locator('button:has-text("Reset password")').click();
    await page.fill('input[placeholder="New password"]', 'a-brand-new-password');
    await memberRow.locator('button:has-text("Confirm")').click();
    await expect(page.locator('text=Password reset')).toBeVisible({ timeout: 10_000 });

    await page.click('button[aria-label="Close manage users"]');
    await page.click('button[aria-label="User menu"]');
    await page.click('[role="menuitem"]:has-text("Sign out")');

    await page.waitForSelector('text=Silent Whisper', { timeout: 15_000 });
    await page.fill('#username', newUsername);
    await page.fill('#password', 'a-brand-new-password');
    await page.click('button:has-text("Sign In")');
    await page.waitForSelector('text=Workspaces', { timeout: 15_000 });
    // The role promotion took effect: this account is now an ADMIN and
    // sees the same admin-only controls the original admin does — the
    // "Admin Tools" trigger itself (canManageAi-gated), not a bare button
    // for each individual tool.
    await expect(page.locator('button:has-text("Admin Tools")')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('workspace archive/unarchive', () => {
  test('an admin can archive a workspace into read-only mode and unarchive it back', async ({ page }) => {
    const seeded = await seedUserWithChannel('archive');
    await loginViaUi(page, seeded.username, seeded.password);
    await page.click(`text=${seeded.workspace.name}`);
    await page.click('text=general');
    await page.waitForSelector('input[placeholder^="Message #"]', { timeout: 10_000 });

    // FEATURE_REQUEST.md's Apple HIG overhaul entry: Archive now lives
    // behind the workspace row's own "•••" overflow menu, consolidated with
    // Invite rather than sitting as a permanent inline pill.
    await page.click(`button[aria-label="${seeded.workspace.name} options"]`);
    await page.click('text=Archive workspace');

    await expect(page.getByText('Archived', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=(archived — read only)')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('input[placeholder="This workspace is archived — read only"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('button:has-text("+ New channel")')).not.toBeVisible();
    // Archived rows render through a separate branch that never mounts the
    // overflow Menu at all (no Invite/Archive applies to a read-only
    // workspace) — a structural guarantee, not just a hidden button.
    await expect(page.locator(`button[aria-label="${seeded.workspace.name} options"]`)).not.toBeVisible();

    const archivedRow = page.locator('[role="button"]', { hasText: seeded.workspace.name });
    await archivedRow.locator('button:has-text("Unarchive")').click();
    await expect(page.locator('input[placeholder^="Message #"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('button:has-text("+ New channel")')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('semantic search (real Ollama inference — allow extra time)', () => {
  test.slow();

  // FEATURE_REQUEST.md's Apple HIG overhaul entry replaced the "Search"
  // button + full-modal SemanticSearchPanel with a persistent field docked
  // at the top of the sidebar (SearchBar.jsx) — always visible, no click to
  // open. The embedding worker ingests asynchronously (embeddingWorker.js
  // polls embedding_jobs on a timer, default 2s), so a message sent just
  // before the search isn't guaranteed to be indexed yet — retries the
  // search itself, bounded, rather than asserting on a single immediate
  // attempt (same "real async pipeline, poll for it" instinct as the
  // mentions test's waitForFunction above, applied here across repeated
  // requests instead of a single DOM mutation).
  test('finds a conceptually related message and clicking it navigates into the channel', async ({ page }) => {
    const seeded = await seedUserWithChannel('search');
    await sendMessage(
      seeded.accessToken,
      seeded.channel.id,
      'The production database had a locking issue during last night\'s migration.',
    );
    await sendMessage(seeded.accessToken, seeded.channel.id, 'I ordered pizza for the team lunch on Friday.');

    await loginViaUi(page, seeded.username, seeded.password);
    await page.click(`text=${seeded.workspace.name}`);
    await page.click('text=general');
    await page.waitForSelector('input[placeholder^="Message #"]', { timeout: 10_000 });

    // Scoped to the results listbox specifically, not a bare page-wide
    // text= locator — the same message content is already visible in the
    // live channel feed behind the popover (sent via the API before the
    // page even loaded), so an unscoped locator would ambiguously resolve
    // to that copy instead of the actual search result row.
    const resultsBox = page.locator('[role="listbox"][aria-label="Search results"]');
    const resultLocator = resultsBox.locator('text=The production database had a locking issue');
    const searchInput = page.locator('input[aria-label="Search messages"]');
    const deadline = Date.now() + 40_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      // eslint-disable-next-line no-await-in-loop
      await searchInput.fill('');
      // eslint-disable-next-line no-await-in-loop
      await searchInput.fill('database outage and downtime problems');
      // eslint-disable-next-line no-await-in-loop
      await searchInput.press('Enter'); // forces an immediate search, bypassing the debounce
      try {
        // eslint-disable-next-line no-await-in-loop
        await resultLocator.waitFor({ timeout: 3_000 });
        found = true;
      } catch {
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(1_000);
      }
    }
    expect(found).toBe(true);

    // The unrelated pizza message must rank below/not appear as the
    // top-of-results conceptual match — the whole point of "semantic," not
    // "substring," search.
    const pizzaResult = resultsBox.locator('text=I ordered pizza for the team lunch');
    expect(await pizzaResult.count()).toBeLessThanOrEqual(1);

    await resultLocator.click();
    // Navigating a result clears/closes the search popover and lands back
    // in the channel it came from — the composer being visible again is the
    // simplest reliable signal the right channel is still selected (only
    // one channel exists for this seeded user).
    await expect(resultsBox).not.toBeVisible();
    await expect(searchInput).toHaveValue('');
    await expect(page.locator('input[placeholder^="Message #"]')).toBeVisible({ timeout: 10_000 });
  });

  test('typing fewer than 2 characters shows no results popover, and Escape then clears the field', async ({ page }) => {
    const seeded = await seedUserWithChannel('searchmin');
    await loginViaUi(page, seeded.username, seeded.password);

    const searchInput = page.locator('input[aria-label="Search messages"]');
    await searchInput.fill('a');
    await page.waitForTimeout(600);
    await expect(page.locator('[role="listbox"][aria-label="Search results"]')).not.toBeVisible();

    await searchInput.fill('database');
    await searchInput.press('Escape');
    // First Escape dismisses the popover without clearing the query.
    await expect(searchInput).toHaveValue('database');
    await searchInput.press('Escape');
    await expect(searchInput).toHaveValue('');
  });
});

test.describe('menus (Apple HIG overhaul: pull-down buttons + progressive disclosure)', () => {
  test('the user menu opens via keyboard, lists account actions, and returns focus to its trigger on Escape', async ({
    page,
  }) => {
    const seeded = await seedUserWithChannel('menukbd');
    await loginViaUi(page, seeded.username, seeded.password);

    const trigger = page.locator('button[aria-label="User menu"]');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[role="menu"][aria-label="User menu"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[role="menuitem"]:has-text("Change Password")')).toBeVisible();
    await expect(page.locator('[role="menuitem"]:has-text("Sign out")')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('[role="menu"][aria-label="User menu"]')).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test('selecting "Change Password" from the user menu opens the panel, and clicking outside a menu closes it', async ({
    page,
  }) => {
    const seeded = await seedUserWithChannel('menuselect');
    await loginViaUi(page, seeded.username, seeded.password);

    await page.click('button[aria-label="User menu"]');
    await page.click('[role="menuitem"]:has-text("Change Password")');
    await expect(page.locator('text=Change Password').first()).toBeVisible({ timeout: 10_000 });
    await page.click('button[aria-label="Close change password"]');

    await page.click('button:has-text("Admin Tools")');
    await expect(page.locator('[role="menu"][aria-label="Admin tools"]')).toBeVisible({ timeout: 5_000 });
    await page.click('body', { position: { x: 5, y: 5 } });
    await expect(page.locator('[role="menu"][aria-label="Admin tools"]')).not.toBeVisible();
  });

  test('the Admin Tools menu opens the same three existing panels', async ({ page }) => {
    const seeded = await seedUserWithChannel('menuadmin');
    await loginViaUi(page, seeded.username, seeded.password);

    await page.click('button:has-text("Admin Tools")');
    await page.click('[role="menuitem"]:has-text("AI Settings")');
    await expect(page.locator('text=Configure the local LLM provider')).toBeVisible({ timeout: 10_000 });
    await page.click('button[aria-label="Close AI settings"]');

    await page.click('button:has-text("Admin Tools")');
    await page.click('[role="menuitem"]:has-text("Audit Log")');
    await expect(page.locator('text=AUTH_SIGNUP').first()).toBeVisible({ timeout: 10_000 });
    await page.click('button[aria-label="Close audit log"]');

    await page.click('button:has-text("Admin Tools")');
    await page.click('[role="menuitem"]:has-text("Manage Users")');
    await expect(page.locator('text=Manage Users').first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('virtual scrolling', () => {
  test('a long channel history renders only a window of message rows, not all of them', async ({ page }) => {
    const seeded = await seedUserWithChannel('scroll');
    const TOTAL_MESSAGES = 50;
    // Seeded directly in Postgres, not via TOTAL_MESSAGES REST POSTs in a
    // tight loop — Section 3's per-user message rate limit (10 sends /
    // 10s, shared across the REST and WebSocket send paths as of the
    // Phase 5 authorization audit pass) would silently reject most of a
    // 50-message burst sent that way, leaving far fewer real rows than the
    // test intends to seed. That's the send-message path correctly
    // enforcing its limit, not something to route around by weakening it —
    // this test isn't exercising that path at all, it just needs existing
    // history to already be there, so it seeds the same way the load-test
    // script does (as the same least-privilege app_runtime_user role the
    // backend itself uses).
    const pgClient = new pg.Client({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      user: process.env.APP_DB_USER,
      password: process.env.APP_DB_PASSWORD,
      database: process.env.PGDATABASE,
    });
    await pgClient.connect();
    try {
      for (let i = 0; i < TOTAL_MESSAGES; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await pgClient.query('INSERT INTO messages (channel_id, user_id, content) VALUES ($1, $2, $3)', [
          seeded.channel.id,
          seeded.userId,
          `history message ${i}`,
        ]);
      }
    } finally {
      await pgClient.end();
    }

    await loginViaUi(page, seeded.username, seeded.password);
    await page.click(`text=${seeded.workspace.name}`);
    await page.click('text=general');
    await page.waitForSelector('input[placeholder^="Message #"]', { timeout: 10_000 });
    await expect(page.locator(`text=history message ${TOTAL_MESSAGES - 1}`)).toBeVisible({ timeout: 10_000 });

    const renderedRowCount = await page.locator('[data-index]').count();
    expect(renderedRowCount).toBeGreaterThan(0);
    expect(renderedRowCount).toBeLessThan(TOTAL_MESSAGES);
  });
});

test.describe('theme toggle (System / Light / Dark)', () => {
  test('selecting Dark applies data-theme and persists across reload; System removes it again', async ({ page }) => {
    const seeded = await seedUserWithChannel('theme');
    await loginViaUi(page, seeded.username, seeded.password);

    // No data-theme attribute at all on first load for a brand-new
    // account — 'system' is the default, driven entirely by global.css's
    // prefers-color-scheme media query, not an explicit override.
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();

    await page.click('button[aria-label="User menu"]');
    await page.click('[role="menuitemcheckbox"]:has-text("Dark")');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
    // The menu closes on selection (Menu.jsx's existing activate()
    // behavior) — reopen it to check the checkmark landed on the right item.
    await page.click('button[aria-label="User menu"]');
    await expect(page.locator('[role="menuitemcheckbox"]:has-text("Dark")')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');

    await page.reload();
    await page.waitForSelector('text=Workspaces', { timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');

    await page.click('button[aria-label="User menu"]');
    await page.click('[role="menuitemcheckbox"]:has-text("System")');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBeNull();
  });
});
