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

### Phase 1 — cache + revalidate on open

- Add `CANVAS_DOCUMENTS_CACHE: 'canvasDocumentsCache'` to `BrowserStorage.KEYS`
  (`browser-storage.js:20`), defaulting to `{}`, with `get/setDocumentsCache()`
  accessors next to `getTrackedCanvasTabs()` (`browser-storage.js:231`).
- Key each entry by what actually determines the result set, so a context or
  path switch can never show another scope's tabs:
  `${mode}:${context.id ?? workspace.id}:${workspacePath ?? '/'}:${offset}:${limit}`
  — mode/context/workspace from `currentConnection` (`popup.js:72`), path from
  `currentWorkspacePath`, offset/limit from `canvasPagination`.
- Store `{ documents, count, totalCount, offset, limit, fetchedAt, serverUrl }`.
  Keep `serverUrl` in the record and drop entries that don't match the active
  connection — switching servers must not surface another server's documents.
- In `loadInitialData()`: read cache → if hit, `applyCanvasDocumentResponse()` +
  `renderCanvasTabs()` right away → fire the normal
  `GET_CANVAS_DOCUMENTS`/`GET_WORKSPACE_DOCUMENTS` → on response, write the cache
  and re-render only if the payload differs (compare a cheap signature: doc count
  + joined ids + `updatedAt`s) to avoid a visible re-flash on every open.
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
- With this, a popup open is a cache read plus a cheap confirmation; revalidation
  from Phase 1 stays as the correctness backstop for missed events / offline gaps.
- Consider extending the same treatment to the tree (`treeData`, `popup.js:88`),
  which has the identical cold-open problem and changes less often.

**Verify:** open popup with a warm cache and confirm first paint has rows and no
network wait; switch context/workspace/server and confirm no cross-scope leak;
mutate documents from another client with the popup closed, reopen, confirm the
list is correct (Phase 2: correct immediately, no flash).

## Backend features

- Add support for multiple trees
- Add "save website" functionality
  - Default storage backend "workspace" which will create a copy of the website in WORKSPACE_ROOT/data/a/website/<ulid>.html
    - backend concern, blocked by canvas-server, more details in the canvas-server repo
  - Support opening a stored website instead of a live one
  - Codebase should be inspired by https://github.com/gildas-lormeau/singlefile
  - Needs proper UI toggles, bells and whistles
