// API Client module for Canvas Extension
// REST transport comes from the shared workspace client (@augmentd-labs/
// canvas-api-client) in envelope mode (unwrap:false): success envelopes are
// returned whole because sync-engine/service-worker call sites still read
// `.status` / `.payload` themselves. This module keeps the extension-specific
// policy: Firefox local-network fetch modes, the 10s budget, AuthExpiredError
// mapping, the started-workspace preflight cache, and the endpoint surface
// the background scripts actually consume.

import { CanvasApiClient as CanvasHttpClient, CanvasError, isNetworkError } from '@augmentd-labs/canvas-api-client';
import { routes, decodeJwtPayload, getJwtExpiryMs } from '@augmentd-labs/canvas-protocol';

import { browserStorage } from './browser-storage.js';

// Token helpers live in @augmentd-labs/canvas-protocol now; re-exported so
// service-worker.js keeps importing them from here.
export { decodeJwtPayload, getJwtExpiryMs };

export class AuthExpiredError extends Error {
  constructor(status) {
    super(`HTTP ${status}: session expired`);
    this.name = 'AuthExpiredError';
    this.status = status;
  }
}

const DEFAULT_WORKSPACE_TREE_NAME = 'context';
const REQUEST_TIMEOUT_MS = 10000;

// Our tree ref is the tree *type* ('context' | 'directory'). Sending treeType
// explicitly lets the server pick the right selector without name-detection
// (older servers only branch on treeType, and a name-only path falls through to
// the context tree → "Tree is not a context tree: directory").
const WORKSPACE_TREE_TYPES = new Set(['context', 'directory']);
function treeTypeFromRef(ref) {
  return WORKSPACE_TREE_TYPES.has(ref) ? ref : undefined;
}

const isFirefoxRuntime = () => typeof browser !== 'undefined' && !!browser.runtime;
const isLocalNetworkUrl = (url) =>
  !!url && (url.includes('127.0.0.1') || url.includes('172.16.') || url.includes('192.168.') || url.includes('10.'));

/**
 * Fetch wrapper injected into the shared client. Applies the historical
 * Firefox/local-network mode handling and logs request timing (console.* is
 * dropped from production bundles by esbuild).
 */
function extensionFetch(url, init = {}) {
  const target = String(url);
  const isFirefox = isFirefoxRuntime();
  const isLocalNetwork = isLocalNetworkUrl(target);

  const options = { ...init };
  if (isFirefox && isLocalNetwork) {
    // Firefox: no CORS mode, no credentials for local network
    options.mode = 'no-cors';
    options.credentials = 'omit';
  } else if (!isLocalNetwork) {
    // Remote servers: use CORS mode
    options.mode = 'cors';
  }
  // Local network in Chrome: no mode specified (default behavior)

  const startedAt = performance.now();
  console.log(`API Request: ${options.method || 'GET'} ${target}`, { mode: options.mode, isFirefox, isLocalNetwork });
  return fetch(target, options).then((response) => {
    console.info(`API Timing: ${options.method || 'GET'} ${target} ${Math.round(performance.now() - startedAt)}ms`);
    return response;
  });
}

export class CanvasApiClient {
  constructor() {
    this.baseUrl = null;
    this.apiBasePath = '/rest/v2';
    this.userToken = null;
    this.connected = false;
    this.appKey = 'canvas-extension';
    this.startedWorkspaces = new Set();
    this._http = null;
  }

  // ---- Utilities ---------------------------------------------------------

  get apiToken() {
    return this.userToken;
  }

  set apiToken(value) {
    this.userToken = value;
  }

  /**
   * Normalize document IDs for SynapsD-backed workspace operations.
   * SynapsD's batch remove/delete expects numbers (strings will fail and trigger 400s).
   */
  normalizeDocumentIds(documentIds) {
    const raw = Array.isArray(documentIds) ? documentIds : [documentIds];
    const ids = raw.map((v) => {
      if (typeof v === 'number') return v;
      const n = Number(v);
      if (!Number.isFinite(n)) return NaN;
      return n;
    });
    const bad = ids.find((n) => !Number.isFinite(n));
    if (bad !== undefined) {
      throw new Error(`Invalid document ID(s): expected numbers (or numeric strings), got ${JSON.stringify(raw)}`);
    }
    return ids;
  }

  // Initialize client with connection settings
  initialize(serverUrl, apiBasePath, apiToken) {
    const normalizedBaseUrl = serverUrl.replace(/\/$/, '');
    const connectionChanged = this.baseUrl !== normalizedBaseUrl || this.userToken !== apiToken;
    const transportChanged = this.baseUrl !== normalizedBaseUrl || this.apiBasePath !== apiBasePath;

    this.baseUrl = normalizedBaseUrl; // Remove trailing slash
    this.apiBasePath = apiBasePath;
    this.userToken = apiToken;

    if (connectionChanged) {
      this.startedWorkspaces.clear();
    }
    if (transportChanged) {
      this._http = null; // rebuilt lazily with the new base
    }
  }

  // Build full API URL (testConnection/login still fetch directly)
  buildUrl(endpoint) {
    return `${this.baseUrl}${this.apiBasePath}${endpoint}`;
  }

  _client() {
    if (!this._http) {
      this._http = new CanvasHttpClient({
        baseUrl: this.baseUrl,
        apiBase: this.apiBasePath,
        // Closure over the mutable field: service-worker assigns userToken
        // directly (token renewal) and the next request picks it up.
        getToken: () => this.userToken || null,
        appName: this.appKey,
        headers: { Accept: 'application/json' },
        timeout: REQUEST_TIMEOUT_MS,
        unwrap: false,
        fetch: extensionFetch
      });
    }
    return this._http;
  }

  /**
   * Run one request through the shared client, mapping errors onto the
   * extension's historical contract: 401/403 → AuthExpiredError, timeouts →
   * the "server is not responding" text, Firefox local-network failures →
   * the console troubleshooting guide.
   */
  async _req(method, path, options = {}) {
    try {
      return await this._client().request(method, path, options);
    } catch (error) {
      const status = error instanceof CanvasError ? error.statusCode : undefined;
      if (status === 401 || status === 403) throw new AuthExpiredError(status);
      if (error instanceof CanvasError && error.code === 'TIMEOUT') {
        console.error(`API Timeout: ${method} ${path} - request took longer than ${REQUEST_TIMEOUT_MS / 1000} seconds`);
        throw new Error(`Request timeout: server ${this.baseUrl} is not responding`);
      }
      if (isFirefoxRuntime() && isLocalNetworkUrl(this.baseUrl) && (isNetworkError(error) || /failed to fetch/i.test(error.message || ''))) {
        console.error(`Firefox local network connection blocked: ${error.message}`);
        console.error(`
🚫 Firefox Security Block Detected

Firefox is blocking connections to your local Canvas server (${this.baseUrl}).

Quick Solutions:
1. ✅ EASIEST: Use Chrome/Edge for local development
2. 🔧 Firefox Fix: Go to about:config and set:
   - network.dns.blockDotOnion = false
   - security.fileuri.strict_origin_policy = false
3. 🌐 Alternative: Try 127.0.0.1:8001 instead of 172.16.x.x
4. 🔗 Tunnel: Use ngrok to create HTTPS tunnel

This is a Firefox security feature, not an extension bug.
`);
        throw new Error('Firefox blocked local network connection - see console for solutions');
      }
      console.error(`API Error: ${method} ${path}`, error);
      throw error;
    }
  }

  async ensureWorkspaceStarted(workspaceNameOrId) {
    const workspaceKey = encodeURIComponent(workspaceNameOrId);
    if (this.startedWorkspaces.has(workspaceKey)) return;

    await this._req('POST', routes.workspaces.start(workspaceKey), { data: {} });
    this.startedWorkspaces.add(workspaceKey);
  }

  // Test connection to server
  async testConnection() {
    try {
      console.log(`Testing connection to ${this.baseUrl}${this.apiBasePath}`);

      // Test unauthenticated ping endpoint
      const pingUrl = `${this.baseUrl}${this.apiBasePath}/ping`;
      console.log(`Testing ping: ${pingUrl}`);

      // Firefox compatibility: avoid CORS issues for local network connections
      const isFirefox = isFirefoxRuntime();
      const isLocalNetwork = isLocalNetworkUrl(this.baseUrl);

      console.log(`Firefox: ${isFirefox}, Local Network: ${isLocalNetwork}`);

      // Firefox-specific: try multiple approaches for local network
      if (isFirefox && isLocalNetwork) {
        console.log('🔧 Firefox local network detected - trying multiple connection approaches...');

        // Try approach 1: no-cors mode (can't read response but checks if server is reachable)
        try {
          console.log('🔧 Trying no-cors mode...');
          const controller1 = new AbortController();
          const timeout1 = setTimeout(() => controller1.abort(), 5000); // 5 second timeout

          const pingResponse = await fetch(pingUrl, {
            method: 'GET',
            mode: 'no-cors',
            credentials: 'omit',
            signal: controller1.signal
          });
          clearTimeout(timeout1);

          console.log('✅ no-cors mode response received (opaque):', pingResponse);
          // no-cors mode returns opaque response, so we can't read it
          // but if we get here, the server is reachable
          if (pingResponse.type === 'opaque') {
            // Server is reachable, but we can't test authentication with no-cors
            return {
              success: true,
              connected: true,
              authenticated: false,
              message: 'Server reachable via no-cors mode - authentication test skipped',
              ping: { message: 'Server reachable (opaque response)' }
            };
          }
        } catch (error1) {
          console.warn('❌ no-cors mode failed:', error1);
        }

        // Try approach 2: no mode specified
        try {
          console.log('🔧 Trying no mode specified...');
          const controller2 = new AbortController();
          const timeout2 = setTimeout(() => controller2.abort(), 5000); // 5 second timeout

          const pingResponse = await fetch(pingUrl, {
            method: 'GET',
            credentials: 'omit',
            signal: controller2.signal
          });
          clearTimeout(timeout2);

          console.log('✅ no mode succeeded:', pingResponse);

          if (!pingResponse.ok) {
            throw new Error(`Ping failed: HTTP ${pingResponse.status} ${pingResponse.statusText}`);
          }

          let pingData;
          try {
            pingData = await pingResponse.json();
            console.log('Ping successful:', pingData);
          } catch (jsonError) {
            console.warn('Ping response is not JSON:', jsonError);
            pingData = { message: 'Server responded but not with JSON' };
          }

          // Continue to authentication test if we have a user token
          if (!this.userToken) {
            return {
              success: true,
              connected: true,
              authenticated: false,
              message: 'Server reachable but no API token provided',
              ping: pingData
            };
          }

          return await this.testAuthentication(pingData);
        } catch (error2) {
          console.warn('❌ no mode failed:', error2);
        }

        // Try approach 3: XMLHttpRequest (older but more compatible)
        try {
          console.log('🔧 Trying XMLHttpRequest...');
          const pingData = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.timeout = 10000;
            xhr.open('GET', pingUrl, true);
            xhr.setRequestHeader('Accept', 'application/json');

            xhr.onload = function() {
              if (xhr.status >= 200 && xhr.status < 300) {
                try {
                  const data = JSON.parse(xhr.responseText);
                  resolve(data);
                } catch {
                  resolve({ message: 'Server responded but not with JSON' });
                }
              } else {
                reject(new Error(`HTTP ${xhr.status}: ${xhr.statusText}`));
              }
            };

            xhr.onerror = function() {
              reject(new Error('XHR network error'));
            };

            xhr.ontimeout = function() {
              reject(new Error('XHR timeout'));
            };

            xhr.send();
          });

          console.log('✅ XMLHttpRequest succeeded:', pingData);

          // Continue to authentication test if we have a user token
          if (!this.userToken) {
            return {
              success: true,
              connected: true,
              authenticated: false,
              message: 'Server reachable but no API token provided',
              ping: pingData
            };
          }

          return await this.testAuthentication(pingData);
        } catch (error3) {
          console.warn('❌ XMLHttpRequest failed:', error3);
        }

        // All approaches failed - provide detailed Firefox instructions
        const firefoxInstructions = `
Firefox Security Error: Cannot connect to local server ${this.baseUrl}

This is a known Firefox security limitation. Try these solutions:

1. RECOMMENDED: Use Chrome for local Canvas development
2. OR modify Firefox settings:
   - Type 'about:config' in address bar
   - Set 'network.dns.blockDotOnion' to false
   - Set 'network.file.disable_unc_paths' to false
   - Set 'security.fileuri.strict_origin_policy' to false

3. OR use a different local IP:
   - Try 127.0.0.1:8001 instead of ${this.baseUrl}
   - Or use your machine's external IP

4. OR tunnel through HTTPS:
   - Use ngrok or similar to expose your local server
   - Connect to the HTTPS tunnel URL instead

Firefox blocks local network requests for security reasons.
`;

        console.error(firefoxInstructions);
        throw new Error('Firefox cannot connect to local server - see console for detailed instructions.');
      }

      // Non-Firefox or remote server: use standard approach
      const pingOptions = {
        method: 'GET'
      };

      if (!isLocalNetwork) {
        pingOptions.mode = 'cors';
      }

      console.log('Testing ping with options:', pingOptions);

      // Add timeout to prevent hanging
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        const pingResponse = await fetch(pingUrl, { ...pingOptions, signal: controller.signal });
        clearTimeout(timeoutId);

        console.log(`Ping response status: ${pingResponse.status}, ok: ${pingResponse.ok}`);

        if (!pingResponse.ok) {
          throw new Error(`Ping failed: HTTP ${pingResponse.status} ${pingResponse.statusText}`);
        }

        let pingData;
        try {
          pingData = await pingResponse.json();
          console.log('Ping successful:', pingData);
        } catch (jsonError) {
          console.warn('Ping response is not JSON:', jsonError);
          pingData = { message: 'Server responded but not with JSON' };
        }

        // After successful ping, test authentication if we have a user token
        if (!this.userToken) {
          return {
            success: true,
            connected: true,
            authenticated: false,
            message: 'Server reachable but no API token provided',
            ping: pingData
          };
        }

        return await this.testAuthentication(pingData);
      } catch (fetchError) {
        clearTimeout(timeoutId);
        throw fetchError;
      }
    } catch (error) {
      console.error('Connection test failed:', error);
      this.connected = false;

      let errorMessage = error.message;
      if (error.name === 'AbortError') {
        errorMessage = `Connection timeout: server ${this.baseUrl} is not responding`;
      }

      return {
        success: false,
        connected: false,
        authenticated: false,
        error: errorMessage,
        message: 'Connection failed'
      };
    }
  }

  // Helper method to test authentication and return standardized response
  async testAuthentication(pingData) {
    try {
      console.log('Testing authenticated endpoint...');
      const userResponse = await this._req('GET', routes.auth.me());
      console.log('Authentication response:', userResponse);

      // Validate Canvas API authentication response
      if (!userResponse || userResponse.status !== 'success') {
        throw new Error(`Authentication failed: ${userResponse?.message || 'Invalid response'}`);
      }

      if (!userResponse.payload || !userResponse.payload.id) {
        throw new Error('Authentication response missing user data');
      }

      this.connected = true;
      return {
        success: true,
        connected: true,
        authenticated: true,
        user: userResponse.payload,
        message: userResponse.message || 'Connection and authentication successful',
        ping: pingData
      };
    } catch (error) {
      console.error('Authentication test failed:', error);
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  // Authentication methods
  async login(email, password) {
    const url = this.buildUrl(routes.auth.login());
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.status !== 'success' || !data.payload?.token) {
        throw new Error(data?.message || `Login failed: HTTP ${response.status}`);
      }
      return data.payload; // { token, user }
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') throw new Error('Login request timed out');
      throw error;
    }
  }

  /**
   * Exchange the current (still-valid) JWT for a fresh one.
   * Only meaningful for credentials/JWT sessions; opaque API tokens never expire.
   * Throws AuthExpiredError if the current token is already expired/invalid.
   * Returns { token, expiresIn } on success.
   */
  async refreshUserToken() {
    const data = await this._req('POST', routes.auth.tokenRefresh(), { data: {} });
    const body = data?.payload || data;
    const token = body?.token;
    if (!token) throw new Error('Token refresh did not return a new token');
    this.userToken = token;
    return { token, expiresIn: body?.expiresIn || null, user: body?.user || null };
  }

  // Context methods
  async getContexts() {
    return await this._req('GET', routes.contexts.collection());
  }

  async updateContextUrl(contextId, url) {
    return await this._req('POST', routes.contexts.url(contextId), { data: { url } });
  }

  // Context tree
  async getContextTree(contextId) {
    return await this._req('GET', routes.contexts.tree(contextId));
  }

  // Workspace methods
  async getWorkspaces() {
    return await this._req('GET', routes.workspaces.collection());
  }

  // Workspace lifecycle
  async startWorkspace(workspaceNameOrId) {
    return await this._req('POST', routes.workspaces.start(encodeURIComponent(workspaceNameOrId)), { data: {} });
  }

  // Workspace tree
  async getWorkspaceTree(workspaceNameOrId, treeNameOrTreeId = DEFAULT_WORKSPACE_TREE_NAME) {
    await this.ensureWorkspaceStarted(workspaceNameOrId);
    const tree = treeNameOrTreeId || DEFAULT_WORKSPACE_TREE_NAME;
    return await this._req(
      'GET',
      routes.workspaces.treeByName(encodeURIComponent(workspaceNameOrId), encodeURIComponent(tree))
    );
  }

  async getWorkspaceDocuments(workspaceNameOrId, contextSpec = '/', featureArray = [], options = {}) {
    await this.ensureWorkspaceStarted(workspaceNameOrId);
    const enhancedFeatureArray = [...featureArray];
    if (!enhancedFeatureArray.includes('data/schema/tab')) {
      enhancedFeatureArray.unshift('data/schema/tab');
    }

    const listTree = options.treeNameOrTreeId || DEFAULT_WORKSPACE_TREE_NAME;
    return await this._req('GET', routes.workspaces.documents(encodeURIComponent(workspaceNameOrId)), {
      params: {
        treeNameOrTreeId: listTree,
        treeType: treeTypeFromRef(listTree),
        ...(contextSpec ? { context: contextSpec } : {}),
        ...(enhancedFeatureArray.length > 0 ? { allOf: enhancedFeatureArray } : {}),
        ...(Number.isFinite(options.limit) ? { limit: options.limit } : {}),
        ...(Number.isFinite(options.offset) ? { offset: options.offset } : {}),
        // Revalidation read: the payload comes back as document ids, not documents.
        ...(options.idsOnly ? { idsOnly: 'true' } : {})
      }
    });
  }

  _workspaceDocumentsBody(documents, contextSpec, featureArray, treeNameOrTreeId) {
    const tree = treeNameOrTreeId || DEFAULT_WORKSPACE_TREE_NAME;
    return {
      treeNameOrTreeId: tree,
      treeType: treeTypeFromRef(tree),
      context: contextSpec,
      features: featureArray,
      documents
    };
  }

  async insertWorkspaceDocument(workspaceNameOrId, document, contextSpec = '/', featureArray = [], treeNameOrTreeId = DEFAULT_WORKSPACE_TREE_NAME) {
    await this.ensureWorkspaceStarted(workspaceNameOrId);
    return await this._req('POST', routes.workspaces.documents(encodeURIComponent(workspaceNameOrId)), {
      data: this._workspaceDocumentsBody([document], contextSpec, featureArray, treeNameOrTreeId)
    });
  }

  async insertWorkspaceDocuments(workspaceNameOrId, documents, contextSpec = '/', featureArray = [], treeNameOrTreeId = DEFAULT_WORKSPACE_TREE_NAME) {
    await this.ensureWorkspaceStarted(workspaceNameOrId);
    return await this._req('POST', routes.workspaces.documents(encodeURIComponent(workspaceNameOrId)), {
      data: this._workspaceDocumentsBody(documents, contextSpec, featureArray, treeNameOrTreeId)
    });
  }

  _workspaceDocumentsParams(contextSpec, featureArray, treeNameOrTreeId) {
    const tree = treeNameOrTreeId || DEFAULT_WORKSPACE_TREE_NAME;
    return {
      treeNameOrTreeId: tree,
      treeType: treeTypeFromRef(tree),
      ...(contextSpec ? { context: contextSpec } : {}),
      ...(Array.isArray(featureArray) && featureArray.length ? { allOf: featureArray } : {})
    };
  }

  async removeWorkspaceDocuments(workspaceNameOrId, documentIds, contextSpec = '/', featureArray = [], treeNameOrTreeId = DEFAULT_WORKSPACE_TREE_NAME) {
    await this.ensureWorkspaceStarted(workspaceNameOrId);
    return await this._req('DELETE', routes.workspaces.documentsRemove(encodeURIComponent(workspaceNameOrId)), {
      params: this._workspaceDocumentsParams(contextSpec, featureArray, treeNameOrTreeId),
      data: this.normalizeDocumentIds(documentIds),
      timeout: 0 // bulk removals had no client timeout historically
    });
  }

  async deleteWorkspaceDocuments(workspaceNameOrId, documentIds, contextSpec = '/', featureArray = [], treeNameOrTreeId = DEFAULT_WORKSPACE_TREE_NAME) {
    await this.ensureWorkspaceStarted(workspaceNameOrId);
    return await this._req('DELETE', routes.workspaces.documents(encodeURIComponent(workspaceNameOrId)), {
      params: this._workspaceDocumentsParams(contextSpec, featureArray, treeNameOrTreeId),
      data: this.normalizeDocumentIds(documentIds),
      timeout: 0 // bulk deletions had no client timeout historically
    });
  }

  // Workspace tree operations.
  // Insert is PUT .../trees/{tree}/path/{encodedPath} — the path is the URL splat
  // (not a body field), matching the web UI and the `PUT /path/*` route.
  async insertWorkspacePath(workspaceNameOrId, path, data = null, autoCreateLayers = true, treeNameOrTreeId = DEFAULT_WORKSPACE_TREE_NAME) {
    await this.ensureWorkspaceStarted(workspaceNameOrId);
    const encodedPath = String(path || '/').split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const body = { autoCreateLayers };
    if (data && typeof data === 'object') Object.assign(body, data);
    const tree = treeNameOrTreeId || DEFAULT_WORKSPACE_TREE_NAME;
    return await this._req(
      'PUT',
      routes.workspaces.treePath(encodeURIComponent(workspaceNameOrId), tree, encodedPath),
      { data: body }
    );
  }

  // Context tree operations
  async insertContextPath(contextId, path, autoCreateLayers = true) {
    return await this._req('POST', routes.contexts.treePaths(contextId), { data: { path, autoCreateLayers } });
  }

  // Document methods (tabs)
  async getContextDocuments(contextId, featureArray = [], options = {}) {
    // Always ensure we're looking for tab documents
    const enhancedFeatureArray = [...featureArray];
    if (!enhancedFeatureArray.includes('data/schema/tab')) {
      enhancedFeatureArray.unshift('data/schema/tab');
    }

    // Get sync settings to check if we should filter by browser instance
    const syncSettings = await browserStorage.getSyncSettings();
    if (syncSettings?.syncOnlyCurrentBrowser || syncSettings?.syncOnlyThisBrowser) {
      const browserIdentity = await browserStorage.getBrowserIdentity();
      if (browserIdentity) {
        const browserTag = `tag/${browserIdentity}`;
        if (!enhancedFeatureArray.includes(browserTag)) {
          enhancedFeatureArray.push(browserTag);
        }
      }
    }

    return await this._req('GET', routes.contexts.documents(contextId), {
      params: {
        ...(enhancedFeatureArray.length > 0 ? { allOf: enhancedFeatureArray } : {}),
        ...(Number.isFinite(options.limit) ? { limit: options.limit } : {}),
        ...(Number.isFinite(options.offset) ? { offset: options.offset } : {}),
        // Revalidation read: the payload comes back as document ids, not documents.
        ...(options.idsOnly ? { idsOnly: 'true' } : {})
      }
    });
  }

  // Always add browser identity for context document writes
  async _withBrowserTag(featureArray) {
    const enhancedFeatureArray = [...featureArray];
    const browserIdentity = await browserStorage.getBrowserIdentity();
    if (browserIdentity) {
      const browserTag = `tag/${browserIdentity}`;
      if (!enhancedFeatureArray.includes(browserTag)) {
        enhancedFeatureArray.push(browserTag);
      }
    }
    return enhancedFeatureArray;
  }

  async insertDocument(contextId, document, featureArray = []) {
    const features = await this._withBrowserTag(featureArray);
    // Server expects "documents" (can be single object)
    return await this._req('POST', routes.contexts.documents(contextId), {
      data: { documents: document, features }
    });
  }

  async insertDocuments(contextId, documents, featureArray = []) {
    const features = await this._withBrowserTag(featureArray);
    return await this._req('POST', routes.contexts.documents(contextId), {
      data: { documents, features }
    });
  }

  async removeDocument(contextId, documentId) {
    // Server route: DELETE /contexts/:id/documents/remove (body: [ids])
    return await this._req('DELETE', routes.contexts.documentsRemove(contextId), {
      data: this.normalizeDocumentIds([documentId]),
      timeout: 0 // remove/delete-with-body had no client timeout historically
    });
  }

  async removeDocuments(contextId, documentIds, featureArray = []) {
    // Server route: DELETE /contexts/:id/documents/remove (body: [ids], featureArray query)
    return await this._req('DELETE', routes.contexts.documentsRemove(contextId), {
      params: Array.isArray(featureArray) && featureArray.length ? { allOf: featureArray } : {},
      data: this.normalizeDocumentIds(documentIds),
      timeout: 0
    });
  }

  async deleteDocument(contextId, documentId) {
    return await this._req('DELETE', routes.contexts.document(contextId, documentId));
  }

  async deleteDocuments(contextId, documentIds) {
    // Server route: DELETE /contexts/:id/documents (body: [ids]) - direct DB deletion (owner-only)
    return await this._req('DELETE', routes.contexts.documents(contextId), {
      data: this.normalizeDocumentIds(documentIds),
      timeout: 0
    });
  }
}

// Create singleton instance
export const apiClient = new CanvasApiClient();
export default apiClient;
