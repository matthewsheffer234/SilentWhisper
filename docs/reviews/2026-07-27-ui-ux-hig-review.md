# Apple macOS HIG UI/UX Audit — 2026-07-27

## 1. Executive Summary & macOS HIG Grade

- Overall macOS HIG Compliance Score: **C / 68%**
- Platform assessed: **macOS desktop only**, assuming a browser-hosted, Electron, or Tauri-style desktop shell. The repository currently exposes a Vite React frontend (`frontend/package.json:1-30`) and no Electron/Tauri window integration, native menu wiring, or title-bar APIs.

### Top 3 systemic desktop design strengths

1. **The app uses a desktop-first split workspace.** A persistent workspace sidebar, central message pane, and optional thread inspector (`frontend/src/components/ChatShell.jsx:1120-1128`) are directionally aligned with macOS split-view productivity apps.
2. **Pointer-visible structure exists.** Rows, cards, and drawer items have hover feedback (`frontend/src/global.css:200-206`), menus are portal-positioned to avoid clipping (`frontend/src/components/Menu.jsx:55-71`), and dense admin/data surfaces use desktop-appropriate tables.
3. **Baseline accessibility is better than average for an internal React app.** The shared `Sheet` has focus management and Escape handling (`frontend/src/components/Sheet.jsx:55-145`), forms are mostly labeled, theme follows system appearance (`frontend/src/context/ThemeContext.jsx:33-39`), and menu/listbox ARIA exists in the custom controls.

### Top 3 major macOS UX liabilities

1. **No macOS window ergonomics.** Sidebars are fixed-width and non-collapsible (`WorkspaceSidebar.jsx:105-114`, `ThreadSidebar.jsx:23-31`), the shell hard-locks the viewport (`ChatShell.jsx:42-43`), and there is no support for title-bar safe regions, sidebar resizing, window restoration, or compact/narrow desktop windows.
2. **No standard Command-key shortcut layer.** Search, new message, new channel/workspace, preferences/settings, close sheet, and navigation all require visible controls or custom local key handling. There is no `metaKey`/Command shortcut implementation anywhere in the frontend search results.
3. **The modal model is too web-like for macOS.** Nearly every secondary workflow opens a centered custom overlay from `ChatShell.jsx:1129-1249`. macOS expects document/window-scoped sheets for short tasks and inspectors/sidebar panels for persistent detail. This app stacks workflow after workflow behind the same dimming overlay pattern.

## 2. High-Severity Issues (Critical macOS HIG Violations)

### Issue 1 — Fixed sidebars with no resize/collapse controls break macOS window ergonomics

- **Location:** `frontend/src/components/WorkspaceSidebar.jsx:105-114`, `frontend/src/components/ThreadSidebar.jsx:23-31`, `frontend/src/components/ChatShell.jsx:42-43`
- **HIG Category:** Desktop Layout
- **Violation:** macOS productivity apps treat sidebars as adjustable structure, not fixed furniture. The workspace sidebar is hardcoded to 260 px and the thread sidebar to 320 px. Users cannot collapse them, resize them, or reclaim horizontal space in smaller windows. This is especially poor for desktop multitasking, Stage Manager, split-screen, and external-monitor window tiling.
- **Remediation Code Snippet:**

```diff
diff --git a/frontend/src/components/WorkspaceSidebar.jsx b/frontend/src/components/WorkspaceSidebar.jsx
@@
-  sidebar: {
-    width: 260,
-    minWidth: 260,
+  sidebar: {
+    width: 'var(--workspace-sidebar-width, 280px)',
+    minWidth: 220,
+    maxWidth: 420,
@@
-    <aside style={styles.sidebar}>
+    <aside className="workspace-sidebar" style={styles.sidebar} aria-label="Workspaces and channels">
```

```diff
diff --git a/frontend/src/components/ThreadSidebar.jsx b/frontend/src/components/ThreadSidebar.jsx
@@
-  sidebar: {
-    width: 320,
-    minWidth: 320,
+  sidebar: {
+    width: 'var(--thread-sidebar-width, 360px)',
+    minWidth: 280,
+    maxWidth: 520,
@@
-    <aside style={styles.sidebar}>
+    <aside className="thread-sidebar" style={styles.sidebar} aria-label="Thread">
```

Add a drag handle between panes and persist widths:

```jsx
function Splitter({ onDrag }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      className="splitter"
      onPointerDown={onDrag}
    />
  );
}
```

```css
.splitter {
  width: 1px;
  cursor: col-resize;
  background: var(--border);
}

.splitter:hover,
.splitter:focus-visible {
  width: 3px;
  background: var(--brg);
}
```

### Issue 2 — The app lacks macOS Command-key shortcuts and menu-equivalent actions

- **Location:** No matches for `metaKey`, `Cmd`, `Command`, `shortcut`, or `hotkey` in `frontend/src`; local keyboard handling exists only inside controls such as `ChannelView.jsx:872-911`, `Menu.jsx:114-133`, and `SearchBar.jsx:199-233`.
- **HIG Category:** Keyboard Navigation
- **Violation:** macOS desktop apps must support keyboard-driven workflows. Search should be `Command-F`, new message can be `Command-N`, preferences/settings should be `Command-,`, Escape/`Command-W` should close panels where appropriate, and sidebar navigation should be reachable without pointer hunting. The current app is pointer-first and web-modal-first.
- **Remediation Code Snippet:**

```diff
diff --git a/frontend/src/components/ChatShell.jsx b/frontend/src/components/ChatShell.jsx
@@
 import { useCallback, useEffect, useRef, useState } from 'react';
@@
   const [newMessageOpen, setNewMessageOpen] = useState(false);
+  const searchInputRef = useRef(null);
@@
+  useEffect(() => {
+    function handleGlobalShortcuts(e) {
+      if (!e.metaKey || e.altKey || e.ctrlKey) return;
+      const key = e.key.toLowerCase();
+      if (key === 'f') {
+        e.preventDefault();
+        searchInputRef.current?.focus();
+      } else if (key === 'n') {
+        e.preventDefault();
+        setNewMessageOpen(true);
+      } else if (key === ',') {
+        e.preventDefault();
+        setAdminPanelOpen(true);
+      } else if (key === 'w') {
+        e.preventDefault();
+        setThreadRoot(null);
+        setAdminPanelOpen(false);
+      }
+    }
+    window.addEventListener('keydown', handleGlobalShortcuts);
+    return () => window.removeEventListener('keydown', handleGlobalShortcuts);
+  }, []);
@@
-      <SearchBar onNavigate={onNavigateToSearchResult} />
+      <SearchBar ref={searchInputRef} onNavigate={onNavigateToSearchResult} />
```

Then wrap `SearchBar` with `forwardRef` and connect it to the input ref. In Electron/Tauri, mirror these actions in the native application menu so users see the shortcuts in the menu bar.

### Issue 3 — Modal overuse replaces macOS inspectors, popovers, and document-scoped sheets

- **Location:** `frontend/src/components/ChatShell.jsx:1129-1249`, `frontend/src/components/Sheet.jsx:20-52`, `frontend/src/components/Sheet.jsx:120-145`
- **HIG Category:** Modals
- **Violation:** The shell opens create forms, channel details, entity details, AI settings, audit log, analytics, password/display-name panels, workspace settings, notifications, digest, and admin panels through the same dimmed centered overlay system. On macOS, frequent full-window dimming is heavy. Persistent details belong in inspectors/sidebars; lightweight option picking belongs in popovers; short blocking tasks can use document-modal sheets.
- **Remediation Code Snippet:**

```diff
diff --git a/frontend/src/components/ChatShell.jsx b/frontend/src/components/ChatShell.jsx
@@
-      {entityDetails && (
-        <EntityDetailsPanel
-          workspaceId={entityDetails.workspaceId}
-          entityId={entityDetails.entity.id}
-          initialEntity={entityDetails.entity}
-          onClose={() => setEntityDetails(null)}
-          onViewContext={handleViewContext}
-        />
-      )}
+      {entityDetails && (
+        <aside className="inspector-panel" aria-label="Entity inspector">
+          <EntityDetailsPanel
+            workspaceId={entityDetails.workspaceId}
+            entityId={entityDetails.entity.id}
+            initialEntity={entityDetails.entity}
+            onClose={() => setEntityDetails(null)}
+            onViewContext={handleViewContext}
+            presentation="inspector"
+          />
+        </aside>
+      )}
```

```css
.inspector-panel {
  width: min(420px, 32vw);
  min-width: 320px;
  border-left: 1px solid var(--border);
  background: var(--surface-alt);
  overflow: auto;
}
```

Keep `Sheet` for create/confirm/password flows. Move entity details, notifications, audit browsing, analytics, and channel details into persistent side panels or separate routed views.

### Issue 4 — The visual system ignores macOS semantic material/color roles

- **Location:** `frontend/src/global.css:27-88`, `frontend/src/global.css:95-183`, repeated hardcoded red/white values in components such as `ConfirmDialog.jsx:31-40`, `SystemAdminPanel.jsx:110-150`, `SearchBar.jsx:75`, `AdminAnalyticsPanel.jsx:87-96`
- **HIG Category:** Desktop Visuals, Dark Mode & System Colors
- **Violation:** The app uses a custom green/gray token set and hardcoded destructive red rather than semantic desktop roles. macOS apps should feel subordinate to content and adapt to light, dark, increased contrast, and vibrancy/material conventions. The current palette is branded but heavy; light-mode neumorphic shadows in `global.css:33-38` make surfaces look raised in a way that is not current macOS.
- **Remediation Code Snippet:**

```diff
diff --git a/frontend/src/global.css b/frontend/src/global.css
@@
 :root, [data-theme="light"] {
+  --color-window-bg: Canvas;
+  --color-sidebar-bg: color-mix(in srgb, Canvas 92%, CanvasText 8%);
+  --color-label: CanvasText;
+  --color-secondary-label: color-mix(in srgb, CanvasText 62%, transparent);
+  --color-separator: color-mix(in srgb, CanvasText 18%, transparent);
+  --color-accent: AccentColor;
+  --color-destructive: #d70015;
@@
-  --card-shadow:      5px 5px 14px rgba(0,0,0,0.10), -3px -3px 8px rgba(255,255,255,0.82);
+  --card-shadow:      none;
@@
-  --input-shadow:     inset 2px 2px 7px rgba(0,0,0,0.09), inset -1px -1px 3px rgba(255,255,255,0.72);
+  --input-shadow:     none;
```

Then migrate component usages from `#c0392b`, `#fff`, `--brg`, and `--text-*` to semantic aliases by role. For desktop wrappers that support it, expose `prefers-contrast` and system accent behavior rather than forcing green everywhere.

### Issue 5 — Icon-only controls lack desktop tooltip affordances

- **Location:** `frontend/src/components/WorkspaceSidebar.jsx:68-102`, `frontend/src/components/WorkspaceSidebar.jsx:534-548`, `frontend/src/components/ChannelView.jsx:975-990`, `frontend/src/components/Sheet.jsx:135-140`
- **HIG Category:** Pointer Interaction
- **Violation:** The app relies on `aria-label` for icon-only buttons, which helps assistive tech but does not help mouse/trackpad users. macOS toolbar and sidebar controls commonly provide tooltips/help tags, especially for icon-only actions like digest, knowledge explorer, admin, details, and close.
- **Remediation Code Snippet:**

```diff
diff --git a/frontend/src/components/WorkspaceSidebar.jsx b/frontend/src/components/WorkspaceSidebar.jsx
@@
       aria-label="Catch Me Up — workspace digest"
+      title="Catch Me Up"
@@
       aria-label="Knowledge Explorer — trending entities"
+      title="Knowledge Explorer"
@@
-          <button type="button" style={styles.adminTrigger} aria-label="Admin" onClick={onOpenAdminPanel}>
+          <button type="button" style={styles.adminTrigger} aria-label="Admin" title="Admin" onClick={onOpenAdminPanel}>
```

Prefer a shared tooltip component over raw `title` for timing, styling, and keyboard focus parity, but `title` is an acceptable first correction.

## 3. Medium & Low-Severity Findings

### macOS Layout & Window Management

- `frontend/src/components/ChatShell.jsx:42-43` uses `height: '100vh'`, `width: '100vw'`, and `overflow: 'hidden'`. For a desktop shell, this creates an app-like canvas, but it also prevents natural document scrolling and can produce awkward clipped states when the window is resized.
- `frontend/src/components/WorkspaceSidebar.jsx:530` uses `<aside>` but does not expose a label. Add `aria-label="Workspaces and channels"`; macOS VoiceOver users need pane-level landmarks.
- `frontend/src/components/WorkspaceHome.jsx:24` centers the workspace overview in a 560 px column. This is readable, but it wastes large desktop windows. Use a split dashboard grid or inspector-style secondary column for tasks and channel metadata.
- `frontend/src/components/SystemAdminPanel.jsx:716-717` uses `width={760}` and `maxHeight="86vh"`. That is a web modal size, not a macOS panel strategy. Admin should be a real routed view or separate resizable management window in an Electron/Tauri shell.
- `frontend/src/components/Menu.jsx:55-71` positions menus using a fixed 220 px viewport clamp. It does not flip above the trigger or align to trailing edges like macOS pull-down menus. The menu will be awkward near the right or bottom edge.

### Keyboard Navigation & Pointer Interaction

- There is no command shortcut registry. Search should be `Command-F`, new message/workspace/channel should have menu equivalents, preferences should be `Command-,`, Escape should close the frontmost transient surface, and thread/details panels should support `Command-W`.
- `frontend/src/components/Menu.jsx:114-133` implements arrow/Home/End/Escape, which is good. It does not support type-ahead selection, a standard desktop menu expectation.
- `frontend/src/components/SearchBar.jsx:199-233` handles arrows, Enter, and Escape. It does not expose a visible shortcut hint or `Command-F` integration, and search result rows are clickable `div`s rather than focusable native controls.
- `frontend/src/components/WorkspaceSidebar.jsx:591-620` and `frontend/src/components/WorkspaceSidebar.jsx:689-713` use `div role="button"` list rows with nested real buttons. On desktop this produces unclear click regions and can complicate focus order. Use real listbox/tree/navigation semantics or split primary row buttons from accessory buttons.
- `frontend/src/components/PresenceBadge.jsx` is one of the only places using `title`. Tooltips are otherwise absent despite many icon-only controls.
- No custom context menus exist for messages, channels, workspaces, or admin rows. macOS users expect right-click/Control-click for actions such as reply, edit, copy link, mark read, channel settings, archive, and manage members.

### Desktop Visuals, Dark Mode & System Colors

- `frontend/src/global.css:20` and `frontend/src/global.css:78` correctly use `-apple-system` first. That is the right foundation for SF Pro on macOS.
- `frontend/src/context/ThemeContext.jsx:33-39` supports System/Light/Dark. This is good desktop behavior, but the actual colors are custom tokens rather than semantic system colors.
- `frontend/src/global.css:33-38` uses raised and inset shadows in light mode. macOS desktop UI should usually rely on hierarchy, translucency/materials where native, separators, and selection states, not faux-physical extrusion.
- `frontend/src/global.css:245-247` forces 4 px scrollbars. macOS overlay scrollbars are system-controlled and user-configurable. Custom scrollbars risk making the app feel non-native.
- `frontend/src/components/ChannelView.jsx:105-118` uses a green bordered pill for AI actions. This is visually loud for a toolbar action. macOS toolbar items usually use restrained icon/text controls, not branded capsule buttons unless the action is primary.
- Hardcoded title case is widespread: "Sign In", "Change Password", "Display Name", "Manage Users", "New Message". macOS buttons and menu items generally use concise, consistent capitalization; current copy feels inconsistent between web SaaS and desktop app.

### Accessibility & Desktop Density

- Dense tables in `SystemAdminPanel.jsx`, `UserManagementPanel.jsx`, `OrgManagementPanel.jsx`, `AuditDashboard.jsx`, and `AdminAnalyticsPanel.jsx` are desktop-appropriate in principle, but several use tiny `--text-xs` text for headers, metadata, and controls. Desktop density is not an excuse for illegibility.
- `frontend/src/components/AuditDashboard.jsx:31` sets the whole audit table to `--text-xs`. Audit logs are high-stakes data; microscopic typography increases error risk.
- `frontend/src/components/WorkspaceSidebar.jsx:549-552` renders unread count visually, but the user menu accessible name remains generic. Include unread state in the button label.
- `frontend/src/components/ChannelView.jsx:546-549` and `ThreadSidebar.jsx:117-129` render initial avatars as text. If decorative, hide them from VoiceOver; if informative, label them with the sender.
- `frontend/src/components/Sheet.jsx:77-80` uses `window.confirm` for dirty-form discard confirmation. That is a browser primitive and looks completely non-native inside a desktop-styled app. Use the shared `ConfirmDialog` or wrapper-native alert APIs in Electron/Tauri.
- Focus rings are present (`global.css:249-268`), but there is no high-contrast media query. Add `@media (prefers-contrast: more)` to strengthen separators, focus, and selection states.

## 4. Priority Remediation Checklist

- [ ] Add resizable and collapsible workspace/thread sidebars with persisted widths and keyboard-accessible splitters.
- [ ] Implement a global macOS shortcut layer: `Command-F`, `Command-N`, `Command-,`, `Command-W`, Escape frontmost close, and next/previous conversation navigation.
- [ ] If wrapped in Electron/Tauri, expose the same actions through the native macOS menu bar.
- [ ] Replace modal-heavy detail workflows with persistent inspectors or routed management views; keep sheets for short, blocking tasks only.
- [ ] Convert high-frequency icon-only controls to shared tooltip/help-tag behavior for pointer and keyboard focus.
- [ ] Replace fixed green/gray visual tokens with semantic desktop color aliases and remove repeated hardcoded destructive colors.
- [ ] Remove faux-neumorphic input/card shadows and custom scrollbar styling that fights macOS conventions.
- [ ] Add right-click/Control-click context menus for message, channel, workspace, and admin row actions.
- [ ] Improve menu behavior with edge flipping, trailing alignment, and type-ahead selection.
- [ ] Add pane landmarks and accessible names for sidebars, inspectors, and major regions.
- [ ] Replace `window.confirm` with app-styled or wrapper-native confirmation dialogs.
- [ ] Add `prefers-contrast: more` styling for focus rings, separators, destructive states, and selected rows.
