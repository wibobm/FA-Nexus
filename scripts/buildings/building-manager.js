import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { premiumFeatureBroker } from '../premium/premium-feature-broker.js';
import { premiumEntitlementsService } from '../premium/premium-entitlements-service.js';
import { ensurePremiumFeaturesRegistered } from '../premium/premium-feature-registry.js';
import { toolOptionsController } from '../core/tool-options-controller.js';

const FEATURE_ID = 'building.edit';
const TOOL_LABEL = 'Building Editor';

export class BuildingManager {
  constructor(app) {
    this._app = app;
    this._delegate = null;
    this._loading = null;
    this._entitlementProbe = null;
    this._toolMonitor = null;
    this._portalMode = false;
    this._onToolOptionsChange = null;
  }

  /**
   * Register a callback to be notified when tool options state changes.
   * Useful for updating UI elements like portal texture thumbnails.
   * @param {Function|null} callback - Callback function receiving (state, handlers)
   */
  setToolOptionsChangeCallback(callback) {
    this._onToolOptionsChange = typeof callback === 'function' ? callback : null;
  }

  get isActive() {
    return !!this._delegate?.isActive;
  }

  get version() {
    return this._delegate?.version || '0.0.14';
  }

  async start(session = {}) {
    if (Object.prototype.hasOwnProperty.call(session || {}, 'portalMode')) {
      this._portalMode = !!session.portalMode;
    }
    const delegate = await this._ensureDelegate();
    let result;
    try {
      if (typeof delegate?.setPortalMode === 'function') {
        delegate.setPortalMode(this._portalMode);
      }
      result = delegate.start?.(session);
      // Sync tool options state BEFORE activating the tool to ensure the cached
      // state reflects the new session mode (e.g., 'inner' vs 'outer'). Otherwise,
      // activateTool would use stale cached state from the previous session.
      this._syncToolOptionsState({ suppressRender: true });
      toolOptionsController.activateTool(FEATURE_ID, { label: TOOL_LABEL });
      this._beginToolWindowMonitor(delegate);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          this._cancelToolWindowMonitor();
          toolOptionsController.deactivateTool(FEATURE_ID);
        });
      }
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  async editTile(tileDocument, options = {}) {
    if (Object.prototype.hasOwnProperty.call(options || {}, 'portalMode')) {
      this._portalMode = !!options.portalMode;
    }
    const delegate = await this._ensureDelegate();
    if (!delegate || typeof delegate.editTile !== 'function') {
      throw new Error('Installed building editor bundle does not support editing existing tiles.');
    }
    let result;
    try {
      if (typeof delegate?.setPortalMode === 'function') {
        delegate.setPortalMode(this._portalMode);
      }
      result = delegate.editTile(tileDocument, options);
      // Sync tool options state BEFORE activating the tool to ensure the cached
      // state reflects the new session mode. Otherwise, activateTool would use
      // stale cached state from the previous session.
      this._syncToolOptionsState({ suppressRender: true });
      toolOptionsController.activateTool(FEATURE_ID, { label: TOOL_LABEL });
      this._beginToolWindowMonitor(delegate);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          this._cancelToolWindowMonitor();
          toolOptionsController.deactivateTool(FEATURE_ID);
        });
      }
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  async updateWallPath(options = {}) {
    const delegate = await this._ensureDelegate();
    if (!delegate) {
      Logger.warn?.('BuildingManager.updateWallPath.delegateMissing', { options });
      return null;
    }
    if (typeof delegate.updateWallPath !== 'function') {
      Logger.warn?.('BuildingManager.updateWallPath.methodMissing', { options });
      return null;
    }
    try {
      return await delegate.updateWallPath(options);
    } catch (error) {
      Logger.warn?.('BuildingManager.updateWallPath.failed', { error: String(error?.message || error), options });
      throw error;
    }
  }

  async updateFillTexture(options = {}) {
    const delegate = await this._ensureDelegate();
    if (!delegate) {
      Logger.warn?.('BuildingManager.updateFillTexture.delegateMissing', { options });
      return null;
    }
    if (typeof delegate.updateFillTexture !== 'function') {
      Logger.warn?.('BuildingManager.updateFillTexture.methodMissing', { options });
      return null;
    }
    try {
      return await delegate.updateFillTexture(options);
    } catch (error) {
      Logger.warn?.('BuildingManager.updateFillTexture.failed', { error: String(error?.message || error), options });
      throw error;
    }
  }

  switchActiveMode(mode) {
    if (!this._delegate?.isActive) return;
    try {
      const result = this._delegate.switchActiveMode?.(mode);
      // If the delegate returns a promise (async switch), wait before refreshing UI.
      Promise.resolve(result).finally(() => {
        this._syncToolOptionsState({ suppressRender: false });
      });
      return result;
    } catch (error) {
      Logger.warn?.('BuildingManager.switchActiveMode.failed', { mode, error: String(error?.message || error) });
      return null;
    }
  }

  setActiveTool(toolId) {
    if (!this._delegate?.isActive) return;
    try {
      this._delegate.setActiveTool?.(toolId);
      this._syncToolOptionsState({ suppressRender: false });
    } catch (error) {
      Logger.warn?.('BuildingManager.setActiveTool.failed', { toolId, error: String(error?.message || error) });
    }
  }

  setPortalMode(enabled = false) {
    this._portalMode = !!enabled;
    if (typeof this._delegate?.setPortalMode === 'function') {
      try {
        this._delegate.setPortalMode(this._portalMode);
      } catch (error) {
        Logger.warn?.('BuildingManager.setPortalMode.failed', { enabled, error: String(error?.message || error) });
      }
    }
    this._syncToolOptionsState({ suppressRender: false });
    return this._portalMode;
  }

  forceExitPortalEditing() {
    try { this._delegate?.exitPortalEditingAllSessions?.(); }
    catch (error) { Logger.warn?.('BuildingManager.forceExitPortalEditing.failed', { error: String(error?.message || error) }); }
    this._portalMode = false;
    this._syncToolOptionsState({ suppressRender: false });
  }

  stop(...args) {
    this._cancelToolWindowMonitor();
    toolOptionsController.deactivateTool(FEATURE_ID);
    if (!this._delegate) return;
    try {
      return this._delegate.stop?.(...args);
    } catch (error) {
      Logger.warn?.('BuildingManager.stop.failed', { error: String(error?.message || error) });
      throw error;
    }
  }

  async _ensureDelegate() {
    if (this._delegate) return this._delegate;
    ensurePremiumFeaturesRegistered();
    if (this._loading) return this._loading;
    this._loading = (async () => {
      const helper = await premiumFeatureBroker.resolve(FEATURE_ID);
      let instance = null;
      if (helper?.create) instance = helper.create(this._app);
      else if (typeof helper === 'function') instance = new helper(this._app);
      if (!instance) throw new Error('Premium building editor bundle missing BuildingManager implementation');
      this._delegate = instance;
      try { instance.attachHost?.(this); }
      catch (_) {}
      try {
        if (typeof instance.setPortalMode === 'function') {
          instance.setPortalMode(this._portalMode);
        }
      } catch (_) {}
      try {
        Logger.info?.('BuildingEditor.bundle.loaded', { version: instance?.version || '0.0.14' });
        Hooks?.callAll?.('fa-nexus-building-editor-loaded', { version: instance?.version || '0.0.14' });
      } catch (logError) {
        Logger.warn?.('BuildingEditor.bundle.loaded.logFailed', String(logError?.message || logError));
      }
      return instance;
    })();
    try {
      return await this._loading;
    } finally {
      this._loading = null;
    }
  }

  _scheduleEntitlementProbe() {
    ensurePremiumFeaturesRegistered();
    if (this._entitlementProbe) return this._entitlementProbe;
    const probe = (async () => {
      try {
        await premiumFeatureBroker.require(FEATURE_ID, { revalidate: true, reason: 'building-edit:revalidate' });
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
    if (!this._hasPremiumAuth()) {
      Logger.info?.('BuildingManager.entitlement.skipDisconnect', {
        code: error?.code || error?.name,
        message: String(error?.message || error)
      });
      return;
    }
    const message = '🔐 Authentication expired - premium building editing has been disabled. Please reconnect Patreon.';
    if (this._isAuthFailure(error)) {
      try { premiumEntitlementsService?.clear?.({ reason: 'building-revalidate-failed' }); }
      catch (_) {}
      try { game?.settings?.set?.('fa-nexus', 'patreon_auth_data', null); }
      catch (_) {}
      ui?.notifications?.warn?.(message);
    } else {
      ui?.notifications?.error?.(`Unable to confirm premium access: ${error?.message || error}`);
    }
    try { Hooks?.callAll?.('fa-nexus-premium-auth-lost', { featureId: FEATURE_ID, error }); }
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
      const auth = game?.settings?.get?.('fa-nexus', 'patreon_auth_data');
      return !!(auth && auth.authenticated && auth.state);
    } catch (_) {
      return false;
    }
  }

  _beginToolWindowMonitor(delegate) {
    this._cancelToolWindowMonitor();
    if (!delegate) return;
    const token = { cancelled: false, handle: null, usingTimeout: false };
    const schedule = (callback) => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        token.usingTimeout = false;
        token.handle = window.requestAnimationFrame(callback);
      } else {
        token.usingTimeout = true;
        token.handle = setTimeout(callback, 200);
      }
    };
    const loop = () => {
      if (token.cancelled) return;
      if (!delegate?.isActive) {
        this._cancelToolWindowMonitor();
        toolOptionsController.deactivateTool(FEATURE_ID);
        return;
      }
      schedule(loop);
    };
    schedule(loop);
    this._toolMonitor = token;
  }

  _cancelToolWindowMonitor() {
    const token = this._toolMonitor;
    this._toolMonitor = null;
    if (!token) return;
    token.cancelled = true;
    if (token.handle != null) {
      if (token.usingTimeout) clearTimeout(token.handle);
      else cancelAnimationFrame(token.handle);
    }
  }

  requestToolOptionsUpdate(options = {}) {
    this._syncToolOptionsState(options);
  }

  _buildToolOptionsState() {
    const baseHints = [];
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
    } else if (typeof delegateState?.hints === 'string' && delegateState.hints.trim()) {
      mergedHints.push(delegateState.hints.trim());
    }
    const state = { ...delegateState, hints: mergedHints };
    return { state, handlers };
  }

  _syncToolOptionsState({ suppressRender = true } = {}) {
    try {
      const descriptor = this._buildToolOptionsState();
      toolOptionsController.setToolOptions(FEATURE_ID, {
        state: descriptor.state,
        handlers: descriptor.handlers,
        suppressRender
      });
      // Notify callback listeners of state change
      if (typeof this._onToolOptionsChange === 'function') {
        try {
          this._onToolOptionsChange(descriptor.state, descriptor.handlers);
        } catch (cbError) {
          Logger.warn?.('BuildingManager.toolOptionsChangeCallback.failed', { error: String(cbError?.message || cbError) });
        }
      }
    } catch (_) {}
  }
}

export default BuildingManager;
