// Browser-compatible storage system for Canvas Extension
// Works with both Chrome and Firefox using storage API directly

// Browser compatibility shim
const browserAPI = (() => {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    return chrome;
  }
  if (typeof browser !== 'undefined' && browser.storage) {
    return browser;
  }
  throw new Error('Browser storage API not available');
})();

export class BrowserStorage {
  constructor() {
    this.storage = browserAPI.storage.local;
    this.setupChangeListeners();

    // Storage keys
    this.KEYS = {
      CONNECTION_SETTINGS: 'canvasConnectionSettings',
      CURRENT_CONTEXT: 'canvasCurrentContext',
      CURRENT_WORKSPACE: 'canvasCurrentWorkspace',
      SYNC_MODE: 'canvasSyncMode',
      WORKSPACE_PATH: 'canvasWorkspacePath',
      SYNC_SETTINGS: 'canvasSyncSettings',
      BROWSER_IDENTITY: 'canvasBrowserIdentity',
      TRACKED_CANVAS_TABS: 'canvasTrackedCanvasTabs',
      PINNED_TABS: 'canvasPinnedTabs',
      USER_INFO: 'canvasUserInfo',
      RECENT_DESTINATIONS: 'canvasRecentDestinations',
      CANVAS_DOCUMENT_STORE: 'canvasDocumentStore',
      CANVAS_DOCUMENT_INDEXES: 'canvasDocumentIndexes',
      CANVAS_TREE_CACHE: 'canvasTreeCache',
      TAB_SESSION_STATE: 'canvasTabSessionState'
    };

    // Documents cache bounds. storage.local is 10 MB by default and we stay
    // inside it deliberately (no unlimitedStorage permission), so the cache is
    // capped by entry count and age rather than measured bytes.
    this.DOCUMENTS_CACHE_MAX_ENTRIES = 20;
    this.DOCUMENTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
    // Entry count alone stops bounding anything once the page size is
    // configurable: 20 entries of 2000 projections would be ~8 MB against a
    // 10 MB budget. Bound the documents instead, so a bigger fetch limit costs
    // fewer retained pages rather than more bytes.
    this.DOCUMENTS_CACHE_MAX_DOCUMENTS = 6000;

    // Tab session state is tiny per entry (five numbers) but accumulates one
    // entry per document ever restored, so it gets a longer life and a higher
    // cap than the document cache.
    this.TAB_SESSION_STATE_MAX_ENTRIES = 500;
    this.TAB_SESSION_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

    // Default values
    this.DEFAULTS = {
      [this.KEYS.CONNECTION_SETTINGS]: {
        serverUrl: 'https://my.cnvs.ai',
        apiBasePath: '/rest/v2',
        apiToken: '',
        connected: false
      },
      [this.KEYS.SYNC_MODE]: 'explorer', // 'explorer' | 'context'
      [this.KEYS.WORKSPACE_PATH]: '/',
      [this.KEYS.SYNC_SETTINGS]: {
        openTabsAddedToCanvas: false,        // Open tabs when added to Canvas Server
        closeTabsRemovedFromCanvas: false,   // Close tabs when removed from Canvas Server
        sendNewTabsToCanvas: false,          // Send newly opened browser tabs to Canvas Server
        removeClosedTabsFromCanvas: false,   // Remove closed browser tabs from Canvas Server
        removeUtmParameters: true,           // Strip utm_* query params from URLs before syncing
        contextUnloadBehavior: 'close',      // 'close' | 'discard' | 'stash'
        stashDiscardTabs: true,              // Discard tabs after stashing them
        firefoxHideStashedTabs: true,        // Firefox-only: hide stashed tabs from the tab strip
        chromiumStashGroupName: 'Stashed',
        canvasTabsFetchLimit: 200,
        contextChangeBehavior: 'keep-only', // How to handle context changes: 'close-open-new', 'save-close-open-new', 'keep-open-new', 'keep-only'
        preferredTreeType: 'context',       // Default workspace tree to sync against: 'context' | 'directory'
        workspaceTreeOverrides: {}           // Per-workspace override: { [workspaceId|name]: 'context' | 'directory' }
      },
      [this.KEYS.CURRENT_CONTEXT]: null,
      [this.KEYS.CURRENT_WORKSPACE]: null, // { id, name, label, path }
      [this.KEYS.BROWSER_IDENTITY]: '',
      [this.KEYS.TRACKED_CANVAS_TABS]: [],
      // Stored as array in browser storage (Set can't be serialized)
      [this.KEYS.PINNED_TABS]: [],
      [this.KEYS.USER_INFO]: null, // { id, name, email, userType, status }
      [this.KEYS.RECENT_DESTINATIONS]: [], // Array of recent destinations: [{ id, title, type: 'workspace'|'context', workspaceName?, contextSpec?, timestamp }]
      [this.KEYS.CANVAS_DOCUMENT_STORE]: {}, // { [documentId]: { id, data: {title, url, favIconUrl}, updatedAt } }
      [this.KEYS.CANVAS_DOCUMENT_INDEXES]: {}, // { [scopeKey]: { ids, count, totalCount, offset, limit, fetchedAt, serverUrl, scope, stale } }
      [this.KEYS.CANVAS_TREE_CACHE]: {}, // { [treeKey]: { tree, fetchedAt, serverUrl } }
      [this.KEYS.TAB_SESSION_STATE]: {} // { [documentId]: { windowId, index, muted, active, groupId, updatedAt } }
    };
  }

  // Setup storage change listeners
  setupChangeListeners() {
    browserAPI.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        console.log('Storage changed:', changes);

        // Notify other parts of the extension about changes
        if (changes[this.KEYS.CONNECTION_SETTINGS]) {
          console.log('Connection settings changed:', changes[this.KEYS.CONNECTION_SETTINGS].newValue);
        }

        if (changes[this.KEYS.CURRENT_CONTEXT]) {
          console.log('Current context changed:', changes[this.KEYS.CURRENT_CONTEXT].newValue);
        }
      }
    });
  }

  // Generic get method
  async get(key) {
    try {
      console.log('BrowserStorage: Getting key:', key);
      const result = await this.storage.get(key);
      const value = result[key];

      console.log('BrowserStorage: Retrieved value for', key, ':', value);

      // Return actual value if exists, otherwise return default
      if (value !== undefined && value !== null) {
        return value;
      }

      const defaultValue = this.DEFAULTS[key];
      console.log('BrowserStorage: Using default value for', key, ':', defaultValue);
      return defaultValue;
    } catch (error) {
      console.error('BrowserStorage: Error getting', key, ':', error);
      return this.DEFAULTS[key];
    }
  }

  // Generic set method
  async set(key, value) {
    try {
      console.log('BrowserStorage: Setting key:', key, 'to value:', value);
      await this.storage.set({ [key]: value });
      console.log('BrowserStorage: Successfully set', key);
      return true;
    } catch (error) {
      console.error('BrowserStorage: Error setting', key, ':', error);
      return false;
    }
  }

  // Get multiple keys at once
  async getMultiple(keys) {
    try {
      console.log('BrowserStorage: Getting multiple keys:', keys);
      const result = await this.storage.get(keys);

      // Apply defaults for missing keys
      const output = {};
      for (const key of keys) {
        output[key] = result[key] !== undefined ? result[key] : this.DEFAULTS[key];
      }

      console.log('BrowserStorage: Retrieved multiple values:', output);
      return output;
    } catch (error) {
      console.error('BrowserStorage: Error getting multiple keys:', error);
      // Return defaults for all requested keys
      const output = {};
      for (const key of keys) {
        output[key] = this.DEFAULTS[key];
      }
      return output;
    }
  }

  // Connection Settings
  async getConnectionSettings() {
    return await this.get(this.KEYS.CONNECTION_SETTINGS);
  }

  async setConnectionSettings(settings) {
    const current = await this.getConnectionSettings();
    const updated = { ...current, ...settings };
    return await this.set(this.KEYS.CONNECTION_SETTINGS, updated);
  }

  // Current Context
  async getCurrentContext() {
    return await this.get(this.KEYS.CURRENT_CONTEXT);
  }

  async setCurrentContext(context) {
    return await this.set(this.KEYS.CURRENT_CONTEXT, context);
  }

  // Current Workspace (Explorer mode)
  async getCurrentWorkspace() {
    return await this.get(this.KEYS.CURRENT_WORKSPACE);
  }

  async setCurrentWorkspace(workspace) {
    return await this.set(this.KEYS.CURRENT_WORKSPACE, workspace);
  }

  // Sync Mode
  async getSyncMode() {
    return await this.get(this.KEYS.SYNC_MODE);
  }

  async setSyncMode(mode) {
    return await this.set(this.KEYS.SYNC_MODE, mode);
  }

  // Explorer path
  async getWorkspacePath() {
    return await this.get(this.KEYS.WORKSPACE_PATH);
  }

  async setWorkspacePath(path) {
    return await this.set(this.KEYS.WORKSPACE_PATH, path || '/');
  }

  // Resolve which tree to sync against for a workspace. Driven entirely by
  // settings (no per-session UI): a global preferredTreeType plus an optional
  // per-workspace override map. Returns a tree *type name* ('context' |
  // 'directory') which the API accepts as treeNameOrTreeId. Every workspace has
  // both default trees, so resolving by type name needs no tree-id lookup.
  async getWorkspaceTreeRef(workspaceNameOrId = null) {
    const sync = await this.getSyncSettings();
    const overrides = (sync && sync.workspaceTreeOverrides) || {};

    let wsKey = workspaceNameOrId;
    if (!wsKey) {
      const ws = await this.getCurrentWorkspace();
      wsKey = ws?.id || ws?.name;
      // Try both id and name when resolving the override
      const override = (ws && (overrides[ws.id] || overrides[ws.name])) || null;
      if (override) return override;
    } else if (overrides[wsKey]) {
      return overrides[wsKey];
    }

    return (sync && sync.preferredTreeType) || 'context';
  }

  // Sync Settings
  async getSyncSettings() {
    return await this.get(this.KEYS.SYNC_SETTINGS);
  }

  async setSyncSettings(settings) {
    const current = await this.getSyncSettings();
    const updated = { ...current, ...settings };
    return await this.set(this.KEYS.SYNC_SETTINGS, updated);
  }

  async getTrackedCanvasTabs() {
    const trackedTabs = await this.get(this.KEYS.TRACKED_CANVAS_TABS);
    return Array.isArray(trackedTabs) ? trackedTabs : [];
  }

  async setTrackedCanvasTabs(trackedTabs) {
    const items = Array.isArray(trackedTabs) ? trackedTabs : [];
    return await this.set(this.KEYS.TRACKED_CANVAS_TABS, items);
  }

  // Canvas Documents Cache (stale-while-revalidate for the popup)
  //
  // The popup renders from this on open so first paint has rows before any
  // server round-trip, then revalidates. Entries are keyed by everything that
  // determines the result set — mode, context/workspace, path and the page
  // window — so a context or path switch can never surface another scope's tabs.

  documentsCacheKey({ mode, contextId, workspaceId, workspacePath, offset, limit } = {}) {
    const scope = contextId || workspaceId || 'none';
    const path = workspacePath || '/';
    return `${mode || 'explorer'}:${scope}:${path}:${offset || 0}:${limit || 0}`;
  }

  // The popup only ever reads id/title/url/favIconUrl, so cache exactly that and
  // drop featureArray/metadata/schema/checksums/timestamps — most of the bytes.
  // `data:` favicons are skipped too (multi-KB for some sites); the renderer
  // already falls back to a placeholder icon.
  projectDocumentForCache(doc) {
    if (!doc || doc.id === undefined || doc.id === null) return null;
    const data = doc.data || {};
    const favIconUrl = typeof data.favIconUrl === 'string' && !data.favIconUrl.startsWith('data:')
      ? data.favIconUrl
      : undefined;
    return {
      id: doc.id,
      data: {
        title: data.title,
        url: data.url,
        ...(favIconUrl ? { favIconUrl } : {})
      }
    };
  }

  // Storage is normalized, because Canvas documents are content-addressed: a
  // tab's checksum field is its url, so the same page filed under /search,
  // /utils/web/search and /design/web/ui is ONE document id linked into three
  // tree paths — not three documents. Keying cached bodies by path would store
  // it three times and force an edit to be patched in three places.
  //
  //   store:   { [documentId]: projection }        one copy, shared by every path
  //   indexes: { [scopeKey]: { ids, … } }          what each path/page lists
  //
  // Which also means a path you have never opened can render without fetching a
  // single document body, as long as its ids resolve in the store.

  async getDocumentStore() {
    const store = await this.get(this.KEYS.CANVAS_DOCUMENT_STORE);
    return (store && typeof store === 'object' && !Array.isArray(store)) ? store : {};
  }

  async getDocumentIndexes() {
    const indexes = await this.get(this.KEYS.CANVAS_DOCUMENT_INDEXES);
    return (indexes && typeof indexes === 'object' && !Array.isArray(indexes)) ? indexes : {};
  }

  async setDocumentCaches(store, indexes) {
    const pruned = this.pruneDocumentCaches(store || {}, indexes || {});
    await this.set(this.KEYS.CANVAS_DOCUMENT_STORE, pruned.store);
    await this.set(this.KEYS.CANVAS_DOCUMENT_INDEXES, pruned.indexes);
    return true;
  }

  // Resolve an index against the store. Returns the same shape callers had when
  // this was one blob — or null, which means "fetch". Null on: no index, wrong
  // server, expired, or any listed id whose body has been evicted. Partial is
  // not an option: a page missing rows is worse than a page that arrives late.
  async getCachedDocuments(key, serverUrl) {
    if (!key) return null;

    const indexes = await this.getDocumentIndexes();
    const entry = indexes[key];
    if (!entry || !Array.isArray(entry.ids)) return null;
    if (serverUrl && entry.serverUrl !== serverUrl) return null;
    if (!Number.isFinite(entry.fetchedAt) || (Date.now() - entry.fetchedAt) > this.DOCUMENTS_CACHE_TTL_MS) return null;

    const store = await this.getDocumentStore();
    const documents = [];
    for (const id of entry.ids) {
      const doc = store[String(id)];
      if (!doc) return null;
      documents.push(doc);
    }

    return {
      documents,
      count: entry.count ?? documents.length,
      totalCount: entry.totalCount ?? documents.length,
      offset: entry.offset ?? 0,
      limit: entry.limit ?? documents.length,
      fetchedAt: entry.fetchedAt,
      stale: entry.stale === true
    };
  }

  // Resolve an arbitrary id list against the store alone — no index needed. This
  // is what makes a first visit to a path cheap: ask the server for the ids
  // (small), and if every body is already here from another path, render with no
  // document fetch at all. Returns null the moment one is missing.
  async resolveCachedDocumentIds(ids = []) {
    if (!Array.isArray(ids)) return null;
    if (ids.length === 0) return [];

    const store = await this.getDocumentStore();
    const documents = [];
    for (const id of ids) {
      const doc = store[String(id)];
      if (!doc) return null;
      documents.push(doc);
    }
    return documents;
  }

  async setCachedDocuments(key, { documents = [], count, totalCount, offset, limit, serverUrl, scope } = {}) {
    if (!key) return false;

    const store = await this.getDocumentStore();
    const indexes = await this.getDocumentIndexes();
    const now = Date.now();

    const ids = [];
    for (const doc of documents) {
      const projected = this.projectDocumentForCache(doc);
      if (!projected) continue;
      const id = String(projected.id);
      store[id] = { ...projected, updatedAt: now };
      ids.push(id);
    }

    indexes[key] = {
      ids,
      count: count ?? ids.length,
      totalCount: totalCount ?? ids.length,
      offset: offset ?? 0,
      limit: limit ?? ids.length,
      fetchedAt: now,
      serverUrl: serverUrl || null,
      // Scope components are kept alongside the key so the service worker can
      // match live events to entries without parsing keys back apart.
      scope: scope || null,
      // Set when an event told us the listing moved but not precisely enough to
      // patch it. Still rendered on open — but revalidated in full.
      stale: false
    };

    return await this.setDocumentCaches(store, indexes);
  }

  /**
   * Bound both halves.
   *
   * Indexes: TTL, then newest-first up to the entry cap, then stop before the
   * documents they reference exceed the budget (the newest is always kept).
   *
   * Store: everything the surviving indexes reference, then — with whatever
   * budget is left — the most recently touched unreferenced bodies. Those
   * leftovers are the point: a document whose index has been evicted still makes
   * some other path render for free.
   */
  pruneDocumentCaches(store, indexes) {
    const now = Date.now();
    const fresh = Object.entries(indexes)
      .filter(([, entry]) => Number.isFinite(entry?.fetchedAt) && (now - entry.fetchedAt) <= this.DOCUMENTS_CACHE_TTL_MS)
      .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
      .slice(0, this.DOCUMENTS_CACHE_MAX_ENTRIES);

    const keptIndexes = [];
    const referenced = new Set();
    for (const [key, entry] of fresh) {
      const ids = Array.isArray(entry.ids) ? entry.ids.map(String) : [];
      if (keptIndexes.length > 0) {
        const projectedSize = new Set([...referenced, ...ids]).size;
        if (projectedSize > this.DOCUMENTS_CACHE_MAX_DOCUMENTS) break;
      }
      keptIndexes.push([key, entry]);
      ids.forEach(id => referenced.add(id));
    }

    const keptStore = {};
    for (const id of referenced) {
      if (store[id]) keptStore[id] = store[id];
    }

    let documentCount = Object.keys(keptStore).length;
    const spare = Object.entries(store)
      .filter(([id]) => !referenced.has(id))
      .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
    for (const [id, doc] of spare) {
      if (documentCount >= this.DOCUMENTS_CACHE_MAX_DOCUMENTS) break;
      keptStore[id] = doc;
      documentCount++;
    }

    return { store: keptStore, indexes: Object.fromEntries(keptIndexes) };
  }

  async clearDocumentsCache() {
    await this.set(this.KEYS.CANVAS_DOCUMENT_STORE, {});
    await this.set(this.KEYS.CANVAS_DOCUMENT_INDEXES, {});
    // Older builds kept one denormalized blob here; drop it so it can't linger.
    try {
      await this.storage.remove('canvasDocumentsCache');
    } catch { /* nothing to remove */ }
    return true;
  }

  // Tree cache. Same cold-open problem as the documents list ("Loading tree…"),
  // but the tree changes rarely and is small, so it needs no patching — the
  // service worker just drops it when a tree event says it moved.

  async getCachedTree(key, serverUrl) {
    if (!key) return null;
    const cache = await this.get(this.KEYS.CANVAS_TREE_CACHE);
    const entry = (cache && typeof cache === 'object') ? cache[key] : null;
    if (!entry?.tree) return null;
    if (serverUrl && entry.serverUrl !== serverUrl) return null;
    if (!Number.isFinite(entry.fetchedAt) || (Date.now() - entry.fetchedAt) > this.DOCUMENTS_CACHE_TTL_MS) return null;
    return entry.tree;
  }

  async setCachedTree(key, tree, serverUrl) {
    if (!key || !tree) return false;
    const cache = await this.get(this.KEYS.CANVAS_TREE_CACHE) || {};
    cache[key] = { tree, fetchedAt: Date.now(), serverUrl: serverUrl || null };

    // One tree per scope, and few scopes — the entry cap alone keeps this bounded.
    const trimmed = Object.entries(cache)
      .sort((a, b) => (b[1]?.fetchedAt || 0) - (a[1]?.fetchedAt || 0))
      .slice(0, this.DOCUMENTS_CACHE_MAX_ENTRIES);
    return await this.set(this.KEYS.CANVAS_TREE_CACHE, Object.fromEntries(trimmed));
  }

  async clearTreeCache() {
    return await this.set(this.KEYS.CANVAS_TREE_CACHE, {});
  }

  // Tab session state (local only, keyed by document id)
  //
  // Where a tab sat — window, position, mute, group — so a context switch back
  // can put it back. This is per-browser-session state and deliberately NOT part
  // of the synced document: window ids are per-machine and unstable across
  // restarts, and pushing them to the server would hand one machine's ids to
  // every other client. Only `pinned` belongs in the document; it's a property
  // of the bookmark, not of a session.
  //
  // Small per entry but unbounded over time, so it gets the same treatment as
  // the document cache: capped and aged out.

  async getTabSessionStates() {
    const states = await this.get(this.KEYS.TAB_SESSION_STATE);
    return (states && typeof states === 'object' && !Array.isArray(states)) ? states : {};
  }

  async getTabSessionState(documentId) {
    if (documentId === undefined || documentId === null) return null;
    const states = await this.getTabSessionStates();
    const entry = states[String(documentId)];
    if (!entry) return null;
    if (!Number.isFinite(entry.updatedAt) || (Date.now() - entry.updatedAt) > this.TAB_SESSION_STATE_TTL_MS) return null;
    return entry;
  }

  // entries: [{ documentId, state: { windowId, index, muted, active, groupId } }]
  async recordTabSessionStates(entries = []) {
    const usable = entries.filter(entry => entry?.documentId != null && entry.state);
    if (usable.length === 0) return false;

    const states = await this.getTabSessionStates();
    for (const { documentId, state } of usable) {
      states[String(documentId)] = { ...state, updatedAt: Date.now() };
    }

    const pruned = Object.entries(states)
      .filter(([, entry]) => Number.isFinite(entry?.updatedAt) && (Date.now() - entry.updatedAt) <= this.TAB_SESSION_STATE_TTL_MS)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, this.TAB_SESSION_STATE_MAX_ENTRIES);

    return await this.set(this.KEYS.TAB_SESSION_STATE, Object.fromEntries(pruned));
  }

  async clearTabSessionState() {
    return await this.set(this.KEYS.TAB_SESSION_STATE, {});
  }

  // Browser Identity
  async getBrowserIdentity() {
    let identity = await this.get(this.KEYS.BROWSER_IDENTITY);

    if (!identity) {
      identity = this.detectBrowserIdentity();
      await this.set(this.KEYS.BROWSER_IDENTITY, identity);
      console.log('Generated new browser identity:', identity);
    }

    return identity;
  }

  detectBrowserIdentity() {
    const ua = navigator.userAgent;

    let browserName = 'browser';
    if (ua.includes('Firefox')) browserName = 'firefox';
    else if (ua.includes('Edg/') || ua.includes('Edg ')) browserName = 'edge';
    else if (ua.includes('Chrome')) browserName = 'chrome';
    else if (ua.includes('Safari')) browserName = 'safari';
    return browserName;
  }

  // Pinned Tabs Management
  // IMPORTANT: We store pinned tabs by URL (NOT tabId) so pins survive browser restarts.
  async getPinnedTabUrls() {
    const pinnedData = await this.get(this.KEYS.PINNED_TABS);
    const arr = Array.isArray(pinnedData) ? pinnedData : (pinnedData ? Array.from(pinnedData) : []);
    // Migration safety: older versions stored numeric tabIds; ignore non-strings.
    return new Set(arr.filter(v => typeof v === 'string' && v.length));
  }

  async setPinnedTabUrls(pinnedUrls) {
    const arr = pinnedUrls instanceof Set ? Array.from(pinnedUrls) : (Array.isArray(pinnedUrls) ? pinnedUrls : []);
    return await this.set(this.KEYS.PINNED_TABS, arr.filter(v => typeof v === 'string' && v.length));
  }

  async pinTabUrl(url) {
    const pinned = await this.getPinnedTabUrls();
    pinned.add(url);
    console.log('Pinning tab URL:', url);
    return await this.setPinnedTabUrls(pinned);
  }

  async unpinTabUrl(url) {
    const pinned = await this.getPinnedTabUrls();
    pinned.delete(url);
    console.log('Unpinning tab URL:', url);
    return await this.setPinnedTabUrls(pinned);
  }

  async isTabUrlPinned(url) {
    const pinned = await this.getPinnedTabUrls();
    return pinned.has(url);
  }

  // User Info
  async getUserInfo() {
    return await this.get(this.KEYS.USER_INFO);
  }

  async setUserInfo(userInfo) {
    return await this.set(this.KEYS.USER_INFO, userInfo);
  }

  // Recent Destinations Management
  async getRecentDestinations() {
    return await this.get(this.KEYS.RECENT_DESTINATIONS);
  }

  async addRecentDestination(destination) {
    try {
      const recent = await this.getRecentDestinations();
      
      // Create destination object with timestamp
      const newDestination = {
        ...destination,
        timestamp: Date.now()
      };

      // Remove any existing destination with the same ID to avoid duplicates
      const filtered = recent.filter(item => item.id !== destination.id);
      
      // Add new destination at the beginning
      filtered.unshift(newDestination);
      
      // Keep only the 5 most recent
      const trimmed = filtered.slice(0, 5);
      
      await this.set(this.KEYS.RECENT_DESTINATIONS, trimmed);
      console.log('Added recent destination:', newDestination);
      return trimmed;
    } catch (error) {
      console.error('Failed to add recent destination:', error);
      return [];
    }
  }

  async clearRecentDestinations() {
    return await this.set(this.KEYS.RECENT_DESTINATIONS, []);
  }

  // Clear all extension data
  async clearAll() {
    try {
      await this.storage.clear();
      console.log('BrowserStorage: Cleared all data');
      return true;
    } catch (error) {
      console.error('BrowserStorage: Error clearing data:', error);
      return false;
    }
  }

  // Check if extension is configured
  async isConfigured() {
    const connectionSettings = await this.getConnectionSettings();
    const currentContext = await this.getCurrentContext();

    return !!(
      connectionSettings.apiToken &&
      connectionSettings.serverUrl &&
      currentContext?.id
    );
  }
}

// Create singleton instance
export const browserStorage = new BrowserStorage();
export default browserStorage;
