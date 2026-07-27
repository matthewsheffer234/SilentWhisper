# Source for the Silent Whisper PDF guides

The three PDFs in `docs/user-guides/` (`Silent-Whisper-User-Guide.pdf`,
`Silent-Whisper-Administrator-Guide.pdf`,
`Silent-Whisper-Quick-Start-Cheat-Sheet.pdf`) are generated from the plain
HTML/CSS in this directory — they are no longer hand-edited binaries.

- `design.css` — shared design system (colors, type, cover/content-page/table/
  callout/cheat-sheet components). Edit this to change the look of all three
  documents at once.
- `user-guide.html`, `admin-guide.html`, `cheat-sheet.html` — the actual
  content, one `<div class="page">` per printed page. Pagination is manual
  (there's no dynamic reflow), so adding a paragraph can push content off the
  bottom of its `.page` silently — always re-render and look at the result
  after an edit (see below), and check the footer's page count against
  `<div class="page">` occurrences if a page count changes.
- `render.sh` — regenerates all three PDFs in place using a headless
  Chromium/Chrome (`--print-to-pdf`). No network access needed; it looks for
  `chromium`/`chromium-browser`/`google-chrome` on `PATH` first, and falls
  back to the Chromium already cached by this repo's Playwright e2e setup
  (`frontend/node_modules`) if none of those are installed.

## Regenerating after an edit

```bash
docs/user-guides/src/render.sh
```

Then open the PDFs (or render pages to PNG with PyMuPDF) and check nothing
overflowed its page before committing.

## Keeping these current

Whenever a change lands that affects a documented workflow or claim in these
guides — a new feature, a changed default, a UI behavior change — update the
relevant page(s) here in the same change, the same way `CHANGELOG.md` gets
updated for every `backend/`/`frontend/`/`scripts/` commit. A stale user-facing
guide is exactly as misleading as a stale changelog, just with a much longer
feedback loop before someone notices.

The front cover of each guide carries a "Built from vX.Y.Z" stamp
(`SILENTWHISPER_VERSION` at the time the guide was last regenerated) — update
it in `user-guide.html`/`admin-guide.html`/`cheat-sheet.html`'s cover markup
whenever you regenerate after a version bump, even if nothing else changed.
