// Keeps the popup's document cache current from live WebSocket events.
//
// Phase 1 filled this cache when the popup opened, which still left one
// round-trip of stale content per open. Here the service worker maintains it
// while the popup is closed, so an open is a storage read plus a cheap
// confirmation.
//
// The rule throughout: patch only what the payload proves, mark everything else
// stale. A stale entry is still painted instantly — it just forfeits the cheap
// idsOnly confirmation and re-fetches, because a content-only change (a retitled
// tab) leaves the id list identical and would otherwise never repaint.

import { browserStorage } from './browser-storage.js';

// storage.local read-modify-write is not atomic and events arrive in bursts, so
// every mutation goes through one chain.
let mutationQueue = Promise.resolve();

// The mutator receives both halves — the shared document store and the per-path
// indexes — and returns true if it changed either.
function enqueue(mutator) {
  const run = async () => {
    try {
      const store = await browserStorage.getDocumentStore();
      const indexes = await browserStorage.getDocumentIndexes();
      if (mutator(store, indexes)) {
        await browserStorage.setDocumentCaches(store, indexes);
      }
    } catch (error) {
      console.error('Documents cache update failed:', error);
    }
    return true;
  };

  mutationQueue = mutationQueue.then(run, run);
  return mutationQueue;
}

// Path out of the several shapes the server uses for a context/tree selector.
function pathFromSpec(spec) {
  if (!spec) return null;
  if (typeof spec === 'string') return spec;
  if (typeof spec === 'object') return spec.path || spec.contextSpec || null;
  return null;
}

/**
 * Which cached entries does this event touch?
 *
 * Returns a predicate over entries. When the payload doesn't identify a scope we
 * deliberately match everything — over-invalidating costs one refetch, while
 * under-invalidating shows the user wrong tabs.
 */
function scopeMatcher(payload = {}) {
  const contextId = payload.contextId ?? null;
  const workspaceId = payload.workspaceId ?? null;
  const workspaceName = payload.workspaceName ?? null;
  const path = pathFromSpec(payload.contextSpec) ??
    pathFromSpec(payload.context) ??
    pathFromSpec(payload.directorySpec) ??
    pathFromSpec(payload.directory);

  if (!contextId && !workspaceId && !workspaceName) {
    return () => true;
  }

  return (entry) => {
    const scope = entry?.scope;
    if (!scope) return true; // Pre-Phase-2 entry: can't prove it's unaffected.

    if (scope.mode === 'context') {
      return contextId ? scope.id === contextId : true;
    }

    // Explorer entries are workspace + path scoped. A workspace match with a
    // different path is a different result set and stays untouched.
    const workspaceMatches = !workspaceId && !workspaceName
      ? true
      : (scope.id === workspaceId || scope.id === workspaceName);
    if (!workspaceMatches) return false;
    return path ? (scope.path || '/') === path : true;
  };
}

function documentIdsFrom(payload = {}) {
  const ids = [];
  if (payload.id !== undefined && payload.id !== null) ids.push(payload.id);
  if (payload.documentId !== undefined && payload.documentId !== null) ids.push(payload.documentId);
  if (Array.isArray(payload.documentIds)) ids.push(...payload.documentIds);
  if (Array.isArray(payload.ids)) ids.push(...payload.ids);
  return [...new Set(ids.map(String))];
}

// The single document body some events carry, when it's a tab.
function tabDocumentFrom(payload = {}) {
  const doc = payload.document;
  if (!doc || typeof doc !== 'object') return null;
  if (doc.schema && doc.schema !== 'data/schema/tab') return null;
  return doc;
}

function markStale(entry) {
  return { ...entry, stale: true };
}

/**
 * Drop documents from every matching listing — safe with ids alone.
 *
 * The body stays in the store: `removed` means unfiled from this path, not gone,
 * and it is very likely still listed by another path. Eviction is the store's
 * own business.
 */
export function removeDocumentsFromCache(payload) {
  const ids = new Set(documentIdsFrom(payload));
  if (ids.size === 0) return Promise.resolve();
  const matches = scopeMatcher(payload);

  return enqueue((store, indexes) => {
    let changed = false;
    for (const [key, entry] of Object.entries(indexes)) {
      if (!matches(entry) || !Array.isArray(entry.ids)) continue;
      const kept = entry.ids.filter(id => !ids.has(String(id)));
      if (kept.length === entry.ids.length) continue;
      const dropped = entry.ids.length - kept.length;
      indexes[key] = {
        ...entry,
        ids: kept,
        count: kept.length,
        totalCount: Math.max(0, (entry.totalCount ?? kept.length) - dropped)
      };
      changed = true;
    }
    return changed;
  });
}

/**
 * Add a newly inserted document to the first page of every matching entry.
 *
 * Only offset 0, and only with a document body: listings are newest-first, so a
 * new document belongs at the head of page 1 and nowhere else we can compute.
 * Deeper pages all shift by one, which we can't patch — they go stale instead.
 */
export function insertDocumentIntoCache(payload) {
  const doc = tabDocumentFrom(payload);
  const matches = scopeMatcher(payload);

  return enqueue((store, indexes) => {
    let changed = false;

    // Bank the body first, whether or not any listing can place it. It is worth
    // holding on its own: the next path that lists this id renders it for free.
    const projected = doc ? browserStorage.projectDocumentForCache(doc) : null;
    if (projected) {
      store[String(projected.id)] = { ...projected, updatedAt: Date.now() };
      changed = true;
    }

    for (const [key, entry] of Object.entries(indexes)) {
      if (!matches(entry) || !Array.isArray(entry.ids)) continue;

      const canPatch = projected && (entry.offset ?? 0) === 0;
      if (!canPatch) {
        if (entry.stale) continue;
        indexes[key] = markStale(entry);
        changed = true;
        continue;
      }

      const id = String(projected.id);
      if (entry.ids.some(existing => String(existing) === id)) continue;

      const limit = entry.limit || entry.ids.length + 1;
      const ids = [id, ...entry.ids].slice(0, limit);
      indexes[key] = {
        ...entry,
        ids,
        count: ids.length,
        totalCount: (entry.totalCount ?? entry.ids.length) + 1
      };
      changed = true;
    }
    return changed;
  });
}

/**
 * Apply a document update.
 *
 * With a body this is now a one-line write to the store — no index is touched
 * and nothing goes stale, because every path that lists this id reads the same
 * record and is correct the moment it lands. That is the whole payoff of keying
 * bodies by document id instead of by path.
 *
 * Without a body we still can't know what changed, so listings holding that id
 * go stale (an id-list check would call a retitled tab "unchanged").
 */
export function updateDocumentInCache(payload) {
  const doc = tabDocumentFrom(payload);
  const ids = new Set(documentIdsFrom(payload));
  const matches = scopeMatcher(payload);

  return enqueue((store, indexes) => {
    if (doc) {
      const projected = browserStorage.projectDocumentForCache(doc);
      if (!projected) return false;
      store[String(projected.id)] = { ...projected, updatedAt: Date.now() };
      return true;
    }

    let changed = false;
    for (const [key, entry] of Object.entries(indexes)) {
      if (!matches(entry) || !Array.isArray(entry.ids)) continue;

      // Only bother when this listing actually holds one of these ids.
      const holdsDocument = ids.size === 0 ||
        entry.ids.some(existing => ids.has(String(existing)));
      if (!holdsDocument || entry.stale) continue;
      indexes[key] = markStale(entry);
      changed = true;
    }
    return changed;
  });
}

/**
 * Coarse changes — the context moved, its url was set, a whole result set
 * shifted. Nothing about the old page can be trusted position-by-position, so
 * drop the matching entries outright rather than patching them.
 */
export function invalidateCacheScope(payload) {
  const matches = scopeMatcher(payload);
  return enqueue((store, indexes) => {
    let changed = false;
    for (const [key, entry] of Object.entries(indexes)) {
      if (!matches(entry)) continue;
      // Only the listing is wrong. The bodies stay — they are still the same
      // documents, and whatever listing comes next will very likely want them.
      delete indexes[key];
      changed = true;
    }
    return changed;
  });
}

// Event → cache action. Insert/update/remove all fan out to the same handlers
// whether they arrive on the context channel or as the tree.* mirror; the ones
// carrying only ids simply patch less and mark more.
const EVENT_ACTIONS = {
  'document.inserted': insertDocumentIntoCache,
  'document.updated': updateDocumentInCache,
  'document.removed': removeDocumentsFromCache,
  'document.deleted': removeDocumentsFromCache,
  'document.removed.batch': removeDocumentsFromCache,
  'document.deleted.batch': removeDocumentsFromCache,
  // A link changes where a document lives, not what it is — the listings that
  // held it are stale, the body is not. An unlink drops it from this scope.
  'document.linked': updateDocumentInCache,
  'document.linked.batch': updateDocumentInCache,
  'document.unlinked': removeDocumentsFromCache,
  'document.unlinked.batch': removeDocumentsFromCache,
  'tree.document.inserted': insertDocumentIntoCache,
  'tree.document.inserted.batch': insertDocumentIntoCache,
  'tree.document.updated': updateDocumentInCache,
  'tree.document.updated.batch': updateDocumentInCache,
  'tree.document.removed': removeDocumentsFromCache,
  'tree.document.removed.batch': removeDocumentsFromCache,
  'tree.document.deleted': removeDocumentsFromCache,
  'tree.document.deleted.batch': removeDocumentsFromCache,
  'workspace.documents.inserted': insertDocumentIntoCache,
  'workspace.documents.updated': updateDocumentInCache,
  'workspace.documents.removed': removeDocumentsFromCache,
  'workspace.documents.deleted': removeDocumentsFromCache,
  'context.changed': invalidateCacheScope,
  'context.url.set': invalidateCacheScope
};

export const DOCUMENT_CACHE_EVENTS = Object.keys(EVENT_ACTIONS);

export async function applyDocumentEventToCache(eventType, payload = {}) {
  const action = EVENT_ACTIONS[eventType];
  if (!action) return;
  await action(payload || {});
}

export default { applyDocumentEventToCache, DOCUMENT_CACHE_EVENTS };
