# TODO

## Not verified in a browser yet

Phases 1–3 (document/tree cache, websocket cache maintenance, tab state restore)
are lint- and build-clean, and the server side of Phase 1 is verified against a
live server. The rest is code-verified only — the browser-side behaviour still
needs these manual passes:

- Cache: open popup with a warm cache and confirm first paint has rows and no
  network wait; switch context/workspace/server and confirm no cross-scope leak;
  mutate documents from another client with the popup closed, reopen, confirm the
  list is correct (Phase 2: correct immediately, no flash).
- Tab restore: mute a tab, place it in a second window, switch context away and
  back — mute and window placement survive; then close that window and switch back
  again, confirming it degrades to a plain open rather than throwing.

## Cache improvements

- A batch get-documents-by-ids endpoint would let the normalized cache fill just
  the gaps when an index only partially resolves, instead of refetching the whole
  page. (Server-side — belongs to canvas-server.)

## Backend features

- Add support for multiple trees
- Add "save website" functionality
  - Default storage backend "workspace" which will create a copy of the website in WORKSPACE_ROOT/data/a/website/<ulid>.html
    - backend concern, blocked by canvas-server, more details in the canvas-server repo
  - Support opening a stored website instead of a live one
  - Codebase should be inspired by https://github.com/gildas-lormeau/singlefile
  - Needs proper UI toggles, bells and whistles
