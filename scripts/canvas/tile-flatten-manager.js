import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { forgeIntegration } from '../core/forge-integration.js';
import { TileFlattenDialog } from './tile-flatten-dialog.js';
import { TileFlattenOverlay } from './tile-flatten-overlay.js';
import { resolveAutoChunking } from './tile-flatten-chunking.js';
import { AssetShadowManager } from '../assets/asset-shadow-manager.js';
import { encodeTexturePath, applyMaskedTilingToTile, getTransparentTextureSrc } from '../textures/texture-render.js';
import { applyPathTile } from '../paths/path-geometry.js';

/**
 * Manages flattening multiple tiles into a single image
 */
export class TileFlattenManager {
  constructor() {
    this._flattening = false;
    this._deconstructing = false;
    this._overlay = null;
  }

  /**
   * Get currently selected tiles
   * @returns {Array<import('foundry/applications/api').TileDocument>}
   */
  static getSelectedTiles() {
    try {
      const layer = canvas?.tiles;
      if (!layer) return [];
      const ids = new Set();
      const controlled = Array.isArray(layer.controlled) ? layer.controlled : [];
      for (const placeable of controlled) {
        const id = placeable?.document?.id || placeable?.id;
        if (id) ids.add(id);
      }

      const listSelection = typeof document?.querySelectorAll === 'function'
        ? document.querySelectorAll('.fa-nexus-layer-manager__item.is-selected[data-tile-id]')
        : [];
      for (const item of listSelection) {
        const id = item?.dataset?.tileId;
        if (id) ids.add(id);
      }

      if (!ids.size) return [];

      const tiles = [];
      const seen = new Set();
      const placeables = Array.isArray(layer.placeables) ? layer.placeables : [];
      for (const placeable of placeables) {
        const doc = placeable?.document;
        const id = doc?.id || placeable?.id;
        if (!id || !ids.has(id) || seen.has(id)) continue;
        if (doc && doc instanceof foundry.documents.TileDocument) {
          tiles.push(doc);
          seen.add(id);
        }
      }

      if (canvas?.scene?.tiles) {
        for (const id of ids) {
          if (seen.has(id)) continue;
          const doc = canvas.scene.tiles.get(id);
          if (doc && doc instanceof foundry.documents.TileDocument) {
            tiles.push(doc);
            seen.add(id);
          }
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

  static canFlattenSelection(tiles = null) {
    const list = Array.isArray(tiles) ? tiles : this.getSelectedTiles();
    if (list.length > 1) return true;
    if (list.length === 1 && this.isMergedTile(list[0])) return true;
    return false;
  }

  /**
   * Show flatten dialog and process flattening
   */
  async showFlattenDialog() {
    const selectedTiles = TileFlattenManager.getSelectedTiles();
    if (!TileFlattenManager.canFlattenSelection(selectedTiles)) {
      ui?.notifications?.warn?.('Please select at least 2 tiles, or a merged tile, to flatten.');
      return;
    }

    if (this.isBusy()) {
      ui?.notifications?.warn?.('Another flattening or deconstruction operation is already in progress.');
      return;
    }

    const dialog = new TileFlattenDialog({
      tiles: selectedTiles,
      previewBoundsResolver: this._capturePreviewBounds.bind(this)
    });
    const result = await dialog.render(true);
    
    if (!result || result.cancelled) return;

    await this.flattenTiles(selectedTiles, result);
  }

  async showExportDialog() {
    if (!canvas?.ready || !canvas?.scene) {
      ui?.notifications?.warn?.('Scene is not ready for export yet.');
      return;
    }

    if (this.isBusy()) {
      ui?.notifications?.warn?.('Another flattening or deconstruction operation is already in progress.');
      return;
    }

    const sceneBounds = this._getSceneBounds();
    if (!sceneBounds) {
      ui?.notifications?.error?.('Could not resolve scene bounds for export.');
      return;
    }
    const gridSize = Math.max(1, Number(canvas?.scene?.grid?.size || 100));
    const tiles = this._collectSceneTiles();

    const dialog = new TileFlattenDialog({
      tiles,
      mode: 'export',
      baseBounds: { ...sceneBounds, gridSize }
    });
    const result = await dialog.render(true);

    if (!result || result.cancelled) return;

    await this.exportScene(result);
  }

  async exportScene(options = {}) {
    if (this.isBusy()) {
      Logger.warn('TileFlatten.exportScene.busy');
      return;
    }

    if (!canvas?.ready || !canvas?.scene) {
      ui?.notifications?.error?.('Scene not available.');
      return;
    }

    this._flattening = true;
    let overlay = null;
    let resolvedAction = 'export';
    let shouldExport = true;
    let shouldFlatten = false;
    try {
      const {
        ppi = 200,
        quality = 0.85,
        paddingSnap = 'none',
        paddingExtra = 0,
        exportSplitLayers = false,
        exportChunked = false,
        exportAction
      } = options || {};
      resolvedAction = exportAction === 'export' || exportAction === 'flatten'
        ? exportAction
        : (options?.exportFlattenScene ? 'flatten' : 'export');
      shouldExport = resolvedAction === 'export';
      shouldFlatten = resolvedAction === 'flatten';
      const normalizedPaddingSnap = this._normalizePaddingSnap(paddingSnap);
      const sceneBounds = this._getSceneBounds();
      if (!sceneBounds) {
        throw new Error('Could not resolve scene bounds for export');
      }

      const gridSize = Math.max(1, Number(canvas?.scene?.grid?.size || 100));
      const resolution = this._computeResolution(ppi, gridSize);
      const plannedRenderBounds = this._computeRenderBounds(sceneBounds, gridSize, normalizedPaddingSnap, paddingExtra);
      const plannedPixelWidth = Math.max(1, Math.round(plannedRenderBounds.width * resolution));
      const plannedPixelHeight = Math.max(1, Math.round(plannedRenderBounds.height * resolution));
      const maxTextureSize = this._getMaxTextureSize(canvas?.app?.renderer);
      const autoChunkPlan = resolveAutoChunking(plannedPixelWidth, plannedPixelHeight, { maxTextureSize });
      const exceedsMaxTexture = plannedPixelWidth > maxTextureSize || plannedPixelHeight > maxTextureSize;
      const useAutoChunking = !!exportChunked && autoChunkPlan.enabled;
      const useChunking = exceedsMaxTexture || useAutoChunking;
      const chunkAuto = useChunking;
      const autoChunkWidth = useChunking ? (autoChunkPlan.chunkPixelWidth / ppi) : 0;
      const autoChunkHeight = useChunking ? (autoChunkPlan.chunkPixelHeight / ppi) : 0;

      overlay = this._showOverlay(shouldExport ? 'export' : 'flatten');
      overlay.setStatus(shouldExport ? 'Preparing export...' : 'Preparing flatten...');
      overlay.setProgress?.(0.1);
      await this._nextFrame();

      const tiles = this._collectSceneTiles();
      if (exceedsMaxTexture && !exportChunked) {
        ui?.notifications?.info?.('Scene exceeds GPU texture size; generating multiple images.');
      }
      let backgroundTiles = tiles;
      let foregroundTiles = tiles;
      if (exportSplitLayers) {
        const fgElevation = this._getForegroundElevation();
        backgroundTiles = tiles.filter((doc) => this._getTileElevation(doc) < fgElevation);
        foregroundTiles = tiles.filter((doc) => this._getTileElevation(doc) >= fgElevation);
      }
      const savedFiles = [];
      if (shouldExport) {
        const exportContext = await this._resolveExportUploadContext();
        const baseName = this._buildExportFilenameBase();
        const tasks = exportSplitLayers
          ? [
            {
              label: 'Background',
              suffix: 'background',
              tiles: backgroundTiles,
              visibility: { keepBackground: true, keepTiles: true, keepForeground: false }
            },
            {
              label: 'Foreground',
              suffix: 'foreground',
              tiles: foregroundTiles,
              visibility: { keepBackground: false, keepTiles: true, keepForeground: true }
            }
          ]
          : [
            {
              label: 'Scene',
              suffix: '',
              tiles,
              visibility: { keepBackground: true, keepTiles: true, keepForeground: true }
            }
          ];

        const taskCount = tasks.length;
        const taskSpan = taskCount > 0 ? 0.8 / taskCount : 0.8;
        for (let i = 0; i < tasks.length; i += 1) {
          const task = tasks[i];
          const layerLabel = task.label || 'Scene';
          const layerSuffix = task.suffix ? `-${task.suffix}` : '';
          const layerProgressBase = 0.1 + (taskSpan * i);

          overlay.setStatus(`Capturing ${layerLabel.toLowerCase()}...`);
          overlay.setProgress?.(layerProgressBase);
          await this._nextFrame();

          if (useChunking) {
            const savedChunks = [];
            const chunkData = await this._renderTilesToCanvasChunked(task.tiles, sceneBounds, ppi, {
              paddingSnap: normalizedPaddingSnap,
              paddingExtra,
              chunkWidth: autoChunkWidth,
              chunkHeight: autoChunkHeight,
              chunkPad: false,
              chunkAuto,
              suspendRender: true,
              visibility: task.visibility,
              onChunk: async (entry, index, total) => {
                const label = Number.isFinite(total) && total > 0
                  ? `Saving ${layerLabel.toLowerCase()} chunk ${index + 1} of ${total}...`
                  : `Saving ${layerLabel.toLowerCase()} chunk...`;
                overlay.setStatus(label);
                if (Number.isFinite(total) && total > 0) {
                  const progress = layerProgressBase + (taskSpan * ((index + 1) / total));
                  overlay.setProgress?.(Math.min(0.9, progress));
                }
                const rowLabel = Number.isFinite(entry?.row) ? entry.row + 1 : null;
                const colLabel = Number.isFinite(entry?.col) ? entry.col + 1 : null;
                let chunkSuffix = '';
                if (Number.isFinite(total) && total > 1) {
                  if (rowLabel && colLabel) chunkSuffix = `-r${rowLabel}-c${colLabel}`;
                  else chunkSuffix = `-${index + 1}`;
                }
                const filename = `${baseName}${layerSuffix}${chunkSuffix}.webp`;
                let src = null;
                try {
                  src = await this._saveAsWebP(entry?.canvas, quality, { uploadContext: exportContext, filename });
                } finally {
                  try {
                    if (entry?.canvas) {
                      entry.canvas.width = 0;
                      entry.canvas.height = 0;
                    }
                  } catch (_) {}
                }
                if (src) savedChunks.push(src);
              }
            });

            if (!chunkData) {
              throw new Error(`Failed to export ${layerLabel.toLowerCase()} chunks`);
            }
            if (!savedChunks.length) {
              throw new Error(`Failed to save ${layerLabel.toLowerCase()} chunks`);
            }
            const expectedChunks = Number.isFinite(chunkData?.rows) && Number.isFinite(chunkData?.columns)
              ? (chunkData.rows * chunkData.columns)
              : null;
            if (Number.isFinite(expectedChunks) && expectedChunks > 0 && savedChunks.length !== expectedChunks) {
              throw new Error(`Failed to save all ${layerLabel.toLowerCase()} chunks`);
            }
            savedFiles.push(...savedChunks);
          } else {
            overlay.setStatus(`Capturing ${layerLabel.toLowerCase()}...`);
            const canvasData = await this._renderTilesToCanvas(task.tiles, sceneBounds, ppi, {
              paddingSnap: normalizedPaddingSnap,
              paddingExtra,
              trimToContent: false,
              suspendRender: true,
              visibility: task.visibility
            });
            if (!canvasData?.canvas) {
              throw new Error(`Failed to export ${layerLabel.toLowerCase()}`);
            }

            overlay.setStatus(`Saving ${layerLabel.toLowerCase()}...`);
            const filename = `${baseName}${layerSuffix}.webp`;
            const filePath = await this._saveAsWebP(canvasData.canvas, quality, { uploadContext: exportContext, filename });
            if (!filePath) {
              throw new Error(`Failed to save ${layerLabel.toLowerCase()} export`);
            }
            try {
              canvasData.canvas.width = 0;
              canvasData.canvas.height = 0;
            } catch (_) {}
            savedFiles.push(filePath);
            overlay.setProgress?.(Math.min(0.9, layerProgressBase + taskSpan));
          }
        }
      }

      let flattenedCount = 0;
      if (shouldFlatten) {
        if (!tiles.length) {
          ui?.notifications?.warn?.('No tiles found to flatten in this scene.');
        } else {
          try {
            const flattenContext = await this._resolveFlattenUploadContext();
            const flattenBaseName = this._buildFlattenFilenameBase();
            const flattenTasks = exportSplitLayers
              ? [
                { label: 'Background', suffix: 'background', tiles: backgroundTiles },
                { label: 'Foreground', suffix: 'foreground', tiles: foregroundTiles }
              ]
              : [{ label: 'Scene', suffix: '', tiles }];
            const logicalBounds = { ...sceneBounds };

            const taskCount = flattenTasks.length;
            const flattenSpan = taskCount > 0 ? 0.08 / taskCount : 0.08;
            for (let i = 0; i < flattenTasks.length; i += 1) {
              const task = flattenTasks[i];
              if (!task.tiles.length) continue;
              const layerLabel = task.label || 'Scene';
              const layerSuffix = task.suffix ? `-${task.suffix}` : '';
              const flattenProgressBase = 0.9 + (flattenSpan * i);

              overlay.setStatus(`Flattening ${layerLabel.toLowerCase()} tiles...`);
              overlay.setProgress?.(flattenProgressBase);
              await this._nextFrame();

              let renderBounds = null;
              let paddingInsets = null;
              let pixelWidth = null;
              let pixelHeight = null;
              let resolutionOut = null;
              let filePath = null;
              let chunkEntries = null;
              let chunkingMeta = null;
              let chunkSize = 0;

              if (useChunking) {
                const savedChunks = [];
                const chunkData = await this._renderTilesToCanvasChunked(task.tiles, sceneBounds, ppi, {
                  paddingSnap: normalizedPaddingSnap,
                  paddingExtra,
                  chunkWidth: autoChunkWidth,
                  chunkHeight: autoChunkHeight,
                  chunkPad: false,
                  chunkAuto,
                  suspendRender: true,
                  visibility: { keepBackground: false, keepTiles: true, keepForeground: false },
                  onChunk: async (entry, index, total) => {
                    const label = Number.isFinite(total) && total > 0
                      ? `Saving ${layerLabel.toLowerCase()} tile chunk ${index + 1} of ${total}...`
                      : `Saving ${layerLabel.toLowerCase()} tile chunk...`;
                    overlay.setStatus(label);
                    if (Number.isFinite(total) && total > 0) {
                      const progress = flattenProgressBase + (flattenSpan * ((index + 1) / total));
                      overlay.setProgress?.(Math.min(0.98, progress));
                    }
                    const rowLabel = Number.isFinite(entry?.row) ? entry.row + 1 : null;
                    const colLabel = Number.isFinite(entry?.col) ? entry.col + 1 : null;
                    const suffix = rowLabel && colLabel ? `-r${rowLabel}-c${colLabel}` : `-${index + 1}`;
                    const filename = `${flattenBaseName}${layerSuffix}${suffix}.webp`;
                    let src = null;
                    try {
                      src = await this._saveAsWebP(entry?.canvas, quality, { uploadContext: flattenContext, filename });
                    } finally {
                      try {
                        if (entry?.canvas) {
                          entry.canvas.width = 0;
                          entry.canvas.height = 0;
                        }
                      } catch (_) {}
                    }
                    if (src) {
                      savedChunks.push({
                        src,
                        x: Number(entry?.x) || 0,
                        y: Number(entry?.y) || 0,
                        width: Number(entry?.width) || 0,
                        height: Number(entry?.height) || 0,
                        pixelWidth: Number(entry?.pixelWidth) || null,
                        pixelHeight: Number(entry?.pixelHeight) || null
                      });
                    }
                  }
                });

                if (!chunkData) {
                  throw new Error(`Failed to flatten ${layerLabel.toLowerCase()} tiles`);
                }
                if (!savedChunks.length) {
                  throw new Error(`Failed to save ${layerLabel.toLowerCase()} tile chunks`);
                }
                renderBounds = chunkData?.renderBounds || sceneBounds;
                paddingInsets = chunkData?.paddingInsets || null;
                pixelWidth = chunkData?.pixelWidth || null;
                pixelHeight = chunkData?.pixelHeight || null;
                resolutionOut = chunkData?.resolution || null;
                chunkEntries = savedChunks;
                chunkingMeta = chunkData?.chunking || null;
                chunkSize = chunkData?.chunkSize ?? 0;
                filePath = savedChunks[0]?.src || null;
              } else {
                const canvasData = await this._renderTilesToCanvas(task.tiles, sceneBounds, ppi, {
                  paddingSnap: normalizedPaddingSnap,
                  paddingExtra,
                  trimToContent: false,
                  suspendRender: true,
                  visibility: { keepBackground: false, keepTiles: true, keepForeground: false }
                });
                if (!canvasData?.canvas) {
                  throw new Error(`Failed to flatten ${layerLabel.toLowerCase()} tiles`);
                }
                renderBounds = canvasData.renderBounds;
                paddingInsets = canvasData.paddingInsets;
                pixelWidth = canvasData.pixelWidth;
                pixelHeight = canvasData.pixelHeight;
                resolutionOut = canvasData.resolution;

                const filename = `${flattenBaseName}${layerSuffix}.webp`;
                filePath = await this._saveAsWebP(canvasData.canvas, quality, { uploadContext: flattenContext, filename });
                if (!filePath) {
                  throw new Error(`Failed to save ${layerLabel.toLowerCase()} tile image`);
                }
                try {
                  canvasData.canvas.width = 0;
                  canvasData.canvas.height = 0;
                } catch (_) {}
              }

              const metadata = this._buildMetadata({
                tiles: task.tiles,
                logicalBounds,
                renderBounds,
                paddingInsets,
                pixelWidth,
                pixelHeight,
                ppi,
                quality,
                paddingSnap: normalizedPaddingSnap,
                paddingExtra,
                resolution: resolutionOut,
                filePath,
                chunks: chunkEntries,
                chunking: chunkingMeta,
                chunkSize
              });
              const created = await this._createFlattenedTile(renderBounds, filePath, metadata);
              if (Array.isArray(created)) flattenedCount += created.length;
            }

            if (flattenedCount > 0) {
              overlay.setStatus('Removing original tiles...');
              overlay.setProgress?.(0.98);
              await this._nextFrame();
              await this._deleteOriginalTiles(tiles);
            }
          } catch (error) {
            Logger.error('TileFlatten.exportScene.flattenFailed', { error: String(error?.message || error) });
            ui?.notifications?.error?.(`Failed to flatten scene tiles: ${error?.message || error}`);
          }
        }
      }

      overlay.setStatus(shouldExport ? 'Export complete.' : 'Flatten complete.');
      overlay.setProgress?.(1);
      const doneMessage = shouldExport
        ? 'Scene export complete.'
        : (flattenedCount > 0
          ? `Scene flatten complete. Flattened ${flattenedCount} tile${flattenedCount === 1 ? '' : 's'}.`
          : 'Scene flatten complete.');
      ui?.notifications?.info?.(doneMessage);
      Logger.info('TileFlatten.exportScene.success', {
        action: resolvedAction,
        files: savedFiles,
        split: !!exportSplitLayers,
        chunked: !!useChunking,
        flattenedCount
      });
    } catch (error) {
      Logger.error('TileFlatten.exportScene.failed', { error: String(error?.message || error) });
      const actionLabel = shouldExport ? 'export' : 'flatten';
      ui?.notifications?.error?.(`Failed to ${actionLabel} scene: ${error?.message || error}`);
    } finally {
      this._hideOverlay();
      this._flattening = false;
    }
  }

  /**
   * Flatten multiple tiles into a single image
   * @param {Array<import('foundry/applications/api').TileDocument>} tiles
   * @param {object} options
   * @param {number} options.ppi - Pixels per inch
   * @param {number} options.quality - WebP quality (0-1)
   * @param {string} options.paddingSnap - 'none' | 'half' | 'full'
   * @param {number} options.paddingExtra - Padding adjustment in grid squares (can be negative)
   * @param {number} options.chunkWidth - Chunk width in grid squares (0 disables chunking)
   * @param {number} options.chunkHeight - Chunk height in grid squares (0 disables chunking)
   * @param {boolean} options.chunkPad - Pad output bounds to full chunks
   * @param {number} options.chunkSize - Legacy chunk size in pixels (0 disables chunking)
   * @param {object} options.previewBounds - Trimmed bounds from the dialog preview (optional)
   * @param {number} options.previewPpi - PPI used to capture preview bounds
   */
  async flattenTiles(tiles, options = {}) {
    if (this.isBusy()) {
      Logger.warn('TileFlatten.flattenTiles.busy');
      return;
    }

    this._flattening = true;
    const {
      ppi = 200,
      quality = 0.85,
      paddingSnap = 'none',
      paddingExtra = 0,
      chunkWidth = 0,
      chunkHeight = 0,
      chunkPad = false,
      chunkSize = 0
    } = options || {};
    const normalizedPaddingSnap = this._normalizePaddingSnap(paddingSnap);
    const normalizedChunkSquares = this._normalizeChunkSquares(chunkWidth, chunkHeight);
    const normalizedChunkPad = normalizedChunkSquares.enabled ? !!chunkPad : false;
    const normalizedChunkSize = normalizedChunkSquares.enabled ? 0 : this._normalizeChunkSize(chunkSize);
    let overlay = null;

    try {
      ui?.notifications?.info?.('Flattening tiles... This may take a moment.');

      const { targets } = this._filterFlattenTargets(tiles);

      if (targets.length < 2 && !(targets.length === 1 && TileFlattenManager.isMergedTile(targets[0]))) {
        ui?.notifications?.warn?.('Please select at least 2 flattenable tiles (walls/frames), or a merged tile.');
        return;
      }

      overlay = this._showOverlay('flatten');
      overlay.setStatus('Preparing tiles...');
      overlay.setProgress?.(0.1);
      await this._nextFrame();

      // Compute bounding box of all tiles (logical + shadow-aware)
      const logicalBounds = this._computeBounds(targets);
      if (!logicalBounds) {
        throw new Error('Could not compute bounds for selected tiles');
      }
      const previewPpi = Number(options?.previewPpi);
      const previewBounds = Number.isFinite(previewPpi) && previewPpi !== ppi
        ? null
        : this._normalizeFlattenBounds(options?.previewBounds);
      const shadowBounds = previewBounds || this._computeShadowedBounds(targets);
      if (!shadowBounds) {
        throw new Error('Could not compute shadow bounds for selected tiles');
      }

      const gridSize = Math.max(1, Number(canvas?.scene?.grid?.size || 100));
      const resolution = this._computeResolution(ppi, gridSize);
      const plannedRenderBounds = this._computeRenderBounds(shadowBounds, gridSize, normalizedPaddingSnap, paddingExtra);
      const plannedPixelWidth = Math.max(1, Math.round(plannedRenderBounds.width * resolution));
      const plannedPixelHeight = Math.max(1, Math.round(plannedRenderBounds.height * resolution));
      const maxTextureSize = this._getMaxTextureSize(canvas?.app?.renderer);
      const autoChunkPlan = resolveAutoChunking(plannedPixelWidth, plannedPixelHeight, {
        maxTextureSize
      });
      const hasManualChunking = normalizedChunkSquares.enabled || normalizedChunkSize > 0;
      const useAutoChunking = !hasManualChunking && autoChunkPlan.enabled;
      const useChunking = hasManualChunking ? true : useAutoChunking;
      let canvasData = null;
      let chunkData = null;
      let filePath = null;
      let chunkEntries = null;

      if (useChunking) {
        overlay.setStatus('Capturing chunks...');
        overlay.setProgress?.(0.35);
        await this._nextFrame();

        const uploadContext = await this._resolveFlattenUploadContext();
        const baseName = this._buildFlattenFilenameBase();
        const savedChunks = [];

        const autoChunkWidth = useAutoChunking ? (autoChunkPlan.chunkPixelWidth / ppi) : 0;
        const autoChunkHeight = useAutoChunking ? (autoChunkPlan.chunkPixelHeight / ppi) : 0;
        chunkData = await this._renderTilesToCanvasChunked(targets, shadowBounds, ppi, {
          paddingSnap: normalizedPaddingSnap,
          paddingExtra,
          chunkWidth: normalizedChunkSquares.enabled ? normalizedChunkSquares.widthSquares : autoChunkWidth,
          chunkHeight: normalizedChunkSquares.enabled ? normalizedChunkSquares.heightSquares : autoChunkHeight,
          chunkPad: normalizedChunkSquares.enabled ? normalizedChunkPad : false,
          chunkSize: normalizedChunkSquares.enabled ? 0 : (useAutoChunking ? 0 : normalizedChunkSize),
          chunkAuto: useAutoChunking,
          suspendRender: true,
          onChunk: async (entry, index, total) => {
            const label = Number.isFinite(total) && total > 0
              ? `Saving chunk ${index + 1} of ${total}...`
              : 'Saving chunk...';
            overlay.setStatus(label);
            if (Number.isFinite(total) && total > 0) {
              const progress = 0.35 + (0.25 * ((index + 1) / total));
              overlay.setProgress?.(Math.min(0.6, progress));
            }
            const rowLabel = Number.isFinite(entry?.row) ? entry.row + 1 : null;
            const colLabel = Number.isFinite(entry?.col) ? entry.col + 1 : null;
            const suffix = rowLabel && colLabel ? `-r${rowLabel}-c${colLabel}` : `-${index + 1}`;
            const filename = `${baseName}${suffix}.webp`;
            let src = null;
            try {
              src = await this._saveAsWebP(entry?.canvas, quality, { uploadContext, filename });
            } finally {
              try {
                if (entry?.canvas) {
                  entry.canvas.width = 0;
                  entry.canvas.height = 0;
                }
              } catch (_) {}
            }
            if (src) {
              savedChunks.push({
                src,
                x: Number(entry?.x) || 0,
                y: Number(entry?.y) || 0,
                width: Number(entry?.width) || 0,
                height: Number(entry?.height) || 0,
                pixelWidth: Number(entry?.pixelWidth) || null,
                pixelHeight: Number(entry?.pixelHeight) || null
              });
            }
          }
        });

        if (!chunkData) {
          throw new Error('Failed to render tile chunks');
        }
        if (!savedChunks.length) {
          throw new Error('Failed to save flattened image chunks');
        }
        const expectedChunks = Number.isFinite(chunkData?.rows) && Number.isFinite(chunkData?.columns)
          ? (chunkData.rows * chunkData.columns)
          : null;
        if (Number.isFinite(expectedChunks) && expectedChunks > 0 && savedChunks.length !== expectedChunks) {
          throw new Error('Failed to save all flattened image chunks');
        }
        chunkEntries = savedChunks;
        filePath = savedChunks[0]?.src || null;
      } else {
        overlay.setStatus('Capturing canvas...');
        overlay.setProgress?.(0.35);
        await this._nextFrame();

        // Render tiles to canvas
        canvasData = await this._renderTilesToCanvas(targets, shadowBounds, ppi, {
          paddingSnap: normalizedPaddingSnap,
          paddingExtra,
          suspendRender: true
        });
        if (!canvasData || !canvasData.canvas) {
          throw new Error('Failed to render tiles to canvas');
        }

        overlay.setStatus('Saving image...');
        overlay.setProgress?.(0.6);
        await this._nextFrame();

        // Save as WebP
        filePath = await this._saveAsWebP(canvasData.canvas, quality);
        if (!filePath) {
          throw new Error('Failed to save flattened image');
        }
        try {
          if (canvasData?.canvas) {
            canvasData.canvas.width = 0;
            canvasData.canvas.height = 0;
          }
        } catch (_) {}
      }

      overlay.setStatus('Building metadata...');
      overlay.setProgress?.(0.75);
      await this._nextFrame();

      const renderBounds = useChunking ? chunkData?.renderBounds : canvasData?.renderBounds;

      // Store metadata for deconstruction
      const metadata = this._buildMetadata({
        tiles: targets,
        logicalBounds,
        renderBounds,
        paddingInsets: useChunking ? chunkData?.paddingInsets : canvasData?.paddingInsets,
        pixelWidth: useChunking ? chunkData?.pixelWidth : canvasData?.pixelWidth,
        pixelHeight: useChunking ? chunkData?.pixelHeight : canvasData?.pixelHeight,
        ppi,
        quality,
        paddingSnap: normalizedPaddingSnap,
        paddingExtra,
        resolution: useChunking ? chunkData?.resolution : canvasData?.resolution,
        filePath,
        chunks: useChunking ? chunkEntries : null,
        chunking: useChunking ? chunkData?.chunking : null,
        chunkSize: useChunking ? (chunkData?.chunkSize ?? normalizedChunkSize) : 0
      });

      overlay.setStatus('Creating flattened tile...');
      overlay.setProgress?.(0.9);
      await this._nextFrame();

      // Create flattened tile
      await this._createFlattenedTile(renderBounds, filePath, metadata);

      overlay.setStatus('Cleaning up...');
      overlay.setProgress?.(0.97);
      await this._nextFrame();

      // Delete original tiles
      await this._deleteOriginalTiles(targets);
      overlay.setProgress?.(1);

      ui?.notifications?.info?.('Tiles flattened successfully!');
      Logger.info('TileFlatten.flattenTiles.success', { tileCount: tiles.length, filePath });

    } catch (error) {
      Logger.error('TileFlatten.flattenTiles.failed', { error: String(error?.message || error) });
      ui?.notifications?.error?.(`Failed to flatten tiles: ${error?.message || error}`);
    } finally {
      this._hideOverlay();
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

  _collectSceneTiles() {
    const docs = [];
    const seen = new Set();
    const TileDoc = foundry?.documents?.TileDocument;
    const addDoc = (doc) => {
      if (!doc) return;
      const id = doc.id || null;
      if (id && seen.has(id)) return;
      if (TileDoc && !(doc instanceof TileDoc)) return;
      docs.push(doc);
      if (id) seen.add(id);
    };

    try {
      const sceneTiles = canvas?.scene?.tiles || null;
      if (sceneTiles) {
        const contents = Array.isArray(sceneTiles.contents)
          ? sceneTiles.contents
          : (Array.isArray(sceneTiles)
            ? sceneTiles
            : (typeof sceneTiles.values === 'function' ? Array.from(sceneTiles.values()) : []));
        for (const doc of contents) addDoc(doc);
      }
    } catch (_) {}

    const layers = [canvas?.tiles, canvas?.background];
    for (const layer of layers) {
      const placeables = Array.isArray(layer?.placeables) ? layer.placeables : [];
      for (const placeable of placeables) {
        addDoc(placeable?.document || placeable);
      }
    }

    return docs;
  }

  _getSceneBounds() {
    try {
      const d = canvas?.dimensions;
      if (d) {
        const sr = d.sceneRect || d.sceneRectangle || null;
        if (sr && Number.isFinite(sr.width) && Number.isFinite(sr.height)) {
          const x = Number(sr.x || 0) || 0;
          const y = Number(sr.y || 0) || 0;
          const w = Math.max(1, Math.round(Number(sr.width || 0)));
          const h = Math.max(1, Math.round(Number(sr.height || 0)));
          return { x, y, width: w, height: h };
        }
        const x = Number((d.sceneX ?? 0) || 0) || 0;
        const y = Number((d.sceneY ?? 0) || 0) || 0;
        const w = Number((d.sceneWidth ?? d.width ?? canvas?.scene?.width) || 0) || 0;
        const h = Number((d.sceneHeight ?? d.height ?? canvas?.scene?.height) || 0) || 0;
        if (w > 0 && h > 0) return { x, y, width: w, height: h };
      }
      const grid = Number(canvas?.scene?.grid?.size || 100) || 100;
      const sw = Math.max(1, Number(canvas?.scene?.width || 50));
      const sh = Math.max(1, Number(canvas?.scene?.height || 50));
      const pad = Number(canvas?.scene?.padding || 0) || 0;
      const padPxX = Math.round(pad * sw * grid);
      const padPxY = Math.round(pad * sh * grid);
      return { x: -padPxX, y: -padPxY, width: sw * grid + 2 * padPxX, height: sh * grid + 2 * padPxY };
    } catch (_) {
      return null;
    }
  }

  _getForegroundElevation() {
    try {
      const raw = canvas?.scene?.foregroundElevation ?? canvas?.scene?._source?.foregroundElevation;
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) return numeric;
    } catch (_) {}
    try {
      const gridDistance = Number(canvas?.scene?.grid?.distance || 0);
      if (Number.isFinite(gridDistance)) return gridDistance * 4;
    } catch (_) {}
    return 0;
  }

  _getTileElevation(doc) {
    const raw = Number(doc?.elevation ?? doc?._source?.elevation ?? doc?.data?.elevation ?? 0);
    return Number.isFinite(raw) ? raw : 0;
  }

  _normalizeFlattenBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') return null;
    const x = Number(bounds.x);
    const y = Number(bounds.y);
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    if (![x, y, width, height].every(Number.isFinite)) return null;
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
  }

  /**
   * Normalize tile list for flattening.
   */
  _filterFlattenTargets(tiles = []) {
    const list = Array.isArray(tiles) ? tiles : [];
    const targets = list.filter(Boolean);
    return { targets, skipped: [] };
  }

  /**
   * Render tiles to canvas including shadows, masks, paths
   * Render the stage directly with adjusted transforms - cannot move PrimaryCanvasObjects
   */
  async _renderTilesToCanvas(tiles, bounds, ppi, options = {}) {
    if (!canvas || !canvas.ready || !canvas.stage || !canvas.app?.renderer) {
      throw new Error('Canvas not available');
    }

    const renderer = canvas.app.renderer;
    const gridSize = Math.max(1, Number(canvas.scene?.grid?.size || 100));
    const resolution = this._computeResolution(ppi, gridSize);
    const outputSnap = options?.paddingSnap;
    const outputExtra = options?.paddingExtra;
    const trimToContent = options?.trimToContent !== false;
    const capturePadding = trimToContent ? this._computeCapturePadding(gridSize) : 0;
    const baseBounds = bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null;
    let renderBounds = baseBounds ? { ...baseBounds } : null;
    if (renderBounds && capturePadding) {
      renderBounds = this._applyExtraPadding(renderBounds, capturePadding);
    }
    let paddingInsets = renderBounds ? this._computeBoundsInsets(bounds, renderBounds) : null;

    Logger.debug?.('TileFlatten.capture.init', {
      tileIds: tiles.map?.((t) => t?.id).filter(Boolean),
      bounds,
      renderBounds,
      gridSize,
      resolution,
      paddingInsets,
      capturePadding,
      trimToContent,
      ppi
    });

    if (!renderBounds) {
      throw new Error('Invalid bounds for flattened image');
    }

    if (renderBounds.width <= 0 || renderBounds.height <= 0) {
      throw new Error('Invalid dimensions for flattened image');
    }

    const maxTextureSize = this._getMaxTextureSize(renderer);
    let pixelWidth = Math.max(1, Math.round(renderBounds.width * resolution));
    let pixelHeight = Math.max(1, Math.round(renderBounds.height * resolution));
    if (pixelWidth > maxTextureSize || pixelHeight > maxTextureSize) {
      if (capturePadding && baseBounds) {
        renderBounds = { ...baseBounds };
        pixelWidth = Math.max(1, Math.round(renderBounds.width * resolution));
        pixelHeight = Math.max(1, Math.round(renderBounds.height * resolution));
      }
      if (pixelWidth > maxTextureSize || pixelHeight > maxTextureSize) {
        throw new Error(`Flattened image would exceed renderer texture cap (${pixelWidth}×${pixelHeight}px > ${maxTextureSize}). Try lowering PPI or enabling chunking.`);
      }
    }

    const renderGuard = this._suspendCanvasRender(options?.suspendRender);
    let visibilityState = null;
    try {
      visibilityState = await this._applyFlattenVisibility(tiles, renderBounds, options?.visibility);
      await this._waitForShadowLayers(visibilityState.shadowManager, visibilityState.shadowElevations);
      await this._prepareTilesForCapture(tiles);
      
      // Ensure selected tiles are visible
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

      const keepBackground = !!options?.visibility?.keepBackground;
      const restorePrimaryRender = keepBackground ? null : this._forcePrimaryTransparentClear(primary);
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

      let outputCanvas = canvasEl;
      let outputBounds = renderBounds;
      if (trimToContent && canvasEl) {
        const trim = this._trimCanvasToContent(canvasEl);
        if (trim && trim.width > 0 && trim.height > 0) {
          outputCanvas = this._cropCanvas(canvasEl, trim);
          outputBounds = {
            x: renderBounds.x + (trim.x / resolution),
            y: renderBounds.y + (trim.y / resolution),
            width: trim.width / resolution,
            height: trim.height / resolution
          };
        }
      }

      const targetBounds = this._computeRenderBounds(outputBounds, gridSize, outputSnap, outputExtra);
      const targetPixelWidth = Math.max(1, Math.round(targetBounds.width * resolution));
      const targetPixelHeight = Math.max(1, Math.round(targetBounds.height * resolution));
      if (targetPixelWidth > maxTextureSize || targetPixelHeight > maxTextureSize) {
        throw new Error(`Flattened image would exceed renderer texture cap (${targetPixelWidth}×${targetPixelHeight}px > ${maxTextureSize}). Try lowering PPI or enabling chunking.`);
      }

      const adjusted = this._adjustCanvasToBounds(outputCanvas, outputBounds, targetBounds, resolution);
      outputCanvas = adjusted?.canvas || outputCanvas;
      outputBounds = targetBounds;
      paddingInsets = this._computeBoundsInsets(bounds, outputBounds);

      const diagnostics = this._diagnoseCanvas(outputCanvas);
      Logger.debug?.('TileFlatten.capture.canvas', {
        pixelWidth,
        pixelHeight,
        actualWidth: outputCanvas?.width,
        actualHeight: outputCanvas?.height,
        blank: diagnostics?.isBlank ?? true,
        diagnostics
      });

      return {
        canvas: outputCanvas,
        renderBounds: outputBounds,
        logicalBounds: bounds,
        pixelWidth: outputCanvas?.width ?? targetPixelWidth,
        pixelHeight: outputCanvas?.height ?? targetPixelHeight,
        paddingInsets,
        resolution,
        gridSize,
        ppi
      };
    } finally {
      if (visibilityState) {
        await this._restoreFlattenVisibility(visibilityState);
      }
      if (typeof renderGuard === 'function') {
        try { renderGuard(); } catch (_) {}
      }
    }
  }

  async _renderTilesToCanvasChunked(tiles, bounds, ppi, options = {}) {
    if (!canvas || !canvas.ready || !canvas.stage || !canvas.app?.renderer) {
      throw new Error('Canvas not available');
    }

    const renderer = canvas.app.renderer;
    const gridSize = Math.max(1, Number(canvas.scene?.grid?.size || 100));
    const resolution = this._computeResolution(ppi, gridSize);
    const outputSnap = options?.paddingSnap;
    const outputExtra = options?.paddingExtra;
    const baseBounds = bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null;
    if (!baseBounds) {
      throw new Error('Invalid bounds for flattened image');
    }

    const maxTextureSize = this._getMaxTextureSize(renderer);
    let renderBounds = this._computeRenderBounds(baseBounds, gridSize, outputSnap, outputExtra);
    const chunkLayout = this._resolveChunkLayout(options, gridSize, resolution, maxTextureSize);
    if (!chunkLayout.enabled) {
      throw new Error('Chunk size is required for chunked flatten');
    }
    if (chunkLayout.padToChunks) {
      renderBounds = this._padBoundsToChunkGrid(renderBounds, chunkLayout.worldWidth, chunkLayout.worldHeight);
    }
    let paddingInsets = renderBounds ? this._computeBoundsInsets(bounds, renderBounds) : null;

    if (!renderBounds || renderBounds.width <= 0 || renderBounds.height <= 0) {
      throw new Error('Invalid dimensions for flattened image');
    }

    const pixelWidth = Math.max(1, Math.round(renderBounds.width * resolution));
    const pixelHeight = Math.max(1, Math.round(renderBounds.height * resolution));
    const logicalWidth = pixelWidth / resolution;
    const logicalHeight = pixelHeight / resolution;
    const scaleFixX = logicalWidth > 0 ? (renderBounds.width / logicalWidth) : 1;
    const scaleFixY = logicalHeight > 0 ? (renderBounds.height / logicalHeight) : 1;
    const shadowOverlapWorld = this._computeMaxShadowMargin(tiles);
    const scaleFixXSafe = Number.isFinite(scaleFixX) && scaleFixX > 0 ? scaleFixX : 1;
    const scaleFixYSafe = Number.isFinite(scaleFixY) && scaleFixY > 0 ? scaleFixY : 1;
    const baseOverlapPxX = shadowOverlapWorld > 0
      ? Math.max(0, Math.ceil((shadowOverlapWorld * resolution) / scaleFixXSafe))
      : 0;
    const baseOverlapPxY = shadowOverlapWorld > 0
      ? Math.max(0, Math.ceil((shadowOverlapWorld * resolution) / scaleFixYSafe))
      : 0;
    const chunkPixelBaseWidth = Number(chunkLayout.pixelWidth) || 0;
    const chunkPixelBaseHeight = Number(chunkLayout.pixelHeight) || 0;
    if (!chunkPixelBaseWidth || !chunkPixelBaseHeight) {
      throw new Error('Chunk size is required for chunked flatten');
    }

    const columns = Math.max(1, Math.ceil(pixelWidth / chunkPixelBaseWidth));
    const rows = Math.max(1, Math.ceil(pixelHeight / chunkPixelBaseHeight));
    const totalChunks = columns * rows;
    const chunkingMeta = {
      widthSquares: Number.isFinite(chunkLayout.widthSquares) ? chunkLayout.widthSquares : null,
      heightSquares: Number.isFinite(chunkLayout.heightSquares) ? chunkLayout.heightSquares : null,
      padToChunks: !!chunkLayout.padToChunks,
      pixelWidth: Number.isFinite(chunkLayout.pixelWidth) ? chunkLayout.pixelWidth : null,
      pixelHeight: Number.isFinite(chunkLayout.pixelHeight) ? chunkLayout.pixelHeight : null,
      worldWidth: Number.isFinite(chunkLayout.worldWidth) ? chunkLayout.worldWidth : null,
      worldHeight: Number.isFinite(chunkLayout.worldHeight) ? chunkLayout.worldHeight : null
    };

    const renderGuard = this._suspendCanvasRender(options?.suspendRender);
    let visibilityState = null;
    try {
      visibilityState = await this._applyFlattenVisibility(tiles, renderBounds, options?.visibility);
      await this._waitForShadowLayers(visibilityState.shadowManager, visibilityState.shadowElevations);
      await this._prepareTilesForCapture(tiles);

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

      const keepBackground = !!options?.visibility?.keepBackground;
      const restorePrimaryRender = keepBackground ? null : this._forcePrimaryTransparentClear(primary);
      const restorePrimaryDisplay = this._usePrimaryChildRendering(primary);

      const originalStageState = {
        scaleX: stage.scale?.x ?? 1,
        scaleY: stage.scale?.y ?? 1,
        positionX: stage.position?.x ?? 0,
        positionY: stage.position?.y ?? 0,
        pivotX: stage.pivot?.x ?? 0,
        pivotY: stage.pivot?.y ?? 0
      };

      const originalScreen = renderer.screen
        ? { width: renderer.screen.width, height: renderer.screen.height }
        : null;

      const rendererBackground = renderer.background || null;
      const previousBackground = rendererBackground
        ? { alpha: rendererBackground.alpha, color: rendererBackground.color }
        : null;
      const hasBackgroundAlpha = typeof renderer.backgroundAlpha === 'number';
      const previousBackgroundAlpha = hasBackgroundAlpha ? renderer.backgroundAlpha : null;

      let stageAdjusted = false;
      let restoreShadowBlur = null;
      try {
        try {
          if (stage.pivot && typeof stage.pivot.set === 'function') {
            stage.pivot.set(0, 0);
          }
        } catch (_) {}

        try {
          if (stage.scale && typeof stage.scale.set === 'function') {
            stage.scale.set(resolution, resolution);
          }
        } catch (_) {}

        restoreShadowBlur = this._syncShadowBlurForCapture(visibilityState.shadowManager);

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

        await this._nextFrame();

        const chunks = [];
        let index = 0;
        for (let row = 0; row < rows; row += 1) {
          const pixelY = row * chunkPixelBaseHeight;
          const chunkPixelHeight = Math.max(1, Math.min(chunkPixelBaseHeight, pixelHeight - pixelY));
          const chunkWorldY = renderBounds.y + ((pixelY / resolution) * scaleFixY);
          const chunkWorldHeight = (chunkPixelHeight / resolution) * scaleFixY;
          const maxOverlapPxY = Math.floor((maxTextureSize - chunkPixelHeight) / 2);
          const overlapPxY = Math.max(0, Math.min(baseOverlapPxY, Number.isFinite(maxOverlapPxY) ? maxOverlapPxY : 0));
          const overlapWorldY = (overlapPxY / resolution) * scaleFixYSafe;

          for (let col = 0; col < columns; col += 1) {
            const pixelX = col * chunkPixelBaseWidth;
            const chunkPixelWidth = Math.max(1, Math.min(chunkPixelBaseWidth, pixelWidth - pixelX));
            const chunkWorldX = renderBounds.x + ((pixelX / resolution) * scaleFixX);
            const chunkWorldWidth = (chunkPixelWidth / resolution) * scaleFixX;
            const maxOverlapPxX = Math.floor((maxTextureSize - chunkPixelWidth) / 2);
            const overlapPxX = Math.max(0, Math.min(baseOverlapPxX, Number.isFinite(maxOverlapPxX) ? maxOverlapPxX : 0));
            const overlapWorldX = (overlapPxX / resolution) * scaleFixXSafe;
            const renderPixelWidth = chunkPixelWidth + (overlapPxX * 2);
            const renderPixelHeight = chunkPixelHeight + (overlapPxY * 2);

            try {
              if (stage.position && typeof stage.position.set === 'function') {
                stage.position.set(-(chunkWorldX - overlapWorldX) * resolution, -(chunkWorldY - overlapWorldY) * resolution);
              }
            } catch (_) {}

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

            if (renderer.screen) {
              renderer.screen.width = renderPixelWidth;
              renderer.screen.height = renderPixelHeight;
            }

            const renderTexture = PIXI.RenderTexture.create({
              width: renderPixelWidth,
              height: renderPixelHeight,
              resolution: 1,
              scaleMode: PIXI.SCALE_MODES.LINEAR
            });

            if (renderTexture?.baseTexture) {
              try { renderTexture.baseTexture.clearColor = [0, 0, 0, 0]; } catch (_) {}
            }

            try {
              renderer.render(stage, {
                renderTexture,
                clear: true,
                skipUpdateTransform: false
              });
            } catch (renderErr) {
              const errorMsg = String(renderErr?.message || renderErr);
              renderTexture.destroy(true);
              throw new Error(`Failed to render tile chunk: ${errorMsg}`);
            }

            const canvasEl = renderer.extract.canvas(renderTexture);
            renderTexture.destroy(true);
            let outputCanvas = canvasEl;
            if (overlapPxX || overlapPxY) {
              outputCanvas = this._cropCanvas(canvasEl, {
                x: overlapPxX,
                y: overlapPxY,
                width: chunkPixelWidth,
                height: chunkPixelHeight
              });
              try {
                canvasEl.width = 0;
                canvasEl.height = 0;
              } catch (_) {}
            }

            const entry = {
              canvas: outputCanvas,
              x: chunkWorldX - renderBounds.x,
              y: chunkWorldY - renderBounds.y,
              width: chunkWorldWidth,
              height: chunkWorldHeight,
              pixelWidth: chunkPixelWidth,
              pixelHeight: chunkPixelHeight,
              row,
              col
            };

            if (typeof options?.onChunk === 'function') {
              await options.onChunk(entry, index, totalChunks);
            } else {
              chunks.push(entry);
            }

            index += 1;
          }
        }

        return {
          chunks,
          renderBounds,
          logicalBounds: bounds,
          pixelWidth,
          pixelHeight,
          paddingInsets,
          resolution,
          gridSize,
          ppi,
          chunking: chunkingMeta,
          chunkSize: Number.isFinite(chunkLayout.pixelSize) ? chunkLayout.pixelSize : null,
          rows,
          columns
        };
      } finally {
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

          if (originalScreen && renderer.screen) {
            renderer.screen.width = originalScreen.width;
            renderer.screen.height = originalScreen.height;
          }

          try {
            if (typeof stage.updateTransform === 'function') {
              stage.updateTransform();
            }
          } catch (_) {}
        }

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
    } finally {
      if (visibilityState) {
        await this._restoreFlattenVisibility(visibilityState);
      }
      if (typeof renderGuard === 'function') {
        try { renderGuard(); } catch (_) {}
      }
    }
  }

  async _capturePreviewBounds({ tiles, ppi } = {}) {
    try {
      if (this.isBusy()) return null;
      const list = Array.isArray(tiles) ? tiles : [];
      if (!list.length) return null;
      const { targets } = this._filterFlattenTargets(list);
      if (!targets.length) return null;
      const shadowBounds = this._computeShadowedBounds(targets);
      if (!shadowBounds) return null;
      const capture = await this._renderTilesToCanvas(targets, shadowBounds, ppi, {
        paddingSnap: 'none',
        paddingExtra: 0,
        trimToContent: true,
        suspendRender: true
      });
      const bounds = capture?.renderBounds;
      if (capture?.canvas) {
        try {
          capture.canvas.width = 0;
          capture.canvas.height = 0;
        } catch (_) {}
      }
      if (!bounds) return null;
      return {
        bounds,
        gridSize: capture?.gridSize,
        resolution: capture?.resolution
      };
    } catch (error) {
      Logger.debug?.('TileFlatten.preview.captureFailed', { error: String(error?.message || error) });
      return null;
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

  _computeShadowedBounds(tiles) {
    if (!Array.isArray(tiles) || !tiles.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const doc of tiles) {
      const base = this._computeTileWorldBounds(doc);
      if (!base) continue;
      const margins = this._computeTileShadowMargins(doc);
      const expanded = this._expandBoundsWithMargins(base, margins);
      minX = Math.min(minX, expanded.x);
      minY = Math.min(minY, expanded.y);
      maxX = Math.max(maxX, expanded.x + expanded.width);
      maxY = Math.max(maxY, expanded.y + expanded.height);
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

  _computeMaxShadowMargin(tiles) {
    if (!Array.isArray(tiles) || !tiles.length) return 0;
    let maxMargin = 0;
    for (const doc of tiles) {
      const margins = this._computeTileShadowMargins(doc);
      if (!margins) continue;
      maxMargin = Math.max(
        maxMargin,
        Number(margins.left) || 0,
        Number(margins.right) || 0,
        Number(margins.top) || 0,
        Number(margins.bottom) || 0
      );
    }
    return Number.isFinite(maxMargin) ? Math.max(0, maxMargin) : 0;
  }

  _computeTileShadowMargins(doc) {
    const margins = { left: 0, right: 0, top: 0, bottom: 0 };
    if (!doc || !this._hasShadowEnabled(doc)) return margins;
    if (!this._isDropShadowEnabled()) return margins;
    const alphaValue = this._readShadowValue(doc, 'shadowAlpha');
    const alpha = Number(alphaValue);
    if (alphaValue !== undefined && Number.isFinite(alpha) && alpha <= 0) return margins;
    const dilation = Math.max(0, this._readShadowNumeric(doc, 'shadowDilation'));
    const blur = Math.max(0, this._readShadowNumeric(doc, 'shadowBlur'));
    const blurMargin = this._computeShadowBlurMargin(blur);
    const extra = dilation + blurMargin;
    const offset = this._resolveShadowOffset(doc);
    margins.left = Math.max(0, extra - offset.x);
    margins.right = Math.max(0, extra + offset.x);
    margins.top = Math.max(0, extra - offset.y);
    margins.bottom = Math.max(0, extra + offset.y);
    return margins;
  }

  _computeShadowBlurMargin(blur) {
    const numeric = Math.max(0, Number(blur) || 0);
    if (!numeric) return 0;
    return Math.ceil((numeric * 2) + 1);
  }

  _computeRenderBounds(bounds, gridSize, paddingSnap, paddingExtra) {
    const extraPadding = this._normalizePaddingExtra(paddingExtra, gridSize);
    const expanded = this._applyExtraPadding(bounds, extraPadding);
    return this._snapBounds(expanded, gridSize, paddingSnap);
  }

  _padBoundsToChunkGrid(bounds, chunkWidth, chunkHeight) {
    if (!bounds) return bounds;
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    const chunkW = Number(chunkWidth);
    const chunkH = Number(chunkHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return bounds;
    if (!Number.isFinite(chunkW) || !Number.isFinite(chunkH) || chunkW <= 0 || chunkH <= 0) return bounds;
    const paddedWidth = Math.ceil(width / chunkW) * chunkW;
    const paddedHeight = Math.ceil(height / chunkH) * chunkH;
    return {
      x: bounds.x,
      y: bounds.y,
      width: paddedWidth,
      height: paddedHeight
    };
  }

  _snapBounds(bounds, gridSize, paddingSnap) {
    const snap = this._normalizePaddingSnap(paddingSnap);
    if (snap === 'none') return bounds;
    const increment = snap === 'half' ? (Number(gridSize) / 2) : Number(gridSize);
    if (!Number.isFinite(increment) || increment <= 0) return bounds;
    const minX = Math.floor(bounds.x / increment) * increment;
    const minY = Math.floor(bounds.y / increment) * increment;
    const maxX = Math.ceil((bounds.x + bounds.width) / increment) * increment;
    const maxY = Math.ceil((bounds.y + bounds.height) / increment) * increment;
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  _expandBoundsWithMargins(bounds, margins) {
    const left = Math.max(0, Number(margins?.left) || 0);
    const right = Math.max(0, Number(margins?.right) || 0);
    const top = Math.max(0, Number(margins?.top) || 0);
    const bottom = Math.max(0, Number(margins?.bottom) || 0);
    return {
      x: bounds.x - left,
      y: bounds.y - top,
      width: bounds.width + left + right,
      height: bounds.height + top + bottom
    };
  }

  _applyExtraPadding(bounds, extraPadding) {
    const pad = Number(extraPadding) || 0;
    if (!pad) return bounds;
    const width = bounds.width + pad * 2;
    const height = bounds.height + pad * 2;
    if (width <= 1 || height <= 1) return bounds;
    return {
      x: bounds.x - pad,
      y: bounds.y - pad,
      width,
      height
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
      const placeable = doc?.object;
      const mesh = placeable?.mesh || placeable?.sprite;
      if (mesh) {
        const width = Math.abs(Number(mesh.width || 0));
        const height = Math.abs(Number(mesh.height || 0));
        if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
          const anchorX = Number(mesh.anchor?.x ?? 0);
          const anchorY = Number(mesh.anchor?.y ?? 0);
          const posX = Number(mesh.position?.x ?? mesh.x ?? 0);
          const posY = Number(mesh.position?.y ?? mesh.y ?? 0);
          const rotation = Number.isFinite(Number(mesh.rotation))
            ? Number(mesh.rotation)
            : (Number(mesh.angle || 0) * (Math.PI / 180));
          const left = -width * anchorX;
          const top = -height * anchorY;
          const right = left + width;
          const bottom = top + height;
          if (!rotation) {
            return {
              x: posX + left,
              y: posY + top,
              width,
              height
            };
          }
          const cos = Math.cos(rotation);
          const sin = Math.sin(rotation);
          const corners = [
            { x: left, y: top },
            { x: right, y: top },
            { x: right, y: bottom },
            { x: left, y: bottom }
          ];
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (const corner of corners) {
            const rx = (corner.x * cos) - (corner.y * sin) + posX;
            const ry = (corner.x * sin) + (corner.y * cos) + posY;
            minX = Math.min(minX, rx);
            minY = Math.min(minY, ry);
            maxX = Math.max(maxX, rx);
            maxY = Math.max(maxY, ry);
          }
          if (Number.isFinite(minX) && Number.isFinite(minY) && Number.isFinite(maxX) && Number.isFinite(maxY)) {
            return {
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY
            };
          }
        }
      }
      const bounds = placeable?.bounds;
      if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height) && bounds.width > 0 && bounds.height > 0) {
        return {
          x: Number(bounds.x) || 0,
          y: Number(bounds.y) || 0,
          width: Number(bounds.width) || 0,
          height: Number(bounds.height) || 0
        };
      }
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

  async _applyFlattenVisibility(tiles, renderBounds, options = {}) {
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
        const keep = this._shouldRetainPrimaryChild(child, options);
        if (!keep && child.visible) {
          hiddenPrimary.push({ child, visible: true });
          child.visible = false;
        }
      }
    }

    const hiddenSceneImages = [];
    const hiddenSceneTargets = new Set();
    const hideSceneTarget = (target) => {
      if (!target || hiddenSceneTargets.has(target)) return;
      if (typeof target.visible !== 'boolean') return;
      if (!target.visible) return;
      hiddenSceneTargets.add(target);
      hiddenSceneImages.push({ target, visible: true });
      target.visible = false;
    };
    const keepBackground = !!options?.keepBackground;
    const keepForeground = !!options?.keepForeground;
    if (!keepBackground) {
      hideSceneTarget(canvas?.primary?.background);
      hideSceneTarget(canvas?.primary?.background?.mesh);
      hideSceneTarget(canvas?.primary?.background?.sprite);
      const backgroundLayerIsPlaceable = Array.isArray(backgroundLayer?.placeables);
      if (backgroundLayer && !backgroundLayerIsPlaceable) {
        hideSceneTarget(backgroundLayer);
      }
    }
    if (!keepForeground) {
      hideSceneTarget(canvas?.primary?.foreground);
      hideSceneTarget(canvas?.primary?.foreground?.mesh);
      hideSceneTarget(canvas?.primary?.foreground?.sprite);
      const foregroundLayer = canvas?.foreground;
      const foregroundLayerIsPlaceable = Array.isArray(foregroundLayer?.placeables);
      if (foregroundLayer && !foregroundLayerIsPlaceable) {
        hideSceneTarget(foregroundLayer);
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
      hiddenSceneImages,
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

  _shouldRetainPrimaryChild(child, options = {}) {
    try {
      const keepTiles = options?.keepTiles !== false;
      const keepBackground = !!options?.keepBackground;
      const keepForeground = !!options?.keepForeground;
      if (child === canvas.tiles) return keepTiles;
      if (child === canvas.background) return keepBackground;
      if (child === canvas.foreground) return keepForeground;
      if (child === canvas?.primary?.background) return keepBackground;
      if (child === canvas?.primary?.foreground) return keepForeground;
      const name = typeof child?.name === 'string' ? child.name : '';
      if (name === 'background') return keepBackground;
      if (name === 'foreground') return keepForeground;
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

  _suspendCanvasRender(shouldSuspend) {
    if (!shouldSuspend) return null;
    try {
      const app = canvas?.app;
      const ticker = app?.ticker;
      const wasRunning = !!ticker?.started;
      if (!wasRunning) return null;
      if (typeof app?.stop === 'function') {
        app.stop();
      } else if (typeof ticker?.stop === 'function') {
        ticker.stop();
      }
      return () => {
        try {
          if (typeof app?.start === 'function') {
            app.start();
          } else if (typeof ticker?.start === 'function') {
            ticker.start();
          }
        } catch (_) {}
      };
    } catch (_) {
      return null;
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
      for (const entry of state.hiddenSceneImages || []) {
        if (entry?.target && typeof entry.target.visible === 'boolean') {
          entry.target.visible = !!entry.visible;
        }
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

  _readShadowValue(doc, key) {
    try {
      const value = doc?.getFlag?.('fa-nexus', key);
      if (value !== undefined && value !== null) return value;
    } catch (_) {}
    try {
      const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'];
      if (flags && Object.prototype.hasOwnProperty.call(flags, key)) return flags[key];
    } catch (_) {}
    return undefined;
  }

  _resolveShadowOffset(doc) {
    const rawX = this._readShadowValue(doc, 'shadowOffsetX');
    const rawY = this._readShadowValue(doc, 'shadowOffsetY');
    const offsetX = Number(rawX);
    const offsetY = Number(rawY);
    if (Number.isFinite(offsetX) && Number.isFinite(offsetY)) return { x: offsetX, y: offsetY };
    const distRaw = this._readShadowValue(doc, 'shadowOffsetDistance');
    const angleRaw = this._readShadowValue(doc, 'shadowOffsetAngle');
    const distance = Number.isFinite(Number(distRaw)) ? Number(distRaw) : 0;
    const angle = Number.isFinite(Number(angleRaw)) ? Number(angleRaw) : 135;
    const radians = this._normalizeAngle(angle) * (Math.PI / 180);
    return {
      x: Math.cos(radians) * distance,
      y: Math.sin(radians) * distance
    };
  }

  _normalizeAngle(angle) {
    const numeric = Number(angle);
    if (!Number.isFinite(numeric)) return 0;
    let normalized = numeric % 360;
    if (normalized < 0) normalized += 360;
    return normalized;
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

  _getOverlay() {
    if (!this._overlay) this._overlay = new TileFlattenOverlay();
    return this._overlay;
  }

  _showOverlay(kind, total = null) {
    const overlay = this._getOverlay();
    overlay.show(kind, { total });
    return overlay;
  }

  _hideOverlay() {
    try { this._overlay?.hide(); } catch (_) {}
  }

  static isFlattenedTile(doc) {
    try {
      const data = doc?.getFlag?.('fa-nexus', 'flattened');
      return !!data && typeof data === 'object';
    } catch (_) {
      return false;
    }
  }

  static isMergedTile(doc) {
    if (!doc) return false;
    try {
      const merged = doc?.getFlag?.('fa-nexus', 'pathsV2');
      if (merged && typeof merged === 'object' && Array.isArray(merged.paths)) return true;
    } catch (_) {}
    try {
      const scatter = doc?.getFlag?.('fa-nexus', 'assetScatter');
      if (scatter && typeof scatter === 'object' && Array.isArray(scatter.instances)) return true;
    } catch (_) {}
    try {
      const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'];
      if (flags?.pathsV2 && typeof flags.pathsV2 === 'object' && Array.isArray(flags.pathsV2.paths)) return true;
      if (flags?.assetScatter && typeof flags.assetScatter === 'object' && Array.isArray(flags.assetScatter.instances)) return true;
    } catch (_) {}
    return false;
  }

  static isCompositeTile(doc) {
    return this.isMergedTile(doc);
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

    const offset = this._resolveFlattenOffset(tileDoc, flattenMeta);
    const payloads = this._prepareDeconstructionPayload(flattenMeta, offset);
    if (!payloads.length) {
      ui?.notifications?.error?.('Flattened tile has no stored tiles to restore.');
      return;
    }

    if (!canvas?.scene) {
      ui?.notifications?.error?.('Scene not available.');
      return;
    }

    this._deconstructing = true;
    let overlay = null;
    const created = [];

    try {
      ui?.notifications?.info?.('Restoring flattened tiles...');
      overlay = this._showOverlay('deconstruct', payloads.length);
      overlay.updateProgress(0, payloads.length);
      await this._nextFrame();

      const chunkSize = 25;
      for (let i = 0; i < payloads.length; i += chunkSize) {
        const chunk = payloads.slice(i, i + chunkSize);
        const chunkCreated = await canvas.scene.createEmbeddedDocuments('Tile', chunk);
        if (Array.isArray(chunkCreated)) created.push(...chunkCreated);
        overlay.updateProgress(Math.min(i + chunk.length, payloads.length), payloads.length);
      }

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
      this._hideOverlay();
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

  _resolveFlattenOffset(tileDoc, metadata) {
    const origin = metadata?.originalPosition || metadata?.renderBounds || metadata?.logicalBounds || null;
    const originX = Number(origin?.x);
    const originY = Number(origin?.y);
    if (!Number.isFinite(originX) || !Number.isFinite(originY)) return { x: 0, y: 0 };
    const currentX = Number(tileDoc?.x) || 0;
    const currentY = Number(tileDoc?.y) || 0;
    return {
      x: currentX - originX,
      y: currentY - originY
    };
  }

  _prepareDeconstructionPayload(metadata, offset = null) {
    const entries = Array.isArray(metadata?.tiles) ? metadata.tiles : [];
    const payloads = [];
    const offsetX = Number.isFinite(offset?.x) ? Number(offset.x) : 0;
    const offsetY = Number.isFinite(offset?.y) ? Number(offset.y) : 0;
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
        if (offsetX || offsetY) {
          data.x = (Number(data.x) || 0) + offsetX;
          data.y = (Number(data.y) || 0) + offsetY;
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
  _buildExportFilenameBase() {
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
    return `scene-export-${timestamp}-${rand}`;
  }

  _buildFlattenFilenameBase() {
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
    return `flattened-${timestamp}-${rand}`;
  }

  async _resolveFlattenUploadContext(subfolder = 'flattened') {
    await forgeIntegration.initialize();
    const assetsSetting = this._getAssetsDir();
    const dirContext = forgeIntegration.resolveFilePickerContext(assetsSetting);
    const source = dirContext?.source || 'data';
    const bucketOptions = dirContext?.options || {};
    const baseTarget = dirContext?.target || '';
    const folderName = String(subfolder || 'flattened').trim() || 'flattened';
    const baseDir = [baseTarget, folderName].filter(Boolean).join('/');
    const FP = foundry.applications.apps.FilePicker.implementation;

    // Ensure nested directory structure exists
    await this._ensureNestedDir(baseDir, { source, options: bucketOptions });

    return {
      FP,
      source,
      bucketOptions,
      baseTarget,
      baseDir,
      assetsSetting
    };
  }

  async _resolveExportUploadContext() {
    return this._resolveFlattenUploadContext('exports');
  }

  async _saveAsWebP(canvasEl, quality, options = {}) {
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

    const baseName = options.baseName || this._buildFlattenFilenameBase();
    let filename = options.filename || `${baseName}.webp`;
    if (!String(filename).toLowerCase().endsWith('.webp')) {
      filename = `${filename}.webp`;
    }
    const file = new File([blob], filename, { type: 'image/webp' });

    const uploadContext = options.uploadContext || await this._resolveFlattenUploadContext();
    const source = uploadContext?.source || 'data';
    const bucketOptions = uploadContext?.bucketOptions || {};
    const baseTarget = uploadContext?.baseTarget || '';
    const baseDir = uploadContext?.baseDir || '';
    const assetsSetting = uploadContext?.assetsSetting || this._getAssetsDir();
    const FP = uploadContext?.FP || foundry.applications.apps.FilePicker.implementation;

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
  _buildMetadata(data, options = {}) {
    const {
      tiles,
      logicalBounds,
      renderBounds,
      paddingInsets,
      pixelWidth,
      pixelHeight,
      ppi,
      quality,
      paddingSnap,
      paddingExtra,
      resolution,
      filePath,
      chunks,
      chunking,
      chunkSize
    } = data || {};
    const sceneId = canvas?.scene?.id || null;
    const tileData = [];

    const list = Array.isArray(tiles) ? tiles : [];
    for (let i = 0; i < list.length; i += 1) {
      const doc = list[i];
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

    const normalizedInsets = this._normalizePaddingInsets(paddingInsets)
      || this._computeBoundsInsets(logicalBounds || renderBounds, renderBounds);
    const fallbackPadding = normalizedInsets?.max ?? 0;
    const normalizedChunks = Array.isArray(chunks)
      ? chunks.map((chunk) => ({
        src: String(chunk?.src || ''),
        x: Number(chunk?.x) || 0,
        y: Number(chunk?.y) || 0,
        width: Number(chunk?.width) || 0,
        height: Number(chunk?.height) || 0,
        pixelWidth: Number.isFinite(Number(chunk?.pixelWidth)) ? Number(chunk?.pixelWidth) : null,
        pixelHeight: Number.isFinite(Number(chunk?.pixelHeight)) ? Number(chunk?.pixelHeight) : null
      })).filter((chunk) => chunk.src && chunk.width > 0 && chunk.height > 0)
      : null;
    const normalizedChunking = chunking && typeof chunking === 'object'
      ? {
        widthSquares: Number.isFinite(Number(chunking.widthSquares)) ? Number(chunking.widthSquares) : null,
        heightSquares: Number.isFinite(Number(chunking.heightSquares)) ? Number(chunking.heightSquares) : null,
        padToChunks: !!chunking.padToChunks,
        pixelWidth: Number.isFinite(Number(chunking.pixelWidth)) ? Number(chunking.pixelWidth) : null,
        pixelHeight: Number.isFinite(Number(chunking.pixelHeight)) ? Number(chunking.pixelHeight) : null,
        worldWidth: Number.isFinite(Number(chunking.worldWidth)) ? Number(chunking.worldWidth) : null,
        worldHeight: Number.isFinite(Number(chunking.worldHeight)) ? Number(chunking.worldHeight) : null
      }
      : null;
    const hasChunkingData = normalizedChunking
      ? [
        normalizedChunking.widthSquares,
        normalizedChunking.heightSquares,
        normalizedChunking.pixelWidth,
        normalizedChunking.pixelHeight,
        normalizedChunking.worldWidth,
        normalizedChunking.worldHeight
      ].some((value) => Number.isFinite(value) && value > 0)
      : false;
    const normalizedChunkSize = Number(chunkSize);

    return {
      version: 1,
      flattenedAt: Date.now(),
      originalTileCount: tileData.length,
      tiles: tileData,
      logicalBounds: logicalBounds || renderBounds,
      renderBounds,
      originalPosition: renderBounds ? { x: renderBounds.x, y: renderBounds.y } : null,
      padding: fallbackPadding,
      paddingInsets: normalizedInsets,
      pixelWidth: Number(pixelWidth) || null,
      pixelHeight: Number(pixelHeight) || null,
      ppi,
      quality,
      paddingSnap: this._normalizePaddingSnap(paddingSnap),
      paddingExtra: Number.isFinite(Number(paddingExtra)) ? Number(paddingExtra) : 0,
      resolution,
      filePath,
      chunked: !!(normalizedChunks && normalizedChunks.length),
      chunks: normalizedChunks,
      chunking: hasChunkingData ? normalizedChunking : null,
      chunkSize: Number.isFinite(normalizedChunkSize) && normalizedChunkSize > 0 ? normalizedChunkSize : null,
      sceneId,
      gridSize: Number(canvas?.scene?.grid?.size || 0) || null
    };
  }

  /**
   * Create flattened tile
   */
  async _createFlattenedTile(bounds, filePath, metadata) {
    if (!canvas?.scene) throw new Error('Scene not available');

    const isChunked = Array.isArray(metadata?.chunks) && metadata.chunks.length > 0;
    const rawPath = typeof filePath === 'string' ? filePath : '';
    // Ensure path doesn't have leading slash for Foundry compatibility
    const cleanPath = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
    const textureSrc = cleanPath || (isChunked ? getTransparentTextureSrc() : '');

    const baseMeta = metadata?.tiles?.[0]?.data || {};
    const occlusionMeta = baseMeta?.occlusion || {};
    const sortValues = Array.isArray(metadata?.tiles)
      ? metadata.tiles.map((t) => Number(t?.data?.sort ?? 0)).filter((v) => Number.isFinite(v))
      : [];
    const maxSort = sortValues.length ? Math.max(...sortValues) : 0;

    const tileData = {
      texture: { src: encodeTexturePath(textureSrc) },
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

  _normalizePaddingInsets(padding) {
    if (!padding || typeof padding !== 'object') return null;
    const left = Math.max(0, Number(padding.left) || 0);
    const right = Math.max(0, Number(padding.right) || 0);
    const top = Math.max(0, Number(padding.top) || 0);
    const bottom = Math.max(0, Number(padding.bottom) || 0);
    const max = Math.max(left, right, top, bottom);
    return { left, right, top, bottom, max };
  }

  _computeBoundsInsets(baseBounds, expandedBounds) {
    if (!baseBounds || !expandedBounds) return null;
    const left = Math.max(0, Number(baseBounds.x) - Number(expandedBounds.x));
    const top = Math.max(0, Number(baseBounds.y) - Number(expandedBounds.y));
    const right = Math.max(
      0,
      (Number(expandedBounds.x) + Number(expandedBounds.width)) -
        (Number(baseBounds.x) + Number(baseBounds.width))
    );
    const bottom = Math.max(
      0,
      (Number(expandedBounds.y) + Number(expandedBounds.height)) -
        (Number(baseBounds.y) + Number(baseBounds.height))
    );
    if (![left, right, top, bottom].every(Number.isFinite)) return null;
    return this._normalizePaddingInsets({ left, right, top, bottom });
  }

  _computeCapturePadding(gridSize) {
    const size = Math.max(1, Number(gridSize) || 100);
    return Math.max(16, Math.round(size));
  }

  _trimCanvasToContent(canvasEl, alphaThreshold = 0) {
    try {
      if (!canvasEl) return null;
      const width = Number(canvasEl.width || 0);
      const height = Number(canvasEl.height || 0);
      if (!width || !height) return null;
      const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      const data = ctx.getImageData(0, 0, width, height)?.data;
      if (!data) return null;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      const threshold = Math.max(0, Number(alphaThreshold) || 0);
      for (let y = 0; y < height; y += 1) {
        const row = y * width * 4;
        for (let x = 0; x < width; x += 1) {
          const alpha = data[row + (x * 4) + 3];
          if (alpha > threshold) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < minX || maxY < minY) return null;
      return {
        x: minX,
        y: minY,
        width: (maxX - minX) + 1,
        height: (maxY - minY) + 1,
        touchesEdge: minX <= 0 || minY <= 0 || maxX >= (width - 1) || maxY >= (height - 1)
      };
    } catch (_) {
      return null;
    }
  }

  _cropCanvas(canvasEl, trim) {
    try {
      if (!canvasEl || !trim) return canvasEl;
      const width = Math.max(1, Math.round(Number(trim.width || 0)));
      const height = Math.max(1, Math.round(Number(trim.height || 0)));
      const output = document.createElement('canvas');
      output.width = width;
      output.height = height;
      const ctx = output.getContext('2d');
      if (ctx) {
        ctx.drawImage(canvasEl, -Number(trim.x || 0), -Number(trim.y || 0));
      }
      return output;
    } catch (_) {
      return canvasEl;
    }
  }

  _adjustCanvasToBounds(canvasEl, currentBounds, targetBounds, resolution) {
    try {
      if (!canvasEl || !currentBounds || !targetBounds) return { canvas: canvasEl };
      const targetWidth = Math.max(1, Math.round(Number(targetBounds.width || 0) * resolution));
      const targetHeight = Math.max(1, Math.round(Number(targetBounds.height || 0) * resolution));
      const offsetX = Math.round((Number(currentBounds.x || 0) - Number(targetBounds.x || 0)) * resolution);
      const offsetY = Math.round((Number(currentBounds.y || 0) - Number(targetBounds.y || 0)) * resolution);
      if (canvasEl.width === targetWidth && canvasEl.height === targetHeight && offsetX === 0 && offsetY === 0) {
        return { canvas: canvasEl };
      }
      const output = document.createElement('canvas');
      output.width = targetWidth;
      output.height = targetHeight;
      const ctx = output.getContext('2d');
      if (ctx) {
        ctx.drawImage(canvasEl, offsetX, offsetY);
      }
      return { canvas: output };
    } catch (_) {
      return { canvas: canvasEl };
    }
  }

  _normalizePaddingExtra(value, gridSize) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric === 0) return 0;
    const size = Math.max(1, Number(gridSize) || 100);
    return numeric * size;
  }

  _normalizeChunkSquares(width, height) {
    const rawWidth = Number(width);
    const rawHeight = Number(height);
    let widthSquares = Number.isFinite(rawWidth) && rawWidth >= 1 ? rawWidth : 0;
    let heightSquares = Number.isFinite(rawHeight) && rawHeight >= 1 ? rawHeight : 0;
    if (widthSquares && !heightSquares) heightSquares = widthSquares;
    if (heightSquares && !widthSquares) widthSquares = heightSquares;
    return {
      widthSquares,
      heightSquares,
      enabled: widthSquares > 0 && heightSquares > 0
    };
  }

  _normalizeChunkSize(value, maxTextureSize = null) {
    const numeric = Math.round(Number(value));
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    let size = Math.max(256, numeric);
    const max = Number(maxTextureSize);
    if (Number.isFinite(max) && max > 0) {
      size = Math.min(size, Math.floor(max));
    }
    return size;
  }

  _resolveChunkLayout(options, gridSize, resolution, maxTextureSize) {
    const chunkSquares = this._normalizeChunkSquares(options?.chunkWidth, options?.chunkHeight);
    const safeResolution = Number.isFinite(resolution) && resolution > 0 ? resolution : 1;
    if (chunkSquares.enabled) {
      const chunkWorldWidth = chunkSquares.widthSquares * gridSize;
      const chunkWorldHeight = chunkSquares.heightSquares * gridSize;
      const roundPixel = options?.chunkAuto ? Math.ceil : Math.round;
      const chunkPixelWidth = Math.max(1, roundPixel(chunkWorldWidth * safeResolution));
      const chunkPixelHeight = Math.max(1, roundPixel(chunkWorldHeight * safeResolution));
      const maxSize = Number(maxTextureSize);
      if (Number.isFinite(maxSize) && maxSize > 0) {
        if (chunkPixelWidth > maxSize || chunkPixelHeight > maxSize) {
          throw new Error(`Chunk size exceeds renderer texture cap (${chunkPixelWidth}x${chunkPixelHeight}px > ${maxSize}). Try lowering PPI or chunk size.`);
        }
      }
      return {
        enabled: true,
        widthSquares: chunkSquares.widthSquares,
        heightSquares: chunkSquares.heightSquares,
        worldWidth: chunkWorldWidth,
        worldHeight: chunkWorldHeight,
        pixelWidth: chunkPixelWidth,
        pixelHeight: chunkPixelHeight,
        padToChunks: !!options?.chunkPad
      };
    }

    const chunkPixelSize = this._normalizeChunkSize(options?.chunkSize, maxTextureSize);
    if (!chunkPixelSize) {
      return { enabled: false };
    }
    const worldSize = chunkPixelSize / safeResolution;
    return {
      enabled: true,
      widthSquares: null,
      heightSquares: null,
      worldWidth: worldSize,
      worldHeight: worldSize,
      pixelWidth: chunkPixelSize,
      pixelHeight: chunkPixelSize,
      pixelSize: chunkPixelSize,
      padToChunks: false
    };
  }

  _isDropShadowEnabled() {
    try { return !!game?.settings?.get?.('fa-nexus', 'assetDropShadow'); }
    catch (_) { return true; }
  }

  _normalizePaddingSnap(value) {
    const snap = String(value || 'none').toLowerCase();
    if (snap === 'half' || snap === 'full') return snap;
    return 'none';
  }
}
