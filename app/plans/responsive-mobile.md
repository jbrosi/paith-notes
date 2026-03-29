# Responsive / Mobile-Friendly Refactor

## Current State

- Desktop-only layout: no `@media` queries anywhere
- Fixed panel widths: graph (300px), chat (380px)
- Nav bar + nook bar always visible, never collapse
- Three-column flex layout (content | graph | chat) — breaks on narrow screens
- No touch/swipe handling

## Goals

1. Usable on phones (≥ 360px) and tablets (≥ 768px)
2. Nav bars scroll with content instead of staying fixed
3. Toolbar actions collapse into a dropdown/menu on small screens
4. Swipe left/right to switch between views: **Content → Links/Mentions → Graph → Chat**
5. Panels become full-screen views on mobile instead of side columns

---

## Breakpoints

| Token | Width | Target |
|-------|-------|--------|
| `sm` | < 640px | Phones |
| `md` | 640–1024px | Tablets / small laptops |
| `lg` | > 1024px | Desktops (current behavior) |

---

## Phase 1: Foundation

### 1.1 — Scrollable nav bars (all breakpoints)

**Files:** `App.tsx`, `Nav.module.css`

- Remove `overflow: hidden` on the main content wrapper in `App.tsx`
- Make the outer layout a single scrollable column: nav → nook bar → content
- Nav bars scroll away naturally with page content
- On desktop this is a subtle change; on mobile it frees screen real estate

### 1.2 — CSS breakpoint utilities

**Files:** new `src/styles/breakpoints.css` or inline in modules

- Define shared breakpoint values (640px, 1024px) as CSS custom properties or just consistent `@media` usage
- Add a `.sr-only` utility for screen-reader-only labels on icon buttons

### 1.3 — Viewport & touch meta

**Files:** `index.html`

- Already has `width=device-width, initial-scale=1.0` ✓
- Add `user-scalable=yes` (don't block pinch-zoom)
- Add `<meta name="mobile-web-app-capable" content="yes">` for PWA feel

---

## Phase 2: Collapsible Nav

### 2.1 — Nook bar collapse on `sm`

**Files:** `Nav.tsx`, `Nav.module.css`

Currently the nook bar shows: `[+ New] [Type filter ▾] [Search notes ▾] ... [View/Edit] [MD] [Graph] [Chat]`

On `sm`:
- Left group: `[+ New]` stays visible, type filter + search collapse into a **single hamburger/filter icon** that opens a dropdown
- Right group: `[View/Edit]` stays as icon toggle, `[MD]` `[Graph]` `[Chat]` collapse into a **⋯ overflow menu**
- All show/hide driven by **CSS `@media` queries only** — no JS-based breakpoint detection
- Use `display: none` / `display: flex` at breakpoints to toggle visibility
- Overflow menus use CSS `:focus-within` or `<details>`/`<summary>` (native HTML, no JS toggle)

### 2.2 — Top nav collapse on `sm`

**Files:** `Nav.tsx`, `Nav.module.css`

- Nook selector + Home/About links → hamburger menu via `<details>`/`<summary>`
- Keep logout visible (small icon)
- All collapsing via CSS `@media` — no `window.innerWidth` checks in JS

---

## Phase 3: Single-Panel Mobile Layout

### 3.1 — UiContext: active panel state

**Files:** `UiContext.tsx`

Add a new signal:
```ts
activePanel: "content" | "links" | "graph" | "chat"
```

- On `lg`: ignored (panels shown side-by-side as today)
- On `sm`/`md`: only one panel visible at a time, full width
- Persisted to localStorage like other UI state

### 3.2 — NookDefaultLayout responsive

**Files:** `NookDefaultLayout.tsx`, new `NookDefaultLayout.module.css`

**Key principle: all responsive layout changes use CSS `@media` queries, not JS breakpoint detection.**

On `lg` (> 1024px):
- Current behavior: flex row with side panels

On `sm`/`md` (≤ 1024px):
- All panels render in DOM but CSS hides inactive ones (`display: none` via media queries + data attributes)
- `activePanel` signal sets a `data-active-panel` attribute on the layout container
- CSS rules like `[data-active-panel="chat"] .panel-chat { display: flex }` control visibility
- No JS-based `if (window.innerWidth < X)` checks
- Optional: panel indicator dots at bottom

### 3.3 — Panel components go full-width

**Files:** `ChatPanel.module.css`, `NookGraphPanel.tsx`

- Remove fixed widths on `sm`/`md`
- Chat panel: `width: 100%` instead of `380px`
- Graph panel: `width: 100%` instead of `300px`
- Links/mentions panel: extract from NookStatusPanel into its own swipeable view

---

## Phase 4: Swipe Navigation

### 4.1 — Swipe gesture handler

**Files:** new `src/hooks/useSwipe.ts`

Minimal touch handler:
```ts
function useSwipe(el: () => HTMLElement, opts: {
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  threshold?: number; // default 50px
})
```

- Track `touchstart` → `touchend` delta
- Minimum threshold (50px) to avoid accidental swipes
- Ignore vertical swipes (deltaY > deltaX)
- Don't interfere with scrolling

### 4.2 — Wire swipe to panel switching

**Files:** `NookDefaultLayout.tsx`

- Wrap the content area in the swipe handler
- Swipe left → next panel (content → links → graph → chat)
- Swipe right → previous panel
- Only active on `sm`/`md` (CSS hides the swipe indicator; swipe handler uses `matchMedia` listener to enable/disable — the one exception where JS needs screen size, but only for event binding, not layout)
- Visual transition: CSS `transform: translateX()` with `transition` for smooth slide

### 4.3 — Panel indicator

**Files:** `NookDefaultLayout.tsx` or new `PanelIndicator.tsx`

- Small dots at the bottom showing which panel is active
- Tappable to switch directly
- Only visible on `sm`/`md`

---

## Phase 5: Touch & Mobile Polish

### 5.1 — Touch targets

**Files:** various CSS modules

- Ensure all interactive elements are ≥ 44px touch targets on mobile
- Add padding to toolbar buttons, nav items, note list items
- Increase dropdown item height on touch devices

### 5.2 — NotePreview on mobile

**Files:** `NotePreview.tsx`, `NotePreview.module.css`

- On mobile, hover doesn't exist — switch to tap-to-preview
- Long-press on note link → show preview
- Or: show preview inline below the link on tap
- Dismiss on tap outside (already implemented via pointerdown)

### 5.3 — Editor adjustments

**Files:** `EditorSection.tsx`, Milkdown config

- Milkdown toolbar (if visible) should wrap or scroll horizontally
- MentionDropdown should be full-width on mobile
- Keyboard should not obscure the input area (scroll into view)

### 5.4 — Chat input

**Files:** `ChatInput.tsx`, `ChatPanel.module.css`

- Input area sticks to bottom above virtual keyboard
- Send button sized for touch (44px)

---

## Implementation Order

| Step | Effort | Impact | Dependency |
|------|--------|--------|------------|
| 1.1 Scrollable navs | Small | Medium | None |
| 1.2 Breakpoint setup | Small | Foundation | None |
| 3.1 Active panel state | Small | Foundation | None |
| 3.2 Single-panel layout | Medium | High — makes mobile usable | 3.1 |
| 2.1 Nook bar collapse | Medium | High — frees screen space | 1.2 |
| 3.3 Full-width panels | Small | Medium | 3.2 |
| 4.1 Swipe handler | Small | High — native mobile feel | 3.2 |
| 4.2 Wire swipe | Small | High | 4.1, 3.1 |
| 4.3 Panel indicator | Small | Medium — navigation clarity | 3.2 |
| 2.2 Top nav collapse | Small | Medium | 1.2 |
| 5.1 Touch targets | Medium | High — usability | 3.2 |
| 5.2 NotePreview mobile | Small | Medium | 3.2 |
| 5.3 Editor adjustments | Medium | Medium | 3.2 |
| 5.4 Chat input | Small | Medium | 3.3 |

**Suggested order: 1.1 → 1.2 → 3.1 → 3.2 → 2.1 → 3.3 → 4.1 → 4.2 → 4.3 → 5.x**

Start with the layout foundation (scrollable navs, breakpoints, panel state), then the big-impact mobile layout change (single-panel), then progressive enhancement (swipe, collapse, polish).

---

## Out of Scope (for now)

- PWA / service worker / offline support
- Native app wrapper (Capacitor/Tauri)
- Responsive note list sidebar (no sidebar exists — notes are accessed via search dropdown, which already works on mobile)
- Dark mode (separate initiative)
