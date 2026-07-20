#!/usr/bin/env node
// Idempotent demo-data seed: "The Monorail Project" — The Simpsons' "Marge
// vs. the Monorail" — a second themed demo workspace alongside
// seed-demo-tv-workspace.mjs's "The Soup Stand Operations", built on the
// exact same proven architecture (see that file's own header comment for
// the full design rationale: dynamic backend/src imports after
// dotenv.config() to avoid the config.js hoisting hazard, direct reuse of
// the app's real appendAuditEvent/linkMessageEntities/
// extractMentionedUserIds/createMentionNotifications/parseTasks rather than
// reimplementing any of them, and precisely-scoped idempotent teardown).
//
// Deliberately a second, separate, self-contained script rather than a
// shared library with seed-demo-tv-workspace.mjs: the two files' actual
// reusable plumbing (~80 lines: dependency loading, find-or-create users,
// scoped cleanup, message insertion with side effects, final report) is
// genuinely identical in shape, but each script's real value is its own
// readable, top-to-bottom narrative and topology — splitting that into a
// shared engine would trade a small amount of duplication for a layer of
// indirection neither script actually needs yet. Matches this repo's own
// existing precedent of seed-springfield-investigation.mjs and
// verify-audit-log.mjs each staying fully self-contained rather than
// sharing infrastructure across /scripts.
//
// Character usernames are deliberately distinct from
// seed-springfield-investigation.mjs's existing Simpsons-themed roster
// (wiggum, smithers, lisa_sleuth, marge_s, homer_j, skinner_s) — this is a
// different demo workspace with its own self-contained cast, not meant to
// share or collide with that script's accounts.

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') });

const WORKSPACE_NAME = 'The Monorail Project';
const SEED_ACTOR_IP = '127.0.0.1'; // no real HTTP request exists to take one from
// Not a production secret — same "one fixed, memorable, policy-compliant
// password shared by every seeded character" convention
// seed-demo-tv-workspace.mjs and frontend/e2e/workflows.spec.js's
// TEST_PASSWORD already establish for non-production fixture accounts.
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'MonorailMonorail48';

const CHARACTERS = [
  { username: 'lyle_lanley', displayName: 'Lyle Lanley', email: 'lyle@monorailproject.demo' },
  { username: 'marge_skeptic', displayName: 'Marge Simpson', email: 'marge@monorailproject.demo' },
  { username: 'homer_conductor', displayName: 'Homer Simpson', email: 'homer@monorailproject.demo' },
  { username: 'mayor_quimby', displayName: 'Mayor Quimby', email: 'quimby@monorailproject.demo' },
  { username: 'ned_flanders', displayName: 'Ned Flanders', email: 'ned@monorailproject.demo' },
  { username: 'bart_simpson', displayName: 'Bart Simpson', email: 'bart@monorailproject.demo' },
];

async function main() {
  if (!process.env.PGDATABASE) {
    throw new Error(
      'PGDATABASE is not set (expected in backend/.env) — refusing to run against an unknown database.',
    );
  }
  console.log(`Seeding "${WORKSPACE_NAME}" into database "${process.env.PGDATABASE}" (host ${process.env.PGHOST}:${process.env.PGPORT || 5432})...\n`);

  // Dynamic imports only — see seed-demo-tv-workspace.mjs's header comment
  // on why a static top-level import here would silently use the wrong
  // PGDATABASE.
  const { db } = await import('../backend/src/db.js');
  const { config } = await import('../backend/src/config.js');
  const { appendAuditEvent } = await import('../backend/src/audit/auditService.js');
  const { linkMessageEntities } = await import('../backend/src/services/entityService.js');
  const { extractMentionedUserIds } = await import('../backend/src/services/mentionService.js');
  const { createMentionNotifications } = await import('../backend/src/services/mentionNotificationService.js');
  const { parseTasks } = await import('../backend/src/services/taskParser.js');
  const { enqueueEmbeddingJob } = await import('../backend/src/search/embeddingQueue.js');
  const knexFactory = (await import('knex')).default;

  const OWNER_ALIAS = config.tasks.ownerTokenAlias;
  const task = (checked, text, owner) => `- [${checked ? 'x' : ' '}] ${text} [${OWNER_ALIAS}:: @${owner}]`;

  const baseTime = Date.now();
  const t = (n) => new Date(baseTime - n * 60_000);

  // Second connection using admin/migration credentials — same split
  // tests/helpers/resetDb.js and seed-demo-tv-workspace.mjs already
  // establish, needed only for deleting from workspaces/channels/users
  // during the idempotent cleanup pass below (app_runtime_user has DELETE
  // revoked on those four tables).
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
      // Only ever removes a DM entirely contained within these six demo
      // accounts — never a conversation involving anyone else (including
      // the Springfield Investigation Taskforce's own separate cast).
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
        owner_id: users.lyle_lanley.id,
        organization_id: org.id,
        visibility: 'DISCOVERABLE',
        created_at: t(2880),
      })
      .returning(['id', 'name']);
    await db('workspace_members').insert({ workspace_id: workspace.id, user_id: users.lyle_lanley.id, system_role: 'OWNER' });
    await appendAuditEvent(db, {
      actorId: users.lyle_lanley.id,
      actorIp: SEED_ACTOR_IP,
      actionType: 'WORKSPACE_CREATED',
      targetResource: workspace.id,
    });

    const nonOwners = CHARACTERS.map((c) => c.username).filter((u) => u !== 'lyle_lanley');
    for (const username of nonOwners) {
      const u = users[username];
      // eslint-disable-next-line no-await-in-loop
      await db('workspace_members').insert({ workspace_id: workspace.id, user_id: u.id, system_role: 'MEMBER' });
      // eslint-disable-next-line no-await-in-loop
      await appendAuditEvent(db, {
        actorId: users.lyle_lanley.id,
        actorIp: SEED_ACTOR_IP,
        actionType: 'WORKSPACE_MEMBERSHIP_CHANGE',
        targetResource: workspace.id,
        payload: { action: 'add', addedUserId: u.id, addedUsername: username, role: 'MEMBER' },
      });
    }
    console.log(`Workspace created: "${workspace.name}" (${workspace.id}), owner @lyle_lanley, ${nonOwners.length} members added.`);

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

    const announcements = await createChannel({ name: 'town-hall-announcements', type: 'PUBLIC', creatorId: users.lyle_lanley.id, createdAt: t(2879) });
    const planning = await createChannel({ name: 'monorail-planning', type: 'PUBLIC', creatorId: users.lyle_lanley.id, createdAt: t(2878) });
    for (const username of nonOwners) {
      // eslint-disable-next-line no-await-in-loop
      await joinChannel(announcements.id, users[username].id);
      // eslint-disable-next-line no-await-in-loop
      await joinChannel(planning.id, users[username].id);
    }

    // Deliberately excludes @lyle_lanley, @homer_conductor, and
    // @mayor_quimby — the authorization isolation this entry exists to
    // demonstrate. Marge creates it (so she's auto-added), then explicitly
    // adds Ned and Bart.
    const skepticsOnly = await createChannel({ name: 'skeptics-only', type: 'PRIVATE', creatorId: users.marge_skeptic.id, createdAt: t(2700) });
    await addChannelMember(skepticsOnly.id, users.marge_skeptic.id, 'ned_flanders');
    await addChannelMember(skepticsOnly.id, users.marge_skeptic.id, 'bart_simpson');

    console.log(`Channels: #${announcements.name} (PUBLIC), #${planning.name} (PUBLIC), #${skepticsOnly.name} (PRIVATE, marge_skeptic/ned_flanders/bart_simpson only).`);

    // ---- 5. DMs + audit ----
    async function createDirectMessage(userAId, userBId) {
      const [channel] = await db('channels')
        .insert({ workspace_id: null, name: 'Direct Message', type: 'DIRECT', created_at: t(410) })
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
        .insert({ workspace_id: null, name: 'Group Direct Message', type: 'GROUP_DM', created_at: t(155) })
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

    const margeHomerDm = await createDirectMessage(users.marge_skeptic.id, users.homer_conductor.id);
    const skepticsGroupDm = await createGroupDirectMessage(users.marge_skeptic.id, [users.ned_flanders.id, users.bart_simpson.id]);
    console.log('Direct messages: 1 DIRECT (marge_skeptic <-> homer_conductor), 1 GROUP_DM (marge_skeptic/ned_flanders/bart_simpson).');

    // ---- 6. Messages ----
    // insertMessage reuses the exact same service functions
    // routes/messages.js's POST handler calls, synchronously and directly,
    // so entities/mentions land deterministically without needing
    // workers/messageSideEffectsWorker.js running at all. Also enqueues an
    // embedding job per message (real enqueueEmbeddingJob, not inlined) so
    // seeded content is semantically searchable once embeddingWorker.js's
    // already-running poll picks the jobs up — omitting this previously left
    // every seeded message unembedded, silently zeroing out search results
    // scoped to this workspace.
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
      await enqueueEmbeddingJob(db, message.id);
      return message.id;
    }

    // Each channel's script: an ordered list of turns. `replyTo` references
    // an earlier index within the SAME array (flat one-level threading).
    const channelScripts = [
      {
        channel: announcements,
        workspaceId: workspace.id,
        turns: [
          { speaker: 'mayor_quimby', minutesAgo: 2880, content: "Attention citizens: town meeting tonight to discuss how we'll spend the three million dollars from the [[Brake Fluid]] settlement... I mean, the surplus. The surplus." },
          { speaker: 'mayor_quimby', minutesAgo: 2875, content: '7pm sharp. Free snacks. Please attend, we need a quorum.' },
          { speaker: 'lyle_lanley', minutesAgo: 2800, content: 'Wonderful turnout tonight, Springfield! You made the right choice. [[The Monorail]] will put this town on the map.' },
          { speaker: 'lyle_lanley', minutesAgo: 2795, content: 'Construction crew arrives Monday. Get ready to be dazzled.' },
          { speaker: 'mayor_quimby', minutesAgo: 100, content: 'URGENT: Grand opening ceremony moved up to TOMORROW morning. Do not ask me why. Just be there.' },
          { speaker: 'lyle_lanley', minutesAgo: 95, content: "Couldn't have said it better myself, Mayor. See you all at the ribbon cutting. @homer_conductor you're driving, remember?" },
        ],
      },
      {
        channel: planning,
        workspaceId: workspace.id,
        turns: [
          { speaker: 'lyle_lanley', minutesAgo: 2860, content: "Folks, I've got a proposition that's gonna knock your socks off. A [[The Monorail]] running right down [[Main Street]]. @mayor_quimby @marge_skeptic @homer_conductor @ned_flanders you're all gonna want to hear this." },
          { speaker: 'homer_conductor', minutesAgo: 2855, content: 'A monorail? Like the one at the airport? I love those!' },
          { speaker: 'homer_conductor', minutesAgo: 2850, content: "Can I drive it? I've always wanted to wear one of those little conductor hats." },
          { speaker: 'marge_skeptic', minutesAgo: 2820, content: "Wait, doesn't this sound a little familiar? Didn't a man try to sell Ogdenville a monorail last year?" },
          { speaker: 'lyle_lanley', minutesAgo: 2815, content: 'Ogdenville, Ogdenville... doesn\'t ring a bell. Small town, hard to keep track.' },
          { speaker: 'ned_flanders', minutesAgo: 2780, content: "Well shucks, if the Mayor thinks it's a good idea, I don't see the harm. Do you, neighborino?" },
          { speaker: 'marge_skeptic', minutesAgo: 2770, content: 'I do see the harm, actually. Has anyone looked into [[North Haverbrook]]? I heard they got a monorail too.' },
          // --- Thread A root: index 7 ---
          { speaker: 'marge_skeptic', minutesAgo: 2700, content: 'Seriously, does anyone actually know how this monorail is going to be maintained, staffed, and inspected? Because nobody has answered a single one of my questions. @mayor_quimby @lyle_lanley' },
          { speaker: 'mayor_quimby', minutesAgo: 2695, replyTo: 7, content: `Maintenance is, uh, handled. By professionals. Moving on.\n${task(false, 'Get three council votes locked in before the town meeting', 'mayor_quimby')}` },
          { speaker: 'lyle_lanley', minutesAgo: 2690, replyTo: 7, content: "The Mayor's right, Marge. Try not to worry about brake fluid and safety inspections. It's all handled. Trust the process." },
          { speaker: 'ned_flanders', minutesAgo: 2685, replyTo: 7, content: `I can help with a safety checklist if that'd ease everybody's minds!\n${task(true, 'Draft the monorail safety inspection checklist', 'ned_flanders')}` },
          { speaker: 'marge_skeptic', minutesAgo: 2680, replyTo: 7, content: 'Thank you Ned. Somebody around here has to actually think this through.' },
          { speaker: 'homer_conductor', minutesAgo: 1500, content: "Started reading the conductor manual. It's mostly pictures, which is great for me." },
          { speaker: 'marge_skeptic', minutesAgo: 1200, content: "Has anyone found someone who's actually operated a monorail before? Asking again since nobody answered the first three times." },
          { speaker: 'lyle_lanley', minutesAgo: 600, content: 'Ribbon cutting ceremony is almost here, everybody! Get your commemorative pins!' },
          { speaker: 'bart_simpson', minutesAgo: 590, content: "Can I get one even though I think this whole thing is gonna blow up spectacularly? Because I really think it is." },
          { speaker: 'homer_conductor', minutesAgo: 585, content: "Bart, don't jinx it. I already picked out my conductor hat." },
          { speaker: 'marge_skeptic', minutesAgo: 70, content: "This is happening tomorrow and I still don't have a single answer about brake fluid or maintenance. I'm worried." },
          { speaker: 'lyle_lanley', minutesAgo: 65, content: 'Worrying is exhausting, Marge! Save your energy for cheering tomorrow.' },
        ],
      },
      {
        channel: skepticsOnly,
        workspaceId: workspace.id,
        turns: [
          // --- Thread B root: index 0 ---
          { speaker: 'marge_skeptic', minutesAgo: 2698, content: "Okay, just us. I don't trust this Lyle Lanley one bit. I want to find out what really happened in [[North Haverbrook]]." },
          { speaker: 'ned_flanders', minutesAgo: 2693, replyTo: 0, content: `I'll look into the neighboring towns, Marge, happy to help however I can.\n${task(true, 'Look up what happened to North Haverbrook', 'marge_skeptic')}` },
          { speaker: 'bart_simpson', minutesAgo: 2688, replyTo: 0, content: `I'm in just to see this go down. Also:\n${task(false, 'Learn the monorail conductor manual before opening day', 'homer_conductor')}\n@marge_skeptic dad's definitely not gonna read that thing.` },
          { speaker: 'marge_skeptic', minutesAgo: 2683, replyTo: 0, content: `This isn't a joke, Bart. If the brakes fail tomorrow people could get hurt.\n${task(false, 'Stop the ceremony before the first ride if the brakes are not fixed', 'marge_skeptic')}` },
          { speaker: 'ned_flanders', minutesAgo: 50, content: "Marge, I did some digging. North Haverbrook's monorail apparently never even finished construction." },
          { speaker: 'marge_skeptic', minutesAgo: 45, content: "That's exactly what I was afraid of." },
          { speaker: 'bart_simpson', minutesAgo: 40, content: "This is gonna be so good. Bad, I mean. Bad for everyone. But also good television." },
        ],
      },
      {
        channel: margeHomerDm,
        workspaceId: null,
        turns: [
          { speaker: 'marge_skeptic', minutesAgo: 400, content: 'Homer, please reconsider driving that thing tomorrow. I have a bad feeling.' },
          { speaker: 'homer_conductor', minutesAgo: 395, content: "Marge, I've read half the manual. Well, looked at half the pictures." },
          { speaker: 'homer_conductor', minutesAgo: 390, content: "It'll be fine! Lyle seems like a very trustworthy man with a very nice hat." },
          { speaker: 'marge_skeptic', minutesAgo: 385, content: 'That is not the reassurance you think it is.' },
        ],
      },
      {
        channel: skepticsGroupDm,
        workspaceId: null,
        turns: [
          { speaker: 'marge_skeptic', minutesAgo: 150, content: "If Ned's right about North Haverbrook, we need to say something before the ceremony tomorrow." },
          { speaker: 'bart_simpson', minutesAgo: 145, content: 'Or, hear me out, we let it happen and everyone learns a valuable lesson.' },
          { speaker: 'ned_flanders', minutesAgo: 140, content: "Bart! We can't just let people get hurt for a lesson." },
          { speaker: 'marge_skeptic', minutesAgo: 135, content: "Ned's right. @bart_simpson we're trying to stop a disaster, not watch one." },
          { speaker: 'bart_simpson', minutesAgo: 130, content: "Fine, fine. I'll help. But I'm still bringing a camera just in case." },
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
    // the database via the app's own parser/tables, not hand-tallied. ----
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
  console.error('seed-demo-simpsons-workspace failed:', err);
  process.exit(1);
});
