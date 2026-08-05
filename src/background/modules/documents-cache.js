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

function enqueue(mutator) {
  const run = async () => {
    try {
      const cache = await browserStorage.getDocumentsCache();
      const next = mutator(cache);
      if (next) await browserStorage.setDocumentsCache(next);
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

/** Drop documents from every matching entry — safe with ids alone. */
export function removeDocumentsFromCache(payload) {
  const ids = new Set(documentIdsFrom(payload));
  if (ids.size === 0) return Promise.resolve();
  const matches = scopeMatcher(payload);

  return enqueue((cache) => {
    let changed = false;
    for (const [key, entry] of Object.entries(cache)) {
      if (!matches(entry) || !Array.isArray(entry.documents)) continue;
      const kept = entry.documents.filter(doc => !ids.has(String(doc.id)));
      if (kept.length === entry.documents.length) continue;
      const dropped = entry.documents.length - kept.length;
      cache[key] = {
        ...entry,
        documents: kept,
        count: kept.length,
        totalCount: Math.max(0, (entry.totalCount ?? kept.length) - dropped)
      };
      changed = true;
    }
    return changed ? cache : null;
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

  return enqueue((cache) => {
    let changed = false;
    for (const [key, entry] of Object.entries(cache)) {
      if (!matches(entry) || !Array.isArray(entry.documents)) continue;

      const canPatch = doc && (entry.offset ?? 0) === 0;
      if (!canPatch) {
        if (entry.stale) continue;
        cache[key] = markStale(entry);
        changed = true;
        continue;
      }

      if (entry.documents.some(existing => String(existing.id) === String(doc.id))) continue;

      const projected = browserStorage.projectDocumentForCache(doc);
      if (!projected) continue;

      const limit = entry.limit || entry.documents.length + 1;
      const documents = [projected, ...entry.documents].slice(0, limit);
      cache[key] = {
        ...entry,
        documents,
        count: documents.length,
        totalCount: (entry.totalCount ?? entry.documents.length) + 1
      };
      changed = true;
    }
    return changed ? cache : null;
  });
}

/**
 * Apply a document update. With a body we patch the projection in place; without
 * one the entry goes stale — the id list is unchanged, so nothing else would
 * catch a retitled tab.
 */
export function updateDocumentInCache(payload) {
  const doc = tabDocumentFrom(payload);
  const ids = new Set(documentIdsFrom(payload));
  const matches = scopeMatcher(payload);

  return enqueue((cache) => {
    let changed = false;
    for (const [key, entry] of Object.entries(cache)) {
      if (!matches(entry) || !Array.isArray(entry.documents)) continue;

      if (doc) {
        const index = entry.documents.findIndex(existing => String(existing.id) === String(doc.id));
        if (index === -1) continue;
        const projected = browserStorage.projectDocumentForCache(doc);
        if (!projected) continue;
        const documents = [...entry.documents];
        documents[index] = projected;
        cache[key] = { ...entry, documents };
        changed = true;
        continue;
      }

      // No body: only bother when the entry actually holds one of these ids.
      const holdsDocument = ids.size === 0 ||
        entry.documents.some(existing => ids.has(String(existing.id)));
      if (!holdsDocument || entry.stale) continue;
      cache[key] = markStale(entry);
      changed = true;
    }
    return changed ? cache : null;
  });
}

/**
 * Coarse changes — the context moved, its url was set, a whole result set
 * shifted. Nothing about the old page can be trusted position-by-position, so
 * drop the matching entries outright rather than patching them.
 */
export function invalidateCacheScope(payload) {
  const matches = scopeMatcher(payload);
  return enqueue((cache) => {
    let changed = false;
    for (const [key, entry] of Object.entries(cache)) {
      if (!matches(entry)) continue;
      delete cache[key];
      changed = true;
    }
    return changed ? cache : null;
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
