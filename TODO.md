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

### Phase 2 — keep the cache warm from the websocket

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

## Phase 3 — restore browser tab state across context switches

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

## Release

- Major version bump for the above: `2.8.6` → `3.0.0`. Three files, no sync
  script — `package.json:3`, `manifest-chromium.json:4`, `manifest-firefox.json:4`.

## Backend features

- Add support for multiple trees
- Add "save website" functionality
  - Default storage backend "workspace" which will create a copy of the website in WORKSPACE_ROOT/data/a/website/<ulid>.html
    - backend concern, blocked by canvas-server, more details in the canvas-server repo
  - Support opening a stored website instead of a live one
  - Codebase should be inspired by https://github.com/gildas-lormeau/singlefile
  - Needs proper UI toggles, bells and whistles
