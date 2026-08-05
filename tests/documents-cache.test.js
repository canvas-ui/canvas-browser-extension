// The popup's document cache is normalized, because Canvas documents are
// content-addressed: a tab's checksum field is its url, so the same page filed
// under several tree paths is ONE document id linked into each of them. Bodies
// are therefore keyed by document id and shared; each path/page stores only an
// id list.
//
// These tests pin the behaviour that follows from that, none of which is
// observable without running the code: cross-path dedup, one-update-fixes-all,
// hydrating a never-visited path from the store alone, and eviction that never
// leaves an index pointing at a body that is gone.

import { strict as assert } from 'node:assert';
import test, { before, beforeEach } from 'node:test';

import { installBrowserStub, resetStorage } from './helpers/browser-stub.js';

installBrowserStub();

let browserStorage;
let cacheEvents;

before(async () => {
  ({ browserStorage } = await import('../src/background/modules/browser-storage.js'));
  cacheEvents = await import('../src/background/modules/documents-cache.js');
});

beforeEach(() => {
  resetStorage();
  browserStorage.DOCUMENTS_CACHE_MAX_DOCUMENTS = 6000;
  browserStorage.DOCUMENTS_CACHE_MAX_ENTRIES = 20;
});

const SERVER = 'https://canvas.local';

const tab = (id, title, url) => ({
  id,
  schema: 'data/schema/tab',
  data: { title, url, favIconUrl: `https://${url}/f.ico` }
});

const keyFor = (path, offset = 0) => browserStorage.documentsCacheKey({
  mode: 'explorer', workspaceId: 'universe', workspacePath: path, offset, limit: 200
});

async function cachePath(path, documents, extra = {}) {
  return await browserStorage.setCachedDocuments(keyFor(path, extra.offset ?? 0), {
    documents,
    count: documents.length,
    totalCount: extra.totalCount ?? documents.length,
    offset: extra.offset ?? 0,
    limit: 200,
    serverUrl: SERVER,
    scope: { mode: 'explorer', id: 'universe', path }
  });
}

const PATHS = ['/search', '/utils/web/search', '/design/web/ui'];

test('one document filed in several paths is stored once', async () => {
  const google = tab(1, 'Google', 'google.com');
  for (const path of PATHS) {
    await cachePath(path, [google, tab(100 + path.length, 'Other', `other${path.length}.com`)]);
  }

  const store = await browserStorage.getDocumentStore();
  const indexes = await browserStorage.getDocumentIndexes();

  assert.ok(store['1'], 'shared document is in the store');
  assert.equal(Object.keys(indexes).length, PATHS.length, 'one index per path');
  for (const path of PATHS) {
    assert.ok(indexes[keyFor(path)].ids.includes('1'), `${path} lists the shared id`);
    assert.equal(indexes[keyFor(path)].documents, undefined, 'indexes hold ids, not bodies');
  }
});

test('a cached listing resolves back into full documents', async () => {
  await cachePath('/search', [tab(1, 'Google', 'google.com'), tab(2, 'Other', 'other.com')]);

  const resolved = await browserStorage.getCachedDocuments(keyFor('/search'), SERVER);
  assert.equal(resolved.documents.length, 2);
  assert.equal(resolved.documents[0].data.title, 'Google');
  assert.equal(resolved.documents[0].data.url, 'google.com');
  assert.equal(resolved.stale, false);
});

test('a listing from another server is never served', async () => {
  await cachePath('/search', [tab(1, 'Google', 'google.com')]);
  assert.equal(await browserStorage.getCachedDocuments(keyFor('/search'), 'https://elsewhere'), null);
});

test('one update fixes every path that lists the document', async () => {
  const google = tab(1, 'Google', 'google.com');
  for (const path of PATHS) await cachePath(path, [google]);

  await cacheEvents.applyDocumentEventToCache('document.updated', {
    workspaceId: 'universe',
    document: { id: 1, schema: 'data/schema/tab', data: { title: 'Google (renamed)', url: 'google.com' } }
  });

  for (const path of PATHS) {
    const resolved = await browserStorage.getCachedDocuments(keyFor(path), SERVER);
    assert.equal(resolved.documents[0].data.title, 'Google (renamed)', `${path} sees the new title`);
    // The whole point of the shared body: no listing needs refetching for this.
    assert.equal(resolved.stale, false, `${path} was not marked stale`);
  }
});

test('an update with no document body marks holding listings stale', async () => {
  await cachePath('/search', [tab(1, 'Google', 'google.com')]);
  await cachePath('/design/web/ui', [tab(2, 'Other', 'other.com')]);

  await cacheEvents.applyDocumentEventToCache('tree.document.updated', {
    workspaceId: 'universe', documentId: 1
  });

  const holding = await browserStorage.getCachedDocuments(keyFor('/search'), SERVER);
  const notHolding = await browserStorage.getCachedDocuments(keyFor('/design/web/ui'), SERVER);
  assert.equal(holding.stale, true, 'listing holding the id must revalidate in full');
  assert.equal(notHolding.stale, false, 'unrelated listing is untouched');
});

test('a never-visited path hydrates from the store alone', async () => {
  await cachePath('/', [tab(1, 'Google', 'google.com'), tab(2, 'Docs', 'docs.com')]);

  // What the popup does for a path with no cached index: fetch ids, resolve local.
  const documents = await browserStorage.resolveCachedDocumentIds(['2', '1']);
  assert.equal(documents.length, 2);
  assert.equal(documents[0].data.title, 'Docs', 'resolution follows the requested id order');

  // All-or-nothing: a partial page is worse than a late one.
  assert.equal(await browserStorage.resolveCachedDocumentIds(['1', '9999']), null);
});

test('removal unfiles from the listing but keeps the body for other paths', async () => {
  const google = tab(1, 'Google', 'google.com');
  await cachePath('/search', [google, tab(2, 'Other', 'other.com')]);
  await cachePath('/design/web/ui', [google]);

  await cacheEvents.applyDocumentEventToCache('document.removed', {
    workspaceId: 'universe', contextSpec: '/search', documentIds: [1]
  });

  const search = await browserStorage.getCachedDocuments(keyFor('/search'), SERVER);
  assert.ok(!search.documents.some(doc => String(doc.id) === '1'), 'dropped from /search');
  assert.equal(search.totalCount, 1, 'totalCount follows the removal');

  const design = await browserStorage.getCachedDocuments(keyFor('/design/web/ui'), SERVER);
  assert.ok(design.documents.some(doc => String(doc.id) === '1'), 'still listed by the other path');
  assert.equal((await browserStorage.resolveCachedDocumentIds(['1'])).length, 1, 'body retained');
});

test('an insert lands on page 0 and marks deeper pages stale', async () => {
  await cachePath('/inbox', [tab(10, 'A', 'a.com')], { totalCount: 300 });
  await cachePath('/inbox', [tab(11, 'B', 'b.com')], { totalCount: 300, offset: 200 });

  await cacheEvents.applyDocumentEventToCache('document.inserted', {
    workspaceId: 'universe', contextSpec: '/inbox',
    document: { id: 12, schema: 'data/schema/tab', data: { title: 'New', url: 'new.com' } }
  });

  const page0 = await browserStorage.getCachedDocuments(keyFor('/inbox', 0), SERVER);
  assert.equal(String(page0.documents[0].id), '12', 'newest first');
  assert.equal(page0.totalCount, 301);

  // Every deeper page shifts by one, which we can't patch — so it refetches.
  const page1 = await browserStorage.getCachedDocuments(keyFor('/inbox', 200), SERVER);
  assert.equal(page1.stale, true);
});

test('an insert banks the body even when no listing can place it', async () => {
  await cachePath('/inbox', [tab(10, 'A', 'a.com')], { totalCount: 300, offset: 200 });

  await cacheEvents.applyDocumentEventToCache('document.inserted', {
    workspaceId: 'universe', contextSpec: '/inbox',
    document: { id: 12, schema: 'data/schema/tab', data: { title: 'New', url: 'new.com' } }
  });

  // Held for whichever path lists it next, even though no cached page took it.
  assert.equal((await browserStorage.resolveCachedDocumentIds(['12'])).length, 1);
});

test('context.url.set drops the listing and keeps the bodies', async () => {
  const key = browserStorage.documentsCacheKey({
    mode: 'context', contextId: 'ctx1', workspacePath: '/a', offset: 0, limit: 200
  });
  await browserStorage.setCachedDocuments(key, {
    documents: [tab(20, 'Keep', 'keep.com')],
    count: 1, totalCount: 1, offset: 0, limit: 200, serverUrl: SERVER,
    scope: { mode: 'context', id: 'ctx1', path: '/a' }
  });

  await cacheEvents.applyDocumentEventToCache('context.url.set', { contextId: 'ctx1', url: '/b' });

  assert.equal(Object.keys(await browserStorage.getDocumentIndexes()).length, 0, 'listing dropped');
  assert.equal((await browserStorage.resolveCachedDocumentIds(['20'])).length, 1, 'body kept for reuse');
});

test('a context event leaves another context\'s listing alone', async () => {
  const keyOf = (contextId) => browserStorage.documentsCacheKey({
    mode: 'context', contextId, workspacePath: '/a', offset: 0, limit: 200
  });
  for (const contextId of ['ctx1', 'ctx2']) {
    await browserStorage.setCachedDocuments(keyOf(contextId), {
      documents: [tab(30, 'T', 't.com')],
      count: 1, totalCount: 1, offset: 0, limit: 200, serverUrl: SERVER,
      scope: { mode: 'context', id: contextId, path: '/a' }
    });
  }

  await cacheEvents.applyDocumentEventToCache('context.changed', { contextId: 'ctx1' });

  const indexes = await browserStorage.getDocumentIndexes();
  assert.equal(indexes[keyOf('ctx1')], undefined, 'target context dropped');
  assert.ok(indexes[keyOf('ctx2')], 'other context untouched');
});

// Writes here land inside a single millisecond, which is the point: it pins the
// tiebreak. Sorting on fetchedAt alone leaves them tied, and a stable sort then
// ranks the oldest first and evicts the page the user is on.
test('eviction stays inside the budget and never leaves a dangling id', async () => {
  browserStorage.DOCUMENTS_CACHE_MAX_DOCUMENTS = 10;
  browserStorage.DOCUMENTS_CACHE_MAX_ENTRIES = 3;

  for (let page = 0; page < 5; page++) {
    const documents = Array.from({ length: 4 }, (_, i) => tab(page * 100 + i, `T${i}`, `p${page}-${i}.com`));
    await cachePath(`/p${page}`, documents);
  }

  const store = await browserStorage.getDocumentStore();
  const indexes = await browserStorage.getDocumentIndexes();

  assert.ok(Object.keys(indexes).length <= 3, 'index cap respected');
  assert.ok(Object.keys(store).length <= 10, 'document budget respected');
  assert.ok(indexes[keyFor('/p4')], 'the newest listing survives');

  for (const [key, entry] of Object.entries(indexes)) {
    for (const id of entry.ids) {
      assert.ok(store[String(id)], `${key} references a body that still exists`);
    }
    assert.notEqual(await browserStorage.getCachedDocuments(key, SERVER), null, `${key} fully resolves`);
  }
});

test('clearing drops both halves and the pre-normalization blob', async () => {
  await cachePath('/search', [tab(1, 'Google', 'google.com')]);
  await chrome.storage.local.set({ canvasDocumentsCache: { legacy: true } });

  await browserStorage.clearDocumentsCache();

  assert.deepEqual(await browserStorage.getDocumentStore(), {});
  assert.deepEqual(await browserStorage.getDocumentIndexes(), {});
  const legacy = await chrome.storage.local.get('canvasDocumentsCache');
  assert.equal(legacy.canvasDocumentsCache, undefined, 'legacy blob removed');
});
