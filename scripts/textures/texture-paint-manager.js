import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { premiumFeatureBroker } from '../premium/premium-feature-broker.js';
import { premiumEntitlementsService } from '../premium/premium-entitlements-service.js';
import { ensurePremiumFeaturesRegistered } from '../premium/premium-feature-registry.js';
import './masked-tiles.js';
import { applyMaskedTilingToTile } from './texture-render.js';
import { toolOptionsController } from '../core/tool-options-controller.js';

const EDITING_TILE_SET_KEY = '__faNexusTextureEditingTileIds';

function getEditingTileSet() {
  try {
    const root = globalThis;
    if (!root) return null;
    let set = root[EDITING_TILE_SET_KEY];
    if (!(set instanceof Set)) {
      set = new Set();
      root[EDITING_TILE_SET_KEY] = set;
    }
    return set;
  } catch (_) {
    return null;
  }
}

function resolveTileId(targetTile) {
  try {
    return targetTile?.document?.id || targetTile?.id || targetTile?.document?._id || null;
  } catch (_) {
    return null;
  }
}

function resolvePlaceableTile(targetTile, tileId) {
  try {
    if (targetTile?.document && targetTile?.mesh) return targetTile;
    const doc = targetTile?.document || targetTile;
    if (doc?.object) return doc.object;
    const id = tileId || doc?.id || doc?._id;
    if (!id) return null;
    return canvas?.tiles?.placeables?.find((tile) => tile?.document?.id === id) || null;
  } catch (_) {
    return null;
  }
}

export class TexturePaintManager {
  constructor(app) {
    this._app = app;
    this._delegate = null;
    this._loading = null;
    this._entitlementProbe = null;
    this._toolMonitor = null;
    this._delegateListenerBound = false;
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

  async _ensureDelegate() {
    if (this._delegate) {
      this._bindDelegate(this._delegate);
      return this._delegate;
    }
    ensurePremiumFeaturesRegistered();
    if (this._loading) return this._loading;
    this._loading = (async () => {
      const helper = await premiumFeatureBroker.resolve('texture.paint');
      let instance = null;
      if (helper?.create) instance = helper.create(this._app);
      else if (typeof helper === 'function') instance = new helper(this._app);
      if (!instance) throw new Error('Premium texture editor bundle missing TexturePaintManager implementation');
      this._delegate = instance;
      this._bindDelegate(instance);
      return instance;
    })();
    try {
      return await this._loading;
    } finally {
      this._loading = null;
    }
  }

  _bindDelegate(delegate) {
    if (!delegate || this._delegateListenerBound) return delegate;
    try {
      delegate.setToolOptionsListener?.((options = {}) => {
        const suppressRender = options && typeof options === 'object' && 'suppressRender' in options
          ? !!options.suppressRender
          : false;
        this._syncToolOptionsState({ suppressRender });
      });
      this._delegateListenerBound = true;
    } catch (_) {}
    return delegate;
  }

  async start(...args) {
    const delegate = await this._ensureDelegate();
    let result;
    try {
      if (!this._editingTileId) {
        this._clearEditingTile();
      }
      result = delegate.start?.(...args);
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      this._syncToolOptionsState({ suppressRender: false });
      toolOptionsController.activateTool('texture.paint', { label: 'Texture Painter' });
      this._beginToolWindowMonitor('texture.paint', delegate);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          this._cancelToolWindowMonitor();
          toolOptionsController.deactivateTool('texture.paint');
        });
      }
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  async editTile(targetTile, options = {}) {
    const delegate = await this._ensureDelegate();
    if (!delegate || typeof delegate.editTile !== 'function') {
      throw new Error('Installed texture painter bundle does not support editing existing tiles.');
    }
    let result;
    try {
      this._markEditingTile(targetTile);
      result = delegate.editTile(targetTile, options);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          this._clearEditingTile();
          this._cancelToolWindowMonitor();
          toolOptionsController.deactivateTool('texture.paint');
        });
      }
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      this._syncToolOptionsState({ suppressRender: false });
      toolOptionsController.activateTool('texture.paint', { label: 'Texture Painter' });
      this._beginToolWindowMonitor('texture.paint', delegate);
    } catch (error) {
      this._clearEditingTile();
      throw error;
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  stop(...args) {
    this._cancelToolWindowMonitor();
    this._clearEditingTile();
    if (!this._delegate) {
      toolOptionsController.deactivateTool('texture.paint');
      return;
    }
    try {
      return this._delegate.stop?.(...args);
    } finally {
      toolOptionsController.deactivateTool('texture.paint');
    }
  }

  async save(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.save?.(...args);
  }

  async saveMask(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.saveMask?.(...args);
  }

  async placeMaskedTiling(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.placeMaskedTiling?.(...args);
  }

  _scheduleEntitlementProbe() {
    ensurePremiumFeaturesRegistered();
    if (this._entitlementProbe) return this._entitlementProbe;
    const probe = (async () => {
      try {
        await premiumFeatureBroker.require('texture.paint', { revalidate: true, reason: 'texture-paint:revalidate' });
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
    this._delegateListenerBound = false;
    const hasAuth = this._hasPremiumAuth();
    if (!hasAuth) {
      Logger.info?.('TexturePaintManager.entitlement.skipDisconnect', {
        code: error?.code || error?.name,
        message: String(error?.message || error)
      });
      return;
    }
    const message = '🔐 Authentication expired - premium texture painting has been disabled. Please reconnect Patreon.';
    if (this._isAuthFailure(error)) {
      try { premiumEntitlementsService?.clear?.({ reason: 'texture-revalidate-failed' }); }
      catch (_) {}
      try { game?.settings?.set?.('fa-nexus', 'patreon_auth_data', null); }
      catch (_) {}
      ui?.notifications?.warn?.(message);
    } else {
      const fallback = `Unable to confirm premium access: ${error?.message || error}`;
      ui?.notifications?.error?.(fallback);
    }
    try { Hooks?.callAll?.('fa-nexus-premium-auth-lost', { featureId: 'texture.paint', error }); }
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

  _markEditingTile(targetTile) {
    try {
      const tileId = resolveTileId(targetTile);
      if (!tileId) return;
      if (this._editingTileId && this._editingTileId !== tileId) {
        this._clearEditingTile();
      }
      this._editingTileId = tileId;
      const set = getEditingTileSet();
      if (set) set.add(tileId);
      const tile = resolvePlaceableTile(targetTile, tileId);
      if (tile) applyMaskedTilingToTile(tile);
    } catch (_) {}
  }

  _clearEditingTile() {
    try {
      const tileId = this._editingTileId;
      if (!tileId) return;
      this._editingTileId = null;
      const set = getEditingTileSet();
      if (set) set.delete(tileId);
      const tile = resolvePlaceableTile(null, tileId);
      if (tile) applyMaskedTilingToTile(tile);
    } catch (_) {}
  }

  _buildToolOptionsState() {
    try {
      const delegateState = this._delegate?.buildToolOptionsState?.();
      if (delegateState && typeof delegateState === 'object') return delegateState;
    } catch (_) {}
    return {
      hints: [
        'LMB paint the texture;',
        'E to toggle erase mode.',
        'Ctrl/Cmd+Wheel adjusts brush size.',
        'Alt+Wheel changes tile elevation (Shift=coarse, Ctrl/Cmd=fine).',
        'Press S to commit the tile; ESC to cancel.'
      ],
      texturePaint: { available: false },
      textureOffset: { available: false },
      rotation: { available: false },
      scale: { available: false },
      layerOpacity: { available: false }
    };
  }

  _syncToolOptionsState({ suppressRender = true } = {}) {
    try {
      const handlers = {
        setTextureMode: (modeId) => {
          const fn = this._delegate?.setTextureMode;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, modeId); }
          catch (_) { return false; }
        },
        handleTextureAction: (actionId) => {
          const fn = this._delegate?.handleTextureAction;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, actionId); }
          catch (_) { return false; }
        },
        handleEditorAction: (actionId) => {
          const fn = this._delegate?.handleEditorAction;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, actionId); }
          catch (_) { return false; }
        },
        setTextureOpacity: (value, commit) => {
          const fn = this._delegate?.setTextureOpacity;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        },
        setBrushSize: (value, commit) => {
          const fn = this._delegate?.setBrushSize;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        },
        setParticleSize: (value, commit) => {
          const fn = this._delegate?.setParticleSize;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        },
        setParticleDensity: (value, commit) => {
          const fn = this._delegate?.setParticleDensity;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        },
        setSprayDeviation: (value, commit) => {
          const fn = this._delegate?.setSprayDeviation;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        },
        setBrushSpacing: (value, commit) => {
          const fn = this._delegate?.setBrushSpacing;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        },
        setRotation: (value, commit) => {
          const fn = this._delegate?.setRotation || this._delegate?.setTextureRotation;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        },
        setScale: (value, commit) => {
          const fn = this._delegate?.setScale || this._delegate?.setTextureScale;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        },
        setTextureOffset: (axis, value, commit) => {
          const fn = this._delegate?.setTextureOffset;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, axis, value, commit); }
          catch (_) { return false; }
        },
        setLayerOpacity: (value, commit) => {
          const fn = this._delegate?.setLayerOpacity;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        },
        setHeightThreshold: (axis, value, commit) => {
          const fn = this._delegate?.setHeightThreshold;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, axis, value, commit); }
          catch (_) { return false; }
        },
        setHeightContrast: (value, commit) => {
          const fn = this._delegate?.setHeightContrast;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        },
        setHeightLift: (value, commit) => {
          const fn = this._delegate?.setHeightLift;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate, value, commit); }
          catch (_) { return false; }
        },
        toggleHeightMapCollapsed: () => {
          const fn = this._delegate?.toggleHeightMapCollapsed;
          if (typeof fn !== 'function') return false;
          try { return fn.call(this._delegate); }
          catch (_) { return false; }
        }
      };
      const customToggles = this._delegate?.getCustomToggleHandlers?.();
      if (customToggles && typeof customToggles === 'object') {
        handlers.customToggles = customToggles;
      }
      toolOptionsController.setToolOptions('texture.paint', {
        state: this._buildToolOptionsState(),
        handlers,
        suppressRender
      });
    } catch (_) {}
  }
}

export default TexturePaintManager;
