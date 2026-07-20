#!/usr/bin/env node
// Idempotent demo-data seed: "The Soup Stand Operations" — a Seinfeld
// ("The Soup Nazi") themed workspace exercising every core feature this app
// has: channel architecture (PUBLIC/PRIVATE), flat one-level threading,
// @mentions + mention_notifications, [[double-bracket]] entity linking,
// inline Markdown checkbox tasks, and both DIRECT and GROUP_DM
// out-of-workspace messaging — over a simulated 48-hour conversation window,
// written to read naturally to a summarization/task-extraction/digest LLM
// rather than as lorem-ipsum filler.
//
// Architecture, and why it differs from seed-springfield-investigation.mjs:
// that script (and its link-springfield-entities.mjs companion) deliberately
// drives the real HTTP API with a raw `pg` client, specifically to get
// appendAuditEvent/entity-linking/mention-notifications "for free" from the
// route handlers without duplicating their logic — at the cost of needing
// the whole stack up, a live login per character, and a wait for the async
// message-side-effects worker to drain before any final report is
// trustworthy. This script was asked to do it differently: use the
// application's own configured Knex instance directly (`backend/src/db.js`)
// and call the same underlying service functions those routes call
// (`appendAuditEvent`, `linkMessageEntities`, `extractMentionedUserIds`,
// `createMentionNotifications`, `parseTasks`) directly against it — no HTTP,
// no running server required, no async worker to wait for, deterministic
// final state the instant the script exits. Nothing here reimplements the
// tokenizer regexes or the audit hash-chain logic by hand; every side effect
// goes through the exact same code path the running app uses.
//
// A hazard learned the hard way in this repo (see git history around
// 2026-07-20): backend/src/config.js and everything under backend/src/
// throws immediately if PGHOST/PGDATABASE/etc. aren't already in
// process.env when it's imported, and ordinary `import` statements are
// hoisted above all other top-level code in an ES module — so a static
// `import { db } from '../backend/src/db.js'` at the top of this file would
// evaluate config.js *before* the dotenv.config() call below ever runs.
// Every backend/src import in this file is therefore a dynamic `await
// import(...)` inside main(), after dotenv.config() has already populated
// process.env — never a static top-level import.
//
// Idempotency model: user accounts (the six character logins) are
// find-or-create and stable across reruns — recreating them every run would
// mean regenerating/re-displaying credentials for no benefit, and nothing
// about "the demo workspace" requires the accounts themselves to churn.
// Everything scoped to *this specific demo workspace* — its channels,
// memberships, messages, threads, tasks, and entities — plus any DIRECT/
// GROUP_DM channel made up entirely of these six demo accounts, is fully
// torn down and rebuilt from scratch on every run. Deletes are scoped
// precisely (by exact workspace name, and by DM channels whose *entire*
// membership is a subset of the six demo user ids) — this script never
// touches any other workspace, user, or DM conversation in the database,
// and never touches audit_logs (appendAuditEvent's own internal
// pg_advisory_xact_lock means a rerun's new rows simply extend the existing
// hash chain; there is nothing to "un-fork" because nothing is ever deleted
// from that table).
//
// Tables with DELETE revoked from app_runtime_user as of migration 0013
// (users, workspaces, channels, messages, organizations, audit_logs — see
// tests/helpers/resetDb.js's own identical split) need a second, admin-
// credentialed Knex connection for the cleanup phase; every other table
// (workspace_members, channel_members, entities, message_entities,
// mention_notifications, organization_members) still allows app_runtime_user
// to delete, same as resetDb.js already relies on. Deleting the workspace
// row itself cascades channels -> messages -> message_entities/
// mention_notifications, and cascades entities directly (all declared
// ON DELETE CASCADE against workspaces/channels/messages in
// database/migrations/) — only workspace_members has no FK at all and must
// be deleted explicitly first.

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Matches every other /scripts tool's convention (create-first-admin.mjs,
// seed-springfield-investigation.mjs): loads backend/.env explicitly by
// path rather than relying on dotenv's cwd-relative default, since this
// script is normally invoked as `cd scripts && node seed-demo-tv-workspace.mjs`
// (cwd = scripts/, which has no .env of its own).
dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') });

const WORKSPACE_NAME = 'The Soup Stand Operations';
const SEED_ACTOR_IP = '127.0.0.1'; // no real HTTP request exists to take one from
// Not a production secret: a fixed, memorable, policy-compliant (>=10 chars,
// not on the common-password deny-list) login shared by every seeded
// character, matching frontend/e2e/workflows.spec.js's/testUsers.js's own
// "every seeded user shares one known TEST_PASSWORD" convention for
// non-production fixture accounts. Overridable, never required to be.
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'NoSoupForYou!48';

const CHARACTERS = [
  { username: 'jerry', displayName: 'Jerry Seinfeld', email: 'jerry@soupstand.demo' },
  { username: 'g_costanza', displayName: 'George Costanza', email: 'george@soupstand.demo' },
  { username: 'elaine_b', displayName: 'Elaine Benes', email: 'elaine@soupstand.demo' },
  { username: 'kramer', displayName: 'Cosmo Kramer', email: 'kramer@soupstand.demo' },
  { username: 'soupnazi', displayName: 'Yev Kassem', email: 'yev@soupstand.demo' },
  { username: 'newman', displayName: 'Newman', email: 'newman@soupstand.demo' },
];

async function main() {
  if (!process.env.PGDATABASE) {
    throw new Error(
      'PGDATABASE is not set (expected in backend/.env) — refusing to run against an unknown database.',
    );
  }
  console.log(`Seeding "${WORKSPACE_NAME}" into database "${process.env.PGDATABASE}" (host ${process.env.PGHOST}:${process.env.PGPORT || 5432})...\n`);

  // Dynamic imports only, by design — see the file header comment on why a
  // static top-level import here would silently use the wrong PGDATABASE.
  const { db } = await import('../backend/src/db.js');
  const { config } = await import('../backend/src/config.js');
  const { appendAuditEvent } = await import('../backend/src/audit/auditService.js');
  const { linkMessageEntities } = await import('../backend/src/services/entityService.js');
  const { extractMentionedUserIds } = await import('../backend/src/services/mentionService.js');
  const { createMentionNotifications } = await import('../backend/src/services/mentionNotificationService.js');
  const { parseTasks } = await import('../backend/src/services/taskParser.js');
  const knexFactory = (await import('knex')).default;

  const OWNER_ALIAS = config.tasks.ownerTokenAlias;
  const task = (checked, text, owner) => `- [${checked ? 'x' : ' '}] ${text} [${OWNER_ALIAS}:: @${owner}]`;

  const baseTime = Date.now();
  const t = (n) => new Date(baseTime - n * 60_000);

  // Second connection using admin/migration credentials — same split
  // tests/helpers/resetDb.js already establishes, needed only for deleting
  // from workspaces/channels/users during the idempotent cleanup pass below
  // (app_runtime_user has DELETE revoked on those four tables).
  const adminDb = knexFactory({
    client: 'pg',
    connection: {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
    },
    pool: { min: 1, max: 5 },
  });

  try {
    const org = await db('organizations').orderBy('created_at', 'asc').first();
    if (!org) {
      throw new Error('No organization exists — run migrations first (0012 seeds the Default Organization).');
    }

    // ---- 1. Find-or-create the six character accounts (stable across reruns) ----
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
    const users = {};
    let usersCreated = 0;
    for (const character of CHARACTERS) {
      // eslint-disable-next-line no-await-in-loop
      let row = await db('users').where({ username: character.username }).first();
      if (!row) {
        // eslint-disable-next-line no-await-in-loop
        const [inserted] = await db('users')
          .insert({
            username: character.username,
            email: character.email,
            password_hash: passwordHash,
            display_name: character.displayName,
            created_at: t(3000),
          })
          .returning(['id', 'username', 'display_name']);
        row = inserted;
        usersCreated += 1;
        // eslint-disable-next-line no-await-in-loop
        await db('organization_members')
          .insert({ organization_id: org.id, user_id: row.id, org_role: 'ORG_MEMBER' })
          .onConflict(['organization_id', 'user_id'])
          .ignore();
      }
      users[character.username] = { id: row.id, username: character.username, displayName: character.displayName };
    }
    const userIds = Object.values(users).map((u) => u.id);
    console.log(`Users: ${usersCreated} created, ${CHARACTERS.length - usersCreated} already existed (${CHARACTERS.length} total).`);

    // ---- 2. Idempotent cleanup: tear down any prior run's workspace + DMs ----
    const existingWorkspace = await db('workspaces').where({ name: WORKSPACE_NAME }).first();
    if (existingWorkspace) {
      // No FK on workspace_members at all (see database/migrations/0003) —
      // must be deleted explicitly; everything else cascades from the
      // workspaces row delete below.
      await db('workspace_members').where({ workspace_id: existingWorkspace.id }).del();
      await adminDb('workspaces').where({ id: existingWorkspace.id }).del();
      console.log(`Removed previous "${WORKSPACE_NAME}" workspace (${existingWorkspace.id}) and everything under it.`);
    }
    const candidateDmChannels = await db('channels').whereIn('type', ['DIRECT', 'GROUP_DM']).select('id');
    let dmChannelsRemoved = 0;
    for (const ch of candidateDmChannels) {
      // eslint-disable-next-line no-await-in-loop
      const members = await db('channel_members').where({ channel_id: ch.id }).select('user_id');
      const memberIds = members.map((m) => m.user_id);
      // Only ever removes a DM entirely contained within the six demo
      // accounts — never a conversation involving anyone else.
      if (memberIds.length > 0 && memberIds.every((id) => userIds.includes(id))) {
        // eslint-disable-next-line no-await-in-loop
        await adminDb('channels').where({ id: ch.id }).del();
        dmChannelsRemoved += 1;
      }
    }
    if (dmChannelsRemoved > 0) {
      console.log(`Removed ${dmChannelsRemoved} prior demo DM/group-DM channel(s).`);
    }

    // ---- 3. Workspace + audit ----
    const [workspace] = await db('workspaces')
      .insert({
        name: WORKSPACE_NAME,
        owner_id: users.jerry.id,
        organization_id: org.id,
        visibility: 'DISCOVERABLE',
        created_at: t(2880),
      })
      .returning(['id', 'name']);
    await db('workspace_members').insert({ workspace_id: workspace.id, user_id: users.jerry.id, system_role: 'OWNER' });
    await appendAuditEvent(db, {
      actorId: users.jerry.id,
      actorIp: SEED_ACTOR_IP,
      actionType: 'WORKSPACE_CREATED',
      targetResource: workspace.id,
    });

    const nonOwners = CHARACTERS.map((c) => c.username).filter((u) => u !== 'jerry');
    for (const username of nonOwners) {
      const u = users[username];
      // eslint-disable-next-line no-await-in-loop
      await db('workspace_members').insert({ workspace_id: workspace.id, user_id: u.id, system_role: 'MEMBER' });
      // eslint-disable-next-line no-await-in-loop
      await appendAuditEvent(db, {
        actorId: users.jerry.id,
        actorIp: SEED_ACTOR_IP,
        actionType: 'WORKSPACE_MEMBERSHIP_CHANGE',
        targetResource: workspace.id,
        payload: { action: 'add', addedUserId: u.id, addedUsername: username, role: 'MEMBER' },
      });
    }
    console.log(`Workspace created: "${workspace.name}" (${workspace.id}), owner @jerry, ${nonOwners.length} members added.`);

    // ---- 4. Channels + audit ----
    async function createChannel({ name, type, creatorId, createdAt }) {
      const [channel] = await db('channels')
        .insert({ workspace_id: workspace.id, name, type, created_at: createdAt })
        .returning(['id', 'name', 'type']);
      await db('channel_members').insert({ channel_id: channel.id, user_id: creatorId });
      await appendAuditEvent(db, {
        actorId: creatorId,
        actorIp: SEED_ACTOR_IP,
        actionType: 'CHANNEL_CREATED',
        targetResource: channel.id,
        payload: { workspaceId: workspace.id, type },
      });
      return channel;
    }
    async function joinChannel(channelId, userId) {
      await db('channel_members').insert({ channel_id: channelId, user_id: userId });
      await appendAuditEvent(db, {
        actorId: userId,
        actorIp: SEED_ACTOR_IP,
        actionType: 'CHANNEL_MEMBERSHIP_CHANGE',
        targetResource: channelId,
        payload: { action: 'join' },
      });
    }
    async function addChannelMember(channelId, addedByUserId, targetUsername) {
      const target = users[targetUsername];
      await db('channel_members').insert({ channel_id: channelId, user_id: target.id });
      await appendAuditEvent(db, {
        actorId: addedByUserId,
        actorIp: SEED_ACTOR_IP,
        actionType: 'CHANNEL_MEMBERSHIP_CHANGE',
        targetResource: channelId,
        payload: { action: 'add', addedUserId: target.id, addedUsername: target.username },
      });
    }

    const announcements = await createChannel({ name: 'announcements', type: 'PUBLIC', creatorId: users.jerry.id, createdAt: t(2879) });
    const generalGripes = await createChannel({ name: 'general-gripes', type: 'PUBLIC', creatorId: users.jerry.id, createdAt: t(2878) });
    for (const username of nonOwners) {
      // eslint-disable-next-line no-await-in-loop
      await joinChannel(announcements.id, users[username].id);
      // eslint-disable-next-line no-await-in-loop
      await joinChannel(generalGripes.id, users[username].id);
    }

    // Deliberately excludes @jerry and @g_costanza — the authorization
    // isolation this entry exists to demonstrate. Elaine creates it (so
    // she's auto-added), then explicitly adds Kramer and Newman.
    const soupSecrets = await createChannel({ name: 'soup-kitchen-secrets', type: 'PRIVATE', creatorId: users.elaine_b.id, createdAt: t(2700) });
    await addChannelMember(soupSecrets.id, users.elaine_b.id, 'kramer');
    await addChannelMember(soupSecrets.id, users.elaine_b.id, 'newman');

    console.log(`Channels: #${announcements.name} (PUBLIC), #${generalGripes.name} (PUBLIC), #${soupSecrets.name} (PRIVATE, elaine_b/kramer/newman only).`);

    // ---- 5. DMs + audit ----
    async function createDirectMessage(userAId, userBId) {
      const [channel] = await db('channels')
        .insert({ workspace_id: null, name: 'Direct Message', type: 'DIRECT', created_at: t(520) })
        .returning(['id']);
      await db('channel_members').insert([
        { channel_id: channel.id, user_id: userAId },
        { channel_id: channel.id, user_id: userBId },
      ]);
      await appendAuditEvent(db, {
        actorId: userAId,
        actorIp: SEED_ACTOR_IP,
        actionType: 'CHANNEL_MEMBERSHIP_CHANGE',
        targetResource: channel.id,
        payload: { action: 'create_direct_message', withUserId: userBId },
      });
      return channel;
    }
    async function createGroupDirectMessage(creatorId, memberIds) {
      const [channel] = await db('channels')
        .insert({ workspace_id: null, name: 'Group Direct Message', type: 'GROUP_DM', created_at: t(210) })
        .returning(['id']);
      await db('channel_members').insert([creatorId, ...memberIds].map((id) => ({ channel_id: channel.id, user_id: id })));
      await appendAuditEvent(db, {
        actorId: creatorId,
        actorIp: SEED_ACTOR_IP,
        actionType: 'CHANNEL_MEMBERSHIP_CHANGE',
        targetResource: channel.id,
        payload: { action: 'create_group_dm', memberIds },
      });
      return channel;
    }

    const jerryElaineDm = await createDirectMessage(users.jerry.id, users.elaine_b.id);
    const schemeGroupDm = await createGroupDirectMessage(users.kramer.id, [users.newman.id, users.elaine_b.id]);
    console.log('Direct messages: 1 DIRECT (jerry <-> elaine_b), 1 GROUP_DM (kramer/newman/elaine_b).');

    // ---- 6. Messages ----
    // insertMessage reuses the exact same service functions
    // routes/messages.js's POST handler calls (via the async job queue in
    // production) synchronously and directly, so entities/mentions land
    // deterministically without needing workers/messageSideEffectsWorker.js
    // running at all.
    const allMessageIds = [];
    async function insertMessage({ channelId, workspaceId, userId, content, createdAt, parentMessageId = null }) {
      const [message] = await db('messages')
        .insert({ channel_id: channelId, user_id: userId, content, parent_message_id: parentMessageId, created_at: createdAt })
        .returning(['id']);
      allMessageIds.push(message.id);

      if (workspaceId) {
        await linkMessageEntities(db, { content, messageId: message.id, workspaceId, createdBy: userId });
      }
      const mentionedUserIds = await extractMentionedUserIds(db, { content, channelId, excludeUserId: userId });
      if (mentionedUserIds.length > 0) {
        await createMentionNotifications(db, {
          mentionedUserIds,
          message: { id: message.id, channelId },
          workspaceId: workspaceId ?? null,
          mentionedByUserId: userId,
        });
      }
      return message.id;
    }

    // Each channel's script: an ordered list of turns. `replyTo` references
    // an earlier index within the SAME array (flat one-level threading,
    // matching messages.js's own doc comment — a reply's id is never itself
    // used as another reply's parent).
    const channelScripts = [
      {
        channel: announcements,
        workspaceId: workspace.id,
        turns: [
          { speaker: 'soupnazi', minutesAgo: 2880, content: 'Attention. Soup stand hours are 11:00 AM to 2:00 PM. If you do not have your order ready, you will not be served. This is not a negotiation.' },
          { speaker: 'soupnazi', minutesAgo: 2875, content: 'Also: no substitutions. If the soup comes with bread, you take the bread. If you do not want the bread, you still take the bread and say nothing.' },
          { speaker: 'soupnazi', minutesAgo: 2870, content: `The line moves. Decide before you reach the counter. [[The Soup Nazi]] has spoken.\n${task(false, 'Post the official soup ordering rules by the register', 'soupnazi')}` },
          { speaker: 'jerry', minutesAgo: 1500, content: 'Reminder to everyone: @soupnazi posted the rules above. Read them. Actually read them, @g_costanza.' },
          { speaker: 'soupnazi', minutesAgo: 90, content: "URGENT: stand will close one hour early tomorrow for a health inspection. Adjust accordingly. [[No Soup For You]] applies extra strictly tomorrow, do not test me." },
          { speaker: 'soupnazi', minutesAgo: 85, content: 'Repeat: 11:00 to 1:00 tomorrow only. That is all.' },
        ],
      },
      {
        channel: generalGripes,
        workspaceId: workspace.id,
        turns: [
          { speaker: 'jerry', minutesAgo: 2860, content: 'So has everyone seen this soup stand a few blocks down? Line around the corner. @g_costanza @elaine_b @kramer you have to try it.' },
          { speaker: 'g_costanza', minutesAgo: 2850, content: 'I heard the guy is insane. Actual rules for ordering soup. Who has rules for soup?' },
          { speaker: 'g_costanza', minutesAgo: 2845, content: "This is a man who has never had a woman yell at him. I can tell." },
          { speaker: 'elaine_b', minutesAgo: 2800, content: "I want the [[Mulligatawny]]. I don't even know what's in it. I just want it." },
          { speaker: 'kramer', minutesAgo: 2790, content: "Elaine, you gotta respect [[The Line]]. There's a rhythm to it. Order, step left, pay, step right, receive. It's a dance, Elaine." },
          { speaker: 'jerry', minutesAgo: 2750, content: "Kramer's not wrong. It's basically a Broadway show over there." },
          { speaker: 'elaine_b', minutesAgo: 2700, content: 'Anyway, has anyone seen the guy from the armoire delivery? Was supposed to be here yesterday and nobody has called me back. @kramer did you hear anything?' },
          // --- Thread A root: index 7 ---
          { speaker: 'g_costanza', minutesAgo: 2600, content: 'Does anybody actually know ALL the rules for ordering from [[The Soup Nazi]]? Real talk, I do not want to get banned. @elaine_b @kramer help me out here.' },
          { speaker: 'elaine_b', minutesAgo: 2595, replyTo: 7, content: `George, it's simple. You decide, you step up, you order, you move to the side to pay, you take the soup and say thank you. That's it.\n${task(true, 'Practice the exact three-step order-money-move method before approaching', 'elaine_b')}` },
          { speaker: 'kramer', minutesAgo: 2590, replyTo: 7, content: "And whatever you do, don't ask questions about the soup. Don't ask what's in it, don't ask if it's spicy. @newman asked once and got the full [[No Soup For You]] treatment for a MONTH." },
          { speaker: 'g_costanza', minutesAgo: 2585, replyTo: 7, content: `A month?! Okay okay.\n${task(false, 'Stop talking before reaching the counter', 'g_costanza')}` },
          { speaker: 'jerry', minutesAgo: 2580, replyTo: 7, content: 'This is the most prepared George has been for anything in his life.' },
          { speaker: 'elaine_b', minutesAgo: 1200, content: 'Update: still no armoire guy. This is unbelievable.' },
          { speaker: 'kramer', minutesAgo: 1000, content: "Jerry, you gotta come see this. [[The Soup Nazi]] yelled at somebody for asking for extra bread. Just yelled. 'NO SOUP FOR YOU.' Classic." },
          { speaker: 'jerry', minutesAgo: 995, content: "I've heard the yell. It's very operatic." },
          { speaker: 'newman', minutesAgo: 500, content: 'For the record, I still maintain my question was reasonable. @kramer you are exaggerating the ban.' },
          { speaker: 'g_costanza', minutesAgo: 450, content: "Newman, you got banned for asking if the soup was 'seasonal.' That's a totally normal question and you still got banned. There's no logic to it." },
          { speaker: 'elaine_b', minutesAgo: 60, content: "Okay I'm going back today. Wish me luck. @jerry @kramer" },
          { speaker: 'jerry', minutesAgo: 55, content: 'Good luck. Godspeed. Bring back intel on the [[Mulligatawny]].' },
        ],
      },
      {
        channel: soupSecrets,
        workspaceId: workspace.id,
        turns: [
          // --- Thread B root: index 0 ---
          { speaker: 'elaine_b', minutesAgo: 2698, content: 'Okay, this stays between us. I need actual soup and I am NOT walking up there and getting my whole day ruined by [[The Soup Nazi]]. Somebody help me figure this out.' },
          { speaker: 'kramer', minutesAgo: 2695, replyTo: 0, content: `Elaine, I got a guy. Well, I got a hat. A very convincing hat.\n${task(false, 'Get in line before 11:30am to beat the rush', 'kramer')}` },
          { speaker: 'newman', minutesAgo: 2690, replyTo: 0, content: `I'll help, but I want something in return. Also:\n${task(false, "Find out if a to-go order still counts as 'moving too slow'", 'newman')}\n@elaine_b this matters, don't skip it.` },
          { speaker: 'elaine_b', minutesAgo: 2685, replyTo: 0, content: `Fine, Newman, whatever you want. Also:\n${task(true, 'Apologize to [[The Soup Nazi]] for yesterday\'s chatter', 'elaine_b')}\nAlready handled, for the record.` },
          { speaker: 'kramer', minutesAgo: 40, content: "Update on the operation: hat's ready. We move at dawn. Or, you know, 11." },
          { speaker: 'newman', minutesAgo: 35, content: "I still haven't decided if I'm in. Depends what @elaine_b is offering." },
          { speaker: 'elaine_b', minutesAgo: 30, content: 'Newman I will owe you a favor, a REAL favor, can we move on.' },
        ],
      },
      {
        channel: jerryElaineDm,
        workspaceId: null,
        turns: [
          { speaker: 'elaine_b', minutesAgo: 510, content: "I can't believe I'm banned from soup, Jerry. BANNED. From SOUP." },
          { speaker: 'jerry', minutesAgo: 505, content: 'You brought it up yourself. You basically dared him.' },
          { speaker: 'jerry', minutesAgo: 500, content: "Also I'm not getting involved in whatever @kramer and @newman are cooking up. I've seen this movie." },
          { speaker: 'elaine_b', minutesAgo: 495, content: "Nobody asked you to get involved. I'm handling it." },
        ],
      },
      {
        channel: schemeGroupDm,
        workspaceId: null,
        turns: [
          { speaker: 'kramer', minutesAgo: 200, content: 'Okay, the three of us, this is where the real plan happens.' },
          { speaker: 'newman', minutesAgo: 195, content: 'I am listening. But I have conditions.' },
          { speaker: 'elaine_b', minutesAgo: 190, content: 'Newman, we have been over the conditions.' },
          { speaker: 'kramer', minutesAgo: 185, content: 'Nobody breathes a word of this to @jerry or @g_costanza. @newman @elaine_b agreed?' },
          { speaker: 'newman', minutesAgo: 180, content: 'Agreed. Reluctantly.' },
        ],
      },
    ];

    let threadRootCount = 0;
    for (const script of channelScripts) {
      const idsInChannel = [];
      for (const turn of script.turns) {
        const parentMessageId = turn.replyTo !== undefined ? idsInChannel[turn.replyTo] : null;
        // eslint-disable-next-line no-await-in-loop
        const id = await insertMessage({
          channelId: script.channel.id,
          workspaceId: script.workspaceId,
          userId: users[turn.speaker].id,
          content: turn.content,
          createdAt: t(turn.minutesAgo),
          parentMessageId,
        });
        idsInChannel.push(id);
      }
      threadRootCount += new Set(script.turns.filter((turn) => turn.replyTo !== undefined).map((turn) => turn.replyTo)).size;
    }
    console.log(`Messages: ${allMessageIds.length} inserted across ${channelScripts.length} channels/DMs, ${threadRootCount} threaded conversations.`);

    // ---- 7. Final report — every count re-derived from what's actually in
    // the database via the app's own parser/tables, not hand-tallied, so the
    // report can never drift from what the app itself would show. ----
    const allChannelIds = channelScripts.map((s) => s.channel.id);
    const allMessages = await db('messages').whereIn('id', allMessageIds).select('content');
    let tasksChecked = 0;
    let tasksUnchecked = 0;
    for (const m of allMessages) {
      for (const parsedTask of parseTasks(m.content)) {
        if (parsedTask.checked) tasksChecked += 1;
        else tasksUnchecked += 1;
      }
    }
    const entityRows = await db('entities')
      .where({ workspace_id: workspace.id })
      .select('canonical_name')
      .orderBy('canonical_name', 'asc');
    const entityLinkCount = await db('message_entities').whereIn('message_id', allMessageIds).count('* as c').first();
    const mentionCount = await db('mention_notifications').whereIn('message_id', allMessageIds).count('* as c').first();
    const threadRootIds = await db('messages')
      .whereIn('channel_id', allChannelIds)
      .whereNotNull('parent_message_id')
      .countDistinct('parent_message_id as c')
      .first();

    console.log('\n=== Demo workspace seeded successfully ===');
    console.log(`Workspace: "${workspace.name}" (${workspace.id})`);
    console.log(`Users:     ${CHARACTERS.length} (${usersCreated} newly created) — password: ${DEMO_PASSWORD}`);
    console.log(`Channels:  3 workspace channels (2 PUBLIC, 1 PRIVATE) + 2 DM channels (1 DIRECT, 1 GROUP_DM)`);
    console.log(`Messages:  ${allMessages.length}`);
    console.log(`Threads:   ${threadRootIds.c} root message(s) with replies`);
    console.log(`Tasks:     ${tasksChecked + tasksUnchecked} checkbox line(s) (${tasksChecked} checked, ${tasksUnchecked} unchecked)`);
    console.log(`Entities:  ${entityRows.length} distinct ([[${entityRows.map((e) => e.canonical_name).join(']], [[')}]]), ${entityLinkCount.c} message reference(s)`);
    console.log(`Mentions:  ${mentionCount.c} mention_notifications row(s) created`);
    console.log('===========================================\n');
  } finally {
    await adminDb.destroy();
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('seed-demo-tv-workspace failed:', err);
  process.exit(1);
});
