import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { createCanvasGestureSession } from '../canvas/canvas-gesture-session.js';
import { getCanvasInteractionController, announceChange } from '../canvas/canvas-interaction-controller.js';
import { getAssetShadowManager } from './asset-shadow-manager.js';
import { toolOptionsController } from '../core/tool-options-controller.js';
import { PlacementOverlay, createPlacementSpinner } from '../core/placement/placement-overlay.js';
import { PlacementPrefetchQueue } from '../core/placement/placement-prefetch-queue.js';

const quantizeElevation = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const quantized = Math.round(numeric * 100) / 100;
  return Object.is(quantized, -0) ? 0 : quantized;
};

const formatElevation = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  const rounded = Math.round(numeric * 100) / 100;
  const normalized = Number(rounded.toFixed(2));
  const safeValue = Object.is(normalized, -0) ? 0 : normalized;
  return safeValue.toString();
};

const MIN_SCALE = 0.1;
const MAX_SCALE = 2.5;
const MAX_SHADOW_OFFSET = 40;
const MAX_SHADOW_DILATION = 20;
const MAX_SHADOW_BLUR = 12;
const SHADOW_PRESET_COUNT = 5;
const DEFAULT_SHADOW_SETTINGS = Object.freeze({
  alpha: 0.65,
  dilation: 1.6,
  blur: 1.8,
  offsetDistance: 0,
  offsetAngle: 135
});
const FREEZE_SHORTCUT_BLOCKED_INPUTS = new Set(['text', 'search', 'email', 'url', 'password', 'tel']);

export class AssetPlacementManager {
  constructor(app) {
    this.app = app;
    this.isPlacementActive = false;
    this.isStickyMode = false;
    this.currentAsset = null;
    this.isRandomMode = false;
    this.randomAssets = [];
    this.previewElement = null;
    this._previewContainer = null;
    this._loadingOverlay = null;
    this.currentRotation = 0;
    this._rotationRandomEnabled = false;
    this._rotationRandomStrength = 0;
    this.isDownloading = false;
    this.queuedPlacement = null; // {x,y}
    this._randomPrefetch = new PlacementPrefetchQueue({
      prefetchCount: 4,
      getItemKey: (asset) => this._assetKey(asset),
      needsPrefetch: (asset) => this._assetRequiresDownload(asset),
      prefetch: (asset) => this._ensureAssetLocal(asset),
      logger: Logger,
      loggerTag: 'AssetPlacement.prefetch'
    });
    this._interactionController = getCanvasInteractionController();
    this._gestureSession = null;
    this._suppressDragSelect = false;
    this._lastPointer = null;
    this._lastPointerWorld = null;
    this._previewFrozen = false;
    this._frozenPreviewWorld = null;
    this._frozenPointerScreen = null;
    // Track canvas zoom to keep preview sized accurately
    this._zoomWatcherId = null;
    this._lastZoom = 1;
     // Per-placement scale multiplier (Shift+wheel)
     this.currentScale = 1;
     // Elevation for the active placement session (Alt+wheel)
    this._previewElevation = 0;
    this._previewSort = 0;
    this._lastElevationAnnounce = 0;
    this._pendingElevationAnnouncePoint = null;
    this._elevationAnnounceTimer = null;
    // Drop shadow preference for the active placement session; null -> follow global
    this._dropShadowPreference = null;
    this._dropShadowSettingsHook = null;
    this._dropShadowAlpha = this._readShadowSetting('assetDropShadowAlpha', 0.65, 0, 1);
    this._dropShadowDilation = this._readShadowSetting('assetDropShadowDilation', 1.6, 0, MAX_SHADOW_DILATION);
    this._dropShadowBlur = this._readShadowSetting('assetDropShadowBlur', 1.8, 0, MAX_SHADOW_BLUR);
    this._dropShadowOffsetDistance = this._readShadowSetting('assetDropShadowOffsetDistance', 0, 0, MAX_SHADOW_OFFSET);
    this._dropShadowOffsetAngle = this._readShadowSetting('assetDropShadowOffsetAngle', 135, 0, 359, { wrapAngle: true });
    this._shadowPresets = this._loadShadowPresets();
    this._shadowSettingsCollapsed = this._readShadowSettingsCollapsed();
    this._shadowElevationContext = { elevation: 0, tileCount: 0, hasTiles: false, source: 'default' };
    this._shadowPreviewTextureListener = null;
    this._shadowOffsetPreview = null;
    this._shadowPreviewFrame = null;
    this._shadowPreviewPendingSignature = null;
    this._shadowPreviewRendering = false;
    this._shadowPreviewSequence = 0;
    this._shadowPreviewRequestedId = 0;
    this._shadowPreviewForce = false;
    this._currentRandomOffset = 0;
    this._pendingRotation = 0;
    this._scaleRandomEnabled = false;
    this._scaleRandomStrength = 0;
    this._currentScaleOffset = 0;
    this._pendingScale = 1;
    this._flipHorizontal = false;
    this._flipVertical = false;
    this._flipRandomHorizontalEnabled = false;
    this._flipRandomVerticalEnabled = false;
    this._flipRandomHorizontalOffset = false;
    this._flipRandomVerticalOffset = false;
    this._pendingFlipHorizontal = false;
    this._pendingFlipVertical = false;
    this._editingTile = null;
    this._isEditingExistingTile = false;
    this._pendingEditState = null;
    this._lastElevationUsed = 0;
    this._editingTileObject = null;
    this._editingTileVisibilitySnapshot = null;
    this._editingCommitTimer = null;
    this._editingTileShadowSuspended = false;
    this._replaceOriginalOnPlace = false;
    this._installDropShadowSettingsHook();
    this._syncToolOptionsState();
  }

  _handleDropShadowOffsetChange(distance, angle, commit = false) {
    const numericDistance = Number(distance);
    const numericAngle = Number(angle);
    if (!Number.isFinite(numericDistance) || !Number.isFinite(numericAngle)) {
      this._syncToolOptionsState();
      return false;
    }
    const clampedDistance = Math.min(MAX_SHADOW_OFFSET, Math.max(0, numericDistance));
    const normalizedAngle = this._normalizeShadowAngle(numericAngle);
    const distanceChanged = Math.abs(clampedDistance - this._dropShadowOffsetDistance) > 0.0005;
    const angleChanged = Math.abs(normalizedAngle - this._dropShadowOffsetAngle) > 0.0005;
    if (!distanceChanged && !angleChanged && !commit) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowOffsetDistance = clampedDistance;
    this._dropShadowOffsetAngle = normalizedAngle;
    this._updatePreviewShadow();
    if (commit) {
      this._persistShadowSetting('assetDropShadowOffsetDistance', clampedDistance);
      this._persistShadowSetting('assetDropShadowOffsetAngle', normalizedAngle);
    }
    this._syncToolOptionsState();
    if (commit) {
      this._propagateShadowSettingsToElevation();
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    }
    return true;
  }

  _handleDropShadowOffsetReset() {
    return this._handleDropShadowOffsetChange(
      DEFAULT_SHADOW_SETTINGS.offsetDistance,
      DEFAULT_SHADOW_SETTINGS.offsetAngle,
      true
    );
  }

  _handleDropShadowCollapseToggle() {
    this._shadowSettingsCollapsed = !this._shadowSettingsCollapsed;
    this._persistShadowCollapsed(this._shadowSettingsCollapsed);
    this._syncToolOptionsState({ suppressRender: false });
  }

  _handleDropShadowPresetAction(index, { save = false } = {}) {
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= SHADOW_PRESET_COUNT) {
      return false;
    }
    if (!Array.isArray(this._shadowPresets)) this._shadowPresets = this._loadShadowPresets();
    if (save) {
      const snapshot = this._normalizeShadowSnapshot(this._currentShadowSnapshot());
      if (!snapshot) {
        this._syncToolOptionsState();
        return false;
      }
      this._shadowPresets[idx] = snapshot;
      this._persistShadowPresets();
      this._syncToolOptionsState({ suppressRender: false });
      try { Logger.info('Placement.shadow.preset.save', { slot: idx + 1, snapshot }); } catch (_) {}
      return true;
    }

    const preset = this._shadowPresets[idx] || null;
    if (!preset) {
      try { ui.notifications?.warn?.('Preset slot is empty. Shift+Click a slot to save the current shadow settings.'); } catch (_) {}
      return false;
    }
    this._applyShadowSettingsSnapshot(preset, { persist: true, notify: true, propagate: true, sync: true, force: true });
    if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    return true;
  }

  _handleDropShadowReset() {
    this._applyShadowSettingsSnapshot(DEFAULT_SHADOW_SETTINGS, { persist: true, notify: true, propagate: true, sync: true, force: true });
    if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
  }

  startPlacement(assetData, stickyMode = false, options = {}) {
    const previousPreference = this.isDropShadowEnabled();
    this.cancelPlacement('replace');
    this._replaceOriginalOnPlace = false;
    this._ensurePointerSnapshot(options);
    this._dropShadowPreference = previousPreference;
    this._notifyDropShadowChanged();
    this.isPlacementActive = true;
    this.isStickyMode = stickyMode;
    this.currentAsset = assetData;
    this.isRandomMode = false;
    this.randomAssets = [];
    this._pendingEditState = null;
    this.currentRotation = 0;
    this._rotationRandomEnabled = false;
    this._rotationRandomStrength = 45;
    this._currentRandomOffset = 0;
    this._pendingRotation = this.currentRotation;
    this._updateRotationPreview();
    this._scaleRandomEnabled = false;
    this._scaleRandomStrength = 0;
    this._currentScaleOffset = 0;
    this.currentScale = 1;
    this._pendingScale = this.currentScale;
    this._updateScalePreview();
    this._flipHorizontal = false;
    this._flipVertical = false;
    this._flipRandomHorizontalEnabled = false;
    this._flipRandomVerticalEnabled = false;
    this._flipRandomHorizontalOffset = false;
    this._flipRandomVerticalOffset = false;
    this._pendingFlipHorizontal = this._flipHorizontal;
    this._pendingFlipVertical = this._flipVertical;
    this._updateFlipPreview();
    this._activateToolOptions();
    try { Logger.info('Placement.start', { sticky: !!stickyMode, kind: 'single', asset: assetData?.filename || assetData?.path }); } catch (_) {}
    const initialElevation = Number.isFinite(this._lastElevationUsed) ? this._lastElevationUsed : 0;
    this._previewElevation = initialElevation;
    this._previewSort = this._interactionController.computeNextSortAtElevation?.(initialElevation) ?? 0;
    this._lastElevationUsed = this._previewElevation;
    this._lastElevationAnnounce = 0;
    this._clearElevationAnnounceTimer();
    this._refreshShadowElevationContext({ adopt: true });
    this._activateTilesLayer();
    this._startInteractionSession();
    this._addPlacementFeedback();
    Promise.resolve(this._prepareCurrentAssetPreview({ initial: true })).catch((error) => {
      Logger.warn('Placement.prepare.failed', String(error?.message || error));
    });
  }

  async editTile(tileDocument, options = {}) {
    try {
      if (!tileDocument) throw new Error('Tile document required');
      const doc = tileDocument.document ?? tileDocument;
      if (!doc) throw new Error('Tile document unavailable');
      if (!doc.texture || !doc.texture.src) throw new Error('Tile is missing a texture source');

      const assetData = this._buildAssetDataFromTile(doc);
      if (!assetData) throw new Error('Unable to derive asset data from tile');

      this.cancelPlacement('replace');

      this.currentAsset = assetData;
      this.isPlacementActive = true;
      this.isStickyMode = false;
      this.isRandomMode = false;
      this.randomAssets = [];
      this._editingTile = doc;
      this._replaceOriginalOnPlace = true;
      this._isEditingExistingTile = true;
      this._pendingEditState = null;

      const tileObj = doc?.object || null;
      this._editingTileObject = tileObj || null;
      this._editingTileVisibilitySnapshot = tileObj ? this._captureTileVisibility(tileObj) : null;
      if (tileObj) {
        this._releaseTileSelection(tileObj);
        this._hideTileForEditing(tileObj);
      }
      this._editingTileShadowSuspended = this._suspendEditingTileShadow(doc);

      const centerWorld = (() => {
        if (options.pointerWorld && Number.isFinite(options.pointerWorld.x) && Number.isFinite(options.pointerWorld.y)) {
          return { x: Number(options.pointerWorld.x), y: Number(options.pointerWorld.y) };
        }
        const px = Number(doc.x || 0);
        const py = Number(doc.y || 0);
        const w = Number(doc.width || 0);
        const h = Number(doc.height || 0);
        return { x: px + w / 2, y: py + h / 2 };
      })();

      const pointerOption = (() => {
        if (options.pointer && Number.isFinite(options.pointer.x) && Number.isFinite(options.pointer.y)) {
          return { x: Number(options.pointer.x), y: Number(options.pointer.y) };
        }
        if (canvas?.stage && centerWorld) {
          try {
            const stagePoint = canvas.stage.worldTransform.apply(new PIXI.Point(centerWorld.x, centerWorld.y));
            const canvasEl = canvas.app?.view || document.querySelector('canvas#board');
            if (canvasEl) {
              const rect = canvasEl.getBoundingClientRect();
              return { x: rect.left + stagePoint.x, y: rect.top + stagePoint.y };
            }
          } catch (_) {}
        }
        return null;
      })();

      this._ensurePointerSnapshot({
        pointer: pointerOption || options.pointer || null,
        pointerWorld: options.pointerWorld || centerWorld
      });

      const initialElevation = Number.isFinite(doc.elevation) ? Number(doc.elevation) : (Number.isFinite(this._lastElevationUsed) ? this._lastElevationUsed : 0);
      this._previewElevation = initialElevation;
      this._lastElevationUsed = this._previewElevation;
      this._previewSort = Number(doc.sort ?? 0) || 0;
      this._lastElevationAnnounce = 0;
      this._clearElevationAnnounceTimer();

      this._activateToolOptions();
      this._activateTilesLayer();
      this._removePreviewElement();
      this._createPreviewElement();

      if (this._previewContainer) {
        this._previewContainer.x = centerWorld.x;
        this._previewContainer.y = centerWorld.y;
      }
      this._lastPointer = null;
      this._lastPointerWorld = { ...centerWorld };

      this._applyTileStateToPlacement(doc, { force: true });
      this._isEditingExistingTile = false;
      this._refreshShadowElevationContext({ adopt: false, sync: true });
      this._syncToolOptionsState({ suppressRender: false });
      this._setPlacementFreeze(true, { announce: false });

      this._startInteractionSession();
      return true;
    } catch (error) {
      Logger.warn('Placement.editTile.failed', String(error?.message || error));
      ui.notifications?.error?.(`Unable to edit asset: ${error?.message || error}`);
      this._restoreEditingTileVisibility();
      this._resumeEditingTileShadow();
      this._editingTileObject = null;
      this._editingTileVisibilitySnapshot = null;
      this._editingTile = null;
      this._isEditingExistingTile = false;
      this._pendingEditState = null;
      this._replaceOriginalOnPlace = false;
      this._editingTileShadowSuspended = false;
      return false;
    }
  }

  startPlacementRandom(assetList, stickyMode = true, options = {}) {
    try {
      if (!Array.isArray(assetList) || !assetList.length) { this.startPlacement(assetList?.[0], stickyMode, options); return; }
      const previousPreference = this.isDropShadowEnabled();
      this.cancelPlacement('replace');
      this._ensurePointerSnapshot(options);
      this._dropShadowPreference = previousPreference;
      this._notifyDropShadowChanged();
      this.isPlacementActive = true;
      this.isStickyMode = stickyMode;
      this.isRandomMode = true;
      this.randomAssets = assetList.slice();
      this.currentAsset = null;
      try { this._randomPrefetch?.setPool?.(this.randomAssets); } catch (_) {}
      this.currentRotation = 0;
      this._rotationRandomEnabled = false;
      this._rotationRandomStrength = 45;
      this._currentRandomOffset = 0;
      this._pendingRotation = this.currentRotation;
      this._updateRotationPreview();
      this._scaleRandomEnabled = false;
      this._scaleRandomStrength = 0;
      this._currentScaleOffset = 0;
      this.currentScale = 1;
      this._pendingScale = this.currentScale;
      this._updateScalePreview();
      this._flipHorizontal = false;
      this._flipVertical = false;
      this._flipRandomHorizontalEnabled = false;
      this._flipRandomVerticalEnabled = false;
      this._flipRandomHorizontalOffset = false;
      this._flipRandomVerticalOffset = false;
      this._pendingFlipHorizontal = this._flipHorizontal;
      this._pendingFlipVertical = this._flipVertical;
      this._updateFlipPreview();
      this._activateToolOptions();
    const initialElevation = Number.isFinite(this._lastElevationUsed) ? this._lastElevationUsed : 0;
    this._previewElevation = initialElevation;
    this._previewSort = this._interactionController.computeNextSortAtElevation?.(initialElevation) ?? 0;
    this._lastElevationUsed = this._previewElevation;
    this._lastElevationAnnounce = 0;
    this._clearElevationAnnounceTimer();
    Logger.info('Placement.startRandom', { sticky: !!stickyMode, count: this.randomAssets.length });
    this._activateTilesLayer();
    this._refreshShadowElevationContext({ adopt: true });
      this._startInteractionSession();
      this._addPlacementFeedback();
      try { this._randomPrefetch?.prime?.(); } catch (_) {}
      this._switchToNextRandomAsset(true);
    } catch (_) {
      this.startPlacement(assetList?.[0], stickyMode, options);
    }
  }

  cancelPlacement(reason = 'user') {
    if (!this.isPlacementActive) {
      this._setPlacementFreeze(false, { announce: false, sync: false });
      return;
    }
    this.isPlacementActive = false;
    this.isStickyMode = false;
    this.currentAsset = null;
    this._restoreEditingTileVisibility();
    this._resumeEditingTileShadow();
    this._editingTileObject = null;
    this._editingTileVisibilitySnapshot = null;
    this._editingTileShadowSuspended = false;
    this._replaceOriginalOnPlace = false;
    if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    if (this._editingCommitTimer) {
      try { clearTimeout(this._editingCommitTimer); }
      catch (_) {}
      this._editingCommitTimer = null;
    }
    this._editingTile = null;
    this._isEditingExistingTile = false;
    this._pendingEditState = null;
    this.isRandomMode = false;
    this.randomAssets = [];
    this._rotationRandomEnabled = false;
    this._scaleRandomEnabled = false;
    const maintainToolUI = reason === 'replace' || reason === 'restart';
    if (!maintainToolUI) {
      this._deactivateToolOptions();
    }
    this.currentRotation = 0;
    this.currentScale = 1;
    this._rotationRandomStrength = 45;
    this._currentRandomOffset = 0;
    this._pendingRotation = 0;
    this._scaleRandomStrength = 0;
    this._currentScaleOffset = 0;
    this._pendingScale = 1;
    this._flipHorizontal = false;
    this._flipVertical = false;
    this._flipRandomHorizontalEnabled = false;
    this._flipRandomVerticalEnabled = false;
    this._flipRandomHorizontalOffset = false;
    this._flipRandomVerticalOffset = false;
    this._pendingFlipHorizontal = false;
    this._pendingFlipVertical = false;
    this._updateRotationPreview();
    this._updateScalePreview();
    this._updateFlipPreview();
    this._removePreviewElement();
    this._hideLoadingOverlay();
    this._stopInteractionSession();
    this._removePlacementFeedback();
    this._clearElevationAnnounceTimer();
    this._lastElevationAnnounce = 0;
    this._setPlacementFreeze(false, { announce: false, sync: false });
    // Notify ESC-based cancellation so selection can be cleared by tab
    try {
      if (reason === 'esc') {
        const target = this.app?.element || document;
        target?.dispatchEvent?.(new CustomEvent('fa-nexus:placement-cancelled', { bubbles: true }));
      }
    } catch (_) {}
    // Reset prefetch state
    try { this._randomPrefetch?.reset?.(); Logger.info('Placement.queue.reset', { reason }); } catch (_) {}
    // Revert drop shadow preference so the next placement defaults to global setting
    this._dropShadowPreference = null;
    this._notifyDropShadowChanged();
  }

  _getAssetBasePxPerSquare() { return 200; }

  /**
   * Apply grid snapping to world coordinates for asset placement
   * Uses half-grid increments for more precise positioning (corners, edges, centers)
   * @param {Object} worldCoords - World coordinates {x, y}
   * @returns {Object} Snapped coordinates {x, y}
   */
  _applyGridSnapping(worldCoords) {
    if (!canvas.grid || !canvas.scene || !this.currentAsset) {
      return worldCoords;
    }

    const gridSnapEnabled = !!game.settings.get('fa-nexus', 'gridSnap');
    if (!gridSnapEnabled) {
      return worldCoords;
    }

    try {
      const gridSize = canvas.scene.grid.size;
      // Use half-grid increments for finer snapping (allows corners, edges, and centers)
      const halfGrid = gridSize / 2;

      // Snap to nearest half-grid increment
      const snapX = Math.round(worldCoords.x / halfGrid) * halfGrid;
      const snapY = Math.round(worldCoords.y / halfGrid) * halfGrid;

      return { x: snapX, y: snapY };
    } catch (error) {
      console.warn('fa-nexus | Asset grid snapping failed, using raw coordinates:', error);
      return worldCoords;
    }
  }

  _normalizeRotation(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return ((num % 360) + 360) % 360;
  }

  _hasRandomRotationEnabled() {
    return !!this._rotationRandomEnabled && Math.max(0, Math.min(180, Number(this._rotationRandomStrength) || 0)) > 0;
  }

  _getPendingRotation() {
    const value = Number(this._pendingRotation);
    if (Number.isFinite(value)) return this._normalizeRotation(value);
    return this._normalizeRotation(this.currentRotation);
  }

  _applyPendingRotationToPreview() {
    try {
      const rotation = this._getPendingRotation();
      if (this._previewContainer?._sprite) {
        this._previewContainer._sprite.rotation = (rotation * Math.PI) / 180;
      }
      this._updatePreviewShadow();
      this._scheduleShadowOffsetPreviewUpdate();
    } catch (_) {}
  }

  _updateRotationPreview({ regenerateOffset = false, clampOffset = false } = {}) {
    const base = this._normalizeRotation(this.currentRotation);
    if (!this._hasRandomRotationEnabled()) {
      this._currentRandomOffset = 0;
      this._pendingRotation = base;
      this._applyPendingRotationToPreview();
      return;
    }
    const limit = Math.max(0, Math.min(180, Number(this._rotationRandomStrength) || 0));
    if (regenerateOffset || !Number.isFinite(this._currentRandomOffset)) {
      this._currentRandomOffset = (Math.random() * 2 - 1) * limit;
    } else if (clampOffset) {
      this._currentRandomOffset = Math.max(-limit, Math.min(limit, this._currentRandomOffset));
    }
    this._pendingRotation = this._normalizeRotation(base + this._currentRandomOffset);
    this._applyPendingRotationToPreview();
  }

  _prepareNextPlacementRotation() {
    if (!this.isPlacementActive) return;
    const regenerate = this._hasRandomRotationEnabled();
    this._updateRotationPreview({ regenerateOffset: regenerate, clampOffset: true });
    this._syncToolOptionsState();
  }

  _clampScale(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return MIN_SCALE;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, num));
  }

  _hasRandomScaleEnabled() {
    return !!this._scaleRandomEnabled && Math.max(0, Math.min(100, Number(this._scaleRandomStrength) || 0)) > 0;
  }

  _getPendingScale() {
    const value = Number(this._pendingScale);
    if (Number.isFinite(value)) return this._clampScale(value);
    return this._clampScale(this.currentScale);
  }

  _applyPendingScaleToPreview() {
    try {
      const scale = this._getPendingScale();
      if (this._previewContainer) {
        this._previewContainer._scaleMul = scale;
        this._applyZoomToPreview(canvas?.stage?.scale?.x || 1);
      }
      this._updatePreviewShadow();
      this._scheduleShadowOffsetPreviewUpdate();
    } catch (_) {}
  }

  _updateScalePreview({ regenerateOffset = false, clampOffset = false } = {}) {
    const base = this._clampScale(this.currentScale);
    if (!this._hasRandomScaleEnabled()) {
      this._currentScaleOffset = 0;
      this._pendingScale = base;
      this._applyPendingScaleToPreview();
      return;
    }
    const strengthPercent = Math.max(0, Math.min(100, Number(this._scaleRandomStrength) || 0));
    if (strengthPercent <= 0) {
      this._currentScaleOffset = 0;
      this._pendingScale = base;
      this._applyPendingScaleToPreview();
      return;
    }
    const limit = strengthPercent / 100;
    if (regenerateOffset || !Number.isFinite(this._currentScaleOffset)) {
      this._currentScaleOffset = (Math.random() * 2 - 1) * limit;
    } else if (clampOffset) {
      this._currentScaleOffset = Math.max(-limit, Math.min(limit, this._currentScaleOffset));
    }
    let pending = this._clampScale(base * (1 + this._currentScaleOffset));
    if (pending <= 0) pending = base;
    if (base > 0) {
      this._currentScaleOffset = Math.max(-limit, Math.min(limit, pending / base - 1));
    } else {
      this._currentScaleOffset = 0;
    }
    this._pendingScale = pending;
    this._applyPendingScaleToPreview();
  }

  _prepareNextPlacementScale() {
    if (!this.isPlacementActive) return;
    const regenerate = this._hasRandomScaleEnabled();
    this._updateScalePreview({ regenerateOffset: regenerate, clampOffset: true });
    this._syncToolOptionsState();
  }

  _hasRandomFlipEnabled() {
    return !!this._flipRandomHorizontalEnabled || !!this._flipRandomVerticalEnabled;
  }

  _getPendingFlipState() {
    return {
      horizontal: !!this._pendingFlipHorizontal,
      vertical: !!this._pendingFlipVertical
    };
  }

  _applyPendingFlipToPreview({ forceShadow = false, syncShadow = true } = {}) {
    try {
      const sprite = this._previewContainer?._sprite;
      if (!sprite) return;
      const currentX = Number(sprite.scale?.x ?? 1) || 1;
      const currentY = Number(sprite.scale?.y ?? 1) || 1;
      const magnitudeX = Math.abs(currentX) || 1;
      const magnitudeY = Math.abs(currentY) || 1;
      const signX = this._pendingFlipHorizontal ? -1 : 1;
      const signY = this._pendingFlipVertical ? -1 : 1;
      if (!Number.isFinite(sprite.scale.x) || sprite.scale.x !== magnitudeX * signX) {
        sprite.scale.x = magnitudeX * signX;
      }
      if (!Number.isFinite(sprite.scale.y) || sprite.scale.y !== magnitudeY * signY) {
        sprite.scale.y = magnitudeY * signY;
      }
      if (syncShadow) {
        if (forceShadow) this._updatePreviewShadow({ force: true });
        else this._updatePreviewShadow();
      }
      this._scheduleShadowOffsetPreviewUpdate();
    } catch (_) {}
  }

  _updateFlipPreview({ regenerateOffsets = false } = {}) {
    const baseHorizontal = !!this._flipHorizontal;
    const baseVertical = !!this._flipVertical;

    if (this._flipRandomHorizontalEnabled) {
      if (regenerateOffsets || this._flipRandomHorizontalOffset === null || this._flipRandomHorizontalOffset === undefined) {
        this._flipRandomHorizontalOffset = Math.random() < 0.5;
      }
      this._pendingFlipHorizontal = this._flipRandomHorizontalOffset ? !baseHorizontal : baseHorizontal;
    } else {
      this._flipRandomHorizontalOffset = false;
      this._pendingFlipHorizontal = baseHorizontal;
    }

    if (this._flipRandomVerticalEnabled) {
      if (regenerateOffsets || this._flipRandomVerticalOffset === null || this._flipRandomVerticalOffset === undefined) {
        this._flipRandomVerticalOffset = Math.random() < 0.5;
      }
      this._pendingFlipVertical = this._flipRandomVerticalOffset ? !baseVertical : baseVertical;
    } else {
      this._flipRandomVerticalOffset = false;
      this._pendingFlipVertical = baseVertical;
    }

    this._applyPendingFlipToPreview({ forceShadow: true });
  }

  _prepareNextPlacementFlip() {
    if (!this.isPlacementActive) return;
    const regenerate = this._hasRandomFlipEnabled();
    this._updateFlipPreview({ regenerateOffsets: regenerate });
    this._syncToolOptionsState();
  }

  _isGlobalDropShadowEnabled() {
    try { return !!game.settings.get('fa-nexus', 'assetDropShadow'); }
    catch (_) { return false; }
  }

  setDropShadowEnabled(enabled) {
    return this._handleDropShadowToggleRequest(enabled);
  }

  isDropShadowEnabled() {
    if (this._dropShadowPreference === null || this._dropShadowPreference === undefined) {
      return this._isGlobalDropShadowEnabled();
    }
    return !!this._dropShadowPreference;
  }

  _notifyDropShadowChanged() {
    try {
      const target = this.app?.element || document;
      target?.dispatchEvent?.(new CustomEvent('fa-nexus:drop-shadow-updated', { bubbles: true }));
    } catch (_) {}
    this._syncToolOptionsState();
  }

  _activateToolOptions() {
    try {
      this._syncToolOptionsState({ suppressRender: false });
      toolOptionsController.activateTool('asset.placement', { label: 'Asset Placement' });
    } catch (_) {}
  }

  _deactivateToolOptions() {
    try { toolOptionsController.deactivateTool('asset.placement'); } catch (_) {}
  }

  refreshToolOptions() {
    this._syncToolOptionsState({ suppressRender: false });
  }

  _buildToolOptionsState() {
    const globalEnabled = this._isGlobalDropShadowEnabled();
    const preference = this.isDropShadowEnabled();
    const dropShadowEnabled = globalEnabled ? !!preference : false;
    const tooltip = globalEnabled
      ? 'Toggle drop shadows for tiles placed during this session.'
      : 'Enable drop shadows in FA Nexus settings to use this toggle.';
    const hint = globalEnabled
      ? ''
      : 'Enable drop shadows in the FA Nexus module settings to unlock this toggle.';
    const freezeHint = this._previewFrozen
      ? 'Preview frozen — press Space to resume following your cursor.'
      : 'Press Space to freeze the preview while adjusting sliders.';
    const hints = [
      'Click to place; ESC to cancel.',
      'Ctrl/Cmd+Wheel rotates (add Shift for 1° steps);',
      'Shift+Wheel scales;',
      'Alt+Wheel adjusts elevation (Shift=coarse, Ctrl/Cmd=fine).',
      freezeHint
    ];
    return {
      dropShadow: {
        available: true,
        enabled: dropShadowEnabled,
        disabled: !globalEnabled,
        tooltip,
        hint
      },
      dropShadowControls: this._buildDropShadowControlsState({
        available: true,
        enabled: dropShadowEnabled
      }),
      flip: this._buildFlipToolState(),
      scale: this._buildScaleToolState(),
      rotation: this._buildRotationToolState(),
      hints
    };
  }

  _togglePlacementFreeze() {
    return this._setPlacementFreeze(!this._previewFrozen);
  }

  _setPlacementFreeze(enabled, { announce = true, sync = true } = {}) {
    const next = !!enabled;
    if (next) {
      if (!this.isPlacementActive || this._isEditingExistingTile) {
        if (sync) this._syncToolOptionsState();
        return false;
      }
      const anchor = this._getPreviewWorldPosition();
      if (!anchor) {
        if (announce) {
          announceChange('asset-placement-freeze', 'Preview not ready to freeze yet.', { throttleMs: 1200, level: 'info' });
        }
        if (sync) this._syncToolOptionsState();
        return false;
      }
      const snapped = this._applyGridSnapping(anchor);
      this._previewFrozen = true;
      this._frozenPreviewWorld = { x: snapped.x, y: snapped.y };
      this._lastPointerWorld = { x: snapped.x, y: snapped.y };
      this._refreshFrozenPointerScreen();
      this._applyPlacementFreezeClass();
      if (announce) {
        announceChange('asset-placement-freeze', 'Preview frozen. Press Space again to unlock.', { throttleMs: 2000 });
      }
      if (sync) this._syncToolOptionsState();
      return true;
    }

    const wasFrozen = this._previewFrozen;
    this._previewFrozen = false;
    this._frozenPreviewWorld = null;
    this._frozenPointerScreen = null;
    this._applyPlacementFreezeClass();
    if (announce && wasFrozen) {
      announceChange('asset-placement-freeze', 'Preview following the cursor again.', { throttleMs: 2000 });
    }
    if (this._loadingOverlay?.overlay && this._lastPointer) {
      this._updateLoadingOverlayPointer(this._lastPointer.x, this._lastPointer.y);
    }
    if (sync) this._syncToolOptionsState();
    return true;
  }

  _getPreviewWorldPosition() {
    if (this._previewContainer && Number.isFinite(this._previewContainer.x) && Number.isFinite(this._previewContainer.y)) {
      return { x: Number(this._previewContainer.x), y: Number(this._previewContainer.y) };
    }
    if (this._frozenPreviewWorld && Number.isFinite(this._frozenPreviewWorld.x) && Number.isFinite(this._frozenPreviewWorld.y)) {
      return { x: this._frozenPreviewWorld.x, y: this._frozenPreviewWorld.y };
    }
    if (this._lastPointerWorld && Number.isFinite(this._lastPointerWorld.x) && Number.isFinite(this._lastPointerWorld.y)) {
      return { x: this._lastPointerWorld.x, y: this._lastPointerWorld.y };
    }
    if (this._lastPointer && Number.isFinite(this._lastPointer.x) && Number.isFinite(this._lastPointer.y)) {
      return this._screenToCanvas(this._lastPointer.x, this._lastPointer.y);
    }
    return null;
  }

  _applyPlacementFreezeClass() {
    try {
      const el = this.app?.element;
      if (!el) return;
      if (this._previewFrozen) el.classList.add('placement-frozen');
      else el.classList.remove('placement-frozen');
    } catch (_) {}
  }

  _refreshFrozenPointerScreen() {
    if (!this._previewFrozen || !this._frozenPreviewWorld) {
      this._frozenPointerScreen = null;
      return;
    }
    const screen = this._canvasToScreen(this._frozenPreviewWorld.x, this._frozenPreviewWorld.y);
    this._frozenPointerScreen = screen;
    if (screen) {
      this._updateLoadingOverlayPointer(screen.x, screen.y);
    }
  }

  _shouldIgnoreFreezeShortcut(target) {
    if (!target) return false;
    try {
      if (target.isContentEditable) return true;
      const tag = String(target.tagName || '').toLowerCase();
      if (tag === 'textarea') return true;
      if (tag !== 'input') return false;
      const type = String(target.type || '').toLowerCase();
      return FREEZE_SHORTCUT_BLOCKED_INPUTS.has(type);
    } catch (_) {
      return false;
    }
  }

  _formatFlipSummary(state) {
    const horizontal = !!state?.horizontal;
    const vertical = !!state?.vertical;
    if (horizontal && vertical) return 'H & V';
    if (horizontal) return 'H';
    if (vertical) return 'V';
    return 'None';
  }

  _buildFlipToolState() {
    const base = { horizontal: !!this._flipHorizontal, vertical: !!this._flipVertical };
    const pending = this._getPendingFlipState();
    const randomActive = this._hasRandomFlipEnabled();
    const baseSummary = this._formatFlipSummary(base);
    const previewSummary = this._formatFlipSummary(pending);
    const previewMatches = base.horizontal === pending.horizontal && base.vertical === pending.vertical;
    const display = randomActive ? `${previewSummary} preview` : baseSummary;
    const previewDisplay = !previewMatches ? `Preview: ${previewSummary}` : '';
    const horizontalPreviewDiff = pending.horizontal !== base.horizontal;
    const verticalPreviewDiff = pending.vertical !== base.vertical;
    const horizontalRandomEnabled = !!this._flipRandomHorizontalEnabled;
    const verticalRandomEnabled = !!this._flipRandomVerticalEnabled;
    return {
      available: true,
      display,
      previewDisplay,
      previewMatchesBase: previewMatches,
      randomActive,
      randomHint: 'Randomizes flips per placement on the selected axes.',
      horizontal: {
        active: base.horizontal,
        pending: pending.horizontal,
        label: 'Flip H',
        tooltip: 'Mirror asset left/right.',
        previewDiff: randomActive && horizontalPreviewDiff,
        aria: 'Toggle horizontal mirroring',
        disabled: false,
        randomEnabled: horizontalRandomEnabled,
        randomLabel: horizontalRandomEnabled ? 'Random On' : 'Random',
        randomTooltip: horizontalRandomEnabled ? 'Disable random horizontal flip' : 'Enable random horizontal flip',
        randomDisabled: false,
        randomAria: 'Toggle random horizontal mirroring',
        randomPreviewDiff: horizontalRandomEnabled && horizontalPreviewDiff
      },
      vertical: {
        active: base.vertical,
        pending: pending.vertical,
        label: 'Flip V',
        tooltip: 'Mirror asset top/bottom.',
        previewDiff: randomActive && verticalPreviewDiff,
        aria: 'Toggle vertical mirroring',
        disabled: false,
        randomEnabled: verticalRandomEnabled,
        randomLabel: verticalRandomEnabled ? 'Random On' : 'Random',
        randomTooltip: verticalRandomEnabled ? 'Disable random vertical flip' : 'Enable random vertical flip',
        randomDisabled: false,
        randomAria: 'Toggle random vertical mirroring',
        randomPreviewDiff: verticalRandomEnabled && verticalPreviewDiff
      }
    };
  }

  _buildScaleToolState() {
    const base = this._clampScale(this.currentScale);
    const preview = this._getPendingScale();
    const basePercent = Math.round(base * 100);
    const previewPercent = Math.round(preview * 100);
    const strengthPercent = Math.round(Math.max(0, Math.min(100, Number(this._scaleRandomStrength) || 0)));
    const randomToggleOn = !!this._scaleRandomEnabled;
    const randomActive = this._hasRandomScaleEnabled();
    return {
      available: true,
      min: 10,
      max: 250,
      step: 1,
      value: basePercent,
      display: randomActive ? `${previewPercent}% preview` : `${basePercent}%`,
      randomEnabled: randomToggleOn,
      strength: strengthPercent,
      strengthMin: 0,
      strengthMax: 100,
      strengthStep: 1,
      strengthDisplay: `±${strengthPercent}%`,
      randomLabel: randomToggleOn ? 'Random On' : 'Random',
      randomTooltip: randomToggleOn ? 'Disable random scale' : 'Enable random scale',
      randomHint: 'Applies a random scale offset around the base value for each placement.'
    };
  }

  _buildRotationToolState() {
    const base = this._normalizeRotation(this.currentRotation);
    const preview = this._getPendingRotation();
    const strength = Math.max(0, Math.min(180, Number(this._rotationRandomStrength) || 0));
    const randomToggleOn = !!this._rotationRandomEnabled;
    const randomActive = this._hasRandomRotationEnabled();
    const baseDisplay = `${Math.round(base)}°`;
    const previewDisplay = `${Math.round(preview)}°`;
    return {
      available: true,
      min: 0,
      max: 359,
      step: 1,
      value: base,
      display: randomActive ? `${previewDisplay} preview` : baseDisplay,
      randomEnabled: randomToggleOn,
      strength,
      strengthMin: 0,
      strengthMax: 180,
      strengthStep: 1,
      strengthDisplay: `±${Math.round(strength)}°`,
      randomLabel: randomToggleOn ? 'Random On' : 'Random',
      randomTooltip: randomToggleOn ? 'Disable random rotation' : 'Enable random rotation',
      randomHint: 'Applies a random offset up to the selected strength for each placement.'
    };
  }

  _buildDropShadowControlsState({ available, enabled }) {
    const allowed = !!available;
    const active = !!enabled;
    const disabled = !(allowed && active);
    const clamp = (value, min, max) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return min;
      return Math.min(max, Math.max(min, num));
    };
    const alphaPercent = clamp(this._dropShadowAlpha * 100, 0, 100);
    const dilation = clamp(this._dropShadowDilation, 0, MAX_SHADOW_DILATION);
    const blur = clamp(this._dropShadowBlur, 0, MAX_SHADOW_BLUR);
    const offsetDistance = clamp(this._dropShadowOffsetDistance, 0, MAX_SHADOW_OFFSET);
    const offsetAngle = this._normalizeShadowAngle(this._dropShadowOffsetAngle);
    const clampedDistanceChanged = Math.abs(offsetDistance - this._dropShadowOffsetDistance) > 0.0005;
    if (clampedDistanceChanged) this._dropShadowOffsetDistance = offsetDistance;
    const normalizedAngleChanged = Math.abs(offsetAngle - this._dropShadowOffsetAngle) > 0.0005;
    if (normalizedAngleChanged) this._dropShadowOffsetAngle = offsetAngle;
    const distanceDisplay = Math.abs(offsetDistance - Math.round(offsetDistance)) < 0.05
      ? `${Math.round(offsetDistance)}`
      : offsetDistance.toFixed(1);
    const angleDisplay = Math.round(offsetAngle);
    const currentSnapshot = this._currentShadowSnapshot();
    const presetState = this._buildDropShadowPresetState(currentSnapshot);
    const preview = this._shadowOffsetPreview
      ? {
          src: this._shadowOffsetPreview.src,
          width: this._shadowOffsetPreview.width,
          height: this._shadowOffsetPreview.height,
          alt: this._shadowOffsetPreview.alt || 'Asset drop shadow preview'
        }
      : null;
    return {
      available: allowed,
      disabled,
      collapsed: !!this._shadowSettingsCollapsed,
      activePreset: presetState.matchedIndex,
      presets: presetState.list,
      alpha: {
        label: 'Opacity',
        value: Math.round(alphaPercent),
        min: 0,
        max: 100,
        step: 1,
        display: `${Math.round(alphaPercent)}%`,
        hint: 'Transparency of the rendered shadow.',
        disabled
      },
      dilation: {
        label: 'Spread',
        value: dilation.toFixed(1),
        min: 0,
        max: MAX_SHADOW_DILATION,
        step: 0.1,
        display: `${dilation.toFixed(1)} px`,
        hint: 'Expands the shadow mask before blurring (world pixels).',
        disabled
      },
      blur: {
        label: 'Blur',
        value: blur.toFixed(1),
        min: 0,
        max: MAX_SHADOW_BLUR,
        step: 0.1,
        display: `${blur.toFixed(1)} px`,
        hint: 'Softens the shadow edges using a post-process blur.',
        disabled
      },
      offset: {
        distance: offsetDistance,
        angle: offsetAngle,
        maxDistance: MAX_SHADOW_OFFSET,
        displayDistance: `${distanceDisplay} px`,
        displayAngle: `${angleDisplay}°`,
        hint: 'Drag the handle to shift the shadow (max 40px). Outwards increases distance; clockwise changes direction.',
        disabled
      },
      preview,
      context: this._buildDropShadowContextState()
    };
  }

  _buildDropShadowContextState() {
    const elevation = Number(this._previewElevation ?? 0) || 0;
    const ctx = this._shadowElevationContext || { elevation, tileCount: 0, hasTiles: false, source: 'default' };
    const display = formatElevation(elevation);
    const tileCount = Number(ctx.tileCount || 0);
    const hasTiles = !!ctx.hasTiles && tileCount > 0;
    const source = ctx.source || (hasTiles ? 'existing' : 'default');
    const mixedOffsets = !!ctx.mixedOffsets;
    const mixedSpread = !!ctx.mixedDilation;
    let status;
    if (hasTiles) {
      const assetText = tileCount === 1 ? '1 asset' : `${tileCount} assets`;
      if (mixedOffsets || mixedSpread) {
        const mixedDetails = [
          mixedSpread ? 'spread' : null,
          mixedOffsets ? 'offset' : null
        ].filter(Boolean).join(' & ');
        status = `Mixed ${mixedDetails} settings across ${assetText}.`;
      } else {
        status = source === 'existing'
          ? `Matched ${assetText} on this elevation.`
          : `Synced with ${assetText} on this elevation.`;
      }
    } else {
      status = 'No assets on this elevation yet.';
    }
    const note = 'Blur & opacity follow elevation; offset & spread can be per asset.';
    return {
      display,
      status,
      note,
      tileCount,
      hasTiles,
      source
    };
  }

  _buildDropShadowPresetState(currentSnapshot) {
    const presets = Array.isArray(this._shadowPresets) ? this._shadowPresets : [];
    const list = [];
    let matchedIndex = -1;
    for (let i = 0; i < SHADOW_PRESET_COUNT; i += 1) {
      const preset = presets[i] || null;
      const saved = !!preset;
      const active = saved && this._compareShadowSnapshots(currentSnapshot, preset);
      if (active && matchedIndex === -1) matchedIndex = i;
      const indexLabel = String(i + 1);
      const tooltipParts = [];
      if (saved) {
        tooltipParts.push(`Click to apply preset ${indexLabel}.`);
        tooltipParts.push('Shift+Click to overwrite with current settings.');
      } else {
        tooltipParts.push(`Shift+Click to save current settings into slot ${indexLabel}.`);
        tooltipParts.push('Click to apply once saved.');
      }
      list.push({
        index: i,
        label: indexLabel,
        saved,
        active,
        tooltip: tooltipParts.join(' ')
      });
    }
    return { list, matchedIndex };
  }

  _applyShadowSettingsSnapshot(snapshot = {}, options = {}) {
    if (!snapshot) return false;
    const { persist = false, notify = false, propagate = false, sync = true, force = false } = options;
    let changed = false;
    const assign = (prop, value, transform) => {
      const current = this[prop];
      let next = value;
      if (typeof transform === 'function') next = transform(value);
      if (!Number.isFinite(next)) return;
      if (Math.abs(Number(current || 0) - Number(next || 0)) > 0.0005) {
        this[prop] = next;
        changed = true;
      }
    };
    assign('_dropShadowAlpha', snapshot.alpha, (v) => Math.min(1, Math.max(0, Number(v))));
    assign('_dropShadowDilation', snapshot.dilation, (v) => Math.min(MAX_SHADOW_DILATION, Math.max(0, Number(v))));
    assign('_dropShadowBlur', snapshot.blur, (v) => Math.min(MAX_SHADOW_BLUR, Math.max(0, Number(v))));
    assign('_dropShadowOffsetDistance', snapshot.offsetDistance, (v) => Math.min(MAX_SHADOW_OFFSET, Math.max(0, Number(v))));
    assign('_dropShadowOffsetAngle', snapshot.offsetAngle, (v) => this._normalizeShadowAngle(v));

    if (changed || force) {
      if (persist) this._persistCurrentShadowSettings();
      if (propagate) this._propagateShadowSettingsToElevation();
      this._updatePreviewShadow({ force: true });
      if (notify) {
        this._notifyDropShadowChanged();
      } else if (sync) {
        this._syncToolOptionsState({ suppressRender: false });
      }
    } else if (force && sync) {
      this._syncToolOptionsState({ suppressRender: false });
    }
    return changed;
  }

  _refreshShadowElevationContext({ adopt = false, sync = true } = {}) {
    try {
      const elevation = Number(this._previewElevation ?? 0) || 0;
      const globalEnabled = this._isGlobalDropShadowEnabled();
      const manager = globalEnabled ? getAssetShadowManager(this.app) : null;
      let snapshot = null;
      if (manager?.getElevationSettings) {
        snapshot = manager.getElevationSettings(elevation) || null;
      }
      const tileCount = Number(snapshot?.tileCount || 0);
      const hasTiles = !!snapshot?.hasTiles && tileCount > 0;
      const mixedOffsets = !!snapshot?.mixedOffset || !!snapshot?.mixedOffsetDistance || !!snapshot?.mixedOffsetAngle;
      const mixedSpread = !!snapshot?.mixedDilation;
      let source = this._shadowElevationContext?.source || (hasTiles ? 'existing' : 'default');
      if (adopt && hasTiles) {
        this._applyShadowSettingsSnapshot(snapshot, { persist: false, notify: false, propagate: false, sync: false, force: true });
        source = 'existing';
      } else if (!hasTiles) {
        source = 'default';
      }
      this._shadowElevationContext = { elevation, tileCount, hasTiles, source, mixedOffsets, mixedDilation: mixedSpread };
      if (sync) {
        this._syncToolOptionsState({ suppressRender: false });
        this._updatePreviewShadow({ force: true });
      }
      return snapshot;
    } catch (_) {
      return null;
    }
  }

  _propagateShadowSettingsToElevation() {
    try {
      if (!this._isGlobalDropShadowEnabled()) return;
      const manager = getAssetShadowManager(this.app);
      if (!manager?.applyElevationSettings) return;
      const elevation = Number(this._previewElevation ?? 0) || 0;
      const snapshot = manager.getElevationSettings?.(elevation) || null;
      const tileCount = Number(snapshot?.tileCount || 0);
      const hasTiles = !!snapshot?.hasTiles && tileCount > 0;
      if (!hasTiles) {
        this._shadowElevationContext = { elevation, tileCount: 0, hasTiles: false, source: 'default' };
        this._syncToolOptionsState({ suppressRender: false });
        this._updatePreviewShadow({ force: true });
        return;
      }
      const settings = {
        alpha: this._dropShadowAlpha,
        blur: this._dropShadowBlur
      };
      const result = manager.applyElevationSettings(elevation, settings);
      const markSynced = () => {
        this._shadowElevationContext = { elevation, tileCount, hasTiles: true, source: 'custom' };
        this._refreshShadowElevationContext({ adopt: false, sync: false });
        this._syncToolOptionsState({ suppressRender: false });
        this._updatePreviewShadow({ force: true });
      };
      if (result?.then) {
        result.then((updated) => { if (updated) markSynced(); }).catch(() => {});
      } else if (result) {
        markSynced();
      }
    } catch (_) {}
  }

  _syncToolOptionsState({ suppressRender = true } = {}) {
    try {
      const state = this._buildToolOptionsState();
      toolOptionsController.setToolOptions('asset.placement', {
        state,
        handlers: {
          setDropShadowEnabled: (value) => this._handleDropShadowToggleRequest(value),
          setDropShadowAlpha: (value, commit) => this._handleDropShadowAlphaChange(value, commit),
          setDropShadowDilation: (value, commit) => this._handleDropShadowDilationChange(value, commit),
          setDropShadowBlur: (value, commit) => this._handleDropShadowBlurChange(value, commit),
          setDropShadowOffset: (distance, angle, commit) => this._handleDropShadowOffsetChange(distance, angle, commit),
          setDropShadowOffsetDistance: (value, commit) => this._handleDropShadowOffsetDistanceChange(value, commit),
          setDropShadowOffsetAngle: (value, commit) => this._handleDropShadowOffsetAngleChange(value, commit),
          toggleDropShadowCollapsed: () => this._handleDropShadowCollapseToggle(),
          handleDropShadowPreset: (index, save) => this._handleDropShadowPresetAction(index, { save: !!save }),
          resetDropShadowOffset: () => this._handleDropShadowOffsetReset(),
          resetDropShadow: () => this._handleDropShadowReset(),
          toggleFlipHorizontal: () => this._handleFlipHorizontalToggle(),
          toggleFlipVertical: () => this._handleFlipVerticalToggle(),
          toggleFlipHorizontalRandom: () => this._handleFlipRandomHorizontalToggle(),
          toggleFlipVerticalRandom: () => this._handleFlipRandomVerticalToggle(),
          setScale: (value) => this._handleScaleSliderInput(value),
          toggleScaleRandom: () => this._handleScaleRandomToggle(),
          setScaleRandomStrength: (value) => this._handleScaleRandomStrength(value),
          setRotation: (value) => this._handleRotationSliderInput(value),
          toggleRotationRandom: () => this._handleRotationRandomToggle(),
          setRotationRandomStrength: (value) => this._handleRotationRandomStrength(value)
        },
        suppressRender
      });
    } catch (_) {}
  }

  _handleDropShadowToggleRequest(value) {
    const globalEnabled = this._isGlobalDropShadowEnabled();
    if (value === null || value === undefined) {
      if (this._dropShadowPreference == null) {
        this._syncToolOptionsState();
        return true;
      }
      this._dropShadowPreference = null;
      this._updatePreviewShadow({ force: true });
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
      return true;
    }
    const next = !!value;
    if (!globalEnabled && next) {
      this._syncToolOptionsState();
      return false;
    }
    if (this._dropShadowPreference === next) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowPreference = next;
    this._updatePreviewShadow({ force: true });
    this._notifyDropShadowChanged();
    if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    return true;
  }

  _handleDropShadowAlphaChange(value, commit = false) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const clampedPercent = Math.min(100, Math.max(0, numeric));
    const normalized = clampedPercent / 100;
    if (Math.abs(normalized - this._dropShadowAlpha) < 0.0005 && !commit) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowAlpha = normalized;
    this._updatePreviewShadow();
    if (commit) this._persistShadowSetting('assetDropShadowAlpha', normalized);
    this._syncToolOptionsState();
    if (commit) {
      this._propagateShadowSettingsToElevation();
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    }
    return true;
  }

  _handleDropShadowDilationChange(value, commit = false) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const clamped = Math.min(MAX_SHADOW_DILATION, Math.max(0, numeric));
    if (Math.abs(clamped - this._dropShadowDilation) < 0.0005 && !commit) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowDilation = clamped;
    this._updatePreviewShadow();
    if (commit) this._persistShadowSetting('assetDropShadowDilation', clamped);
    this._syncToolOptionsState();
    if (commit) {
      this._propagateShadowSettingsToElevation();
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    }
    return true;
  }

  _handleDropShadowBlurChange(value, commit = false) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const clamped = Math.min(MAX_SHADOW_BLUR, Math.max(0, numeric));
    if (Math.abs(clamped - this._dropShadowBlur) < 0.0005 && !commit) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowBlur = clamped;
    this._updatePreviewShadow({ force: commit });
    if (commit) this._persistShadowSetting('assetDropShadowBlur', clamped);
    this._syncToolOptionsState();
    if (commit) {
      this._propagateShadowSettingsToElevation();
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    }
    return true;
  }

  _handleDropShadowOffsetDistanceChange(value, commit = false) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const clamped = Math.min(MAX_SHADOW_OFFSET, Math.max(0, numeric));
    if (Math.abs(clamped - this._dropShadowOffsetDistance) < 0.0005 && !commit) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowOffsetDistance = clamped;
    this._updatePreviewShadow();
    if (commit) this._persistShadowSetting('assetDropShadowOffsetDistance', clamped);
    this._syncToolOptionsState();
    if (commit) {
      this._propagateShadowSettingsToElevation();
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    }
    return true;
  }

  _handleDropShadowOffsetAngleChange(value, commit = false) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const normalized = this._normalizeShadowAngle(numeric);
    if (Math.abs(normalized - this._dropShadowOffsetAngle) < 0.0005 && !commit) {
      this._syncToolOptionsState();
      return true;
    }
    this._dropShadowOffsetAngle = normalized;
    this._updatePreviewShadow();
    if (commit) this._persistShadowSetting('assetDropShadowOffsetAngle', normalized);
    this._syncToolOptionsState();
    if (commit) {
      this._propagateShadowSettingsToElevation();
      this._notifyDropShadowChanged();
      if (this._isEditingExistingTile) this._scheduleEditingCommit(true);
    }
    return true;
  }

  _handleScaleSliderInput(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const normalized = this._clampScale(numeric / 100);
    this.currentScale = normalized;
    this._updateScalePreview({ clampOffset: true });
    this._syncToolOptionsState();
    if (this._isEditingExistingTile) this._scheduleEditingCommit();
    return true;
  }

  _handleScaleRandomToggle() {
    const next = !this._scaleRandomEnabled;
    this._scaleRandomEnabled = next;
    if (next && (!Number.isFinite(this._scaleRandomStrength) || this._scaleRandomStrength <= 0)) {
      this._scaleRandomStrength = 15;
    }
    this._updateScalePreview({ regenerateOffset: next, clampOffset: true });
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _handleScaleRandomStrength(value) {
    const numeric = Number(value);
    const clamped = Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0;
    this._scaleRandomStrength = clamped;
    this._updateScalePreview({ clampOffset: true });
    this._syncToolOptionsState();
    return true;
  }

  _handleRotationSliderInput(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const normalized = this._normalizeRotation(numeric);
    this.currentRotation = normalized;
    this._updateRotationPreview({ clampOffset: true });
    this._syncToolOptionsState();
    if (this._isEditingExistingTile) this._scheduleEditingCommit();
    return true;
  }

  _handleRotationRandomToggle() {
    const next = !this._rotationRandomEnabled;
    this._rotationRandomEnabled = next;
    if (next && (!Number.isFinite(this._rotationRandomStrength) || this._rotationRandomStrength <= 0)) {
      this._rotationRandomStrength = 45;
    }
    this._updateRotationPreview({ regenerateOffset: next, clampOffset: true });
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _handleRotationRandomStrength(value) {
    const numeric = Number(value);
    const clamped = Number.isFinite(numeric) ? Math.min(180, Math.max(0, numeric)) : 0;
    this._rotationRandomStrength = clamped;
    this._updateRotationPreview({ clampOffset: true });
    this._syncToolOptionsState();
    return true;
  }

  _handleFlipHorizontalToggle() {
    this._flipHorizontal = !this._flipHorizontal;
    this._updateFlipPreview();
    this._syncToolOptionsState({ suppressRender: false });
    if (this._isEditingExistingTile) this._scheduleEditingCommit();
    return true;
  }

  _handleFlipVerticalToggle() {
    this._flipVertical = !this._flipVertical;
    this._updateFlipPreview();
    this._syncToolOptionsState({ suppressRender: false });
    if (this._isEditingExistingTile) this._scheduleEditingCommit();
    return true;
  }

  _handleFlipRandomHorizontalToggle() {
    const next = !this._flipRandomHorizontalEnabled;
    this._flipRandomHorizontalEnabled = next;
    this._flipRandomHorizontalOffset = next ? null : false;
    this._updateFlipPreview({ regenerateOffsets: next });
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _handleFlipRandomVerticalToggle() {
    const next = !this._flipRandomVerticalEnabled;
    this._flipRandomVerticalEnabled = next;
    this._flipRandomVerticalOffset = next ? null : false;
    this._updateFlipPreview({ regenerateOffsets: next });
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _installDropShadowSettingsHook() {
    const hooks = globalThis?.Hooks;
    if (!hooks || typeof hooks.on !== 'function' || this._dropShadowSettingsHook) return;
    const handler = (setting) => {
      if (!setting || setting.namespace !== 'fa-nexus') return;
      if (setting.key === 'assetDropShadow') {
        this._syncToolOptionsState();
        return;
      }
      switch (setting.key) {
        case 'assetDropShadowAlpha':
          this._dropShadowAlpha = this._coerceShadowNumeric(setting.value, 0, 1, this._dropShadowAlpha);
          this._syncToolOptionsState();
          this._updatePreviewShadow({ force: true });
          break;
        case 'assetDropShadowDilation':
          this._dropShadowDilation = this._coerceShadowNumeric(setting.value, 0, MAX_SHADOW_DILATION, this._dropShadowDilation);
          this._syncToolOptionsState();
          this._updatePreviewShadow({ force: true });
          break;
        case 'assetDropShadowBlur':
      this._dropShadowBlur = this._coerceShadowNumeric(setting.value, 0, MAX_SHADOW_BLUR, this._dropShadowBlur);
          this._syncToolOptionsState();
          this._updatePreviewShadow({ force: true });
          break;
        case 'assetDropShadowOffsetDistance':
          this._dropShadowOffsetDistance = this._coerceShadowNumeric(setting.value, 0, MAX_SHADOW_OFFSET, this._dropShadowOffsetDistance);
          this._syncToolOptionsState();
          this._updatePreviewShadow({ force: true });
          break;
        case 'assetDropShadowOffsetAngle':
          this._dropShadowOffsetAngle = this._normalizeShadowAngle(setting.value);
          this._syncToolOptionsState();
          this._updatePreviewShadow({ force: true });
          break;
        case 'assetDropShadowCollapsed':
          this._shadowSettingsCollapsed = !!setting.value;
          this._syncToolOptionsState({ suppressRender: false });
          break;
        case 'assetDropShadowPresets':
          try {
            const parsed = typeof setting.value === 'string'
              ? JSON.parse(setting.value || '[]')
              : Array.isArray(setting.value) ? setting.value : [];
            this._shadowPresets = Array.from({ length: SHADOW_PRESET_COUNT }, (_, index) => this._normalizeShadowSnapshot(parsed?.[index]));
          } catch (_) {
            this._shadowPresets = this._loadShadowPresets();
          }
          this._syncToolOptionsState({ suppressRender: false });
          break;
        default:
          break;
      }
    };
    try {
      hooks.on('updateSetting', handler);
      this._dropShadowSettingsHook = handler;
    } catch (_) {
      this._dropShadowSettingsHook = null;
    }
  }

  _isPreviewShadowActive() {
    return this._isGlobalDropShadowEnabled() && this.isDropShadowEnabled() && !!this._previewContainer;
  }

  _ensurePreviewShadowContainer() {
    if (!this._previewContainer) return null;
    let shadow = this._previewContainer._shadowContainer || null;
    if (!shadow || shadow.destroyed) {
      shadow = new PIXI.Container();
      shadow.sortableChildren = false;
      shadow.eventMode = 'none';
      shadow.visible = false;
      shadow.name = 'fa-nexus-shadow-preview';
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.anchor.set(0.5, 0.5);
      sprite.visible = false;
      sprite.eventMode = 'none';
      shadow.addChild(sprite);
      shadow._sprite = sprite;
      this._previewContainer.addChildAt(shadow, 0);
      this._previewContainer._shadowContainer = shadow;
      this._previewContainer._shadowSprite = sprite;
      this._previewContainer._shadowRenderTexture = null;
      this._previewContainer._shadowState = null;
    }
    return shadow;
  }

  _buildPreviewDilationOffsets(radius) {
    const offsets = [{ x: 0, y: 0 }];
    const r = Math.max(0, Number(radius || 0));
    if (r < 0.05) return offsets;
    const steps = 16;
    const full = Math.PI * 2;
    for (let i = 0; i < steps; i++) {
      const angle = (full * i) / steps;
      offsets.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }
    const inner = r * 0.55;
    if (inner >= 0.05) {
      for (let i = 0; i < steps; i++) {
        const angle = (full * i) / steps + (full / (steps * 2));
        offsets.push({ x: Math.cos(angle) * inner, y: Math.sin(angle) * inner });
      }
    }
    return offsets;
  }

  _updatePreviewShadow({ force = false } = {}) {
    try {
      const container = this._previewContainer;
      if (!container) return;
      if (!this._isPreviewShadowActive()) {
        if (container._shadowContainer) container._shadowContainer.visible = false;
        this._scheduleShadowOffsetPreviewUpdate({ force });
        return;
      }
      const sprite = container._sprite;
      if (!sprite || !sprite.texture) return;
      const texture = sprite.texture;
      const baseTexture = texture.baseTexture;
      if (baseTexture && !baseTexture.valid) {
        if (!this._shadowPreviewTextureListener && typeof baseTexture.once === 'function') {
          const handler = () => {
            this._shadowPreviewTextureListener = null;
            this._updatePreviewShadow({ force: true });
          };
          this._shadowPreviewTextureListener = handler;
          baseTexture.once('loaded', handler);
          baseTexture.once('update', handler);
        }
        return;
      }

      const renderer = canvas?.app?.renderer;
      if (!renderer) return;

      const worldWidth = Number(sprite.width || 0);
      const worldHeight = Number(sprite.height || 0);
      if (!Number.isFinite(worldWidth) || !Number.isFinite(worldHeight) || worldWidth <= 0 || worldHeight <= 0) return;
      const spriteScaleX = Number(sprite.scale?.x ?? 1) || 1;
      const spriteScaleY = Number(sprite.scale?.y ?? 1) || 1;
      const flipX = spriteScaleX < 0 ? -1 : 1;
      const flipY = spriteScaleY < 0 ? -1 : 1;

      const rotation = Number(sprite.rotation || 0);
      const alpha = Math.min(1, Math.max(0, Number(this._dropShadowAlpha || 0)));
      const dilation = Math.max(0, Number(this._dropShadowDilation || 0));
      const blur = Math.max(0, Number(this._dropShadowBlur || 0));
      const offset = this._computeShadowOffsetVector();
      const zoom = Math.max(0.1, Number(canvas?.stage?.scale?.x || 1));

      const blurMargin = blur * 12;
      const marginX = Math.abs(offset.x) + dilation + blurMargin;
      const marginY = Math.abs(offset.y) + dilation + blurMargin;
      const paddedWidth = Math.max(8, Math.ceil(worldWidth + marginX * 2));
      const paddedHeight = Math.max(8, Math.ceil(worldHeight + marginY * 2));
      const centerX = paddedWidth / 2;
      const centerY = paddedHeight / 2;

      const signature = `${baseTexture?.uid || baseTexture?.cacheId || 'tex'}:${worldWidth}:${worldHeight}:${rotation}:${alpha}:${dilation}:${blur}:${offset.x}:${offset.y}:${zoom}:${paddedWidth}:${paddedHeight}:${flipX}:${flipY}`;
      const previousSignature = container._shadowState?.signature || null;
      if (!force && previousSignature === signature) {
        this._scheduleShadowOffsetPreviewUpdate({ force: false });
        return;
      }

      const shadow = this._ensurePreviewShadowContainer();
      if (!shadow) return;
      shadow.visible = true;
      shadow.alpha = 1;

      const shadowSprite = container._shadowSprite || shadow._sprite;
      if (!shadowSprite) return;

      let renderTexture = container._shadowRenderTexture || null;
      if (!renderTexture || renderTexture.width !== paddedWidth || renderTexture.height !== paddedHeight) {
        if (renderTexture && !renderTexture.destroyed) {
          try { renderTexture.destroy(true); } catch (_) {}
        }
        renderTexture = PIXI.RenderTexture.create({ width: paddedWidth, height: paddedHeight, scaleMode: PIXI.SCALE_MODES.LINEAR });
        container._shadowRenderTexture = renderTexture;
      }

      const drawContainer = new PIXI.Container();
      const offsets = this._buildPreviewDilationOffsets(dilation);
      for (const sample of offsets) {
        const clone = new PIXI.Sprite(texture);
        clone.anchor.set(0.5, 0.5);
        clone.width = worldWidth;
        clone.height = worldHeight;
        if (flipX < 0) clone.scale.x *= -1;
        if (flipY < 0) clone.scale.y *= -1;
        clone.rotation = rotation;
        clone.position.set(centerX + offset.x + sample.x, centerY + offset.y + sample.y);
        clone.alpha = 1;
        drawContainer.addChild(clone);
      }

      renderer.render(drawContainer, { renderTexture, clear: true });
      try { drawContainer.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}

      shadowSprite.texture = renderTexture;
      shadowSprite.tint = 0x000000;
      shadowSprite.alpha = alpha;
      shadowSprite.position.set(0, 0);
      shadowSprite.anchor.set(0.5, 0.5);
      shadowSprite.visible = true;

      if (blur > 0) {
        let filter = container._shadowBlurFilter || null;
        if (!filter || filter.destroyed) {
          filter = new PIXI.BlurFilter();
          filter.quality = 4;
          filter.repeatEdgePixels = true;
          container._shadowBlurFilter = filter;
        }
        filter.blur = blur * zoom;
        shadowSprite.filters = [filter];
      } else if (shadowSprite.filters) {
        shadowSprite.filters = null;
      }

      container._shadowState = { signature };
      this._scheduleShadowOffsetPreviewUpdate({ force });
    } catch (_) {}
  }

  _cleanupPreviewShadowResources(container) {
    if (!container) return;
    if (container._shadowRenderTexture && !container._shadowRenderTexture.destroyed) {
      try { container._shadowRenderTexture.destroy(true); } catch (_) {}
    }
    container._shadowRenderTexture = null;
    if (container._shadowBlurFilter && !container._shadowBlurFilter.destroyed) {
      try { container._shadowBlurFilter.destroy(); } catch (_) {}
    }
    container._shadowBlurFilter = null;
    if (container._shadowSprite) {
      try {
        container._shadowSprite.texture = PIXI.Texture.EMPTY;
        container._shadowSprite.visible = false;
        container._shadowSprite.filters = null;
      } catch (_) {}
    }
    if (container._shadowContainer && !container._shadowContainer.destroyed) {
      try { container._shadowContainer.visible = false; } catch (_) {}
    }
    container._shadowState = null;
  }

  _computeShadowPreviewSignature() {
    try {
      const container = this._previewContainer;
      const sprite = container?._sprite;
      if (!container || !sprite) return null;
      const texture = sprite.texture || null;
      const baseTexture = texture?.baseTexture || null;
      const assetKey = (() => {
        if (baseTexture?.uid) return baseTexture.uid;
        if (baseTexture?.cacheId) return baseTexture.cacheId;
        if (texture?.cacheId) return texture.cacheId;
        if (this.currentAsset) return this._assetKey(this.currentAsset);
        return 'fa-nexus-preview';
      })();
      const width = Number(sprite.width || 0).toFixed(3);
      const height = Number(sprite.height || 0).toFixed(3);
      const rotation = Number(sprite.rotation || 0).toFixed(4);
      const scaleX = Number(sprite.scale?.x || 0).toFixed(4);
      const scaleY = Number(sprite.scale?.y || 0).toFixed(4);
      const pendingScale = Number(this._getPendingScale() || 0).toFixed(4);
      const pendingRotation = Number(this._getPendingRotation() || 0).toFixed(4);
      const flips = `${this._pendingFlipHorizontal ? 1 : 0}:${this._pendingFlipVertical ? 1 : 0}`;
      const dropShadowActive = this._isPreviewShadowActive() ? 1 : 0;
      const dropSignature = dropShadowActive
        ? [
            Number(this._dropShadowAlpha || 0).toFixed(3),
            Number(this._dropShadowDilation || 0).toFixed(3),
            Number(this._dropShadowBlur || 0).toFixed(3),
            Number(this._dropShadowOffsetDistance || 0).toFixed(3),
            Number(this._dropShadowOffsetAngle || 0).toFixed(3)
          ].join(':')
        : 'off';
      const elevation = formatElevation(this._previewElevation || 0);
      return `${assetKey}:${width}:${height}:${rotation}:${scaleX}:${scaleY}:${pendingScale}:${pendingRotation}:${flips}:${dropShadowActive}:${dropSignature}:${elevation}`;
    } catch (_) {
      return null;
    }
  }

  _scheduleShadowOffsetPreviewUpdate({ force = false } = {}) {
    try {
      if (typeof window === 'undefined') return;
      if (!this._previewContainer || !this._previewContainer._sprite) return;
      const signature = this._computeShadowPreviewSignature();
      const currentSignature = this._shadowOffsetPreview?.signature || null;
      if (!force && signature && currentSignature === signature && !this._shadowPreviewPendingSignature) return;
      this._shadowPreviewPendingSignature = signature;
      if (force) this._shadowPreviewForce = true;
      const requestId = ++this._shadowPreviewSequence;
      this._shadowPreviewRequestedId = requestId;
      if (this._shadowPreviewRendering) return;
      if (this._shadowPreviewFrame) {
        window.cancelAnimationFrame(this._shadowPreviewFrame);
      }
      this._shadowPreviewFrame = window.requestAnimationFrame(() => {
        this._shadowPreviewFrame = null;
        const pendingSignature = this._shadowPreviewPendingSignature;
        const shouldForce = this._shadowPreviewForce;
        this._shadowPreviewPendingSignature = null;
        this._shadowPreviewForce = false;
        if (!pendingSignature) return;
        this._renderShadowOffsetPreview(pendingSignature, { force: shouldForce, requestId: this._shadowPreviewRequestedId });
      });
    } catch (_) {}
  }

  _renderShadowOffsetPreview(signature, { force = false, requestId = null } = {}) {
    try {
      const container = this._previewContainer;
      const sprite = container?._sprite;
      const renderer = canvas?.app?.renderer;
      if (!container || !sprite || !renderer) return;
      const texture = sprite.texture;
      const baseTexture = texture?.baseTexture || null;
      if (!texture || !baseTexture) return;
      if (!baseTexture.valid) {
        if (!this._shadowPreviewTextureListener && typeof baseTexture.once === 'function') {
          const handler = () => {
            if (this._shadowPreviewTextureListener === handler) this._shadowPreviewTextureListener = null;
            this._scheduleShadowOffsetPreviewUpdate({ force: true });
          };
          this._shadowPreviewTextureListener = handler;
          baseTexture.once('loaded', handler);
          baseTexture.once('update', handler);
        }
        return;
      }

      const targetSignature = signature || this._computeShadowPreviewSignature();
      if (!force && targetSignature && this._shadowOffsetPreview?.signature === targetSignature) {
        this._shadowPreviewRendering = false;
        return;
      }

      this._shadowPreviewRendering = true;
      const renderId = requestId ?? ++this._shadowPreviewSequence;

      const circleSize = 160;
      const marginPx = 8;
      const availableSize = circleSize - marginPx * 2;

      const worldWidth = Math.max(0.001, Math.abs(Number(sprite.width || 0)));
      const worldHeight = Math.max(0.001, Math.abs(Number(sprite.height || 0)));
      const spriteScaleX = Number(sprite.scale?.x ?? 1) || 1;
      const spriteScaleY = Number(sprite.scale?.y ?? 1) || 1;
      const flipX = spriteScaleX < 0 ? -1 : 1;
      const flipY = spriteScaleY < 0 ? -1 : 1;
      const rotation = Number(sprite.rotation || 0);
      const alpha = Math.min(1, Math.max(0, Number(this._dropShadowAlpha || 0)));
      const dilation = Math.max(0, Number(this._dropShadowDilation || 0));
      const blur = Math.max(0, Number(this._dropShadowBlur || 0));
      const offset = this._computeShadowOffsetVector();
      const blurMargin = blur * 12;
      const marginWorldX = Math.abs(offset.x) + dilation + blurMargin;
      const marginWorldY = Math.abs(offset.y) + dilation + blurMargin;
      const fitWidth = worldWidth + marginWorldX * 2;
      const fitHeight = worldHeight + marginWorldY * 2;
      const baseScale = availableSize / Math.max(worldWidth, worldHeight);
      const fitScale = availableSize / Math.max(fitWidth, fitHeight);
      const minScale = baseScale * 0.68;
      const scale = Math.max(minScale, Math.min(baseScale, fitScale));

      const renderRoot = new PIXI.Container();
      renderRoot.sortableChildren = false;

      const center = circleSize / 2;
      const createdFilters = [];
      const createdTextures = [];
      const sourceTint = typeof sprite.tint === 'number' ? sprite.tint : null;
      const buildClone = () => {
        const clone = new PIXI.Sprite(texture);
        clone.anchor.set(0.5, 0.5);
        clone.width = worldWidth;
        clone.height = worldHeight;
        clone.rotation = rotation;
        clone.scale.x *= flipX;
        clone.scale.y *= flipY;
        if (sourceTint != null) clone.tint = sourceTint;
        return clone;
      };

      const dropShadowActive = this._isPreviewShadowActive();
      if (dropShadowActive) {
        const shadowDraw = new PIXI.Container();
        shadowDraw.position.set(center, center);
        shadowDraw.scale.set(scale);
        const dilationSamples = this._buildPreviewDilationOffsets(dilation);
        for (const sample of dilationSamples) {
          const clone = buildClone();
          clone.position.set(offset.x + sample.x, offset.y + sample.y);
          clone.tint = 0x000000;
          clone.alpha = 1;
          shadowDraw.addChild(clone);
        }
        if (blur > 0) {
          const filter = new PIXI.BlurFilter();
          filter.quality = 4;
          filter.repeatEdgePixels = true;
          filter.blur = Math.max(0.25, blur * scale);
          shadowDraw.filters = [filter];
          createdFilters.push(filter);
        }
        const shadowTexture = PIXI.RenderTexture.create({
          width: circleSize,
          height: circleSize,
          scaleMode: PIXI.SCALE_MODES.LINEAR
        });
        renderer.render(shadowDraw, { renderTexture: shadowTexture, clear: true });
        const shadowSprite = new PIXI.Sprite(shadowTexture);
        shadowSprite.anchor.set(0.5, 0.5);
        shadowSprite.position.set(center, center);
        shadowSprite.tint = 0x000000;
        shadowSprite.alpha = alpha;
        shadowSprite.blendMode = PIXI.BLEND_MODES.NORMAL;
        renderRoot.addChild(shadowSprite);
        createdTextures.push(shadowTexture);
        shadowDraw.destroy({ children: true, texture: false, baseTexture: false });
      }

      const assetContainer = new PIXI.Container();
      assetContainer.position.set(center, center);
      assetContainer.scale.set(scale);

      const assetClone = buildClone();
      assetClone.position.set(0, 0);
      assetClone.alpha = 1;
      assetContainer.addChild(assetClone);

      renderRoot.addChild(assetContainer);

      const renderTexture = PIXI.RenderTexture.create({
        width: circleSize,
        height: circleSize,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      renderer.render(renderRoot, { renderTexture, clear: true });
      const extraction = renderer.extract?.base64?.(renderTexture);

      const cleanup = () => {
        try { renderRoot.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        for (const filter of createdFilters) {
          if (filter && typeof filter.destroy === 'function') {
            try { filter.destroy(true); } catch (_) {}
          }
        }
        for (const tex of createdTextures) {
          if (tex && !tex.destroyed) {
            try { tex.destroy(true); } catch (_) {}
          }
        }
        if (renderTexture && !renderTexture.destroyed) {
          try { renderTexture.destroy(true); } catch (_) {}
        }
      };

      const finalize = (dataUrl, ok = true) => {
        cleanup();
        const latestRequested = this._shadowPreviewRequestedId;
        const hasPending = this._shadowPreviewPendingSignature != null;
        if (ok && renderId === latestRequested && !hasPending && typeof dataUrl === 'string' && dataUrl.length) {
          const previewData = {
            src: dataUrl,
            width: circleSize,
            height: circleSize,
            signature: targetSignature || null,
            updatedAt: typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now(),
            alt: 'Asset drop shadow preview'
          };
          this._shadowOffsetPreview = previewData;
          try { toolOptionsController.updateDropShadowPreview('asset.placement', previewData); } catch (_) {}
        }
        this._shadowPreviewRendering = false;
        if (this._shadowPreviewPendingSignature) {
          this._scheduleShadowOffsetPreviewUpdate({ force: this._shadowPreviewForce });
        }
      };

      if (extraction && typeof extraction.then === 'function') {
        extraction.then((dataUrl) => finalize(dataUrl, true)).catch(() => finalize(null, false));
      } else {
        finalize(extraction, true);
      }
    } catch (_) {
      this._shadowPreviewRendering = false;
    }
  }

  _clearShadowOffsetPreview({ notify = true } = {}) {
    try {
      if (this._shadowPreviewFrame) {
        window.cancelAnimationFrame(this._shadowPreviewFrame);
        this._shadowPreviewFrame = null;
      }
    } catch (_) {
      this._shadowPreviewFrame = null;
    }
    this._shadowPreviewPendingSignature = null;
    this._shadowPreviewRendering = false;
    if (notify) {
      try { toolOptionsController.updateDropShadowPreview('asset.placement', null); } catch (_) {}
    }
    this._shadowOffsetPreview = null;
  }

  _createPreviewElement() {
     if (!this.currentAsset) return;
     const assetPx = this._getAssetBasePxPerSquare();
     const sceneGridSize = canvas?.scene?.grid?.size || 100;
    const zoomLevel = canvas?.stage?.scale?.x || 1;
    const gridScaleFactor = sceneGridSize / assetPx;

    const gridWidth = Math.max(0.01, Number(this.currentAsset.grid_width || 1));
    const gridHeight = Math.max(0.01, Number(this.currentAsset.grid_height || 1));
    const tileWidth = gridWidth * assetPx;
    const tileHeight = gridHeight * assetPx;

    const scaleMul = this._getPendingScale();

     // Create PIXI container for preview
     const container = new PIXI.Container();
     container.sortableChildren = true;
     container.eventMode = 'none';
     this._previewContainer = container;

     // Create sprite
     const textureUrl = this._encodeAssetPath(this.currentAsset.url);
     let texture;
     const isVideo = /\.(webm|mp4|ogg)$/i.test(this.currentAsset.path || '');
     if (isVideo) {
       // For videos, create a video element and use it as texture
       const video = document.createElement('video');
       video.src = textureUrl;
       video.muted = true;
       video.loop = true;
       video.playsInline = true;
       video.autoplay = true;
       video.load();
       texture = PIXI.Texture.from(video);
     } else {
       texture = PIXI.Texture.from(textureUrl);
     }

    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5, 0.5);
    sprite.rotation = (this._getPendingRotation() * Math.PI) / 180;
    container.addChild(sprite);
    this._ensurePreviewShadowContainer();

     // Set container properties for sorting
     const primary = canvas?.primary;
     const tilesSortLayer = (() => {
       try { return primary?.constructor?.SORT_LAYERS?.TILES ?? 0; }
       catch (_) { return 0; }
     })();
     container.sortLayer = tilesSortLayer;
     container.sort = this._previewSort;
     container.faNexusSort = this._previewSort;
     container.faNexusElevation = this._previewElevation;
     container.elevation = this._previewElevation;
     container.zIndex = 0;

     // Add to canvas
     const parent = primary || canvas?.stage;
     if (parent) {
       parent.addChild(container);
       if ('sortDirty' in parent) parent.sortDirty = true;
       parent.sortChildren?.();
     }

     // Store properties
     container._tileWidth = tileWidth;
     container._tileHeight = tileHeight;
    container._gridScaleFactor = gridScaleFactor;
    container._scaleMul = scaleMul;
    container._sprite = sprite;
    this._lastZoom = zoomLevel;

    // Ensure initial sizing reflects world scale and canvas zoom
    this._applyZoomToPreview(zoomLevel);
    this._applyPendingRotationToPreview();
    this._applyPendingScaleToPreview();
    this._applyPendingFlipToPreview({ forceShadow: true });
    this._updatePreviewShadow({ force: true });

    // Position at current pointer or frozen world
    try {
      let world = null;
      if (this._previewFrozen && this._frozenPreviewWorld && Number.isFinite(this._frozenPreviewWorld.x) && Number.isFinite(this._frozenPreviewWorld.y)) {
        world = { x: this._frozenPreviewWorld.x, y: this._frozenPreviewWorld.y };
      } else if (this._lastPointerWorld && Number.isFinite(this._lastPointerWorld.x) && Number.isFinite(this._lastPointerWorld.y)) {
        world = { x: this._lastPointerWorld.x, y: this._lastPointerWorld.y };
      } else if (this._lastPointer && Number.isFinite(this._lastPointer.x) && Number.isFinite(this._lastPointer.y)) {
        world = this._screenToCanvas(this._lastPointer.x, this._lastPointer.y);
      } else {
        const fallbackX = (typeof window !== 'undefined' && typeof window.innerWidth === 'number') ? window.innerWidth / 2 : 0;
        const fallbackY = (typeof window !== 'undefined' && typeof window.innerHeight === 'number') ? window.innerHeight / 2 : 0;
        world = this._screenToCanvas(fallbackX, fallbackY);
      }
      if (world) {
        container.x = world.x;
        container.y = world.y;
        if (this._previewFrozen) {
          this._frozenPreviewWorld = { x: world.x, y: world.y };
          this._refreshFrozenPointerScreen();
        }
      }
    } catch (_) {}

    if (this._pendingEditState?.doc) {
      this._applyTileStateToPlacement(this._pendingEditState.doc, { force: true });
    } else if ((this._isEditingExistingTile || this._replaceOriginalOnPlace) && this._editingTile) {
      this._applyTileStateToPlacement(this._editingTile, { force: true });
    }
    this._scheduleShadowOffsetPreviewUpdate({ force: true });
  }

  _ensurePointerSnapshot(options = {}) {
    const snapshot = this._capturePointerSnapshot(options);
    if (snapshot?.screen) {
      this._lastPointer = { x: snapshot.screen.x, y: snapshot.screen.y };
    } else if (!snapshot) {
      this._lastPointer = null;
    }
    if (snapshot?.world) {
      this._lastPointerWorld = { x: snapshot.world.x, y: snapshot.world.y };
    } else if (snapshot?.screen) {
      const world = this._screenToCanvas(snapshot.screen.x, snapshot.screen.y);
      this._lastPointerWorld = world ? { x: world.x, y: world.y } : null;
    } else if (!snapshot) {
      this._lastPointerWorld = null;
    }
    return snapshot;
  }

  _capturePointerSnapshot(options = {}) {
    const candidates = [];
    const push = (screen, world, weight) => {
      if (!screen) return;
      const x = Number(screen.x);
      const y = Number(screen.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const entry = {
        screen: { x, y },
        world: null,
        weight: Number(weight) || 0
      };
      if (world && Number.isFinite(world.x) && Number.isFinite(world.y)) {
        entry.world = { x: Number(world.x), y: Number(world.y) };
      }
      candidates.push(entry);
    };

    try {
      const pointerEvent = options?.pointerEvent;
      if (pointerEvent && typeof pointerEvent.clientX === 'number' && typeof pointerEvent.clientY === 'number') {
        const screen = { x: Number(pointerEvent.clientX), y: Number(pointerEvent.clientY) };
        const world = this._screenToCanvas(screen.x, screen.y);
        const weight = this._isScreenPointOnCanvas(screen) ? 6 : 2.5;
        push(screen, world, weight);
      }
    } catch (_) { /* no-op */ }

    if (options?.pointer && Number.isFinite(options.pointer.x) && Number.isFinite(options.pointer.y)) {
      const screen = { x: Number(options.pointer.x), y: Number(options.pointer.y) };
      const pointerWorld = options.pointerWorld;
      const world = (pointerWorld && Number.isFinite(pointerWorld.x) && Number.isFinite(pointerWorld.y))
        ? { x: Number(pointerWorld.x), y: Number(pointerWorld.y) }
        : this._screenToCanvas(screen.x, screen.y);
      const weight = this._isScreenPointOnCanvas(screen) ? 5 : 2;
      push(screen, world, weight);
    }

    try {
      const controllerState = this._interactionController?.getPointerState?.();
      if (controllerState?.screen && Number.isFinite(controllerState.screen.x) && Number.isFinite(controllerState.screen.y)) {
        const screen = { x: Number(controllerState.screen.x), y: Number(controllerState.screen.y) };
        const world = (controllerState.world && Number.isFinite(controllerState.world.x) && Number.isFinite(controllerState.world.y))
          ? { x: Number(controllerState.world.x), y: Number(controllerState.world.y) }
          : this._screenToCanvas(screen.x, screen.y);
        const weight = this._isScreenPointOnCanvas(screen) ? 4 : 1.5;
        push(screen, world, weight);
      }
    } catch (_) { /* no-op */ }

    const rendererPointer = this._resolveRendererPointer();
    if (rendererPointer) {
      const world = this._screenToCanvas(rendererPointer.x, rendererPointer.y);
      const weight = this._isScreenPointOnCanvas(rendererPointer) ? 4.5 : 1.8;
      push(rendererPointer, world, weight);
    }

    if (!candidates.length) {
      const width = (typeof window !== 'undefined' && typeof window.innerWidth === 'number') ? window.innerWidth : 1920;
      const height = (typeof window !== 'undefined' && typeof window.innerHeight === 'number') ? window.innerHeight : 1080;
      const screen = { x: width / 2, y: height / 2 };
      const world = this._screenToCanvas(screen.x, screen.y);
      push(screen, world, 0);
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.weight - a.weight);
    const best = candidates[0];
    return {
      screen: best.screen,
      world: best.world
    };
  }

  _isScreenPointOnCanvas(point) {
    if (!point) return false;
    try {
      const canvasEl = this._interactionController?.getCanvasElement?.();
      const rect = canvasEl?.getBoundingClientRect?.();
      if (!rect) return false;
      const x = Number(point.x);
      const y = Number(point.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    } catch (_) {
      return false;
    }
  }

  _resolveRendererPointer() {
    try {
      const canvasEl = this._interactionController?.getCanvasElement?.();
      const rect = canvasEl?.getBoundingClientRect?.();
      if (!rect) return null;
      const candidates = [];
      const add = (pt, weight = 1) => {
        if (!pt) return;
        const x = Number(pt.x);
        const y = Number(pt.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        candidates.push({ x: rect.left + x, y: rect.top + y, weight: Number(weight) || 1 });
      };

      const eventPointer = canvas?.app?.renderer?.events?.pointer?.global;
      if (eventPointer) add(eventPointer, 2.2);

      const interactionPointer = canvas?.app?.renderer?.plugins?.interaction?.mouse?.global;
      if (interactionPointer) add(interactionPointer, 1.6);

      const eventSystemPointer = canvas?.app?.renderer?.eventSystem?.pointer?.global;
      if (eventSystemPointer) add(eventSystemPointer, 1.9);

      if (!candidates.length) return null;
      candidates.sort((a, b) => b.weight - a.weight);
      const top = candidates[0];
      return { x: top.x, y: top.y };
    } catch (_) {
      return null;
    }
  }

  _buildAssetDataFromTile(tileDocument) {
    try {
      const doc = tileDocument?.document ?? tileDocument;
      if (!doc) return null;
      const texture = doc.texture || {};
      const src = String(texture.src || '').trim();
      if (!src) return null;
      const gridSize = Number(canvas?.scene?.grid?.size || 100) || 100;
      const width = Math.max(1, Number(doc.width || 0) || gridSize);
      const height = Math.max(1, Number(doc.height || 0) || gridSize);
      const gridWidth = Math.max(0.01, width / gridSize);
      const gridHeight = Math.max(0.01, height / gridSize);
      const isRemote = /^https?:/i.test(src);
      const filename = src.split('/').pop() || '';
      return {
        source: isRemote ? 'cloud' : 'local',
        tier: isRemote ? 'premium' : 'local',
        file_path: src,
        folder_path: '',
        cachedLocalPath: src,
        path: src,
        url: src,
        filename,
        grid_width: gridWidth,
        grid_height: gridHeight,
        width,
        height,
        actual_width: width,
        actual_height: height
      };
    } catch (error) {
      Logger.warn('Placement.assetDataFromTile.failed', String(error?.message || error));
      return null;
    }
  }

  _captureTileVisibility(tileObject) {
    try {
      if (!tileObject) return null;
      const snapshot = {
        visible: tileObject.visible,
        renderable: typeof tileObject.renderable === 'boolean' ? tileObject.renderable : undefined,
        alpha: Number.isFinite(tileObject.alpha) ? tileObject.alpha : undefined,
        mesh: null,
        sprite: null,
        root: null
      };
      const mesh = tileObject.mesh;
      if (mesh) {
        snapshot.mesh = {
          visible: mesh.visible,
          renderable: typeof mesh.renderable === 'boolean' ? mesh.renderable : undefined,
          alpha: Number.isFinite(mesh.alpha) ? mesh.alpha : undefined
        };
      }
      const sprite = tileObject.sprite;
      if (sprite) {
        snapshot.sprite = {
          visible: sprite.visible,
          renderable: typeof sprite.renderable === 'boolean' ? sprite.renderable : undefined,
          alpha: Number.isFinite(sprite.alpha) ? sprite.alpha : undefined
        };
      }
      const root = tileObject.root;
      if (root) {
        snapshot.root = {
          visible: root.visible,
          renderable: typeof root.renderable === 'boolean' ? root.renderable : undefined,
          alpha: Number.isFinite(root.alpha) ? root.alpha : undefined
        };
      }
      return snapshot;
    } catch (_) {
      return null;
    }
  }

  _applyTileVisibilitySnapshot(tileObject, snapshot) {
    if (!tileObject || !snapshot) return;
    if (tileObject.destroyed) return;
    try {
      if (snapshot.visible !== undefined) tileObject.visible = snapshot.visible;
      if (snapshot.renderable !== undefined && typeof tileObject.renderable === 'boolean') {
        tileObject.renderable = snapshot.renderable;
      }
      if (snapshot.alpha !== undefined && Number.isFinite(snapshot.alpha)) tileObject.alpha = snapshot.alpha;
      const mesh = tileObject.mesh;
      const meshSnap = snapshot.mesh;
      if (mesh && !mesh.destroyed && meshSnap) {
        if (meshSnap.visible !== undefined) mesh.visible = meshSnap.visible;
        if (meshSnap.renderable !== undefined && typeof mesh.renderable === 'boolean') {
          mesh.renderable = meshSnap.renderable;
        }
        if (meshSnap.alpha !== undefined && Number.isFinite(meshSnap.alpha)) mesh.alpha = meshSnap.alpha;
      }
      const sprite = tileObject.sprite;
      const spriteSnap = snapshot.sprite;
      if (sprite && !sprite.destroyed && spriteSnap) {
        if (spriteSnap.visible !== undefined) sprite.visible = spriteSnap.visible;
        if (spriteSnap.renderable !== undefined && typeof sprite.renderable === 'boolean') {
          sprite.renderable = spriteSnap.renderable;
        }
        if (spriteSnap.alpha !== undefined && Number.isFinite(spriteSnap.alpha)) sprite.alpha = spriteSnap.alpha;
      }
      const root = tileObject.root;
      const rootSnap = snapshot.root;
      if (root && !root.destroyed && rootSnap) {
        if (rootSnap.visible !== undefined) root.visible = rootSnap.visible;
        if (rootSnap.renderable !== undefined && typeof root.renderable === 'boolean') {
          root.renderable = rootSnap.renderable;
        }
        if (rootSnap.alpha !== undefined && Number.isFinite(rootSnap.alpha)) root.alpha = rootSnap.alpha;
      }
    } catch (_) {}
  }

  _hideTileForEditing(tileObject) {
    if (!tileObject || tileObject.destroyed) return;
    try {
      tileObject.visible = false;
      if (typeof tileObject.renderable === 'boolean') tileObject.renderable = false;
      if (Number.isFinite(tileObject.alpha)) tileObject.alpha = 0;
      const mesh = tileObject.mesh;
      if (mesh && !mesh.destroyed) {
        mesh.visible = false;
        if (typeof mesh.renderable === 'boolean') mesh.renderable = false;
        if (Number.isFinite(mesh.alpha)) mesh.alpha = 0;
      }
      const sprite = tileObject.sprite;
      if (sprite && !sprite.destroyed) {
        sprite.visible = false;
        if (typeof sprite.renderable === 'boolean') sprite.renderable = false;
        if (Number.isFinite(sprite.alpha)) sprite.alpha = 0;
      }
      const root = tileObject.root;
      if (root && !root.destroyed) {
        root.visible = false;
        if (typeof root.renderable === 'boolean') root.renderable = false;
        if (Number.isFinite(root.alpha)) root.alpha = 0;
      }
    } catch (_) {}
  }

  _releaseTileSelection(tileObject) {
    try {
      if (tileObject?.controlled && typeof tileObject.release === 'function') {
        tileObject.release();
      }
      const layer = canvas?.tiles;
      const controlled = Array.isArray(layer?.controlled) ? layer.controlled : null;
      if (layer && Array.isArray(controlled) && controlled.length) {
        try { layer.releaseAll?.(); }
        catch (_) {
          for (const placeable of controlled) {
            try { placeable.release?.(); }
            catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  _restoreEditingTileVisibility() {
    try {
      const tileObject = this._editingTileObject;
      const snapshot = this._editingTileVisibilitySnapshot;
      if (!tileObject || !snapshot) {
        this._editingTileVisibilitySnapshot = null;
        return;
      }
      this._applyTileVisibilitySnapshot(tileObject, snapshot);
    } catch (_) {
      // ignore restore failures
    } finally {
      this._editingTileVisibilitySnapshot = null;
    }
  }

  _suspendEditingTileShadow(doc) {
    try {
      const manager = getAssetShadowManager(this.app);
      if (!manager || typeof manager.suspendTile !== 'function') return false;
      return !!manager.suspendTile(doc);
    } catch (_) {
      return false;
    }
  }

  _resumeEditingTileShadow() {
    if (!this._editingTileShadowSuspended) return;
    try {
      const manager = getAssetShadowManager(this.app);
      if (manager && typeof manager.resumeTile === 'function' && this._editingTile) {
        manager.resumeTile(this._editingTile);
      }
    } catch (_) {
      // ignore resume failures
    } finally {
      this._editingTileShadowSuspended = false;
    }
  }

  _applyTileStateToPlacement(tileDocument, { force = false } = {}) {
    try {
      if (!tileDocument) return;
      const doc = tileDocument.document ?? tileDocument;
      if (!doc) return;
      this._editingTile = doc;
      const shadowEnabled = !!doc.getFlag('fa-nexus', 'shadow');
      this._dropShadowPreference = shadowEnabled ? true : false;

      const readFlag = (key, fallback) => {
        try {
          const value = doc.getFlag('fa-nexus', key);
          if (value === undefined || value === null) return fallback;
          const numeric = Number(value);
          return Number.isFinite(numeric) ? numeric : fallback;
        } catch (_) {
          return fallback;
        }
      };

      const alpha = readFlag('shadowAlpha', this._dropShadowAlpha);
      this._dropShadowAlpha = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : this._dropShadowAlpha));

      const blur = readFlag('shadowBlur', this._dropShadowBlur);
      this._dropShadowBlur = Math.max(0, Number.isFinite(blur) ? blur : this._dropShadowBlur);

      const dilation = readFlag('shadowDilation', this._dropShadowDilation);
      this._dropShadowDilation = Math.min(MAX_SHADOW_DILATION, Math.max(0, Number.isFinite(dilation) ? dilation : this._dropShadowDilation));

      let offsetDistance = readFlag('shadowOffsetDistance', this._dropShadowOffsetDistance);
      offsetDistance = Math.min(MAX_SHADOW_OFFSET, Math.max(0, Number.isFinite(offsetDistance) ? offsetDistance : this._dropShadowOffsetDistance));
      let offsetAngle = readFlag('shadowOffsetAngle', this._dropShadowOffsetAngle);
      offsetAngle = this._normalizeShadowAngle(Number.isFinite(offsetAngle) ? offsetAngle : this._dropShadowOffsetAngle);
      let offsetX = readFlag('shadowOffsetX', null);
      let offsetY = readFlag('shadowOffsetY', null);
      if (Number.isFinite(offsetX) && Number.isFinite(offsetY)) {
        offsetDistance = Math.min(MAX_SHADOW_OFFSET, Math.hypot(offsetX, offsetY));
        offsetAngle = this._normalizeShadowAngle(Math.atan2(offsetY, offsetX) * (180 / Math.PI));
      } else {
        const vecFallback = this._computeShadowOffsetVector(offsetDistance, offsetAngle);
        offsetX = vecFallback.x;
        offsetY = vecFallback.y;
      }
      this._dropShadowOffsetDistance = offsetDistance;
      this._dropShadowOffsetAngle = offsetAngle;

      const canApply = this._isEditingExistingTile || force;
      if (!canApply) {
        this._pendingEditState = { doc };
        this._refreshShadowElevationContext({ adopt: false, sync: true });
        this._notifyDropShadowChanged();
        return;
      }
      if (!this._previewContainer) {
        this._pendingEditState = { doc };
        this._refreshShadowElevationContext({ adopt: false, sync: true });
        this._notifyDropShadowChanged();
        return;
      }

      this._pendingEditState = null;

      const center = {
        x: Number(doc.x || 0) + Number(doc.width || 0) / 2,
        y: Number(doc.y || 0) + Number(doc.height || 0) / 2
      };
      this._lastPointerWorld = { ...center };
      this._previewContainer.x = center.x;
      this._previewContainer.y = center.y;

      this._previewElevation = Number(doc.elevation ?? 0) || 0;
      this._lastElevationUsed = this._previewElevation;
      this._previewSort = Number(doc.sort ?? 0) || 0;
      this._syncPreviewOrdering();

      this.currentRotation = this._normalizeRotation(doc.rotation || 0);
      this._pendingRotation = this.currentRotation;
      this._updateRotationPreview({ clampOffset: true });

      this.currentScale = 1;
      this._pendingScale = this.currentScale;
      this._updateScalePreview({ clampOffset: true });

      const texScaleX = Number(doc?.texture?.scaleX ?? 1);
      const texScaleY = Number(doc?.texture?.scaleY ?? 1);
      this._flipHorizontal = texScaleX < 0;
      this._flipVertical = texScaleY < 0;
      this._pendingFlipHorizontal = this._flipHorizontal;
      this._pendingFlipVertical = this._flipVertical;
      this._applyPendingFlipToPreview({ forceShadow: true });

      this._updatePreviewShadow({ force: true });

      this._refreshShadowElevationContext({ adopt: false, sync: true });
      this._notifyDropShadowChanged();
    } catch (error) {
      Logger.warn('Placement.applyTileState.failed', String(error?.message || error));
    }
  }

  _computeWorldSizeForAsset(asset, scaleMul = this._getPendingScale()) {
    try {
      const assetPx = this._getAssetBasePxPerSquare();
      const sceneGridSize = canvas?.scene?.grid?.size || 100;
      const gridScaleFactor = sceneGridSize / assetPx;
      const gw = Math.max(0.01, Number(asset?.grid_width || 1));
      const gh = Math.max(0.01, Number(asset?.grid_height || 1));
      const sm = Number(scaleMul || 1) || 1;
      const worldWidth = gw * assetPx * gridScaleFactor * sm;
      const worldHeight = gh * assetPx * gridScaleFactor * sm;
      return { worldWidth, worldHeight };
    } catch (_) {
      return { worldWidth: 200, worldHeight: 200 };
    }
  }

  _showLoadingOverlay(dimensions = { worldWidth: 200, worldHeight: 200 }) {
    try {
      const pointer = (() => {
        if (this._previewFrozen && this._frozenPointerScreen) {
          return { x: this._frozenPointerScreen.x, y: this._frozenPointerScreen.y };
        }
        return this._lastPointer ? { x: this._lastPointer.x, y: this._lastPointer.y } : null;
      })();
      const worldWidth = Math.max(0.01, Number(dimensions.worldWidth || 200));
      const worldHeight = Math.max(0.01, Number(dimensions.worldHeight || 200));
      this._hideLoadingOverlay();
      let spinner = null;
      const overlay = new PlacementOverlay({
        className: 'fa-nexus-placement-loading',
        pointer,
        worldWidth,
        worldHeight,
        onSizeChange: (screenWidth, screenHeight) => {
          if (spinner) {
            spinner.style.width = `${screenWidth}px`;
            spinner.style.height = `${screenHeight}px`;
          }
        }
      });
      spinner = createPlacementSpinner();
      spinner.style.width = '100%';
      spinner.style.height = '100%';
      overlay.content.appendChild(spinner);
      this._loadingOverlay = { overlay, spinner, worldWidth, worldHeight };
    } catch (_) {}
  }

  _hideLoadingOverlay() {
    try { this._loadingOverlay?.overlay?.destroy?.(); }
    catch (_) {}
    this._loadingOverlay = null;
  }

  _updateLoadingOverlaySize(worldWidth, worldHeight) {
    try {
      if (!this._loadingOverlay?.overlay) return;
      const current = this._loadingOverlay;
      const ww = Number.isFinite(worldWidth) ? worldWidth : current.worldWidth;
      const wh = Number.isFinite(worldHeight) ? worldHeight : current.worldHeight;
      current.worldWidth = ww;
      current.worldHeight = wh;
      current.overlay.setWorldSize(ww, wh, { trackZoom: true });
    } catch (_) {}
  }

  _updateLoadingOverlayPointer(screenX, screenY) {
    try {
      if (!this._loadingOverlay?.overlay) return;
      this._loadingOverlay.overlay.updatePointer(screenX, screenY);
    } catch (_) {}
  }

  _assetRequiresDownload(asset) {
    if (!asset) return false;
    if (asset.cachedLocalPath) return false;
    const source = String(asset.source || '').toLowerCase();
    if (source !== 'cloud') return false;
    return true;
  }

  async _ensureAssetLocal(asset) {
    if (!asset) return null;
    if (asset.cachedLocalPath) return asset.cachedLocalPath;
    const source = String(asset.source || '').toLowerCase();
    if (source !== 'cloud') return asset.path || asset.url || null;
    const filename = String(asset.filename || '');
    const item = {
      file_path: asset.file_path || asset.path,
      filename,
      tier: asset.tier || 'free',
      path: asset.folder_path || asset.path || asset.file_path || ''
    };
    const app = this.app;
    const content = app?._contentService;
    const dl = app?._downloadManager;
    if (!content || !dl) throw new Error('Content services unavailable');
    const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
    const authed = !!(auth && auth.authenticated && auth.state);
    const fullUrl = await content.getFullURL('assets', item, authed ? auth.state : undefined);
    const local = await dl.ensureLocal('assets', item, fullUrl);
    if (local) {
      asset.cachedLocalPath = local;
      asset.path = local;
      asset.url = local;
      try { this._updateGridCardDownloaded(asset.file_path || asset.path, local); }
      catch (_) {}
    }
    return local;
  }

  async _prepareCurrentAssetPreview(options = {}) {
    const { initial = false } = options || {};
    const asset = this.currentAsset;
    if (!asset) return;
    const { worldWidth, worldHeight } = this._computeWorldSizeForAsset(asset, this._getPendingScale());
    const needsDownload = this._assetRequiresDownload(asset);
    if (needsDownload) {
      this.isDownloading = true;
      this._removePreviewElement();
      this._showLoadingOverlay({ worldWidth, worldHeight });
      try {
        await this._ensureAssetLocal(asset);
      } catch (error) {
        Logger.warn('Placement.prepare.download.failed', String(error?.message || error));
        ui.notifications?.error?.(`Failed to download asset: ${error?.message || error}`);
        this.isDownloading = false;
        this._hideLoadingOverlay();
        if (initial) this.cancelPlacement('error');
        return;
      }
    }

    if (!this.isPlacementActive) {
      this.isDownloading = false;
      this._hideLoadingOverlay();
      return;
    }

    if (asset !== this.currentAsset) {
      this.isDownloading = false;
      this._hideLoadingOverlay();
      return;
    }

    this._removePreviewElement();
    this._hideLoadingOverlay();
    this.isDownloading = false;
    this._createPreviewElement();
    await this._flushQueuedPlacement();
  }

  async _flushQueuedPlacement() {
    if (!this.queuedPlacement) return;
    const qp = this.queuedPlacement;
    this.queuedPlacement = null;
    try {
      await this._placeAtScreenCoordinates(qp.x, qp.y);
    } catch (error) {
      Logger.warn('Placement.queued.failed', String(error?.message || error));
    }
  }

  _removePreviewElement() {
    try {
      if (this._previewContainer) {
        this._cleanupPreviewShadowResources(this._previewContainer);
        this._previewContainer.parent?.removeChild(this._previewContainer);
        this._previewContainer.destroy({ children: true });
      }
    } catch (_) {}
    this._previewContainer = null;
    this.previewElement = null;
    this._shadowPreviewTextureListener = null;
    this._clearShadowOffsetPreview();
  }

  _startInteractionSession() {
    this._stopInteractionSession();

    const pointerMoveHandler = (event, { pointer }) => {
      if (!this.isPlacementActive) return;
      if (this._isEditingExistingTile) return;
      if (pointer?.screen) {
        this._lastPointer = { x: pointer.screen.x, y: pointer.screen.y };
      }
      const overlayPointer = (() => {
        if (this._previewFrozen) {
          if (this._frozenPointerScreen) return this._frozenPointerScreen;
          const frozenWorld = this._frozenPreviewWorld;
          if (frozenWorld) {
            const screen = this._canvasToScreen(frozenWorld.x, frozenWorld.y);
            if (screen) {
              this._frozenPointerScreen = screen;
              return screen;
            }
          }
          return null;
        }
        return pointer?.screen || null;
      })();
      if (this._loadingOverlay?.overlay && overlayPointer) {
        this._updateLoadingOverlayPointer(overlayPointer.x, overlayPointer.y);
      }

      let worldCoords = pointer?.world || null;
      if ((!worldCoords || !Number.isFinite(worldCoords.x) || !Number.isFinite(worldCoords.y)) && pointer?.screen) {
        worldCoords = this._screenToCanvas(pointer.screen.x, pointer.screen.y);
      }
      if (worldCoords && Number.isFinite(worldCoords.x) && Number.isFinite(worldCoords.y)) {
        this._lastPointerWorld = { x: worldCoords.x, y: worldCoords.y };
      }
      let displayCoords = worldCoords;
      if (displayCoords && this.currentAsset) {
        displayCoords = this._applyGridSnapping(displayCoords);
      }
      if (this._previewContainer && displayCoords && !this._previewFrozen) {
        this._previewContainer.x = displayCoords.x;
        this._previewContainer.y = displayCoords.y;
      }

      if (this._suppressDragSelect && (event.buttons & 1) === 1 && pointer?.overCanvas && pointer?.zOk) {
        try {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
        } catch (_) { /* no-op */ }
      }
    };

    const wheelHandler = (event, { pointer }) => {
      if (!this.isPlacementActive) return;
      if (this._isEditingExistingTile) return;
      const screen = pointer?.screen;
      if (!pointer?.overCanvas || !pointer.zOk || !screen) return;

      if (event.altKey) {
        try {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          const dir = event.deltaY < 0 ? 1 : -1;
          const fineModifier = event.ctrlKey || event.metaKey;
          const baseStep = fineModifier ? 0.01 : 0.1;
          const step = event.shiftKey ? baseStep * 5 : baseStep;
          const minElev = -1000;
          const maxElev = 1000;
          const current = Number.isFinite(this._previewElevation) ? this._previewElevation : 0;
          const raw = current + dir * step;
          const clamped = Math.min(maxElev, Math.max(minElev, raw));
          const next = quantizeElevation(clamped);
          if (next !== this._previewElevation) {
            this._previewElevation = next;
            this._lastElevationUsed = this._previewElevation;
            this._syncPreviewOrdering();
            this._refreshShadowElevationContext({ adopt: true });
            this._announcePreviewElevation(pointer?.world || null);
          }
        } catch (_) { /* no-op */ }
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const baseStep = Number(this._rotationStep || 15) || 15;
        const step = event.shiftKey ? 1 : baseStep;
        const dir = event.deltaY > 0 ? 1 : -1;
        this.currentRotation = ((this.currentRotation + dir * step) % 360 + 360) % 360;
        this._updateRotationPreview({ clampOffset: true });
        this._syncToolOptionsState();
        return;
      }

      if (event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        try {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          const step = 1.05;
          const dir = event.deltaY < 0 ? 1 : -1;
          const current = Number(this.currentScale || 1) || 1;
          let next = current * Math.pow(step, dir);
          next = this._clampScale(next);
          this.currentScale = next;
          this._updateScalePreview({ clampOffset: true });
          this._syncToolOptionsState();
        } catch (_) { /* no-op */ }
        return;
      }

      try {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const stage = canvas?.stage; if (!stage) return;
        const canvasEl = pointer?.canvas || this._interactionController.getCanvasElement?.();
        if (!canvasEl) return;
        const rect = canvasEl.getBoundingClientRect();
        const cx = screen.x - rect.left;
        const cy = screen.y - rect.top;
        const currentScale = Number(stage.scale?.x || 1);
        const step = 1.25;
        const dir = event.deltaY < 0 ? 1 : -1;
        const targetScale = currentScale * Math.pow(step, dir);
        const cfgMin = Number(globalThis?.CONFIG?.Canvas?.minZoom ?? 0.25);
        const cfgMax = Number(globalThis?.CONFIG?.Canvas?.maxZoom ?? 4);
        const minZ = Number.isFinite(cfgMin) ? cfgMin : 0.25;
        const maxZ = Number.isFinite(cfgMax) ? cfgMax : 4;
        const newScale = Math.min(maxZ, Math.max(minZ, targetScale));
        if (Math.abs(newScale - currentScale) < 1e-6) return;
        const worldUnderCursor = stage.worldTransform.applyInverse(new PIXI.Point(cx, cy));
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        const desiredCenterX = worldUnderCursor.x + (centerX - cx) / newScale;
        const desiredCenterY = worldUnderCursor.y + (centerY - cy) / newScale;
        if (typeof canvas?.animatePan === 'function') {
          canvas.animatePan({ x: desiredCenterX, y: desiredCenterY, scale: newScale, duration: 50 });
        } else {
          stage.scale.set(newScale, newScale);
          stage.position.set(centerX - newScale * desiredCenterX, centerY - newScale * desiredCenterY);
        }
      } catch (_) { /* no-op */ }
    };

    const pointerDownHandler = async (event, { pointer }) => {
      if (!this.isPlacementActive) return;
      if (event.button !== 0) return;
      if (this._isEditingExistingTile) {
        try {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
        } catch (_) {}
        return false;
      }
      const screen = pointer?.screen;
      if (!pointer?.overCanvas || !pointer.zOk || !screen) return;
      if (screen) {
        this._lastPointer = { x: screen.x, y: screen.y };
        const world = (pointer?.world && Number.isFinite(pointer.world.x) && Number.isFinite(pointer.world.y))
          ? pointer.world
          : this._screenToCanvas(screen.x, screen.y);
        if (world && Number.isFinite(world.x) && Number.isFinite(world.y)) {
          this._lastPointerWorld = { x: world.x, y: world.y };
        }
      }
      this._suppressDragSelect = true;
      if (this.isDownloading) {
        const queued = (this._previewFrozen && this._frozenPointerScreen)
          ? { x: this._frozenPointerScreen.x, y: this._frozenPointerScreen.y }
          : { x: screen.x, y: screen.y };
        this.queuedPlacement = queued;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        return false;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      await this._handleCanvasPlacement(event, pointer);
      return false;
    };

    const pointerUpHandler = () => {
      if (!this.isPlacementActive) return;
      this._suppressDragSelect = false;
    };

    const keyDownHandler = (event) => {
      if (!this.isPlacementActive) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        this.cancelPlacement('esc');
        return;
      }
      if (this._isEditingExistingTile) return;
      const isSpace = event.code === 'Space' || event.key === ' ';
      if (!isSpace || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (this._shouldIgnoreFreezeShortcut(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      this._togglePlacementFreeze();
    };

    this._gestureSession = createCanvasGestureSession({
      pointermove: { handler: pointerMoveHandler, respectZIndex: false },
      wheel: { handler: wheelHandler, respectZIndex: true },
      pointerdown: pointerDownHandler,
      pointerup: pointerUpHandler,
      pointercancel: pointerUpHandler,
      keydown: keyDownHandler
    }, {
      lockTileInteractivity: true,
      onCanvasTearDown: () => this.cancelPlacement('canvas-teardown'),
      onStop: () => {
        this._gestureSession = null;
        this._stopZoomWatcher();
        this._suppressDragSelect = false;
      }
    });

    this._startZoomWatcher();
  }

  _stopInteractionSession() {
    if (this._gestureSession) {
      try { this._gestureSession.stop('manual'); }
      catch (_) { /* no-op */ }
      return;
    }
    this._stopZoomWatcher();
    this._suppressDragSelect = false;
  }

  async _handleCanvasPlacement(event, pointerContext = null) {
    try {
      if (this._isEditingExistingTile) {
        return;
      }
      if (this._previewFrozen && this._frozenPreviewWorld) {
        const frozenWorld = { x: this._frozenPreviewWorld.x, y: this._frozenPreviewWorld.y };
        const screen = this._frozenPointerScreen ? { ...this._frozenPointerScreen } : null;
        await this._placeAtWorldCoordinates(frozenWorld, {
          screenX: screen?.x ?? null,
          screenY: screen?.y ?? null,
          reason: 'frozen'
        });
        return;
      }
      const screen = pointerContext?.screen;
      const screenX = Number(screen?.x ?? event?.clientX);
      const screenY = Number(screen?.y ?? event?.clientY);
      if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
      await this._placeAtScreenCoordinates(screenX, screenY);
    } catch (e) {
      console.error('fa-nexus | place asset failed', e);
      ui.notifications?.error?.(`Failed to place asset: ${e?.message || e}`);
    }
  }

  async _placeAtScreenCoordinates(screenX, screenY) {
    try {
      const world = this._screenToCanvas(screenX, screenY);
      if (!world) return;
      await this._placeAtWorldCoordinates(world, { screenX, screenY, reason: 'screen' });
    } catch (e) {
      console.error('fa-nexus | place asset failed', e);
      ui.notifications?.error?.(`Failed to place asset: ${e?.message || e}`);
    }
  }

  async _placeAtWorldCoordinates(world, { screenX = null, screenY = null } = {}) {
    try {
      if (!world || !Number.isFinite(world.x) || !Number.isFinite(world.y)) return;
      const worldPoint = { x: Number(world.x), y: Number(world.y) };
      if (Number.isFinite(screenX) && Number.isFinite(screenY)) {
        this._lastPointer = { x: Number(screenX), y: Number(screenY) };
      } else {
        const estimated = this._canvasToScreen(worldPoint.x, worldPoint.y);
        if (estimated && Number.isFinite(estimated.x) && Number.isFinite(estimated.y)) {
          this._lastPointer = { x: estimated.x, y: estimated.y };
        }
      }
      this._lastPointerWorld = { x: worldPoint.x, y: worldPoint.y };
      const snappedWorld = this._applyGridSnapping(worldPoint);
      this._announcePreviewElevation(snappedWorld, { immediate: true });
      if (this._previewFrozen) {
        this._frozenPreviewWorld = { x: snappedWorld.x, y: snappedWorld.y };
        this._refreshFrozenPointerScreen();
      }
      if (!this.currentAsset) return;
      const editingDoc = ((this._isEditingExistingTile || this._replaceOriginalOnPlace) && this._editingTile) ? this._editingTile : null;
      // Re-evaluate sort order before every placement so consecutive drops
      // during the same session continue stacking correctly.
      if (editingDoc) {
        this._previewSort = Number(editingDoc.sort ?? 0) || 0;
        if (this._previewContainer) {
          this._previewContainer.sort = this._previewSort;
          this._previewContainer.faNexusSort = this._previewSort;
          const parent = this._previewContainer.parent;
          if (parent && 'sortDirty' in parent) parent.sortDirty = true;
          parent?.sortChildren?.();
        }
      } else {
        try {
          const controller = this._interactionController;
          const computed = controller?.computeNextSortAtElevation?.(this._previewElevation);
          if (Number.isFinite(computed)) {
            this._previewSort = computed;
            if (this._previewContainer) {
              this._previewContainer.sort = computed;
              this._previewContainer.faNexusSort = computed;
              const parent = this._previewContainer.parent;
              if (parent && 'sortDirty' in parent) parent.sortDirty = true;
              parent?.sortChildren?.();
            }
          }
        } catch (_) { /* no-op */ }
      }
      // If in random lazy mode and the current asset is cloud without local cache, ensure now
      if (this.isRandomMode && this.currentAsset && String(this.currentAsset.source || '').toLowerCase() === 'cloud' && !this.currentAsset.cachedLocalPath) {
        try {
          const app = this.app;
          const content = app?._contentService;
          const dl = app?._downloadManager;
          const filename = String(this.currentAsset.filename || '');
          const item = { file_path: this.currentAsset.file_path || this.currentAsset.path, filename, tier: this.currentAsset.tier || 'free' };
          const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
          const authed = !!(auth && auth.authenticated && auth.state);
          const fullUrl = content?.getFullURL ? await content.getFullURL('assets', item, authed ? auth.state : undefined) : null;
          const local = dl?.ensureLocal && fullUrl ? await dl.ensureLocal('assets', item, fullUrl) : null;
          if (local) {
            this.currentAsset.cachedLocalPath = local;
            this.currentAsset.path = local;
            this.currentAsset.url = local;
            Logger.info('Placement.lazyDownload.done', { filename, local });
            // Reflect in grid UI if possible
            try { this._updateGridCardDownloaded(this.currentAsset.file_path || this.currentAsset.path, local); } catch (_) {}
          }
        } catch (e) {
          Logger.warn('Placement.lazyDownload.failed', String(e?.message || e));
        }
      }
      const assetPx = this._getAssetBasePxPerSquare();
      const sceneGridSize = canvas?.scene?.grid?.size || 100;
      const gridScaleFactor = sceneGridSize / assetPx;
      const sm = this._getPendingScale();
      const placedWidth = Math.round((this._previewContainer?._tileWidth || assetPx) * gridScaleFactor * sm);
      const placedHeight = Math.round((this._previewContainer?._tileHeight || assetPx) * gridScaleFactor * sm);
      const x = Math.round(snappedWorld.x - placedWidth / 2);
      const y = Math.round(snappedWorld.y - placedHeight / 2);
      const globalDropShadowEnabled = this._isGlobalDropShadowEnabled();
      const dropShadowEnabled = globalDropShadowEnabled && this.isDropShadowEnabled();
      const placementRotation = this._getPendingRotation();
      const flipState = this._getPendingFlipState();
      const textureConfig = {
        src: this._encodeAssetPath(this.currentAsset.path),
        scaleX: flipState.horizontal ? -1 : 1,
        scaleY: flipState.vertical ? -1 : 1
      };
      const tileData = {
        texture: textureConfig,
        width: placedWidth, height: placedHeight, x, y,
        rotation: placementRotation, hidden: false, locked: false,
        elevation: this._previewElevation, sort: this._previewSort,
        overhead: false, roof: false, occlusion: { mode: 0, alpha: 0 }
      };
      if (dropShadowEnabled) {
        tileData.flags = tileData.flags || {};
        const moduleFlags = Object.assign({}, tileData.flags['fa-nexus'] || {});
        moduleFlags.shadow = true;
        moduleFlags.shadowAlpha = this._roundShadowValue(this._dropShadowAlpha, 3);
        moduleFlags.shadowDilation = this._roundShadowValue(this._dropShadowDilation, 3);
        moduleFlags.shadowBlur = this._roundShadowValue(this._dropShadowBlur, 3);
        moduleFlags.shadowOffsetDistance = this._roundShadowValue(this._dropShadowOffsetDistance, 2);
        moduleFlags.shadowOffsetAngle = this._roundShadowValue(this._normalizeShadowAngle(this._dropShadowOffsetAngle), 1);
        const offsetVec = this._computeShadowOffsetVector();
        moduleFlags.shadowOffsetX = this._roundShadowValue(offsetVec.x, 2);
        moduleFlags.shadowOffsetY = this._roundShadowValue(offsetVec.y, 2);
        tileData.flags['fa-nexus'] = moduleFlags;
      }
      if (!canvas || !canvas.scene) throw new Error('Canvas unavailable');

      const replaceDoc = (this._replaceOriginalOnPlace && this._editingTile) ? this._editingTile : null;

      if (editingDoc && !replaceDoc) {
        const update = {
          _id: editingDoc.id,
          x,
          y,
          width: placedWidth,
          height: placedHeight,
          rotation: placementRotation,
          elevation: this._previewElevation,
          sort: this._previewSort,
          'texture.scaleX': textureConfig.scaleX,
          'texture.scaleY': textureConfig.scaleY
        };
        if (textureConfig.src && textureConfig.src !== editingDoc.texture?.src) {
          update['texture.src'] = textureConfig.src;
        }
        if (dropShadowEnabled) {
          update['flags.fa-nexus.shadow'] = true;
          update['flags.fa-nexus.shadowAlpha'] = this._roundShadowValue(this._dropShadowAlpha, 3);
          update['flags.fa-nexus.shadowDilation'] = this._roundShadowValue(this._dropShadowDilation, 3);
          update['flags.fa-nexus.shadowBlur'] = this._roundShadowValue(this._dropShadowBlur, 3);
          update['flags.fa-nexus.shadowOffsetDistance'] = this._roundShadowValue(this._dropShadowOffsetDistance, 2);
          update['flags.fa-nexus.shadowOffsetAngle'] = this._roundShadowValue(this._normalizeShadowAngle(this._dropShadowOffsetAngle), 1);
          const offsetVec = this._computeShadowOffsetVector();
          update['flags.fa-nexus.shadowOffsetX'] = this._roundShadowValue(offsetVec.x, 2);
          update['flags.fa-nexus.shadowOffsetY'] = this._roundShadowValue(offsetVec.y, 2);
        } else {
          update['flags.fa-nexus.shadow'] = false;
          update['flags.fa-nexus.shadowAlpha'] = null;
          update['flags.fa-nexus.shadowDilation'] = null;
          update['flags.fa-nexus.shadowBlur'] = null;
          update['flags.fa-nexus.shadowOffsetDistance'] = null;
          update['flags.fa-nexus.shadowOffsetAngle'] = null;
          update['flags.fa-nexus.shadowOffsetX'] = null;
          update['flags.fa-nexus.shadowOffsetY'] = null;
        }
        const updated = await canvas.scene.updateEmbeddedDocuments('Tile', [update], { diff: false });
        if (Array.isArray(updated) && updated[0]) {
          this._editingTile = updated[0];
        }
        this._setPlacementFreeze(false, { announce: false });
        this.cancelPlacement('completed');
        return;
      }

      const created = await canvas.scene.createEmbeddedDocuments('Tile', [tileData]);
      const createdDocs = Array.isArray(created) ? created : [created];
      const primaryCreated = createdDocs[0] || null;
      try { Logger.info('Placement.placed', { path: this.currentAsset?.path, w: placedWidth, h: placedHeight, x, y, rot: placementRotation }); } catch (_) {}

      if (replaceDoc) {
        try {
          await canvas.scene.deleteEmbeddedDocuments('Tile', [replaceDoc.id]);
        } catch (error) {
          Logger.warn('Placement.replaceTile.delete.failed', String(error?.message || error));
          ui.notifications?.warn?.(`Failed to remove original tile: ${error?.message || error}`);
          this._restoreEditingTileVisibility();
          this._resumeEditingTileShadow();
        }
        this._editingTileObject = null;
        this._editingTileVisibilitySnapshot = null;
        this._editingTile = primaryCreated ?? null;
        this._replaceOriginalOnPlace = false;
        this._editingTileShadowSuspended = false;
      }

      if (dropShadowEnabled) {
        try {
          const manager = getAssetShadowManager(this.app);
          for (const doc of createdDocs) {
            manager?.registerTile?.(doc);
          }
          this._refreshShadowElevationContext({ adopt: false });
       } catch (e) {
          Logger.warn('Placement.shadow.register.failed', String(e?.message || e));
        }
      }

      if (this.isPlacementActive) {
        // Prepare preview for the next placement using the newly created tile as context.
        this._syncPreviewOrdering();
        this._prepareNextPlacementRotation();
        this._prepareNextPlacementScale();
        this._prepareNextPlacementFlip();
      }
      this._setPlacementFreeze(false, { announce: false });
      
      // Continue random mode by switching preview to next asset
      if (this.isStickyMode && this.isRandomMode) {
        await this._switchToNextRandomAsset();
        return; // remain active
      }

      // Only cancel placement if not in sticky mode
      if (!this.isStickyMode) { this.cancelPlacement('completed'); }
    } catch (e) {
      console.error('fa-nexus | place asset failed', e);
      ui.notifications?.error?.(`Failed to place asset: ${e?.message || e}`);
    }
  }

  _screenToCanvas(screenX, screenY) {
    try {
      const world = this._interactionController.worldFromScreen?.(screenX, screenY);
      return world ? { x: world.x, y: world.y } : null;
    } catch (_) {
      return null;
    }
  }

  _canvasToScreen(worldX, worldY) {
    try {
      if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return null;
      const stage = canvas?.stage;
      const canvasEl = this._interactionController?.getCanvasElement?.() || document.querySelector('canvas#board');
      if (!stage || !canvasEl || !stage.worldTransform) return null;
      if (typeof PIXI === 'undefined' || typeof PIXI.Point !== 'function') return null;
      const point = stage.worldTransform.apply(new PIXI.Point(worldX, worldY));
      if (!point) return null;
      const rect = canvasEl.getBoundingClientRect();
      return { x: rect.left + point.x, y: rect.top + point.y };
    } catch (_) {
      return null;
    }
  }

  _readShadowSetting(key, fallback, min, max, { wrapAngle = false } = {}) {
    try {
      const settings = globalThis?.game?.settings;
      if (!settings || typeof settings.get !== 'function') return fallback;
      const raw = settings.get('fa-nexus', key);
      if (wrapAngle) return this._normalizeShadowAngle(raw);
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) return fallback;
      return Math.min(max, Math.max(min, numeric));
    } catch (_) {
      return fallback;
    }
  }

  _persistShadowSetting(key, value) {
    try {
      const settings = globalThis?.game?.settings;
      if (!settings || typeof settings.set !== 'function') return;
      const maybe = settings.set('fa-nexus', key, value);
      if (maybe?.catch) maybe.catch(() => {});
    } catch (_) {
      // no-op
    }
  }

  _coerceShadowNumeric(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      if (Number.isFinite(fallback)) return Math.min(max, Math.max(min, fallback));
      return Math.max(min, Math.min(max, min));
    }
    return Math.min(max, Math.max(min, numeric));
  }

  _currentShadowSnapshot() {
    return {
      alpha: Number(this._dropShadowAlpha || 0),
      dilation: Number(this._dropShadowDilation || 0),
      blur: Number(this._dropShadowBlur || 0),
      offsetDistance: Number(this._dropShadowOffsetDistance || 0),
      offsetAngle: this._normalizeShadowAngle(this._dropShadowOffsetAngle || 0)
    };
  }

  _normalizeShadowSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const alpha = Number(snapshot.alpha);
    const dilation = Number(snapshot.dilation);
    const blur = Number(snapshot.blur);
    const offsetDistance = Number(snapshot.offsetDistance);
    const offsetAngle = Number(snapshot.offsetAngle);
    if (!Number.isFinite(alpha) || !Number.isFinite(dilation) || !Number.isFinite(blur) || !Number.isFinite(offsetDistance) || !Number.isFinite(offsetAngle)) {
      return null;
    }
    return {
      alpha: Math.min(1, Math.max(0, alpha)),
      dilation: Math.min(MAX_SHADOW_DILATION, Math.max(0, dilation)),
      blur: Math.min(MAX_SHADOW_BLUR, Math.max(0, blur)),
      offsetDistance: Math.min(MAX_SHADOW_OFFSET, Math.max(0, offsetDistance)),
      offsetAngle: this._normalizeShadowAngle(offsetAngle)
    };
  }

  _compareShadowSnapshots(a, b) {
    if (!a || !b) return false;
    const approx = (x, y, tol = 0.0005) => Math.abs(Number(x || 0) - Number(y || 0)) <= tol;
    if (!approx(a.alpha, b.alpha)) return false;
    if (!approx(a.dilation, b.dilation)) return false;
    if (!approx(a.blur, b.blur)) return false;
    if (!approx(a.offsetDistance, b.offsetDistance)) return false;
    const angleA = this._normalizeShadowAngle(a.offsetAngle);
    const angleB = this._normalizeShadowAngle(b.offsetAngle);
    const angleDelta = Math.abs(angleA - angleB) % 360;
    return angleDelta <= 0.1 || angleDelta >= 359.9;
  }

  _readShadowSettingsCollapsed() {
    try { return !!game.settings.get('fa-nexus', 'assetDropShadowCollapsed'); }
    catch (_) { return false; }
  }

  _persistShadowCollapsed(collapsed) {
    try {
      const result = game.settings.set('fa-nexus', 'assetDropShadowCollapsed', !!collapsed);
      if (result?.catch) result.catch(() => {});
    } catch (_) {}
  }

  _loadShadowPresets() {
    const fallback = Array.from({ length: SHADOW_PRESET_COUNT }, () => null);
    try {
      const raw = game.settings.get('fa-nexus', 'assetDropShadowPresets');
      const parsed = typeof raw === 'string' ? JSON.parse(raw || '[]') : Array.isArray(raw) ? raw : [];
      const list = Array.from({ length: SHADOW_PRESET_COUNT }, (_, index) => this._normalizeShadowSnapshot(parsed?.[index]));
      return list;
    } catch (_) {
      return fallback;
    }
  }

  _persistShadowPresets() {
    try {
      const payload = JSON.stringify((this._shadowPresets || []).map((snap) => (snap ? {
        alpha: snap.alpha,
        dilation: snap.dilation,
        blur: snap.blur,
        offsetDistance: snap.offsetDistance,
        offsetAngle: snap.offsetAngle
      } : null)));
      const result = game.settings.set('fa-nexus', 'assetDropShadowPresets', payload);
      if (result?.catch) result.catch(() => {});
    } catch (_) {}
  }

  _persistCurrentShadowSettings() {
    this._persistShadowSetting('assetDropShadowAlpha', this._dropShadowAlpha);
    this._persistShadowSetting('assetDropShadowDilation', this._dropShadowDilation);
    this._persistShadowSetting('assetDropShadowBlur', this._dropShadowBlur);
    this._persistShadowSetting('assetDropShadowOffsetDistance', this._dropShadowOffsetDistance);
    this._persistShadowSetting('assetDropShadowOffsetAngle', this._dropShadowOffsetAngle);
  }

  _normalizeShadowAngle(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    let normalized = numeric % 360;
    if (normalized < 0) normalized += 360;
    return normalized;
  }

  _roundShadowValue(value, decimals = 2) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    const places = Math.max(0, Math.min(6, Math.floor(decimals)));
    const factor = 10 ** places;
    return Math.round(numeric * factor) / factor;
  }

  _scheduleEditingCommit(immediate = false) {
    if (!this._isEditingExistingTile) return;
    if (this._editingCommitTimer) {
      try { clearTimeout(this._editingCommitTimer); }
      catch (_) {}
      this._editingCommitTimer = null;
    }
    if (immediate) {
      this._commitEditingShadowChanges();
      return;
    }
    this._editingCommitTimer = setTimeout(() => {
      this._editingCommitTimer = null;
      this._commitEditingShadowChanges();
    }, 150);
  }

  _commitEditingShadowChanges() {
    if (!this._isEditingExistingTile || !this._editingTile || !canvas?.scene) return;
    if (this._editingCommitTimer) {
      try { clearTimeout(this._editingCommitTimer); }
      catch (_) {}
      this._editingCommitTimer = null;
    }
    const doc = this._editingTile;
    const enabled = this.isDropShadowEnabled();
    const offsetVec = this._computeShadowOffsetVector();
    let placedWidth = null;
    let placedHeight = null;
    try {
      const dims = this._computeWorldSizeForAsset(this.currentAsset, this._getPendingScale());
      if (dims && Number.isFinite(dims.worldWidth) && Number.isFinite(dims.worldHeight)) {
        placedWidth = Math.max(1, Math.round(dims.worldWidth));
        placedHeight = Math.max(1, Math.round(dims.worldHeight));
      }
    } catch (_) {}
    const rotation = this._getPendingRotation();
    const flipState = this._getPendingFlipState();

    const payload = {
      _id: doc.id,
      'flags.fa-nexus.shadow': !!enabled,
      'flags.fa-nexus.shadowAlpha': this._roundShadowValue(this._dropShadowAlpha, 3),
      'flags.fa-nexus.shadowBlur': this._roundShadowValue(this._dropShadowBlur, 3),
      'flags.fa-nexus.shadowDilation': this._roundShadowValue(this._dropShadowDilation, 3),
      'flags.fa-nexus.shadowOffsetDistance': this._roundShadowValue(this._dropShadowOffsetDistance, 2),
      'flags.fa-nexus.shadowOffsetAngle': this._roundShadowValue(this._normalizeShadowAngle(this._dropShadowOffsetAngle), 1),
      'flags.fa-nexus.shadowOffsetX': this._roundShadowValue(offsetVec.x, 2),
      'flags.fa-nexus.shadowOffsetY': this._roundShadowValue(offsetVec.y, 2)
    };

    if (placedWidth !== null) payload.width = placedWidth;
    if (placedHeight !== null) payload.height = placedHeight;
    if (Number.isFinite(rotation)) payload.rotation = rotation;
    payload['texture.scaleX'] = flipState.horizontal ? -1 : 1;
    payload['texture.scaleY'] = flipState.vertical ? -1 : 1;

    const applyUpdates = canvas.scene.updateEmbeddedDocuments('Tile', [payload], { diff: false })
      .then((updated) => {
        const nextDoc = (Array.isArray(updated) && updated[0]) ? updated[0] : doc;
        if (this._isEditingExistingTile && nextDoc) this._editingTile = nextDoc;
        if (this.currentAsset && nextDoc) {
          try {
            this.currentAsset.width = nextDoc.width;
            this.currentAsset.height = nextDoc.height;
            const sceneGridSize = Number(canvas?.scene?.grid?.size || 100) || 100;
            const gw = Number(nextDoc.width || 0) / sceneGridSize;
            const gh = Number(nextDoc.height || 0) / sceneGridSize;
            if (Number.isFinite(gw) && gw > 0) this.currentAsset.grid_width = gw;
            if (Number.isFinite(gh) && gh > 0) this.currentAsset.grid_height = gh;
            this.currentAsset.actual_width = nextDoc.width;
            this.currentAsset.actual_height = nextDoc.height;
          } catch (_) {}
        }
        try {
          const manager = getAssetShadowManager(this.app);
          const elevation = Number((nextDoc && nextDoc.elevation) ?? doc.elevation ?? 0) || 0;
          manager?._scheduleRebuild?.(elevation, true);
        } catch (_) {}
        this._refreshShadowElevationContext({ adopt: false, sync: true });
      })
      .catch((error) => {
        try { Logger.warn('Placement.editTile.update.failed', String(error?.message || error)); }
        catch (_) {}
      });
    if (applyUpdates?.catch) applyUpdates.catch(() => {});
  }

  _computeShadowOffsetVector(distance = this._dropShadowOffsetDistance, angle = this._dropShadowOffsetAngle) {
    const dist = Math.min(MAX_SHADOW_OFFSET, Math.max(0, Number(distance) || 0));
    const theta = this._normalizeShadowAngle(angle) * (Math.PI / 180);
    const x = Math.cos(theta) * dist;
    const y = Math.sin(theta) * dist;
    return { x, y };
  }

  _getCanvasElement() {
    try { return this._interactionController.getCanvasElement?.() || null; }
    catch (_) { return null; }
  }

  _activateTilesLayer() {
    try { canvas?.tiles?.activate?.(); }
    catch (_) { /* no-op */ }
  }

    _syncPreviewOrdering() {
      try {
        if (!this._previewContainer) return;
        const controller = this._interactionController;
        const nextSort = controller.computeNextSortAtElevation?.(this._previewElevation) ?? this._previewSort;
        this._previewSort = nextSort;
        this._previewContainer.sort = nextSort;
        this._previewContainer.faNexusSort = nextSort;
        this._previewContainer.faNexusElevation = this._previewElevation;
        this._previewContainer.elevation = this._previewElevation;
        const parent = this._previewContainer.parent;
        if (parent && 'sortDirty' in parent) parent.sortDirty = true;
        parent?.sortChildren?.();
      } catch (_) {}
  }

  _clearElevationAnnounceTimer() {
    if (this._elevationAnnounceTimer) {
      clearTimeout(this._elevationAnnounceTimer);
      this._elevationAnnounceTimer = null;
    }
    this._pendingElevationAnnouncePoint = null;
  }

  _announcePreviewElevation(worldPoint, options = {}) {
    try {
      const now = Date.now();
      const delta = now - this._lastElevationAnnounce;
      const throttleMs = 75;
      const immediate = options?.immediate === true;
      this._pendingElevationAnnouncePoint = worldPoint ?? this._pendingElevationAnnouncePoint ?? null;

      if (immediate || delta >= throttleMs) {
        this._flushPreviewElevationAnnounce();
        return;
      }

      const remaining = Math.max(0, throttleMs - delta);
      if (this._elevationAnnounceTimer) clearTimeout(this._elevationAnnounceTimer);
      this._elevationAnnounceTimer = setTimeout(() => {
        this._elevationAnnounceTimer = null;
        this._flushPreviewElevationAnnounce();
      }, remaining);
    } catch (_) {}
  }

  _flushPreviewElevationAnnounce() {
    try {
      this._lastElevationAnnounce = Date.now();
      const worldPoint = this._pendingElevationAnnouncePoint ?? null;
      this._pendingElevationAnnouncePoint = null;
      const text = `Elevation: ${formatElevation(this._previewElevation)}`;
      if (worldPoint && canvas?.interface?.createScrollingText && globalThis.CONST?.TEXT_ANCHOR_POINTS) {
        canvas.interface.createScrollingText(worldPoint, text, {
          anchor: CONST.TEXT_ANCHOR_POINTS.CENTER,
          direction: CONST.TEXT_ANCHOR_POINTS.TOP,
          distance: 60,
          duration: 900,
          fade: 0.8,
          stroke: 0x111111,
          strokeThickness: 4,
          fill: 0xffffff,
          fontSize: 26
        });
      }
    } catch (_) {}
  }

  _encodeAssetPath(p) {
    if (!p) return p;
    if (/^https?:/i.test(p)) return p;
    try {
      return encodeURI(decodeURI(String(p)));
    } catch (_) {
      try { return encodeURI(String(p)); } catch (err) { return p; }
    }
  }

  _addPlacementFeedback() { 
    try { 
      this.app?.element?.classList?.add?.('placement-active'); 
      // Always show sticky mode since it's now the default
      this.app?.element?.classList?.add?.('placement-sticky');
      this._applyPlacementFreezeClass();
    } catch (_) {} 
    const message = 'Click to place. Wheel zooms to cursor. Ctrl/Cmd+Wheel rotates (Shift=1°). Alt+Wheel adjusts elevation (Shift=coarse, Ctrl/Cmd=fine). Shift+Wheel scales preview. Right-click or ESC to cancel.';
    announceChange('asset-placement', message, { throttleMs: 800 });
  }
  _removePlacementFeedback() { 
    try { 
      this.app?.element?.classList?.remove?.('placement-active'); 
      this.app?.element?.classList?.remove?.('placement-sticky'); 
      this.app?.element?.classList?.remove?.('placement-frozen');
    } catch (_) {} 
  }

  /** Keep preview sized to current canvas zoom */
  _applyZoomToPreview(zoomLevel) {
    try {
      const sm = Number(this._previewContainer?._scaleMul || this.currentScale || 1) || 1;
      let worldWidth = null;
      let worldHeight = null;
      if (this._previewContainer) {
        const tw = Number(this._previewContainer._tileWidth || 0);
        const th = Number(this._previewContainer._tileHeight || 0);
        const gsf = Number(this._previewContainer._gridScaleFactor || 1);
        if (tw && th) {
          worldWidth = tw * gsf * sm;
          worldHeight = th * gsf * sm;
          if (this._previewContainer._sprite) {
            this._previewContainer._sprite.width = worldWidth;
            this._previewContainer._sprite.height = worldHeight;
          }
        }
      }
      if ((!worldWidth || !worldHeight) && this.currentAsset) {
        const dims = this._computeWorldSizeForAsset(this.currentAsset, sm);
        worldWidth = dims.worldWidth;
        worldHeight = dims.worldHeight;
      }
      if (!worldWidth || !worldHeight) return;
      this._applyPendingFlipToPreview({ syncShadow: false });
      this._updateLoadingOverlaySize(worldWidth, worldHeight);
      this._updatePreviewShadow();
      this._scheduleShadowOffsetPreviewUpdate();
    } catch (_) { /* no-op */ }
  }

  _startZoomWatcher() {
    try {
      this._stopZoomWatcher();
      const loop = () => {
        if (!this.isPlacementActive) { this._zoomWatcherId = null; return; }
        const z = canvas?.stage?.scale?.x || 1;
        if (z !== this._lastZoom) {
          this._lastZoom = z;
          this._applyZoomToPreview(z);
        }
        if (this._previewFrozen) this._refreshFrozenPointerScreen();
        this._zoomWatcherId = window.requestAnimationFrame(loop);
      };
      this._lastZoom = canvas?.stage?.scale?.x || 1;
      if (this._previewFrozen) this._refreshFrozenPointerScreen();
      this._zoomWatcherId = window.requestAnimationFrame(loop);
    } catch (_) { /* no-op */ }
  }

  _stopZoomWatcher() {
    try {
      if (this._zoomWatcherId) {
        window.cancelAnimationFrame(this._zoomWatcherId);
        this._zoomWatcherId = null;
      }
    } catch (_) { /* no-op */ }
  }

  _pickRandomAsset() {
    try {
      if (!Array.isArray(this.randomAssets) || !this.randomAssets.length) return null;
      const queue = this._randomPrefetch;
      let picked = queue?.next?.(this.currentAsset) || null;
      if (picked) {
        try { Logger.info('Placement.random.pick', { source: 'queue', filename: picked?.filename || picked?.path }); } catch (_) {}
        return picked;
      }
      const idx = Math.floor(Math.random() * this.randomAssets.length);
      picked = this.randomAssets[idx];
      try { Logger.info('Placement.random.pick', { source: 'fallback', index: idx, filename: picked?.filename || picked?.path }); } catch (_) {}
      return picked;
    } catch (_) { return null; }
  }

  async _switchToNextRandomAsset(initial = false) {
    const next = this._pickRandomAsset();
    if (!next) return;
    // If cloud and not cached, fetch now before preview
    if (String(next.source || '').toLowerCase() === 'cloud' && !next.cachedLocalPath) {
      this.isDownloading = true;
      const dims = this._computeWorldSizeForAsset(next, this._getPendingScale());
      this._removePreviewElement();
      this._showLoadingOverlay(dims);
      try {
        await this._ensureAssetLocal(next);
      } catch (e) {
        Logger.warn('Placement.lazyPrime.failed', String(e?.message || e));
      }
    }
    this.currentAsset = next;
    const lastWorld = (() => {
      if (this._previewFrozen && this._frozenPreviewWorld && Number.isFinite(this._frozenPreviewWorld.x) && Number.isFinite(this._frozenPreviewWorld.y)) {
        return { x: this._frozenPreviewWorld.x, y: this._frozenPreviewWorld.y };
      }
      if (this._lastPointerWorld && Number.isFinite(this._lastPointerWorld.x) && Number.isFinite(this._lastPointerWorld.y)) {
        return { x: this._lastPointerWorld.x, y: this._lastPointerWorld.y };
      }
      return null;
    })();
    const lastScreen = (() => {
      if (this._previewFrozen && this._frozenPointerScreen && Number.isFinite(this._frozenPointerScreen.x) && Number.isFinite(this._frozenPointerScreen.y)) {
        return { x: this._frozenPointerScreen.x, y: this._frozenPointerScreen.y };
      }
      return this._lastPointer || null;
    })();
    this._removePreviewElement();
    this._hideLoadingOverlay();
    this._createPreviewElement();
    this._applyPendingRotationToPreview();
    this._applyPendingScaleToPreview();
    this._applyPendingFlipToPreview({ forceShadow: true });
    try {
      let world = null;
      if (lastWorld) {
        world = lastWorld;
      } else if (lastScreen) {
        world = this._screenToCanvas(lastScreen.x, lastScreen.y);
      }
      if (world && this._previewContainer) {
        this._previewContainer.x = world.x;
        this._previewContainer.y = world.y;
      }
    } catch (_) {}
    this.isDownloading = false;
    // Refill prefetch queue for smoother next placements
    try { this._randomPrefetch?.prime?.(this.currentAsset); } catch (_) {}
    // If user clicked during download, place now at queued coords
    await this._flushQueuedPlacement();
  }

  _updateGridCardDownloaded(filePath, localPath) {
    try {
      if (!filePath || !this.app?.element) return;
      const grid = this.app.element.querySelector('#fa-nexus-grid');
      if (!grid) return;
      const sel = `.fa-nexus-card[data-file-path="${CSS.escape(String(filePath))}"]`;
      const card = grid.querySelector(sel) || grid.querySelector(`.fa-nexus-card[data-filename="${CSS.escape(String((filePath||'').split('/').pop()||''))}"]`);
      if (!card) return;
      try { card.setAttribute('data-cached', 'true'); } catch (_) {}
      try { if (localPath) card.setAttribute('data-url', localPath); } catch (_) {}
      const statusIcon = card.querySelector('.fa-nexus-status-icon');
      if (statusIcon) {
        statusIcon.classList.remove('cloud-plus', 'cloud', 'premium');
        statusIcon.classList.add('cloud','cached');
        statusIcon.title = 'Downloaded';
        statusIcon.innerHTML = '<i class="fas fa-cloud-check"></i>';
      }
    } catch (_) {}
  }

  _assetKey(asset) {
    return String(asset?.file_path || asset?.path || asset?.filename || '').toLowerCase();
  }
}
