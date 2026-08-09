// The api-client wrapper binds the shared @augmentd-labs/canvas-api-client
// (envelope mode) to the extension's historical contract. These tests pin the
// contract pieces the background scripts depend on: full envelopes coming
// back (sync-engine reads .status/.payload itself), the exact insert/remove
// wire shapes, AuthExpiredError on 401/403, the started-workspace preflight
// cache, and live token pickup after service-worker assigns userToken.

import { strict as assert } from 'node:assert';
import test, { before, beforeEach } from 'node:test';

import { installBrowserStub, resetStorage } from './helpers/browser-stub.js';

installBrowserStub();

let apiClient;
let AuthExpiredError;

// Captured fetch traffic + scripted responses
const calls = [];
let responder;

function envelopeResponse(payload, { status = 200, statusCode, message = 'ok', ...rest } = {}) {
  return new Response(
    JSON.stringify({
      status: rest.errorStatus ? 'error' : 'success',
      statusCode: statusCode ?? status,
      message,
      payload,
      count: Array.isArray(payload) ? payload.length : null,
      totalCount: null,
      ...(rest.code ? { code: rest.code } : {})
    }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

before(async () => {
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return responder(call);
  };
  ({ apiClient, AuthExpiredError } = await import('../src/background/modules/api-client.js'));
});

beforeEach(() => {
  resetStorage();
  calls.length = 0;
  responder = () => envelopeResponse([]);
  apiClient.initialize('http://127.0.0.1:8001/', '/rest/v2', 'tok-ext');
  apiClient.startedWorkspaces.clear();
});

test('returns whole envelopes (sync-engine digs .payload itself) and sends the historical headers', async () => {
  responder = () => envelopeResponse([{ id: 1 }], { message: 'listed' });
  const envelope = await apiClient.getWorkspaces();
  assert.equal(envelope.status, 'success');
  assert.deepEqual(envelope.payload, [{ id: 1 }]);
  assert.equal(envelope.message, 'listed');

  const { url, init } = calls[0];
  assert.equal(url, 'http://127.0.0.1:8001/rest/v2/workspaces');
  assert.equal(init.headers.Authorization, 'Bearer tok-ext');
  assert.equal(init.headers['X-App-Name'], 'canvas-extension');
  assert.equal(init.headers.Accept, 'application/json');
});

test('insertWorkspaceDocuments: body shape and encoded workspace id', async () => {
  const doc = { schema: 'data/schema/tab', data: { url: 'https://x' }, featureArray: ['data/schema/tab'] };
  await apiClient.insertWorkspaceDocuments('my ws', [doc], '/inbox', ['data/schema/tab', 'tag/dev'], 'context');

  // preflight start + insert
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:8001/rest/v2/workspaces/my%20ws/start');
  assert.equal(calls[1].url, 'http://127.0.0.1:8001/rest/v2/workspaces/my%20ws/documents');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    treeNameOrTreeId: 'context',
    treeType: 'context',
    context: '/inbox',
    features: ['data/schema/tab', 'tag/dev'],
    documents: [doc]
  });
});

test('removeWorkspaceDocuments: DELETE with query filters and numeric-id JSON body', async () => {
  await apiClient.removeWorkspaceDocuments('ws1', ['12', 34], '/', ['data/schema/tab'], 'context');

  const del = calls[1];
  const url = new URL(del.url);
  assert.equal(url.pathname, '/rest/v2/workspaces/ws1/documents/remove');
  assert.equal(url.searchParams.get('treeNameOrTreeId'), 'context');
  assert.equal(url.searchParams.get('treeType'), 'context');
  assert.deepEqual(url.searchParams.getAll('allOf'), ['data/schema/tab']);
  assert.equal(del.init.method, 'DELETE');
  assert.deepEqual(JSON.parse(del.init.body), [12, 34]);
  assert.equal(del.init.headers['Content-Type'], 'application/json');
});

test('ensureWorkspaceStarted caches per connection', async () => {
  await apiClient.getWorkspaceDocuments('ws1');
  await apiClient.getWorkspaceDocuments('ws1');
  const starts = calls.filter((c) => c.url.endsWith('/start'));
  assert.equal(starts.length, 1);
  // connection change clears the memo
  apiClient.initialize('http://127.0.0.1:8001', '/rest/v2', 'other-token');
  await apiClient.getWorkspaceDocuments('ws1');
  assert.equal(calls.filter((c) => c.url.endsWith('/start')).length, 2);
});

test('HTTP 401 maps to AuthExpiredError; error envelopes throw with the server message', async () => {
  responder = () => new Response('unauthorized', { status: 401 });
  const err = await apiClient.getWorkspaces().then(
    () => assert.fail('should throw'),
    (e) => e
  );
  assert.ok(err instanceof AuthExpiredError);
  assert.equal(err.status, 401);
  assert.equal(err.name, 'AuthExpiredError');

  responder = () => envelopeResponse(null, { errorStatus: true, status: 200, statusCode: 500, message: 'Canvas exploded' });
  const err2 = await apiClient.getContexts().then(
    () => assert.fail('should throw'),
    (e) => e
  );
  assert.match(err2.message, /Canvas exploded/);
});

test('userToken assignment is picked up without re-initialize (token renewal path)', async () => {
  apiClient.userToken = 'renewed-token';
  await apiClient.getContexts();
  assert.equal(calls[0].init.headers.Authorization, 'Bearer renewed-token');
});

test('getContextDocuments: allOf always includes data/schema/tab, idsOnly only when asked', async () => {
  await apiClient.getContextDocuments('c1', ['tag/work'], { limit: 10, idsOnly: true });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/rest/v2/contexts/c1/documents');
  assert.deepEqual(url.searchParams.getAll('allOf'), ['data/schema/tab', 'tag/work']);
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(url.searchParams.get('idsOnly'), 'true');

  calls.length = 0;
  await apiClient.getContextDocuments('c1');
  const url2 = new URL(calls[0].url);
  assert.equal(url2.searchParams.has('idsOnly'), false);
  assert.equal(url2.searchParams.has('limit'), false);
});
