# Backlog Item 2 Implementation Plan: Double-Bracket Entity Registry & Autocomplete

## Scope

Implement `FEATURE_REQUEST.md` backlog item #2: a workspace-scoped entity registry created from message text tokens shaped as `[[Entity Name]]`, plus composer autocomplete and safe rendering for those entity tokens.

This is a planning artifact only. It intentionally does not implement code.

## Current Codebase Findings

The requested design fits the current architecture well:

- Message creation is centralized in `backend/src/services/messageService.js`, shared by both REST and WebSocket send paths.
- Post-message side effects already live outside `createMessage`: mentions run via `backend/src/services/mentionService.js` and notifications, while semantic search ingestion runs via `enqueueEmbeddingJob`. Entity extraction should follow the same pattern.
- REST sends are handled in `backend/src/routes/messages.js` and WebSocket sends in `backend/src/ws/server.js`; both already have the channel row from `requireChannelMember`, including `channel.workspace_id`.
- Direct and group DM channels can be identified by `channel.workspace_id === null`, so excluding them from the workspace entity registry is straightforward.
- Workspace membership authorization is centralized in `backend/src/authz/membershipService.js`; the entity search endpoint should use `requireWorkspaceMember`.
- Keystroke search rate limiting already has a precedent: `memberSearchLimiter` in `backend/src/auth/rateLimit.js`.
- Feature route mounting currently uses `app.use('/api', messagesRouter)` and similar feature routers in `backend/src/index.js`; an `entitiesRouter` mounted under `/api` is consistent.
- Frontend API helpers are thin wrappers around `apiFetch`; adding `frontend/src/api/entities.js` is consistent with the current pattern.
- `frontend/src/components/ChannelView.jsx` has an existing `@mention` autocomplete flow: trigger detection, 200ms debounce, dropdown listbox, keyboard navigation, click selection, and caret restoration. Entity autocomplete should extend or share this flow.
- `frontend/src/markdown.jsx` already uses a safe ordered tokenizer that returns React nodes, never HTML strings. Entity rendering should add another pass there rather than introducing HTML rendering.
- `frontend/src/markdown.test.jsx` directly inspects returned React nodes, which is the right place for entity rendering tests.
- E2E tests already have `withPgClient` and direct DB assertion precedent in `frontend/e2e/workflows.spec.js`.

## Design Decisions To Preserve

- Entities are scoped to a workspace, not globally unique across the whole app.
- Entity search is available to any workspace member; it should not require owner/manager/system-admin privileges.
- Entity names are ordinary user-generated content, so create/link/search actions are not audited.
- Extraction is best-effort. A parser/upsert failure must be logged and must not block message sending.
- Direct and group DM messages are excluded in v1 because there is no workspace registry to attach to.
- No entity detail page or click behavior ships in v1.

## Implementation Sequence

### 1. Database Migration

Add `database/migrations/0019_entities.js`.

Migration `up` should:

- Enable `pg_trgm` with `CREATE EXTENSION IF NOT EXISTS "pg_trgm"`.
- Create `entities`:
  - `id UUID PRIMARY KEY DEFAULT uuid_generate_v4()`
  - `workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`
  - `canonical_name VARCHAR(255) NOT NULL`
  - `normalized_name VARCHAR(255) NOT NULL`
  - `aliases VARCHAR(255)[] NOT NULL DEFAULT '{}'`
  - `description TEXT NULL`
  - `created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL`
  - `created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()`
  - `updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()`
- Add `UNIQUE (workspace_id, normalized_name)`.
- Add a GIN trigram index on `normalized_name` using `gin_trgm_ops`.
- Create `message_entities`:
  - `message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE`
  - `entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE`
  - `PRIMARY KEY (message_id, entity_id)`
- Add `idx_message_entities_entity` on `message_entities(entity_id)`.
- Grant `SELECT, INSERT, UPDATE, DELETE` on both tables to `APP_DB_USER`, matching recent migrations.

Migration `down` should revoke privileges and drop `message_entities` before `entities`.

Consider adding an `updated_at` trigger only if the codebase already has a reusable trigger pattern by implementation time. Today, plain application-managed `updated_at` is enough because v1 does not edit entities after creation.

### 2. Backend Entity Service

Add `backend/src/services/entityService.js`.

Export:

- `ENTITY_RE = /\[\[([^\[\]]{1,255})\]\]/g`
- `MAX_ENTITIES_PER_MESSAGE = 20`
- `normalizeEntityName(name)`
- `extractEntityNames(content)`
- `linkMessageEntities(db, { content, messageId, workspaceId, createdBy })`

Behavior:

- Extract complete `[[...]]` tokens only.
- Trim, collapse internal whitespace with `\s+`, and lowercase for `normalized_name`.
- Skip empty normalized names.
- De-duplicate by normalized name before DB work.
- Process only the first 20 distinct normalized names.
- For each entity:
  - Prefer an existing row in the same workspace where `normalized_name = ?` or `aliases` contains the normalized token.
  - If none exists, insert `{ workspace_id, canonical_name, normalized_name, created_by }`.
  - Use `ON CONFLICT (workspace_id, normalized_name) DO NOTHING RETURNING id`, then fallback-select by `(workspace_id, normalized_name)` to handle concurrent creation.
- Bulk insert `(message_id, entity_id)` into `message_entities` with `ON CONFLICT DO NOTHING`.

Keep this service free of WebSocket/broadcast knowledge, matching `mentionService.js`.

### 3. Wire Extraction Into Message Send Paths

In `backend/src/routes/messages.js`:

- Import `linkMessageEntities`.
- After message creation and broadcast, call entity linking when `channel.workspace_id` is truthy.
- Wrap the call in `try/catch` and log `Failed to link message entities:` on error.
- Keep mention notification and embedding behavior unchanged.

In `backend/src/ws/server.js`:

- Make the same import and same best-effort call after message creation/broadcast.
- Use `ws.userId` as `createdBy`.
- Skip when `channel.workspace_id` is null.

Open implementation choice: place entity linking before or after mention notifications. Either is acceptable because both are best-effort. Prefer before `enqueueEmbeddingJob` so content-derived relational metadata is attempted before asynchronous semantic ingestion.

### 4. Backend Search Endpoint

Add `backend/src/routes/entities.js` and mount it from `backend/src/index.js` with `app.use('/api', entitiesRouter)`.

Endpoint:

`GET /api/workspaces/:workspaceId/entities/search?q=&limit=`

Authorization and validation:

- `requireAuth` for all routes.
- Validate `workspaceId` with `assertUuid`.
- Gate with `requireWorkspaceMember(db, req.user.id, workspaceId)`.
- `q` optional, coerced to string, max 255 characters.
- `limit` optional, default 8, max 8 with `assertBoundedInt`.
- Add `entitySearchLimiter` in `backend/src/auth/rateLimit.js`, same window/limit/key shape as `memberSearchLimiter` but with key prefix `entity-search:${req.user.id}`.

Query behavior:

- Always filter by `workspace_id`.
- If `q` is empty, return recent or alphabetical entities. Prefer `canonical_name ASC` for deterministic combobox behavior.
- If `q` exists:
  - Normalize it with the same `normalizeEntityName`.
  - Prefix matches should rank first.
  - Then rank by trigram similarity.
  - Return only the requested limit.

Suggested SQL shape via bound `knex.raw` fragments:

```sql
ORDER BY
  CASE WHEN normalized_name ILIKE ? THEN 0 ELSE 1 END,
  similarity(normalized_name, ?) DESC,
  canonical_name ASC
```

Use bound parameters only. Avoid interpolating `q` into raw SQL.

Response shape:

```json
[
  {
    "id": "uuid",
    "canonicalName": "Server Alpha",
    "normalizedName": "server alpha",
    "description": null
  }
]
```

### 5. Backend Tests

Add focused coverage, likely in a new `backend/tests/entities.test.js`.

Required tests:

- First `[[Entity]]` in a workspace channel creates one `entities` row and one `message_entities` row.
- A second mention with different casing/spacing, such as `[[  entity  ]]`, links to the existing entity without duplicating it.
- Two workspaces can each create `[[Same Name]]` and receive separate entity rows.
- A message with more than 20 distinct bracket tokens only processes 20.
- Repeating the same entity in one message creates one `message_entities` row.
- Direct and group DM messages do not create entities.
- Workspace member can search entities.
- Non-member gets 404 from search.
- Overlong `q` gets 400.
- Search results are workspace-scoped and do not leak same-name entities from another workspace.

Also add a direct unit-style test for `normalizeEntityName`/`extractEntityNames` if the service exports them. This will make whitespace/casing behavior easier to lock down without heavy HTTP setup.

### 6. Frontend API Helper

Add `frontend/src/api/entities.js`:

```js
import { apiFetch } from './client.js';

export const searchEntities = (workspaceId, query) => {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const qs = params.toString();
  return apiFetch(`/workspaces/${workspaceId}/entities/search${qs ? `?${qs}` : ''}`);
};
```

### 7. Composer Autocomplete

Modify `frontend/src/components/ChannelView.jsx`.

Current state is mention-specific:

- `mention`
- `mentionDropdownRef`
- `mentionDebounceRef`
- `detectMentionTrigger`
- `acceptMentionSuggestion`
- `handleComposerKeyDown`
- `aria-controls="mention-suggestions"`

Implement entity autocomplete as a sibling state first; refactor shared code only if it stays small and obvious.

Add:

- `ENTITY_DEBOUNCE_MS = 200`, or reuse the existing debounce constant under a neutral name.
- `entity` state shaped like `{ start, query, suggestions, highlightIndex } | null`.
- `entityDropdownRef` and `entityDebounceRef`.
- Cleanup for both debounce refs on unmount.
- Outside-click dismissal that considers both dropdown refs.
- Channel-change cleanup for both states.

Trigger detection:

- Backward-scan from caret for an open `[[`.
- Stop if the scan crosses a newline or finds `]]` before finding the unmatched opener.
- Match partial text after the opener up to 255 characters.
- Reject if the partial token contains `[` or `]`.
- Do not trigger in direct/group DM channels because there is no workspace id.

On composer change:

- Detect mention and entity triggers.
- If both somehow match, prefer the one whose `start` is later.
- Clear the inactive suggestion state.
- Debounce search with `searchEntities(channel.workspaceId, trigger.query)`.
- Preserve the request-shape guard already used for mentions: only apply results if state still matches the same `start` and `query`.

Selection:

- Insert `[[Canonical Name]] ` replacing from the first `[` through the current query.
- Restore caret after the trailing space, using the existing `pendingCaretRef` pattern.

Keyboard:

- Arrow up/down, Enter, Tab, and Escape should operate on whichever suggestion state is active and has suggestions.
- Ensure Enter does not also submit the message when accepting a suggestion.

ARIA:

- The input can keep `role="combobox"`.
- `aria-expanded` should be true when either dropdown has suggestions.
- `aria-controls` and `aria-activedescendant` should point at the active dropdown/option.
- Use distinct IDs such as `entity-suggestions` and `entity-option-${id}`.
- Entity dropdown label should be `Entity suggestions`.

Rendering:

- Reuse `styles.mentionDropdown` and `styles.mentionOption`, but consider renaming to neutral names only if the edit remains scoped.
- Entity rows should show the canonical name. Description can be ignored in v1 unless returned and non-empty.

### 8. Message Rendering

Modify `frontend/src/markdown.jsx`.

Add:

- `ENTITY_RE = /\[\[([^\[\]]{1,255})\]\]/g`
- `styles.entity`
- `styles.entityOnMine`
- `entityToNode`

Style:

- Default entity tag should use existing tokens only, for example:
  - `color: 'var(--brg)'`
  - `background: 'var(--surface-alt)'`
  - `fontWeight: 700`
  - small horizontal padding and `borderRadius: 6`
- `variant: 'mine'` should use `var(--item-active-fg)` and an underline or border treatment for contrast.

Pass ordering:

- Keep links and autolinks first.
- Run entity tokenization after links and before mentions.
- Ensure entity syntax does not consume markdown links.
- Do not parse links inside entity tokens.

If bold/italic content should allow entity highlighting in addition to mention highlighting, rename `processMentionsWithin` to something like `processInlineHighlightsWithin` and apply both entity and mention passes inside bold/italic children. This is optional for v1 unless tests specify nested entity behavior.

### 9. Frontend Tests

Extend `frontend/src/markdown.test.jsx`:

- `[[Server Alpha]]` renders a `span`.
- Entity span uses default entity style.
- Entity span uses on-mine contrast style with `variant: 'mine'`.
- A message containing both `[[Server Alpha]]` and `[docs](https://example.com)` renders one entity span and one anchor.
- A malformed/unclosed entity token remains literal text.
- A token longer than 255 chars remains literal text.
- A mention and entity in the same message both render.

Add `ChannelView` unit tests only if the existing `ChannelView.test.jsx` can exercise trigger helpers without full DOM complexity. If not, leave composer behavior to e2e.

### 10. E2E Coverage

Extend `frontend/e2e/workflows.spec.js`.

Suggested test:

1. Seed a user/workspace/channel with `seedUserWithChannel`.
2. Insert an entity directly with `withPgClient`, or send a setup message `[[Server Alpha]]` through the API and wait for the entity row.
3. Login via UI and open the seeded channel.
4. Type `[[Ser` in the composer.
5. Assert the `Entity suggestions` listbox appears and includes `Server Alpha`.
6. Press Enter or click the suggestion.
7. Assert the composer value becomes `[[Server Alpha]] `.
8. Send the message.
9. Send another message containing `[[ server   alpha ]]`.
10. Query `entities` and assert there is still only one normalized `server alpha` row in that workspace.

Because e2e runs against the real deployed stack, avoid relying on global absence of text. Scope locators to the composer or listbox, following the existing sidebar-scoping lessons in this file.

### 11. Verification Commands

Backend:

```bash
cd backend
npm test -- --runInBand entities.test.js messages.test.js directMessages.test.js ws.test.js
```

Frontend unit tests:

```bash
cd frontend
npm test -- markdown.test.jsx ChannelView.test.jsx
```

Build:

```bash
cd frontend
npx vite build
```

E2E, after the Docker stack is running and migrated:

```bash
cd frontend
npx playwright test e2e/workflows.spec.js
```

If implementation changes dependencies, also run `npm audit` in the changed package directory per `PROJECT_PLAN.md`.

## Risks And Mitigations

- **Race on concurrent first use of an entity**: use unique `(workspace_id, normalized_name)` plus `INSERT ... ON CONFLICT DO NOTHING RETURNING id` and fallback select.
- **Cross-tenant leakage**: every DB query must include `workspace_id`; the endpoint must require workspace membership before search.
- **Message send regression from side-effect failure**: wrap entity linking in `try/catch` exactly like mention notification creation.
- **Autocomplete request races**: keep the existing state-shape guard so older search responses cannot clobber newer input.
- **Markdown collision with links**: links must be tokenized before entity spans, with tests covering `[[Entity]]` next to `[link](url)`.
- **DM ambiguity**: skip extraction and composer search for direct/group DM channels until a separate DM-scoped registry is requested.

## Files Expected To Change During Implementation

- `database/migrations/0019_entities.js`
- `backend/src/services/entityService.js`
- `backend/src/routes/entities.js`
- `backend/src/routes/messages.js`
- `backend/src/ws/server.js`
- `backend/src/auth/rateLimit.js`
- `backend/src/index.js`
- `backend/tests/entities.test.js`
- `frontend/src/api/entities.js`
- `frontend/src/components/ChannelView.jsx`
- `frontend/src/markdown.jsx`
- `frontend/src/markdown.test.jsx`
- `frontend/e2e/workflows.spec.js`

## Out Of Scope

- Entity profile/detail pages.
- Clicking an entity tag to search history.
- Editing canonical names, aliases, or descriptions.
- DM-scoped personal entities.
- Auditing ordinary entity creation/linking.
- Backfilling entities from historical messages.
