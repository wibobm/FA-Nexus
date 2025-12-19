import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { forgeIntegration } from '../core/forge-integration.js';
import { TileFlattenDialog } from './tile-flatten-dialog.js';
import { AssetShadowManager } from '../assets/asset-shadow-manager.js';
import { encodeTexturePath, applyMaskedTilingToTile } from '../textures/texture-render.js';
import { applyPathTile } from '../paths/path-geometry.js';

/**
 * Manages flattening multiple tiles into a single image
 */
export class TileFlattenManager {
  constructor() {
    this._flattening = false;
    this._deconstructing = false;
  }

  /**
   * Get currently selected tiles
   * @returns {Array<import('foundry/applications/api').TileDocument>}
   */
  static getSelectedTiles() {
    try {
      const layer = canvas?.tiles;
      if (!layer) return [];
      const controlled = Array.isArray(layer.controlled) ? layer.controlled : [];
      const tiles = [];
      for (const placeable of controlled) {
        const doc = placeable?.document;
        if (doc && doc instanceof foundry.documents.TileDocument) {
          tiles.push(doc);
        }
      }
      return tiles;
    } catch (error) {
      Logger.warn('TileFlatten.getSelectedTiles.failed', { error: String(error?.message || error) });
      return [];
    }
  }

  /**
   * Check if multiple tiles are selected
   * @returns {boolean}
   */
  static hasMultipleTilesSelected() {
    return this.getSelectedTiles().length > 1;
  }

  /**
   * Show flatten dialog and process flattening
   */
  async showFlattenDialog() {
    const selectedTiles = TileFlattenManager.getSelectedTiles();
    if (selectedTiles.length < 2) {
      ui?.notifications?.warn?.('Please select at least 2 tiles to flatten.');
      return;
    }

    if (this.isBusy()) {
      ui?.notifications?.warn?.('Another flattening or deconstruction operation is already in progress.');
      return;
    }

    const dialog = new TileFlattenDialog({ tiles: selectedTiles });
    const result = await dialog.render(true);
    
    if (!result || result.cancelled) return;

    await this.flattenTiles(selectedTiles, result);
  }

  /**
   * Flatten multiple tiles into a single image
   * @param {Array<import('foundry/applications/api').TileDocument>} tiles
   * @param {object} options
   * @param {number} options.ppi - Pixels per inch
   * @param {number} options.quality - WebP quality (0-1)
   */
  async flattenTiles(tiles, options = {}) {
    if (this.isBusy()) {
      Logger.warn('TileFlatten.flattenTiles.busy');
      return;
    }

    this._flattening = true;
    const { ppi = 200, quality = 0.85 } = options || {};

    try {
      ui?.notifications?.info?.('Flattening tiles... This may take a moment.');

      const { targets, skipped } = this._filterFlattenTargets(tiles);
      if (skipped.length) {
        Logger.debug?.('TileFlatten.flattenTiles.skipped', {
          skipped: skipped.map((t) => t?.id).filter(Boolean)
        });
        ui?.notifications?.info?.(`Skipped ${skipped.length} building fill/window tile${skipped.length === 1 ? '' : 's'}; flattening walls and frames only.`);
      }

      if (targets.length < 2) {
        ui?.notifications?.warn?.('Please select at least 2 flattenable tiles (walls/frames).');
        return;
      }

      // Compute bounding box of all tiles
      const bounds = this._computeBounds(targets);
      if (!bounds) {
        throw new Error('Could not compute bounds for selected tiles');
      }

      // Render tiles to canvas
      const canvasData = await this._renderTilesToCanvas(targets, bounds, ppi);
      if (!canvasData || !canvasData.canvas) {
        throw new Error('Failed to render tiles to canvas');
      }

      // Save as WebP
      const filePath = await this._saveAsWebP(canvasData.canvas, quality);
      if (!filePath) {
        throw new Error('Failed to save flattened image');
      }

      // Store metadata for deconstruction
      const metadata = this._buildMetadata({
        tiles: targets,
        logicalBounds: bounds,
        renderBounds: canvasData.renderBounds,
        padding: canvasData.padding,
        pixelWidth: canvasData.pixelWidth,
        pixelHeight: canvasData.pixelHeight,
        ppi,
        quality,
        resolution: canvasData.resolution,
        filePath
      });

      // Create flattened tile
      await this._createFlattenedTile(canvasData.renderBounds, filePath, metadata);

      // Delete original tiles
      await this._deleteOriginalTiles(targets);

      ui?.notifications?.info?.('Tiles flattened successfully!');
      Logger.info('TileFlatten.flattenTiles.success', { tileCount: tiles.length, filePath });

    } catch (error) {
      Logger.error('TileFlatten.flattenTiles.failed', { error: String(error?.message || error) });
      ui?.notifications?.error?.(`Failed to flatten tiles: ${error?.message || error}`);
    } finally {
      this._flattening = false;
    }
  }

  /**
   * Compute bounding box of all tiles
   */
  _computeBounds(tiles) {
    if (!Array.isArray(tiles) || tiles.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const doc of tiles) {
      const x = Number(doc.x) || 0;
      const y = Number(doc.y) || 0;
      const width = Number(doc.width) || 0;
      const height = Number(doc.height) || 0;
      const rotation = Number(doc.rotation) || 0;

      // For rotated tiles, compute bounding box of rotated rectangle
      if (rotation !== 0) {
        const rad = rotation * (Math.PI / 180);
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const corners = [
          { x: x, y: y },
          { x: x + width, y: y },
          { x: x + width, y: y + height },
          { x: x, y: y + height }
        ];
        for (const corner of corners) {
          const dx = corner.x - (x + width / 2);
          const dy = corner.y - (y + height / 2);
          const rotatedX = (x + width / 2) + dx * cos - dy * sin;
          const rotatedY = (y + height / 2) + dx * sin + dy * cos;
          minX = Math.min(minX, rotatedX);
          minY = Math.min(minY, rotatedY);
          maxX = Math.max(maxX, rotatedX);
          maxY = Math.max(maxY, rotatedY);
        }
      } else {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + width);
        maxY = Math.max(maxY, y + height);
      }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  /**
   * Filter out building elements that should not be flattened
   * (fill tiles, window sills/windows). Door/window frames and walls are kept.
   */
  _filterFlattenTargets(tiles = []) {
    const targets = [];
    const skipped = [];
    const list = Array.isArray(tiles) ? tiles : [];
    const hasFlag = (doc, key) => {
      try {
        if (typeof doc?.getFlag === 'function') return !!doc.getFlag('fa-nexus', key);
      } catch (_) { /* ignore */ }
      try { return !!doc?.flags?.['fa-nexus']?.[key]; } catch (_) { return false; }
    };

    for (const doc of list) {
      if (!doc) continue;
      const isFill = hasFlag(doc, 'buildingFill');
      const isWindowSill = hasFlag(doc, 'buildingWindowSill');
      const isWindow = hasFlag(doc, 'buildingWindowWindow');
      if (isFill || isWindowSill || isWindow) {
        skipped.push(doc);
        continue;
      }
      targets.push(doc);
    }

    return { targets, skipped };
  }

  /**
   * Render tiles to canvas including shadows, masks, paths
   * Render the stage directly with adjusted transforms - cannot move PrimaryCanvasObjects
   */
  async _renderTilesToCanvas(tiles, bounds, ppi) {
    if (!canvas || !canvas.ready || !canvas.stage || !canvas.app?.renderer) {
      throw new Error('Canvas not available');
    }

    const renderer = canvas.app.renderer;
    const gridSize = Math.max(1, Number(canvas.scene?.grid?.size || 100));
    const resolution = this._computeResolution(ppi, gridSize);
    const padding = this._computePadding(tiles, gridSize, ppi);
    const renderBounds = this._expandBounds(bounds, padding);

    Logger.debug?.('TileFlatten.capture.init', {
      tileIds: tiles.map?.((t) => t?.id).filter(Boolean),
      bounds,
      renderBounds,
      gridSize,
      resolution,
      padding,
      ppi
    });

    const pixelWidth = Math.max(1, Math.round(renderBounds.width * resolution));
    const pixelHeight = Math.max(1, Math.round(renderBounds.height * resolution));

    if (renderBounds.width <= 0 || renderBounds.height <= 0) {
      throw new Error('Invalid dimensions for flattened image');
    }

    const maxTextureSize = this._getMaxTextureSize(renderer);
    if (pixelWidth > maxTextureSize || pixelHeight > maxTextureSize) {
      throw new Error(`Flattened image would exceed renderer texture cap (${pixelWidth}×${pixelHeight}px > ${maxTextureSize})`);
    }

    const visibilityState = await this._applyFlattenVisibility(tiles, renderBounds);

    try {
      await this._waitForShadowLayers(visibilityState.shadowManager, visibilityState.shadowElevations);
      await this._prepareTilesForCapture(tiles);
      
      // Ensure selected tiles are visible
      const selectedIds = new Set(tiles.map(t => t?.id).filter(Boolean));
      for (const doc of tiles) {
        try {
          const placeable = doc?.object;
          if (placeable) {
            placeable.visible = true;
            if (placeable.renderable !== undefined) {
              placeable.renderable = true;
            }
            const visual = placeable.sprite || placeable.mesh;
            if (visual) {
              visual.visible = true;
              if (visual.renderable !== undefined) {
                visual.renderable = true;
              }
            }
          }
        } catch (_) {}
      }
      
      await this._nextFrame();

      const stage = canvas.stage;
      const primary = canvas.primary;
      
      if (!stage || !primary) throw new Error('Canvas stage/primary unavailable');

      const restorePrimaryRender = this._forcePrimaryTransparentClear(primary);
      const restorePrimaryDisplay = this._usePrimaryChildRendering(primary);

      // Store original stage state
      const originalStageState = {
        scaleX: stage.scale?.x ?? 1,
        scaleY: stage.scale?.y ?? 1,
        positionX: stage.position?.x ?? 0,
        positionY: stage.position?.y ?? 0,
        pivotX: stage.pivot?.x ?? 0,
        pivotY: stage.pivot?.y ?? 0
      };
      
      const originalScreen = renderer.screen ? { 
        width: renderer.screen.width, 
        height: renderer.screen.height 
      } : null;

      const rendererBackground = renderer.background || null;
      const previousBackground = rendererBackground
        ? { alpha: rendererBackground.alpha, color: rendererBackground.color }
        : null;
      const hasBackgroundAlpha = typeof renderer.backgroundAlpha === 'number';
      const previousBackgroundAlpha = hasBackgroundAlpha ? renderer.backgroundAlpha : null;

      Logger.debug?.('TileFlatten.capture.stageRender', {
        originalStage: originalStageState,
        renderBounds,
        resolution,
        pixelSize: { width: pixelWidth, height: pixelHeight }
      });

      // Create render texture
      const renderTexture = PIXI.RenderTexture.create({
        width: pixelWidth,
        height: pixelHeight,
        resolution: 1,
        scaleMode: PIXI.SCALE_MODES.LINEAR
      });
      
      if (renderTexture?.baseTexture) {
        try { renderTexture.baseTexture.clearColor = [0, 0, 0, 0]; } catch (_) {}
      }

      let stageAdjusted = false;
      let restoreShadowBlur = null;
      try {
        // Adjust renderer screen to match our render texture size
        if (renderer.screen) {
          renderer.screen.width = pixelWidth;
          renderer.screen.height = pixelHeight;
        }
        
        // Adjust stage to render the target region at the desired resolution
        // Transform world coordinates to render texture coordinates
        try {
          if (stage.pivot && typeof stage.pivot.set === 'function') {
            stage.pivot.set(0, 0);
          }
        } catch (_) {}
        
        try {
          if (stage.position && typeof stage.position.set === 'function') {
            // Position stage so renderBounds.x,y maps to 0,0 in render texture
            // Current stage position + offset = target position
            const targetX = -renderBounds.x * resolution;
            const targetY = -renderBounds.y * resolution;
            stage.position.set(targetX, targetY);
            
            Logger.debug?.('TileFlatten.capture.stagePositionSet', {
              renderBounds,
              resolution,
              targetPosition: { x: targetX, y: targetY },
              stagePosition: { x: stage.position.x, y: stage.position.y }
            });
          }
        } catch (_) {}
        
        try {
          if (stage.scale && typeof stage.scale.set === 'function') {
            stage.scale.set(resolution, resolution);
            
            Logger.debug?.('TileFlatten.capture.stageScaleSet', {
              resolution,
              stageScale: { x: stage.scale.x, y: stage.scale.y }
            });
          }
        } catch (_) {}

        // Recompute shadow blur to match capture scale, restore afterwards
        restoreShadowBlur = this._syncShadowBlurForCapture(visibilityState.shadowManager);
        
        // Make background transparent
        if (rendererBackground) {
          try {
            rendererBackground.alpha = 0;
          } catch (_) {}
        }
        if (hasBackgroundAlpha) {
          try {
            renderer.backgroundAlpha = 0;
          } catch (_) {}
        }
        
        stageAdjusted = true;
        
        // Update transforms - critical for correct rendering
        await this._nextFrame();
        
        try {
          if (typeof stage.updateTransform === 'function') {
            stage.updateTransform();
          }
        } catch (_) {}
        
        try {
          if (typeof primary.updateTransform === 'function') {
            primary.updateTransform();
          }
        } catch (_) {}
        
        // Also update transforms for tiles and background layers
        const tilesLayer = canvas.tiles;
        const backgroundLayer = canvas.background;
        try {
          if (tilesLayer && typeof tilesLayer.updateTransform === 'function') {
            tilesLayer.updateTransform();
          }
        } catch (_) {}
        try {
          if (backgroundLayer && typeof backgroundLayer.updateTransform === 'function') {
            backgroundLayer.updateTransform();
          }
        } catch (_) {}
        
        await this._nextFrame(); // Extra frame for transforms to settle
        
        // Render the stage (which shows only visible tiles due to visibility state)
        try {
          renderer.render(stage, {
            renderTexture,
            clear: true,
            skipUpdateTransform: false
          });
        } catch (renderErr) {
          const errorMsg = String(renderErr?.message || renderErr);
          Logger.error('TileFlatten.capture.renderFailed', { 
            error: errorMsg,
            stagePos: stage.position ? { x: stage.position.x, y: stage.position.y } : null,
            stageScale: stage.scale ? { x: stage.scale.x, y: stage.scale.y } : null
          });
          throw new Error(`Failed to render tiles: ${errorMsg}`);
        }
      } catch (err) {
        renderTexture.destroy(true);
        throw err;
      } finally {
        // Restore stage state
        if (stageAdjusted) {
          try {
            if (stage.scale && typeof stage.scale.set === 'function') {
              stage.scale.set(originalStageState.scaleX, originalStageState.scaleY);
            }
          } catch (_) {}
          
          try {
            if (stage.position && typeof stage.position.set === 'function') {
              stage.position.set(originalStageState.positionX, originalStageState.positionY);
            }
          } catch (_) {}
          
          try {
            if (stage.pivot && typeof stage.pivot.set === 'function') {
              stage.pivot.set(originalStageState.pivotX, originalStageState.pivotY);
            }
          } catch (_) {}
          
          // Restore renderer screen
          if (originalScreen && renderer.screen) {
            renderer.screen.width = originalScreen.width;
            renderer.screen.height = originalScreen.height;
          }
          
          // Update transforms after restoration
          try {
            if (typeof stage.updateTransform === 'function') {
              stage.updateTransform();
            }
          } catch (_) {}
        }
        
        // Restore background
        if (rendererBackground && previousBackground) {
          try {
            rendererBackground.alpha = previousBackground.alpha;
            rendererBackground.color = previousBackground.color;
          } catch (_) {}
        }
        if (hasBackgroundAlpha && previousBackgroundAlpha !== null) {
          try {
            renderer.backgroundAlpha = previousBackgroundAlpha;
          } catch (_) {}
        }

        if (typeof restorePrimaryDisplay === 'function') {
          try { restorePrimaryDisplay(); } catch (_) {}
        }
        if (typeof restorePrimaryRender === 'function') {
          try { restorePrimaryRender(); } catch (_) {}
        }
        if (typeof restoreShadowBlur === 'function') {
          try { restoreShadowBlur(); } catch (_) {}
        }
      }

      const canvasEl = renderer.extract.canvas(renderTexture);
      renderTexture.destroy(true);

      const diagnostics = this._diagnoseCanvas(canvasEl);
      Logger.debug?.('TileFlatten.capture.canvas', {
        pixelWidth,
        pixelHeight,
        actualWidth: canvasEl?.width,
        actualHeight: canvasEl?.height,
        blank: diagnostics?.isBlank ?? true,
        diagnostics
      });

      return {
        canvas: canvasEl,
        renderBounds,
        logicalBounds: bounds,
        pixelWidth: canvasEl?.width ?? pixelWidth,
        pixelHeight: canvasEl?.height ?? pixelHeight,
        padding,
        resolution,
        gridSize,
        ppi
      };
    } finally {
      await this._restoreFlattenVisibility(visibilityState);
    }
  }

  async _prepareTilesForCapture(tiles) {
    const jobs = [];
    for (const doc of Array.isArray(tiles) ? tiles : []) {
      try {
        const placeable = doc?.object;
        if (!placeable) continue;
        if (doc.getFlag?.('fa-nexus', 'maskedTiling')) {
          jobs.push(Promise.resolve(applyMaskedTilingToTile(placeable)));
        }
        if (doc.getFlag?.('fa-nexus', 'path')) {
          jobs.push(Promise.resolve(applyPathTile(placeable)));
        }
      } catch (_) {}
    }
    if (!jobs.length) return;
    try {
      await Promise.allSettled(jobs);
    } catch (_) {}
  }

  _computeResolution(ppi, gridSize) {
    const numericPPI = Math.max(10, Number(ppi) || 200);
    const numericGrid = Math.max(1, Number(gridSize) || 100);
    const resolution = numericPPI / numericGrid;
    return Math.max(0.1, Math.min(8, resolution));
  }

  _computePadding(tiles, gridSize, ppi) {
    const resolution = this._computeResolution(ppi, gridSize);
    let extraWorld = 0;
    if (Array.isArray(tiles)) {
      for (const doc of tiles) {
        if (!doc || !this._hasShadowEnabled(doc)) continue;
        const offsetDistance = this._readShadowNumeric(doc, 'shadowOffsetDistance');
        const offsetX = Math.abs(this._readShadowNumeric(doc, 'shadowOffsetX'));
        const offsetY = Math.abs(this._readShadowNumeric(doc, 'shadowOffsetY'));
        const dilation = this._readShadowNumeric(doc, 'shadowDilation');
        const blur = this._readShadowNumeric(doc, 'shadowBlur');
        const candidate = Math.max(offsetDistance, offsetX, offsetY) + dilation + blur;
        if (candidate > extraWorld) extraWorld = candidate;
      }
    }
    const basePadding = Math.max(16, Math.round((Number(ppi) || 200) * 0.35));
    const extraPadding = Math.max(0, Math.ceil(extraWorld * resolution));
    return Math.max(16, basePadding + extraPadding);
  }

  _expandBounds(bounds, padding) {
    const pad = Math.max(0, Number(padding) || 0);
    return {
      x: bounds.x - pad,
      y: bounds.y - pad,
      width: bounds.width + (pad * 2),
      height: bounds.height + (pad * 2)
    };
  }

  _tileOverlapsBounds(doc, bounds) {
    try {
      if (!doc || !bounds) return false;
      const tb = this._computeTileWorldBounds(doc);
      if (!tb) return false;
      const rightA = tb.x + tb.width;
      const bottomA = tb.y + tb.height;
      const rightB = bounds.x + bounds.width;
      const bottomB = bounds.y + bounds.height;
      return !(rightA <= bounds.x || rightB <= tb.x || bottomA <= bounds.y || bottomB <= tb.y);
    } catch (_) {
      return true;
    }
  }

  _computeTileWorldBounds(doc) {
    try {
      const x = Number(doc.x) || 0;
      const y = Number(doc.y) || 0;
      const width = Number(doc.width) || 0;
      const height = Number(doc.height) || 0;
      const rotation = Number(doc.rotation) || 0;
      if (!rotation) {
        return { x, y, width, height };
      }
      const rad = rotation * (Math.PI / 180);
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const cx = x + width / 2;
      const cy = y + height / 2;
      const corners = [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height }
      ];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const corner of corners) {
        const dx = corner.x - cx;
        const dy = corner.y - cy;
        const rx = cx + (dx * cos) - (dy * sin);
        const ry = cy + (dx * sin) + (dy * cos);
        if (rx < minX) minX = rx;
        if (ry < minY) minY = ry;
        if (rx > maxX) maxX = rx;
        if (ry > maxY) maxY = ry;
      }
      return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
      };
    } catch (_) {
      return null;
    }
  }

  _getMaxTextureSize(renderer) {
    try {
      const gl = renderer?.gl;
      if (gl) {
        const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (Number.isFinite(max)) return max;
      }
    } catch (_) {}
    try {
      const optionMax = renderer?.options?.maxTextureSize;
      if (Number.isFinite(optionMax)) return optionMax;
    } catch (_) {}
    try {
      const system = renderer?.textures ?? renderer?.texture;
      const max = system?.GC?.maxSize ?? system?.maxSize;
      if (Number.isFinite(max)) return max;
    } catch (_) {}
    return 8192;
  }

  async _applyFlattenVisibility(tiles, renderBounds) {
    const selectedIds = new Set();
    for (const doc of Array.isArray(tiles) ? tiles : []) {
      if (doc?.id) selectedIds.add(doc.id);
    }

    const tilesLayer = canvas?.tiles;
    const placeables = Array.isArray(tilesLayer?.placeables) ? tilesLayer.placeables : [];
    const hiddenTiles = [];

    for (const placeable of placeables) {
      const doc = placeable?.document;
      if (!doc) continue;
      if (selectedIds.has(doc.id)) continue;
      if (renderBounds && !this._tileOverlapsBounds(doc, renderBounds)) continue;
      if (placeable.visible) {
        placeable.visible = false;
        hiddenTiles.push(placeable);
      }
    }

    const backgroundLayer = canvas?.background;
    const backgroundPlaceables = Array.isArray(backgroundLayer?.placeables) ? backgroundLayer.placeables : [];
    const hiddenBackgroundTiles = [];

    for (const placeable of backgroundPlaceables) {
      const doc = placeable?.document;
      if (!doc) continue;
      if (selectedIds.has(doc.id)) {
        try {
          if (!placeable.visible) placeable.visible = true;
        } catch (_) {}
        continue;
      }
      if (renderBounds && !this._tileOverlapsBounds(doc, renderBounds)) continue;
      if (placeable.visible) {
        placeable.visible = false;
        hiddenBackgroundTiles.push(placeable);
      }
    }

    const primary = canvas?.primary;
    const hiddenPrimary = [];
    if (primary?.children) {
      for (const child of primary.children) {
        if (!child) continue;
        const keep = this._shouldRetainPrimaryChild(child);
        if (!keep && child.visible) {
          hiddenPrimary.push({ child, visible: true });
          child.visible = false;
        }
      }
    }

    const hiddenFrames = [];
    const hiddenControlIcons = [];
    for (const doc of Array.isArray(tiles) ? tiles : []) {
      try {
        const placeable = doc?.object;
        if (placeable?.frame) {
          hiddenFrames.push({ frame: placeable.frame, visible: placeable.frame.visible });
          placeable.frame.visible = false;
        }
        if (placeable?.controlIcon) {
          hiddenControlIcons.push({ icon: placeable.controlIcon, visible: placeable.controlIcon.visible });
          placeable.controlIcon.visible = false;
        }
      } catch (_) {}
    }

    const grid = canvas?.grid;
    const gridState = typeof grid?.visible === 'boolean' ? grid.visible : null;
    const interfaceGrid = canvas?.interface?.grid || null;
    const interfaceGridState = typeof interfaceGrid?.visible === 'boolean' ? interfaceGrid.visible : null;
    const interfaceHighlightStates = [];

    const effects = canvas?.effects;
    const effectsState = typeof effects?.visible === 'boolean' ? effects.visible : null;
    if (effects) effects.visible = false;

    // Use interface.grid.highlightLayers (non-deprecated API)
    if (interfaceGrid?.highlightLayers && typeof interfaceGrid.highlightLayers.values === 'function') {
      for (const layer of interfaceGrid.highlightLayers.values()) {
        if (!layer) continue;
        interfaceHighlightStates.push({ layer, visible: !!layer.visible });
        layer.visible = false;
      }
    }

    if (grid) grid.visible = false;
    if (interfaceGrid) interfaceGrid.visible = false;
    const interfaceGroup = canvas?.interface || null;
    const interfaceState = typeof interfaceGroup?.visible === 'boolean' ? interfaceGroup.visible : null;
    if (interfaceGroup) interfaceGroup.visible = false;

    const shadowState = this._suspendShadowsForFlatten(selectedIds, placeables);

    return {
      selectedIds,
      placeables,
      hiddenTiles,
      hiddenBackgroundTiles,
      hiddenPrimary,
      hiddenFrames,
      hiddenControlIcons,
      gridState,
      interfaceGridState,
      interfaceHighlightStates,
      interfaceState,
      effectsState,
      ...shadowState
    };
  }

  _shouldRetainPrimaryChild(child) {
    try {
      if (child === canvas.tiles) return true;
      const name = typeof child?.name === 'string' ? child.name : '';
      if (!name) return false;
      if (!name.startsWith('fa-nexus-')) return false;
      if (name.endsWith('-preview') || name.endsWith('-ghost')) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  _suspendShadowsForFlatten(selectedIds, placeables) {
    const manager = AssetShadowManager?.peek?.();
    if (!manager) {
      return { shadowManager: null, suspendedShadows: [], shadowElevations: [] };
    }

    const suspendedShadows = [];
    const elevations = new Set();

    for (const placeable of placeables) {
      const doc = placeable?.document;
      if (!doc) continue;
      if (selectedIds.has(doc.id)) continue;
      if (!this._hasShadowEnabled(doc)) continue;
      try {
        if (manager.suspendTile(doc)) {
          suspendedShadows.push(doc);
          elevations.add(Number(doc.elevation ?? 0) || 0);
        }
      } catch (error) {
        Logger.debug?.('TileFlatten.suspendShadow.failed', { error: String(error?.message || error) });
      }
    }

    return {
      shadowManager: manager,
      suspendedShadows,
      shadowElevations: Array.from(elevations)
    };
  }

  async _waitForShadowLayers(manager, elevations) {
    if (!manager || !Array.isArray(elevations) || elevations.length === 0) return;
    const start = Date.now();
    const timeout = 500;
    while (Date.now() - start < timeout) {
      let pending = false;
      for (const elevation of elevations) {
        try {
          const layer = manager?._layers?.get?.(elevation);
          if (layer && (layer.rebuilding || layer.dirty)) {
            pending = true;
            break;
          }
        } catch (_) {
          continue;
        }
      }
      if (!pending) return;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }

  _usePrimaryChildRendering(primary) {
    try {
      if (!primary) return null;
      const sprite = primary.sprite ?? null;
      const previousState = {
        displayed: !!primary.displayed,
        spriteVisible: sprite ? !!sprite.visible : null,
        spriteRenderable: sprite && typeof sprite.renderable === 'boolean' ? sprite.renderable : null,
        clearColor: Array.isArray(primary.clearColor) ? primary.clearColor.slice() : null
      };

      primary.displayed = true;
      if (sprite) {
        sprite.visible = false;
        if (typeof sprite.renderable === 'boolean') sprite.renderable = false;
      }
      if (primary.clearColor) {
        try { primary.clearColor = [0, 0, 0, 0]; } catch (_) {}
      }
      try {
        primary.renderDirty = true;
      } catch (_) {}

      return () => {
        try { primary.displayed = previousState.displayed; } catch (_) {}
        if (sprite) {
          try { sprite.visible = previousState.spriteVisible; } catch (_) {}
          if (previousState.spriteRenderable !== null) {
            try { sprite.renderable = previousState.spriteRenderable; } catch (_) {}
          }
        }
        if (previousState.clearColor) {
          try { primary.clearColor = previousState.clearColor; } catch (_) {}
        }
        try { primary.renderDirty = true; } catch (_) {}
      };
    } catch (error) {
      Logger.debug?.('TileFlatten.capture.primaryDisplayPatchFailed', { error: String(error?.message || error) });
      return null;
    }
  }

  _forcePrimaryTransparentClear(primary) {
    try {
      if (!primary || typeof primary._render !== 'function') return null;
      const originalRender = primary._render;
      primary._render = function patchedPrimaryRender(localRenderer) {
        const activeRenderer = localRenderer || canvas?.app?.renderer;
        const framebuffer = activeRenderer?.framebuffer;
        let restoreClear = null;
        if (framebuffer && typeof framebuffer.clear === 'function') {
          const originalClear = framebuffer.clear;
          framebuffer.clear = function patchedClear(r, g, b, a, mask) {
            return originalClear.call(this, 0, 0, 0, 0, mask);
          };
          restoreClear = () => {
            framebuffer.clear = originalClear;
          };
        }
        try {
          return originalRender.call(this, activeRenderer);
        } finally {
          if (restoreClear) {
            try { restoreClear(); } catch (_) {}
          }
        }
      };
      try { primary.renderDirty = true; } catch (_) {}
      return () => {
        primary._render = originalRender;
        try { primary.renderDirty = true; } catch (_) {}
      };
    } catch (error) {
      Logger.debug?.('TileFlatten.capture.primaryClearPatchFailed', { error: String(error?.message || error) });
      return null;
    }
  }

  async _restoreFlattenVisibility(state) {
    if (!state) return;
    try {
      for (const placeable of state.hiddenTiles || []) {
        if (placeable) placeable.visible = true;
      }
    } catch (_) {}

    try {
      if (state.shadowManager && state.suspendedShadows?.length) {
        for (const doc of state.suspendedShadows) {
          try {
            state.shadowManager.resumeTile(doc);
          } catch (error) {
            Logger.debug?.('TileFlatten.resumeShadow.failed', { error: String(error?.message || error) });
          }
        }
        await this._waitForShadowLayers(state.shadowManager, state.shadowElevations);
      }
    } catch (_) {}

    try {
      for (const entry of state.hiddenPrimary || []) {
        if (entry?.child) entry.child.visible = !!entry.visible;
      }
    } catch (_) {}

    try {
      for (const placeable of state.hiddenBackgroundTiles || []) {
        if (placeable) placeable.visible = true;
      }
    } catch (_) {}

    try {
      for (const entry of state.hiddenFrames || []) {
        if (entry?.frame) entry.frame.visible = !!entry.visible;
      }
    } catch (_) {}

    try {
      for (const entry of state.hiddenControlIcons || []) {
        if (entry?.icon) entry.icon.visible = !!entry.visible;
      }
    } catch (_) {}

    try {
      const grid = canvas?.grid;
      if (typeof state.gridState === 'boolean' && grid) {
        grid.visible = state.gridState;
      }
      const interfaceGrid = canvas?.interface?.grid;
      if (typeof state.interfaceGridState === 'boolean' && interfaceGrid) {
        interfaceGrid.visible = state.interfaceGridState;
      }
      if (Array.isArray(state.interfaceHighlightStates) && interfaceGrid?.highlightLayers) {
        for (const entry of state.interfaceHighlightStates) {
          const layer = entry?.layer;
          if (!layer) continue;
          try { layer.visible = !!entry.visible; } catch (_) {}
        }
      }
      const effects = canvas?.effects;
      if (typeof state.effectsState === 'boolean' && effects) {
        effects.visible = state.effectsState;
      }
      const interfaceGroup = canvas?.interface;
      if (typeof state.interfaceState === 'boolean' && interfaceGroup) {
        interfaceGroup.visible = state.interfaceState;
      }
    } catch (_) {}
  }

  /**
   * Align shadow blur radius with the current canvas scale for capture, and
   * provide a restore function to re-sync after reverting the stage transform.
   */
  _syncShadowBlurForCapture(manager) {
    try {
      const mgr = manager || AssetShadowManager?.peek?.();
      if (!mgr || typeof mgr._onCanvasPan !== 'function') return null;
      mgr._onCanvasPan(); // apply blur for current stage scale
      return () => {
        try { mgr._onCanvasPan(); } catch (_) {}
      };
    } catch (_) {
      return null;
    }
  }

  async _nextFrame() {
    await new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 16);
    });
  }

  _hasShadowEnabled(doc) {
    try {
      return !!doc?.getFlag?.('fa-nexus', 'shadow');
    } catch (_) {
      const flags = doc?.flags?.['fa-nexus'];
      return !!(flags && flags.shadow);
    }
  }

  _readShadowNumeric(doc, key) {
    try {
      const value = doc?.getFlag?.('fa-nexus', key);
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : 0;
    } catch (_) {
      return 0;
    }
  }

  _isCanvasBlank(canvas) {
    try {
      if (!canvas) return true;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return true;
      const { width, height } = canvas;
      if (!width || !height) return true;
      const sampleWidth = Math.min(width, 4);
      const sampleHeight = Math.min(height, 4);
      const data = ctx.getImageData(0, 0, sampleWidth, sampleHeight)?.data;
      if (!data) return true;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a !== 0 && (r !== 0 || g !== 0 || b !== 0)) return false;
      }
      return true;
    } catch (error) {
      Logger.debug?.('TileFlatten.capture.blankCheckFailed', { error: String(error?.message || error) });
      return false;
    }
  }

  _deepClone(value) {
    if (value == null || typeof value !== 'object') return value;
    try {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    } catch (_) {}
    try {
      return structuredClone(value);
    } catch (_) {}
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  }

  _serializeMatrix(matrix) {
    try {
      if (!matrix) return null;
      const round = (v) => (Number.isFinite(v) ? Number(v.toFixed(6)) : v);
      return {
        a: round(matrix.a),
        b: round(matrix.b),
        c: round(matrix.c),
        d: round(matrix.d),
        tx: round(matrix.tx),
        ty: round(matrix.ty)
      };
    } catch (_) {
      return null;
    }
  }

  _serializePoint(point) {
    try {
      if (!point) return null;
      const round = (v) => (Number.isFinite(v) ? Number(v.toFixed(3)) : v);
      return { x: round(point.x), y: round(point.y) };
    } catch (_) {
      return null;
    }
  }

  _diagnoseCanvas(canvasEl) {
    try {
      if (!canvasEl) return { reason: 'no-canvas', isBlank: true };
      const width = canvasEl.width ?? 0;
      const height = canvasEl.height ?? 0;
      if (!width || !height) {
        return { reason: 'zero-dimensions', width, height, isBlank: true };
      }
      const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        return { reason: 'no-context', width, height, isBlank: true };
      }
      const samplePoints = [
        { label: 'center', x: Math.floor(width / 2), y: Math.floor(height / 2) },
        { label: 'topLeft', x: 0, y: 0 },
        { label: 'bottomRight', x: width - 1, y: height - 1 }
      ];
      const samples = [];
      let nonZero = false;
      for (const sample of samplePoints) {
        const data = ctx.getImageData(sample.x, sample.y, 1, 1)?.data;
        if (!data) continue;
        const rgba = Array.from(data).slice(0, 4);
        if (rgba.some((value) => value !== 0)) nonZero = true;
        samples.push({ label: sample.label, rgba });
      }
      return {
        width,
        height,
        samples,
        isBlank: !nonZero
      };
    } catch (error) {
      return { reason: 'diagnostic-error', error: String(error?.message || error), isBlank: true };
    }
  }

  /**
   * Ensure nested directory structure exists
   */
  async _ensureNestedDir(targetDir, context = null) {
    const segments = String(targetDir || '').split('/').filter(Boolean);
    if (!segments.length) return;
    let acc = segments[0];
    await this._ensureDir(acc, context);
    for (let i = 1; i < segments.length; i++) {
      acc = `${acc}/${segments[i]}`;
      await this._ensureDir(acc, context);
    }
  }

  /**
   * Ensure a single directory exists
   */
  async _ensureDir(dir, context = null) {
    const FP = foundry.applications.apps.FilePicker.implementation;
    const source = context?.source || 'data';
    const options = context?.options || {};
    try {
      await FP.browse(source, dir, options);
    } catch (_) {
      await FP.createDirectory(source, dir, options);
    }
  }

  /**
   * Get the assets directory from settings
   * @returns {string}
   */
  _getAssetsDir() {
    try { return game.settings.get('fa-nexus', 'cloudDownloadDirAssets') || 'fa-nexus-assets'; }
    catch (_) { return 'fa-nexus-assets'; }
  }

  isBusy() {
    return !!(this._flattening || this._deconstructing);
  }

  static isFlattenedTile(doc) {
    try {
      const data = doc?.getFlag?.('fa-nexus', 'flattened');
      return !!data && typeof data === 'object';
    } catch (_) {
      return false;
    }
  }

  async confirmAndDeconstructTile(tileDoc) {
    const metadata = this._resolveFlattenMetadata(tileDoc);
    if (!metadata) {
      ui?.notifications?.warn?.('Selected tile does not contain FA Nexus flatten data.');
      return;
    }

    if (this.isBusy()) {
      ui?.notifications?.warn?.('Another flattening or deconstruction operation is already in progress.');
      return;
    }

    const confirmed = await this._confirmDeconstruct(tileDoc, metadata);
    if (!confirmed) return;

    await this.deconstructFlattenedTile(tileDoc, metadata);
  }

  async deconstructFlattenedTile(tileDoc, metadata = null) {
    if (!tileDoc) {
      ui?.notifications?.error?.('No tile selected for deconstruction.');
      return;
    }

    if (this.isBusy()) {
      ui?.notifications?.warn?.('Another flattening or deconstruction operation is already in progress.');
      return;
    }

    const flattenMeta = metadata || this._resolveFlattenMetadata(tileDoc);
    if (!flattenMeta) {
      ui?.notifications?.warn?.('Selected tile does not contain FA Nexus flatten data.');
      return;
    }

    const payloads = this._prepareDeconstructionPayload(flattenMeta);
    if (!payloads.length) {
      ui?.notifications?.error?.('Flattened tile has no stored tiles to restore.');
      return;
    }

    if (!canvas?.scene) {
      ui?.notifications?.error?.('Scene not available.');
      return;
    }

    this._deconstructing = true;

    try {
      ui?.notifications?.info?.('Restoring flattened tiles...');
      const created = await canvas.scene.createEmbeddedDocuments('Tile', payloads);
      await canvas.scene.deleteEmbeddedDocuments('Tile', [tileDoc.id]);

      Logger.info('TileFlatten.deconstruct.success', {
        restoredCount: payloads.length,
        flattenedId: tileDoc.id
      });

      await this._nextFrame();

      const layer = canvas?.tiles;
      if (layer?.releaseAll && Array.isArray(created) && created.length) {
        try { layer.releaseAll(); } catch (_) {}
        await this._nextFrame();
        for (const doc of created) {
          if (!doc?.id) continue;
          const placeable = layer?.placeables?.find?.((p) => p?.document?.id === doc.id);
          if (placeable?.control) {
            try { placeable.control({ releaseOthers: false }); } catch (_) {}
          }
        }
      }

      ui?.notifications?.info?.('Flattened tile deconstructed successfully.');
    } catch (error) {
      Logger.error('TileFlatten.deconstruct.failed', { error: String(error?.message || error) });
      ui?.notifications?.error?.(`Failed to deconstruct tile: ${error?.message || error}`);
    } finally {
      this._deconstructing = false;
    }
  }

  _resolveFlattenMetadata(tileDoc) {
    try {
      if (!tileDoc || typeof tileDoc.getFlag !== 'function') return null;
      const data = tileDoc.getFlag('fa-nexus', 'flattened');
      if (!data || typeof data !== 'object') return null;
      return this._deepClone(data);
    } catch (error) {
      Logger.debug?.('TileFlatten.resolveMetadata.failed', { error: String(error?.message || error) });
      return null;
    }
  }

  _prepareDeconstructionPayload(metadata) {
    const entries = Array.isArray(metadata?.tiles) ? metadata.tiles : [];
    const payloads = [];
    for (const entry of entries) {
      try {
        const data = this._deepClone(entry?.data);
        if (!data || typeof data !== 'object') continue;
        delete data._id;
        delete data._stats;
        if (!data.flags || typeof data.flags !== 'object') data.flags = {};
        const faFlags = this._deepClone(entry?.faFlags);
        if (faFlags && typeof faFlags === 'object') {
          data.flags['fa-nexus'] = faFlags;
        } else if (data.flags['fa-nexus']) {
          delete data.flags['fa-nexus'].flattened;
        }
        if (data.flags['fa-nexus'] && data.flags['fa-nexus'].flattened) {
          delete data.flags['fa-nexus'].flattened;
        }
        payloads.push(data);
      } catch (error) {
        Logger.debug?.('TileFlatten.deconstruct.prepare.failed', { error: String(error?.message || error) });
      }
    }
    return payloads;
  }

  async _confirmDeconstruct(tileDoc, metadata) {
    const tileCount = Number(metadata?.originalTileCount ?? metadata?.tiles?.length ?? 0) || 0;
    const message = tileCount
      ? `This will delete the flattened tile and restore ${tileCount} original tile${tileCount === 1 ? '' : 's'}. Continue?`
      : 'This will delete the flattened tile and restore the saved tiles. Continue?';

    try {
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      if (DialogV2?.confirm) {
        const result = await DialogV2.confirm({
          window: {
            title: 'Deconstruct Flattened Tile'
          },
          modal: true,
          content: `<p>${message}</p>`,
          yes: {
            label: 'Deconstruct',
            icon: 'fas fa-object-ungroup'
          },
          no: {
            label: 'Cancel'
          },
          defaultYes: true
        });
        return !!result;
      }
      if (typeof Dialog?.confirm === 'function') {
        return Dialog.confirm({
          title: 'Deconstruct Flattened Tile',
          content: `<p>${message}</p>`,
          yes: () => true,
          no: () => false,
          defaultYes: true
        });
      }
    } catch (_) {}

    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      return window.confirm(message);
    }

    return true;
  }

  /**
   * Save canvas as WebP
   */
  async _saveAsWebP(canvasEl, quality) {
    if (!canvasEl) return null;

    const blob = await new Promise((resolve) => {
      if (canvasEl.toBlob) {
        canvasEl.toBlob(resolve, 'image/webp', quality);
      } else {
        try {
          const dataUrl = canvasEl.toDataURL('image/webp', quality);
          const bin = atob(dataUrl.split(',')[1] || '');
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < arr.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: 'image/webp' }));
        } catch (err) {
          resolve(null);
        }
      }
    });

    if (!blob) return null;

    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
    const filename = `flattened-${timestamp}-${rand}.webp`;
    const file = new File([blob], filename, { type: 'image/webp' });

    await forgeIntegration.initialize();
    const assetsSetting = this._getAssetsDir();
    const dirContext = forgeIntegration.resolveFilePickerContext(assetsSetting);
    const source = dirContext?.source || 'data';
    const bucketOptions = dirContext?.options || {};
    const baseTarget = dirContext?.target || '';
    const baseDir = [baseTarget, 'flattened'].filter(Boolean).join('/');
    const FP = foundry.applications.apps.FilePicker.implementation;

    // Ensure nested directory structure exists
    await this._ensureNestedDir(baseDir, { source, options: bucketOptions });

    const uploadResult = await FP.upload(source, baseDir, file, { ...bucketOptions }, { notify: true, filename });

    let path = '';
    try {
      if (typeof uploadResult?.url === 'string') path = uploadResult.url;
      else if (typeof uploadResult?.path === 'string') path = uploadResult.path;
      else if (typeof uploadResult === 'string') path = uploadResult;
    } catch (_) {}
    if (!path) path = `${baseDir}/${filename}`;

    if (source === 's3' && !/^https?:\/\//i.test(path) && /^https?:\/\//i.test(String(assetsSetting || ''))) {
      const baseUrl = String(assetsSetting || '').trim().endsWith('/') ? String(assetsSetting || '').trim() : `${String(assetsSetting || '').trim()}/`;
      const rel = baseTarget && baseDir.startsWith(`${baseTarget}/`) ? baseDir.slice(baseTarget.length + 1) : (baseDir === baseTarget ? '' : baseDir);
      const relPath = [rel, filename].filter(Boolean).join('/');
      path = `${baseUrl}${relPath.replace(/^\/+/, '')}`;
    }
    if (source === 'forgevtt') {
      path = forgeIntegration.optimizeCacheURL(path);
    }

    // Wait for Foundry to process the uploaded file before using it
    // This prevents "Invalid Asset" errors when immediately creating tiles
    await new Promise(resolve => setTimeout(resolve, 200));

    return path;
  }

  /**
   * Build metadata for deconstruction
   */
  _buildMetadata({
    tiles,
    logicalBounds,
    renderBounds,
    padding,
    pixelWidth,
    pixelHeight,
    ppi,
    quality,
    resolution,
    filePath
  }) {
    const sceneId = canvas?.scene?.id || null;
    const tileData = [];

    for (const doc of Array.isArray(tiles) ? tiles : []) {
      if (!doc) continue;
      try {
        const data = doc.toObject(false);
        tileData.push({
          id: doc.id,
          data,
          faFlags: data?.flags?.['fa-nexus'] ? this._deepClone(data.flags['fa-nexus']) : {}
        });
      } catch (error) {
        Logger.debug?.('TileFlatten.metadata.toObject.failed', { error: String(error?.message || error) });
      }
    }

    return {
      version: 1,
      flattenedAt: Date.now(),
      originalTileCount: tileData.length,
      tiles: tileData,
      logicalBounds: logicalBounds || renderBounds,
      renderBounds,
      padding: Number(padding) || 0,
      pixelWidth: Number(pixelWidth) || null,
      pixelHeight: Number(pixelHeight) || null,
      ppi,
      quality,
      resolution,
      filePath,
      sceneId,
      gridSize: Number(canvas?.scene?.grid?.size || 0) || null
    };
  }

  /**
   * Create flattened tile
   */
  async _createFlattenedTile(bounds, filePath, metadata) {
    if (!canvas?.scene) throw new Error('Scene not available');

    // Ensure path doesn't have leading slash for Foundry compatibility
    const cleanPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;

    const baseMeta = metadata?.tiles?.[0]?.data || {};
    const occlusionMeta = baseMeta?.occlusion || {};
    const sortValues = Array.isArray(metadata?.tiles)
      ? metadata.tiles.map((t) => Number(t?.data?.sort ?? 0)).filter((v) => Number.isFinite(v))
      : [];
    const maxSort = sortValues.length ? Math.max(...sortValues) : 0;

    const tileData = {
      texture: { src: encodeTexturePath(cleanPath) },
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      rotation: 0,
      alpha: Number.isFinite(Number(baseMeta.alpha)) ? Number(baseMeta.alpha) : 1,
      elevation: Number(baseMeta.elevation ?? 0) || 0,
      sort: Number.isFinite(maxSort) ? maxSort : 0,
      hidden: !!baseMeta.hidden,
      locked: !!baseMeta.locked,
      overhead: !!baseMeta.overhead,
      roof: !!baseMeta.roof,
      occlusion: baseMeta.occlusion ? this._deepClone(baseMeta.occlusion) : { mode: 0, alpha: 0 },
      restrictions: baseMeta.restrictions ? this._deepClone(baseMeta.restrictions) : undefined,
      flags: {
        'fa-nexus': {
          flattened: metadata
        }
      }
    };

    if (!tileData.restrictions) delete tileData.restrictions;

    const created = await canvas.scene.createEmbeddedDocuments('Tile', [tileData]);
    
    // Wait for Foundry to finish processing the tile creation
    // This gives the texture loader time to initialize
    await new Promise(resolve => setTimeout(resolve, 100));
    
    return created;
  }

  /**
   * Delete original tiles
   */
  async _deleteOriginalTiles(tiles) {
    if (!canvas?.scene) return;

    const ids = tiles.map(t => t.id).filter(Boolean);
    if (ids.length === 0) return;

    const prev = globalThis?.FA_NEXUS_SUPPRESS_BUILDING_TILE_DELETE;
    try {
      globalThis.FA_NEXUS_SUPPRESS_BUILDING_TILE_DELETE = true;
      await canvas.scene.deleteEmbeddedDocuments('Tile', ids);
    } finally {
      if (prev === undefined) delete globalThis.FA_NEXUS_SUPPRESS_BUILDING_TILE_DELETE;
      else globalThis.FA_NEXUS_SUPPRESS_BUILDING_TILE_DELETE = prev;
    }
  }
}
