import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { premiumFeatureBroker } from '../premium/premium-feature-broker.js';
import { premiumEntitlementsService } from '../premium/premium-entitlements-service.js';
import { ensurePremiumFeaturesRegistered } from '../premium/premium-feature-registry.js';
import { applyPathTile, cleanupPathOverlay } from './path-tiles.js';
import { toolOptionsController } from '../core/tool-options-controller.js';

const MODULE_ID = 'fa-nexus';
const PATH_SUBTOOL_SETTING_KEY = 'pathToolActiveSubtool';
const PATH_SUBTOOL_IDS = new Set(['curve', 'draw']);
const EDITING_TILES_KEY = '__faNexusPathEditingTiles';

function getEditingTileSet() {
  try {
    const root = globalThis || window;
    const existing = root?.[EDITING_TILES_KEY];
    if (existing instanceof Set) return existing;
    const created = new Set();
    if (root) root[EDITING_TILES_KEY] = created;
    return created;
  } catch (_) {
    return new Set();
  }
}

function resolveTileDocument(target) {
  if (!target) return null;
  const TileDocument = globalThis?.foundry?.documents?.TileDocument;
  if (TileDocument && target instanceof TileDocument) return target;
  if (TileDocument && target?.document instanceof TileDocument) return target.document;
  if (target?.document) return target.document;
  if (typeof target === 'string' && canvas?.scene?.tiles?.get) {
    try { return canvas.scene.tiles.get(target) || null; } catch (_) { return null; }
  }
  return null;
}

function resolveTilePlaceableById(id) {
  if (!id) return null;
  try {
    const list = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    return list.find((tile) => tile?.document?.id === id) || null;
  } catch (_) {
    return null;
  }
}

export class PathManagerV2 {
  constructor(app) {
    this._app = app;
    this._delegate = null;
    this._loading = null;
    this._entitlementProbe = null;
    this._toolMonitor = null;
    this._lastPersistedSubtool = null;
    this._toolDefaultsPersistTimer = null;
    this._editingTileId = null;
    this._syncToolOptionsState();
  }

  get isActive() {
    return !!this._delegate?.isActive;
  }

  hasSessionChanges() {
    if (!this._delegate?.isActive) return false;
    try {
      if (typeof this._delegate?.hasSessionChanges === 'function') {
        return !!this._delegate.hasSessionChanges();
      }
    } catch (_) {}
    return true;
  }

  get pathTension() {
    return this._delegate?.pathTension ?? 0;
  }

  setPathTension(value) {
    if (!this._delegate) return value;
    return this._delegate.setPathTension(value);
  }

  async _ensureDelegate() {
    if (this._delegate) return this._delegate;
    ensurePremiumFeaturesRegistered();
    if (this._loading) return this._loading;
    this._loading = (async () => {
      const helper = await premiumFeatureBroker.resolve('path.edit.v2');
      let instance = null;
      if (helper?.create) instance = helper.create(this._app);
      else if (typeof helper === 'function') instance = new helper(this._app);
      if (!instance) throw new Error('Premium path editor v2 bundle missing PathManager implementation');
      this._delegate = instance;
      try { instance.attachHost?.(this); }
      catch (_) {}
      try {
        Logger.info?.('PathEditorV2.bundle.loaded', { version: instance?.version || '0.0.15' });
        const hooks = globalThis?.Hooks;
        hooks?.callAll?.('fa-nexus-path-editor-v2-loaded', { version: instance?.version || '0.0.15' });
      } catch (logError) {
        Logger.warn?.('PathEditorV2.bundle.loaded.logFailed', String(logError?.message || logError));
      }
      return instance;
    })();
    try {
      return await this._loading;
    } finally {
      this._loading = null;
    }
  }

  async start(...args) {
    this._cancelPlacementSessions();
    const delegate = await this._ensureDelegate();
    const wasActive = !!delegate?.isActive;
    if (!wasActive) this._clearEditingTile();
    let result;
    try {
      this._refreshDelegateToolDefaults();
      result = delegate.start?.(...args);
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      this._syncToolOptionsState({
        suppressSubtoolPersistence: true,
        suppressToolDefaultsPersistence: true
      });
      toolOptionsController.activateTool('path.edit.v2', { label: 'Path Editor v2' });
      this._beginToolWindowMonitor('path.edit.v2', delegate);
      if (!wasActive) this._restoreSubtoolPreference();
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          this._cancelToolWindowMonitor();
          toolOptionsController.deactivateTool('path.edit.v2');
        });
      }
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  async editTile(targetTile, options = {}) {
    this._cancelPlacementSessions();
    const delegate = await this._ensureDelegate();
    if (!delegate || typeof delegate.editTile !== 'function') {
      throw new Error('Installed path editor bundle does not support editing existing tiles.');
    }
    const doc = resolveTileDocument(targetTile);
    if (doc) this._markEditingTile(doc);
    let result;
    try {
      this._refreshDelegateToolDefaults();
      result = delegate.editTile(targetTile, options);
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      this._syncToolOptionsState({
        suppressSubtoolPersistence: true,
        suppressToolDefaultsPersistence: true
      });
      toolOptionsController.activateTool('path.edit.v2', { label: 'Path Editor v2' });
      this._beginToolWindowMonitor('path.edit.v2', delegate);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          this._cancelToolWindowMonitor();
          toolOptionsController.deactivateTool('path.edit.v2');
        });
      }
    } catch (error) {
      this._clearEditingTile(doc);
      throw error;
    } finally {
      this._scheduleEntitlementProbe();
    }
    if (result && typeof result.catch === 'function') {
      result.catch(() => this._clearEditingTile(doc));
    }
    return result;
  }

  stop(...args) {
    this._cancelToolWindowMonitor();
    if (!this._delegate) {
      this._clearEditingTile();
      toolOptionsController.deactivateTool('path.edit.v2');
      return;
    }
    try {
      if (this._delegate?.isActive) this._persistDelegateToolDefaults();
      return this._delegate.stop?.(...args);
    } finally {
      this._clearEditingTile();
      toolOptionsController.deactivateTool('path.edit.v2');
    }
  }

  async savePath(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.savePath?.(...args);
  }

  async save(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.save?.(...args);
  }

  _scheduleEntitlementProbe() {
    ensurePremiumFeaturesRegistered();
    if (this._entitlementProbe) return this._entitlementProbe;
    const probe = (async () => {
      try {
        await premiumFeatureBroker.require('path.edit.v2', { revalidate: true, reason: 'path-edit-v2:revalidate' });
      } catch (error) {
        this._handleEntitlementFailure(error);
      } finally {
        if (this._entitlementProbe === probe) this._entitlementProbe = null;
      }
    })();
    this._entitlementProbe = probe;
    probe.catch(() => {});
    return probe;
  }

  _handleEntitlementFailure(error) {
    try { this.stop?.(); }
    catch (_) {}
    this._delegate = null;
    const hasAuth = this._hasPremiumAuth();
    if (!hasAuth) {
      Logger.info?.('PathManager.entitlement.skipDisconnect', {
        code: error?.code || error?.name,
        message: String(error?.message || error)
      });
      return;
    }
    const message = '🔐 Authentication expired - premium path editing v2 has been disabled. Please reconnect Patreon.';
    if (this._isAuthFailure(error)) {
      try { premiumEntitlementsService?.clear?.({ reason: 'path-revalidate-failed' }); }
      catch (_) {}
      try { game?.settings?.set?.('fa-nexus', 'patreon_auth_data', null); }
      catch (_) {}
      ui?.notifications?.warn?.(message);
    } else {
      const fallback = `Unable to confirm premium access: ${error?.message || error}`;
      ui?.notifications?.error?.(fallback);
    }
    try { Hooks?.callAll?.('fa-nexus-premium-auth-lost', { featureId: 'path.edit.v2', error }); }
    catch (_) {}
  }

  _isAuthFailure(error) {
    if (!error) return false;
    const code = String(error?.code || error?.name || '').toUpperCase();
    if (code && (/AUTH/.test(code) || ['STATE_MISSING', 'ENTITLEMENT_REQUIRED', 'HTTP_401', 'HTTP_403', 'SESSION_EXPIRED', 'STATE_INVALID'].includes(code))) {
      return true;
    }
    const message = String(error?.message || '').toLowerCase();
    return message.includes('auth') || message.includes('state');
  }

  _hasPremiumAuth() {
    try {
      const authData = game?.settings?.get?.('fa-nexus', 'patreon_auth_data');
      return !!(authData && authData.authenticated && authData.state);
    } catch (_) {
      return false;
    }
  }

  _cancelPlacementSessions() {
    try {
      const tabs = this._app?._tabManager?.getTabs?.();
      const assetsTab = tabs?.assets;
      const activeTab = this._app?._tabManager?.getActiveTab?.();
      const managers = [
        assetsTab?.placementManager,
        assetsTab?._placement,
        assetsTab?._controller?.placementManager,
        activeTab?.placementManager,
        activeTab?._placement,
        activeTab?._controller?.placementManager
      ];
      for (const manager of managers) {
        if (manager?.cancelPlacement) {
          try { manager.cancelPlacement('path-edit'); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  _beginToolWindowMonitor(toolId, delegate) {
    this._cancelToolWindowMonitor();
    if (!delegate) return;
    const token = { cancelled: false, handle: null, usingTimeout: false, toolId };
    const schedule = (callback) => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        token.usingTimeout = false;
        token.handle = window.requestAnimationFrame(callback);
      } else {
        token.usingTimeout = true;
        token.handle = setTimeout(callback, 200);
      }
    };
    const tick = () => {
      if (token.cancelled) return;
      let active = false;
      try { active = !!delegate?.isActive; }
      catch (_) { active = false; }
      if (!active) {
        this._clearEditingTile();
        toolOptionsController.deactivateTool(toolId);
        this._cancelToolWindowMonitor();
        return;
      }
      schedule(tick);
    };
    this._toolMonitor = token;
    schedule(tick);
  }

  _cancelToolWindowMonitor() {
    const token = this._toolMonitor;
    if (!token) return;
    token.cancelled = true;
    if (token.handle != null) {
      try {
        if (token.usingTimeout) clearTimeout(token.handle);
        else if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(token.handle);
      } catch (_) {}
    }
    this._toolMonitor = null;
  }

  _markEditingTile(doc) {
    const id = doc?.id;
    if (!id) return;
    if (this._editingTileId && this._editingTileId !== id) {
      this._clearEditingTile(this._editingTileId);
    }
    this._editingTileId = id;
    try { getEditingTileSet().add(id); } catch (_) {}
    const tile = doc?.object || resolveTilePlaceableById(id);
    if (tile) {
      try { cleanupPathOverlay(tile); } catch (_) {}
    }
  }

  _clearEditingTile(target = null) {
    const id = typeof target === 'string' ? target : target?.id || this._editingTileId;
    if (!id) return;
    try { getEditingTileSet().delete(id); } catch (_) {}
    if (this._editingTileId === id) this._editingTileId = null;
    const tile = (typeof target === 'object' && target?.object) ? target.object : resolveTilePlaceableById(id);
    if (tile) {
      try { applyPathTile(tile); } catch (_) {}
    }
  }

  _buildToolOptionsState() {
    const baseHints = [
      'LMB adds control points;',
      'LMB Drag existing points to adjust;',
      'Shift+LMB inserts along the path;',
      'Alt+LMB deletes the closest point.',
      'Double-click ends the current path.',
      'Ctrl/Cmd+Wheel adjusts scale;',
      'Alt+Wheel changes elevation (Shift=coarse, Ctrl/Cmd=fine).',
      'Press S to commit the path; ESC to cancel.'
    ];
    let delegateState = {};
    let handlers = {};
    try {
      const descriptor = this._delegate?.getToolOptionsDescriptor?.();
      if (descriptor) {
        if (descriptor.state && typeof descriptor.state === 'object') delegateState = descriptor.state;
        if (descriptor.handlers && typeof descriptor.handlers === 'object') handlers = descriptor.handlers;
      }
    } catch (_) {}
    const mergedHints = [...baseHints];
    if (Array.isArray(delegateState?.hints)) {
      for (const hint of delegateState.hints) {
        if (typeof hint === 'string' && hint.trim()) mergedHints.push(hint.trim());
      }
    }
    const state = { ...delegateState, hints: mergedHints };
    return { state, handlers };
  }

  _syncToolOptionsState({
    suppressRender = false,
    suppressSubtoolPersistence = false,
    suppressToolDefaultsPersistence = false
  } = {}) {
    try {
      const descriptor = this._buildToolOptionsState();
      toolOptionsController.setToolOptions('path.edit.v2', {
        state: descriptor.state,
        handlers: descriptor.handlers,
        suppressRender
      });
      this._persistSubtoolFromState(descriptor.state, { suppress: suppressSubtoolPersistence });
      if (!suppressToolDefaultsPersistence) this._scheduleToolDefaultsPersist();
    } catch (_) {}
  }

  requestToolOptionsUpdate(options = {}) {
    this._syncToolOptionsState(options);
  }

  _persistDelegateToolDefaults() {
    const delegate = this._delegate;
    if (!delegate) return;
    if (typeof delegate._persistToolDefaults !== 'function') return;
    try { delegate._persistToolDefaults(); } catch (_) {}
  }

  _refreshDelegateToolDefaults() {
    const delegate = this._delegate;
    if (!delegate) return;
    try {
      if (typeof delegate._readToolDefaults === 'function') {
        const defaults = delegate._readToolDefaults();
        delegate._toolDefaults = defaults && typeof defaults === 'object' ? defaults : null;
      } else if ('_toolDefaults' in delegate) {
        delegate._toolDefaults = null;
      }
    } catch (_) {}
  }

  _scheduleToolDefaultsPersist() {
    if (!this._delegate?.isActive) return;
    if (this._toolDefaultsPersistTimer) return;
    this._toolDefaultsPersistTimer = setTimeout(() => {
      this._toolDefaultsPersistTimer = null;
      if (!this._delegate?.isActive) return;
      this._persistDelegateToolDefaults();
    }, 200);
  }

  _readSubtoolPreference() {
    try {
      const value = game?.settings?.get?.(MODULE_ID, PATH_SUBTOOL_SETTING_KEY);
      const normalized = typeof value === 'string' ? value : '';
      return PATH_SUBTOOL_IDS.has(normalized) ? normalized : null;
    } catch (_) {
      return null;
    }
  }

  _persistSubtoolPreference(value) {
    if (!value || !PATH_SUBTOOL_IDS.has(value)) return;
    if (this._lastPersistedSubtool === value) return;
    this._lastPersistedSubtool = value;
    try { game?.settings?.set?.(MODULE_ID, PATH_SUBTOOL_SETTING_KEY, value); } catch (_) {}
  }

  _extractActiveSubtoolId(state) {
    const toggles = Array.isArray(state?.subtoolToggles) ? state.subtoolToggles : [];
    for (const toggle of toggles) {
      if (!toggle || typeof toggle !== 'object') continue;
      if (!toggle.enabled) continue;
      const id = String(toggle.id || '');
      if (PATH_SUBTOOL_IDS.has(id)) return id;
    }
    return null;
  }

  _persistSubtoolFromState(state, { suppress = false } = {}) {
    if (suppress) return;
    const active = this._extractActiveSubtoolId(state);
    if (!active) return;
    this._persistSubtoolPreference(active);
  }

  _restoreSubtoolPreference() {
    const preferred = this._readSubtoolPreference();
    if (!preferred) return;
    this._lastPersistedSubtool = preferred;
    const apply = () => {
      try {
        const result = toolOptionsController?.requestCustomToggle?.(preferred, true);
        if (result === false) {
          setTimeout(() => {
            try { toolOptionsController?.requestCustomToggle?.(preferred, true); } catch (_) {}
          }, 50);
        }
      } catch (_) {}
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(apply);
    else setTimeout(apply, 0);
  }
}

export default PathManagerV2;
