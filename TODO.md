# TODO

## Popup document cache (stale-while-revalidate)

**Problem.** Every popup open does a cold server round-trip before it can render
anything. Fetched documents live only in `let canvasTabs = []`
(`src/popup/popup.js:75`), overwritten wholesale by `applyCanvasDocumentResponse()`
(`popup.js:862`), and the popup document is torn down on close — so the list is
re-fetched from scratch each time and the user watches an empty pane until it
lands. Same for the tree ("Loading tree…") and pagination: `canvasPagination`
(`popup.js:82`) is in-memory too, so paging back re-fetches a page we already had.

**Approach.** Cache the last response in `chrome.storage.local` and render it
immediately on open, then revalidate in the background and re-render if changed.
`storage.local`, not a service-worker global — MV3 evicts idle workers. Not
`storage.session` either: it is memory-backed and clears on browser restart,
which is exactly the cold-start we want to cover. (`localStorage` is unavailable
in MV3 workers; everything already goes through `BrowserStorage` /
`StorageManager`, both wrapping `storage.local`.)

**Quota — decided: stay on the default, do NOT request `unlimitedStorage`.**
`storage.local` gives 10 MB in Chrome (5 MB before Chrome 114); Firefox puts it
under the origin quota manager. There is no per-item cap — `QUOTA_BYTES_PER_ITEM`
is `storage.sync` only. Living inside 10 MB is what forces the projection and the
eviction rules below, both of which we want regardless. Revisit only if a real
measurement says otherwise; adding the permission also re-triggers store review.

### Phase 1 — cache + revalidate on open — **DONE**

Landed as described below, with two corrections to the plan:

- The `idsOnly` prerequisite was **not** in `listTreeDocuments()` — that helper is
  directory-tree-only and neither route touches it. Both routes go
  `Context.list()` / `Workspace.list()` → `SynapsD.list()` → **`SynapsD.rank()`**
  (`synapsd/src/index.js`), which was the only place `parse` was honoured. The
  option went there (covering `list`/`query`/`search` at once) plus
  `parseSpec` (`synapsd/src/utils/spec.js`, options are whitelisted), and
  `idsOnly` was added to both route querystrings. Measured on a 200-doc page:
  2.49 MB → 1.5 KB. Covered by `synapsd/tests/list-ids-only.test.js`.
- **Delta hydration was dropped.** There is no batch get-by-ids endpoint, and a
  changed page is a single ≤200-doc fetch — the same one we already did. So
  revalidation is: ids match → nothing; ids differ → re-fetch the page. Phase 2
  makes even that rare.

Also beyond the plan: revalidation failure with cached rows on screen keeps them
rather than blanking the pane, and the service worker clears the cache whenever
sync settings change (they shape the query itself — browser-scoped tag filter,
fetch limit, tree preference — without changing the cache key).

- Add `CANVAS_DOCUMENTS_CACHE: 'canvasDocumentsCache'` to `BrowserStorage.KEYS`
  (`browser-storage.js:20`), defaulting to `{}`, with `get/setDocumentsCache()`
  accessors next to `getTrackedCanvasTabs()` (`browser-storage.js:231`).
- Key each entry by what actually determines the result set, so a context or
  path switch can never show another scope's tabs:
  `${mode}:${context.id ?? workspace.id}:${workspacePath ?? '/'}:${offset}:${limit}`
  — mode/context/workspace from `currentConnection` (`popup.js:72`), path from
  `currentWorkspacePath`, offset/limit from `canvasPagination`.
- **Cache a projection, not the document.** The popup only ever reads four
  fields: `id`, `data.title`, `data.url`, `data.favIconUrl`
  (`popup.js:1385-1415`); Fuse indexes the same set, and
  `markSyncedBrowserTabs()` reads only `doc.data?.url` (`popup.js:903`). So
  `{id, data:{title, url, favIconUrl}}` is lossless for every consumer and drops
  `featureArray` / `metadata` / `schema` / checksums / timestamps — most of the
  bytes. Skip caching `data:` favicon URIs (Chrome returns multi-KB ones for some
  sites); fall back to the existing placeholder icon.
- Store `{ documents, count, totalCount, offset, limit, fetchedAt, serverUrl }`.
  Keep `serverUrl` in the record and drop entries that don't match the active
  connection — switching servers must not surface another server's documents.
- In `loadInitialData()`: read cache → if hit, `applyCanvasDocumentResponse()` +
  `renderCanvasTabs()` right away → revalidate (below) → re-render only on a real
  change, so a normal open doesn't visibly re-flash the list.
- **Revalidate with an ID list, hydrate only the delta.** synapsd already
  supports this: `listTreeDocuments()` takes `idsOnly` and returns
  `{ids, count, totalCount}` without hydrating
  (`src/services/synapsd/src/index.js:2724,2744`), and `getDocumentsByIdArray()`
  (`:3859`) is the hydrate primitive. Diff returned ids against cached ids →
  fetch only what's new/changed. On the common "nothing changed" open that is one
  small response and zero re-render, which also removes the need for a payload
  signature diff.
  - **Prerequisite (server-side):** neither `src/transports/routes/contexts/documents.js`
    nor `.../workspaces/documents.js` exposes `idsOnly` as a query param — add it
    to both route schemas and pass it through to the synapsd call, then plumb it
    through `api-client.js` and the `GET_CANVAS_DOCUMENTS` /
    `GET_WORKSPACE_DOCUMENTS` handlers (`service-worker.js:866,871`).
- Mark the list stale while revalidating (subtle affordance, not a spinner — the
  point is that content is on screen immediately).
- Bound it: cap total entries (~20) and evict oldest by `fetchedAt`; drop entries
  older than a TTL (~24h) rather than rendering them. Clear the whole cache on
  disconnect, logout, server-URL change, and `settings.saved`.
- `markSyncedBrowserTabs(canvasTabs)` (`popup.js:781`) runs off this data, so a
  cache hit also fixes the first-paint flash where synced tabs look unsynced.

### Phase 2 — keep the cache warm from the websocket — **DONE**

`src/background/modules/documents-cache.js` maintains the cache from the events
the service worker already receives. Grounded in what the payloads actually
carry: single `document.inserted` has the full document, `tree.document.*` and
every `.batch` variant carry ids only.

- **Patch what the payload proves, mark the rest stale.** Removals patch from ids
  alone. An insert with a document body patches page 0 (prepend, trim, bump
  totalCount); deeper pages all shift, so they go stale instead. An update with a
  body patches the projection in place.
- **`stale` was needed for a hole in Phase 1**: a content-only change (a retitled
  tab) leaves the id list identical, so the `idsOnly` check would call it
  "unchanged" and never repaint. A stale entry is still painted instantly, it
  just skips the id check and re-fetches.
- Coarse events (`context.changed`, `context.url.set`) delete the matching
  entries rather than patching them. Entries carry their `scope`
  (`{mode, id, path}`) so events match without parsing keys; when a payload
  doesn't identify a scope we over-invalidate deliberately — one refetch beats
  showing another scope's tabs.
- All mutations go through one promise chain: `storage.local` read-modify-write
  is not atomic and these events arrive in bursts.
- **Tree cache done too** (`CANVAS_TREE_CACHE`): painted from cache on open,
  re-rendered only when the fetched tree differs (re-rendering an identical tree
  would collapse the user's expansions), dropped wholesale on any
  `workspace.tree.*` / `directory.*` event.

### Phase 2 — original plan

- Phase 1 still shows stale content for one round-trip. Fix by having the service
  worker maintain the cache instead of the popup only filling it on open.
- `websocket-client.js` already receives the relevant events —
  `document.inserted` / `updated` / `removed` / `deleted` (+ `.batch` variants)
  and the `tree.document.*` mirror, plus `context.changed` / `context.url.set`.
  Apply them to the cached entries for the affected context/path so the cache is
  current even while the popup is closed.
- Invalidate (don't patch) on the coarse events — `context.changed`,
  `context.url.set`, workspace switch — where the whole result set moves.
- With this, a popup open is a cache read plus a cheap confirmation; the
  `idsOnly` revalidation from Phase 1 stays as the correctness backstop for
  missed events and offline gaps.
- Consider extending the same treatment to the tree (`treeData`, `popup.js:88`),
  which has the identical cold-open problem and changes less often.

**Verify:** open popup with a warm cache and confirm first paint has rows and no
network wait; switch context/workspace/server and confirm no cross-scope leak;
mutate documents from another client with the popup closed, reopen, confirm the
list is correct (Phase 2: correct immediately, no flash).

## Phase 3 — restore browser tab state across context switches — **DONE**

Split implemented exactly as decided: `pinned` stays in the document,
`{windowId, index, muted, active, groupId}` live in `storage.local` under
`TAB_SESSION_STATE`, keyed by document id (capped at 500, 30-day TTL, and
cleared on disconnect and server change — document ids are per-server and would
otherwise collide).

- **Capture** in `syncEngine.unloadTabsForContextChange()` — the one choke point
  both close paths (`closeTabsNotInContext`, `closeCurrentTabs`) funnel through,
  and the last moment a tab's placement still exists. Only tabs with a known
  document id are recorded; restore is document-driven, so a tab without one has
  nothing to key on.
- **Restore** in both `openCanvasDocument()` *and* `openCanvasDocuments()` — the
  bulk path is what a context switch actually re-opens through, and it was
  calling `openTab()` directly. Both gotchas avoided: properties go into
  `tabs.create({url, pinned, index, windowId})` rather than being assigned to the
  returned object, and `muted` + grouping are applied afterwards (`mutedInfo` is
  read-only on create). A recorded window is verified with `windows.get` first;
  if it's gone the position is dropped with it, and any placement failure falls
  back to a plain open.
- **`active` is recorded but deliberately not applied**: with several tabs
  restored at once it would just be a fight over focus, and the caller's intent
  (a bulk open shouldn't yank focus) is the better default.
- Legacy documents carrying `data.windowId` from the old version are still
  honoured behind the existing `restoreWindow` option, but never written back.

## Phase 3 — original plan

**Problem.** In bound mode a context switch may close the old tabs and open new
ones; switching back should restore the old set as closely as possible. Today it
cannot: `convertTabToDocument()` (`tab-manager.js:116`) stores only
`{pinned, url, title, favIconUrl, timestamp}`. Mute state, window placement and
tab order are simply not captured anywhere.

**This used to exist.** `stripTabProperties()` in `src/background/utils.ts` at
commit `2e4de35` ("cleanup") — lost in the TS→JS rewrite. Its field list, with
the original intent:

```
id, index, highlighted, active, pinned,
discarded: true,   // hardcoded, NOT tab.discarded — "to conserve memory on restore"
incognito, audible, mutedInfo, url, title, favIconUrl
```

The next generation (`08fea67:src/background/modules/tab-manager.js`) inlined the
same set into `convertTabToDocument` and added `windowId`. Both are worth reading
before reimplementing.

**Two gotchas from that code — do not reintroduce them:**

- The old restore was a no-op. `browserOpenTab()` did `tabs.create({url})` and
  then assigned `["mutedInfo","discarded","active","pinned","title"]` onto the
  returned object, which the browser never reads back. Real restore needs the
  properties passed to `tabs.create({url, pinned, index, windowId, active})`,
  plus `tabs.update(id, {muted})` afterwards — `mutedInfo` is read-only on
  create.
- `windowId` is per-machine and unstable across browser restarts. The old code
  put it in the synced document, which pushes one machine's window ids to the
  server and every other client.

**Split — decided:**

- **In the document (synced):** `pinned`. It is a property of the bookmark, not
  of a session, and it is already there.
- **In `storage.local` (local-only), keyed by document id:** `windowId`, `index`,
  `muted`, `active`, `groupId`. This is per-browser session state; treat restore
  as best-effort and fall back to opening the tab normally when the recorded
  window no longer exists.
- Same discipline as the doc cache: bounded, TTL'd, evicted — it is small per
  entry but unbounded over time, and we are staying inside the default 10 MB.

**Verify:** mute a tab, place it in a second window, switch context away and
back — mute and window placement survive; then close that window and switch back
again, confirming it degrades to a plain open rather than throwing.

## Release — **DONE**

- Major version bump for the above: `2.8.6` → `3.0.0`. Three files, no sync
  script — `package.json:3`, `manifest-chromium.json:4`, `manifest-firefox.json:4`.

## Refresh the sidebar on connect — **DONE**

The sidebar showed "not connected" after a successful connect. `handleConnect()`
only `sendResponse`s, which reaches the settings page that asked — and the
settings page sends `CONNECT` alone, never `SAVE_SETTINGS`, so no
`settings.saved` broadcast followed either. The side panel / sidebar is the same
`popup.html` document with `?host=panel`, but unlike the popup it stays open
across the whole connect, so nothing ever told it to re-read the state.

Fixed by broadcasting `connection.changed` from connect (success *and* failure)
and from disconnect; the popup handles it with `loadInitialData()`. Disconnect
had the same staleness in reverse.

## Normalized cache — id-keyed bodies + id-list indexes — **DONE**

The per-path cache from Phase 1 was wrong about identity. Canvas documents are
content-addressed and a tab's checksum field is its url
(`synapsd/src/index.js`), so the same page filed under `/search`,
`/utils/web/search` and `/design/web/ui` is **one document id linked into three
tree paths**, not three documents. Caching bodies per path stored it three times
and made one edit a three-place patch.

    store:   { [documentId]: projection }   one copy, shared by every path
    indexes: { [scopeKey]: { ids, … } }     what each path/page lists

- **A never-visited path can render with no document fetch.** Ask for its id list
  (`idsOnly`, ~1.5 KB) and resolve it against the store — `/` → `/Library` after
  loading `/` costs one tiny request and zero bodies. This is the case the Phase 1
  notes wrongly called underivable; that was true of the layout, not the problem.
- **An update is one store write.** Every path listing that id is correct at once,
  so content changes no longer mark listings stale and refetch.
- Removal unfiles from the listing but keeps the body — it is almost certainly
  still listed elsewhere. Same for `context.url.set`: drop the listing, keep the
  bodies.
- Resolution is all-or-nothing: an index whose ids don't all resolve returns null
  and the page is fetched. Partial pages are worse than late ones. (A batch
  get-documents-by-ids endpoint would let us fill just the gaps — the one thing
  that would still improve this.)
- Eviction is reference-aware: keep what surviving indexes reference, then spend
  what's left of the budget on the most recently touched *unreferenced* bodies —
  those are what make the next unvisited path free.
- Fetch limit raised 1000 → 2000 (client-side cap, four places). The cache is
  bounded by total documents (6000), not entry count, so a bigger page size costs
  fewer retained pages rather than more bytes.

Covered by `tests/documents-cache.test.js` (13 tests, `npm test`) against a
stubbed `chrome.storage.local` in `tests/helpers/browser-stub.js`: dedup across
three paths, one-update-fixes-all, stale-on-bodyless-update, store-only
hydration, remove/insert patching, scope isolation between contexts, budget
eviction with no dangling ids, and the legacy-blob cleanup on clear.

## Not verified in a browser yet

Phases 1–3 are lint- and build-clean, and the server side of Phase 1 is verified
against a live server. The rest is code-verified only — the browser-side
behaviour still needs the manual passes each phase describes under **Verify**.

## Backend features

- Add support for multiple trees
- Add "save website" functionality
  - Default storage backend "workspace" which will create a copy of the website in WORKSPACE_ROOT/data/a/website/<ulid>.html
    - backend concern, blocked by canvas-server, more details in the canvas-server repo
  - Support opening a stored website instead of a live one
  - Codebase should be inspired by https://github.com/gildas-lormeau/singlefile
  - Needs proper UI toggles, bells and whistles
