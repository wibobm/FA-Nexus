import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { TileFlattenCanvasPreview } from './tile-flatten-canvas-preview.js';
import { resolveAutoChunking } from './tile-flatten-chunking.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Dialog for configuring tile flattening options
 */
export class TileFlattenDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    const cursorX = options.cursorX || window.innerWidth / 2;
    const cursorY = options.cursorY || window.innerHeight / 2;
    const left = Math.max(cursorX - 200, 20);
    const top = Math.max(cursorY - 150, 20);
    const mode = options.mode === 'export' ? 'export' : 'flatten';
    
    super({ position: { left, top, width: 400, height: 'auto' } });
    
    this._mode = mode;
    this._baseBounds = this._normalizeBaseBounds(options.baseBounds);
    this._exportDefaults = { action: 'flatten', splitLayers: false, chunked: false };
    this.tiles = options.tiles || [];
    this._previewBoundsResolver = typeof options.previewBoundsResolver === 'function'
      ? options.previewBoundsResolver
      : null;
    this._previewBounds = null;
    this._previewBoundsPending = null;
    this._previewBoundsPendingKey = null;
    this._previewBoundsRequestId = 0;
    this._previewBoundsTimer = null;
    this._inputRefs = null;
    this._resolved = false;
    this._resolveCallback = null;
    this._canvasPreview = null;

    if (this._mode === 'export') {
      try { this.options.window.title = 'Export / Flatten Scene'; } catch (_) {}
    }
  }

  static DEFAULT_OPTIONS = {
    id: 'fa-nexus-tile-flatten-dialog',
    tag: 'form',
    window: {
      frame: true,
      positioned: true,
      resizable: false,
      title: 'Flatten Tiles'
    },
    position: {
      width: 400,
      height: 'auto'
    }
  };

  static PARTS = {
    form: {
      template: 'modules/fa-nexus/templates/canvas/tile-flatten-dialog.hbs'
    }
  };

  async _prepareContext() {
    const tileCount = Array.isArray(this.tiles) ? this.tiles.length : 0;
    const stored = this._readPersistedOptions();
    const defaultPPI = Number.isFinite(Number(stored.ppi)) ? Number(stored.ppi) : 200;
    const defaultQuality = Number.isFinite(Number(stored.quality)) ? Number(stored.quality) : 0.85;
    const defaultPaddingSnap = this._normalizePaddingSnap(stored.paddingSnap);
    const defaultPaddingExtra = Number.isFinite(Number(stored.paddingExtra)) ? Number(stored.paddingExtra) : 0;
    const defaultExportSplitLayers = !!stored.exportSplitLayers;
    const defaultExportChunked = !!stored.exportChunked;
    const storedExportAction = stored.exportAction;
    const defaultExportAction = storedExportAction === 'export' ? 'export' : 'flatten';
    const exportActionStrings = this._getExportActionStrings(defaultExportAction);
    this._exportDefaults = {
      action: defaultExportAction,
      splitLayers: defaultExportSplitLayers,
      chunked: defaultExportChunked
    };
    const estimated = this._estimateRenderBounds(defaultPPI, defaultPaddingSnap, defaultPaddingExtra);
    const isExport = this._mode === 'export';
    const pluralSuffix = tileCount !== 1;
    const dialogTitle = isExport
      ? 'Export / Flatten Scene'
      : `Flatten ${tileCount} tile${pluralSuffix ? 's' : ''}`;
    const dialogDescription = isExport
      ? exportActionStrings.description
      : 'Flatten the selected tiles into a WebP image while preserving FA Nexus metadata for future restoration.';
    const submitLabel = isExport ? exportActionStrings.submitLabel : 'Flatten Tiles';
    const submitIcon = isExport ? exportActionStrings.submitIcon : 'fa-compress-arrows-alt';
    const exportChunkHint = defaultExportChunked
      ? 'Auto-chunks large output.'
      : 'Creates a single image by default.';
    const exportActionIsExport = defaultExportAction === 'export';
    const exportActionIsFlatten = !exportActionIsExport;

    return {
      tileCount,
      isExport,
      dialogTitle,
      dialogDescription,
      submitLabel,
      submitIcon,
      defaultPPI,
      defaultQuality,
      defaultPaddingSnap,
      defaultPaddingExtra,
      defaultExportSplitLayers,
      defaultExportChunked,
      defaultExportAction,
      exportActionIsExport,
      exportActionIsFlatten,
      exportActionHint: exportActionStrings.actionHint,
      exportSplitHint: exportActionStrings.splitHint,
      exportChunkHint,
      snapNone: defaultPaddingSnap === 'none',
      snapHalf: defaultPaddingSnap === 'half',
      snapFull: defaultPaddingSnap === 'full',
      estimatedWidth: estimated?.pixelWidth || null,
      estimatedHeight: estimated?.pixelHeight || null,
      pluralSuffix
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);

    // Apply theme
    try {
      const body = document.body;
      const isDark = body.classList.contains('theme-dark');
      this.element.classList.toggle('fa-theme-dark', isDark);
      this.element.classList.toggle('fa-theme-light', !isDark);
    } catch (e) {}

    // Set default values
    const ppiInput = this.element.querySelector('#flatten-ppi');
    const qualityInput = this.element.querySelector('#flatten-quality');
    const paddingSnapInput = this.element.querySelector('#flatten-padding-snap');
    const paddingExtraInput = this.element.querySelector('#flatten-padding-extra');
    const exportActionInputs = Array.from(this.element.querySelectorAll('input[name="flatten-export-action"]'));
    const exportSplitInput = this.element.querySelector('#flatten-export-split');
    const exportChunkInput = this.element.querySelector('#flatten-export-chunk');
    this._inputRefs = {
      ppiInput,
      qualityInput,
      paddingSnapInput,
      paddingExtraInput,
      exportActionInputs,
      exportSplitInput,
      exportChunkInput
    };
    if (ppiInput) ppiInput.value = context.defaultPPI;
    if (qualityInput) qualityInput.value = context.defaultQuality;
    if (paddingSnapInput) paddingSnapInput.value = context.defaultPaddingSnap || 'none';
    if (paddingExtraInput) paddingExtraInput.value = context.defaultPaddingExtra ?? 0;
    if (exportActionInputs.length) {
      const desiredAction = context.defaultExportAction || 'flatten';
      let matched = false;
      for (const input of exportActionInputs) {
        if (input?.value === desiredAction) {
          input.checked = true;
          matched = true;
          break;
        }
      }
      if (!matched) {
        exportActionInputs[0].checked = true;
      }
    }
    if (exportSplitInput) exportSplitInput.checked = !!context.defaultExportSplitLayers;
    if (exportChunkInput) exportChunkInput.checked = !!context.defaultExportChunked;
    this._updateExportActionUI(exportActionInputs);
    this._updateExportChunkHint(exportChunkInput, context.exportChunkHint);
    this._updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput);

    // Event handlers
    this.element.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-action]')?.getAttribute('data-action');
      
      if (action === 'flatten') {
        event.preventDefault();
        const ppi = parseFloat(ppiInput?.value) || 200;
        const quality = parseFloat(qualityInput?.value) || 0.85;
        const paddingSnap = this._normalizePaddingSnap(paddingSnapInput?.value);
        const rawPaddingExtra = parseFloat(paddingExtraInput?.value);
        const paddingExtra = Number.isFinite(rawPaddingExtra) ? rawPaddingExtra : 0;
        const exportAction = this._readExportAction(exportActionInputs);
        const exportSplitLayers = exportSplitInput
          ? !!exportSplitInput.checked
          : !!this._exportDefaults?.splitLayers;
        const exportChunked = exportChunkInput
          ? !!exportChunkInput.checked
          : !!this._exportDefaults?.chunked;
        
        // Validate
        if (ppi < 50 || ppi > 1000) {
          ui?.notifications?.warn?.('PPI must be between 50 and 1000');
          return;
        }
        if (quality < 0 || quality > 1) {
          ui?.notifications?.warn?.('Quality must be between 0 and 1');
          return;
        }
        try {
          await this._ensurePreviewBounds(ppi);
        } catch (_) {}
        const previewBounds = this._previewBounds?.ppi === ppi ? this._previewBounds.bounds : null;
        const previewPpi = this._previewBounds?.ppi ?? null;

        this._persistOptions({
          ppi,
          quality,
          paddingSnap,
          paddingExtra,
          exportAction,
          exportSplitLayers,
          exportChunked
        });
        this._resolve({
          ppi,
          quality,
          paddingSnap,
          paddingExtra,
          exportSplitLayers,
          exportChunked,
          exportAction,
          mode: this._mode,
          previewBounds,
          previewPpi,
          cancelled: false
        });
        this.close();
      } else if (action === 'cancel') {
        event.preventDefault();
        this._resolve({ cancelled: true });
        this.close();
      }
    });

    // Prevent form submission
    this.element.addEventListener('submit', (event) => {
      event.preventDefault();
    });

    if (ppiInput) {
      ppiInput.addEventListener('input', () => this._updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput));
      ppiInput.addEventListener('change', () => this._updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput));
    }
    if (paddingSnapInput) {
      paddingSnapInput.addEventListener('change', () => this._updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput));
    }
    if (paddingExtraInput) {
      paddingExtraInput.addEventListener('input', () => this._updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput));
      paddingExtraInput.addEventListener('change', () => this._updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput));
    }
    if (exportActionInputs.length) {
      for (const input of exportActionInputs) {
        input.addEventListener('change', () => {
          this._updateExportActionUI(exportActionInputs);
        });
      }
    }
    if (exportChunkInput) {
      exportChunkInput.addEventListener('change', () => {
        this._updateExportChunkHint(exportChunkInput);
        this._updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput);
      });
    }
  }

  _resolve(result) {
    if (this._resolved) return;
    this._resolved = true;
    if (this._resolveCallback) {
      this._resolveCallback(result);
    }
  }

  async render(force = false) {
    return new Promise((resolve) => {
      this._resolveCallback = resolve;
      super.render(force);
    });
  }

  _onClose() {
    if (!this._resolved) {
      this._resolve({ cancelled: true });
    }
    this._previewBoundsRequestId += 1;
    if (this._previewBoundsTimer) {
      clearTimeout(this._previewBoundsTimer);
      this._previewBoundsTimer = null;
    }
    this._previewBoundsPending = null;
    this._previewBoundsPendingKey = null;
    this._inputRefs = null;
    this._destroyCanvasPreview();
    super._onClose();
  }

  _estimateRenderBounds(ppi, paddingSnap = 'none', paddingExtra = 0) {
    try {
      const base = this._resolveBaseBounds(ppi);
      const bounds = base?.bounds;
      if (!bounds) return null;
      const gridSize = Math.max(1, Number(base.gridSize || canvas?.scene?.grid?.size || 100));
      const resolution = this._computeResolution(ppi, gridSize);
      const extraPadding = this._normalizePaddingExtra(paddingExtra, gridSize);
      const expanded = this._applyExtraPadding(bounds, extraPadding);
      const snapped = this._snapBounds(expanded, gridSize, paddingSnap);
      return {
        bounds,
        expanded,
        snapped,
        gridSize,
        resolution,
        pixelWidth: Math.max(1, Math.round(snapped.width * resolution)),
        pixelHeight: Math.max(1, Math.round(snapped.height * resolution))
      };
    } catch (_) {
      return null;
    }
  }

  _resolveBaseBounds(ppi) {
    const numericPpi = Number(ppi);
    if (Number.isFinite(numericPpi) && this._previewBounds?.bounds && this._previewBounds.ppi === numericPpi) {
      return {
        bounds: this._previewBounds.bounds,
        gridSize: this._previewBounds.gridSize
      };
    }
    if (this._baseBounds?.bounds) {
      return {
        bounds: this._baseBounds.bounds,
        gridSize: this._baseBounds.gridSize
      };
    }
    const bounds = this._computeShadowedBounds(this.tiles);
    if (!bounds) return null;
    return { bounds };
  }

  _computeBounds(tiles) {
    if (!Array.isArray(tiles) || !tiles.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const doc of tiles) {
      const x = Number(doc?.x) || 0;
      const y = Number(doc?.y) || 0;
      const width = Number(doc?.width) || 0;
      const height = Number(doc?.height) || 0;
      const rotation = Number(doc?.rotation) || 0;

      if (rotation !== 0) {
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
      } else {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + width > maxX) maxX = x + width;
        if (y + height > maxY) maxY = y + height;
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

  _updatePreview(ppiInput, paddingSnapInput, paddingExtraInput, exportChunkInput = null) {
    try {
      const ppi = parseFloat(ppiInput?.value) || 200;
      const paddingSnap = this._normalizePaddingSnap(paddingSnapInput?.value);
      const rawPaddingExtra = parseFloat(paddingExtraInput?.value);
      const paddingExtra = Number.isFinite(rawPaddingExtra) ? rawPaddingExtra : 0;
      this._schedulePreviewBounds(ppi);
      const paddingValueEl = this.element?.querySelector?.('[data-padding-extra-value]');
      if (paddingValueEl) {
        paddingValueEl.textContent = paddingExtra.toFixed(1);
      }
      const estimate = this._estimateRenderBounds(ppi, paddingSnap, paddingExtra);
      const debugEnabled = Logger?._isEnabled?.() === true;
      const chunkingAllowed = this._mode !== 'export' || !!exportChunkInput?.checked;
      let chunkMeta = null;
      if (debugEnabled && chunkingAllowed && estimate?.pixelWidth && estimate?.pixelHeight && estimate?.resolution) {
        const chunkPlan = resolveAutoChunking(estimate.pixelWidth, estimate.pixelHeight);
        if (chunkPlan?.enabled) {
          const chunkPixelWidth = Math.ceil(chunkPlan.chunkPixelWidth);
          const chunkPixelHeight = Math.ceil(chunkPlan.chunkPixelHeight);
          const chunkWorldWidth = chunkPixelWidth / estimate.resolution;
          const chunkWorldHeight = chunkPixelHeight / estimate.resolution;
          if (Number.isFinite(chunkWorldWidth) && Number.isFinite(chunkWorldHeight)
            && chunkWorldWidth > 0 && chunkWorldHeight > 0) {
            chunkMeta = {
              width: chunkWorldWidth,
              height: chunkWorldHeight,
              columns: chunkPlan.columns,
              rows: chunkPlan.rows
            };
          }
        }
      }
      const estimateEl = this.element?.querySelector?.('[data-flatten-estimate]');
      if (estimateEl) {
        if (estimate?.pixelWidth && estimate?.pixelHeight) {
          estimateEl.hidden = false;
          const textEl = estimateEl.querySelector('[data-flatten-estimate-text]') || estimateEl;
          if (debugEnabled && chunkMeta?.columns && chunkMeta?.rows) {
            textEl.textContent = `~${estimate.pixelWidth} x ${estimate.pixelHeight} px (${chunkMeta.columns} x ${chunkMeta.rows} chunks)`;
          } else {
            textEl.textContent = `~${estimate.pixelWidth} x ${estimate.pixelHeight} px`;
          }
        } else {
          estimateEl.hidden = true;
        }
      }

      const previewRoot = this.element?.querySelector?.('[data-flatten-preview]');
      if (!previewRoot) {
        this._updateCanvasPreview(estimate, chunkMeta, debugEnabled);
        return;
      }
      if (!estimate?.snapped || !estimate?.expanded) {
        previewRoot.hidden = true;
        this._updateCanvasPreview(null, null, debugEnabled);
        return;
      }

      const snapped = estimate.snapped;
      const expanded = estimate.expanded;
      const gridSize = Math.max(1, Number(estimate.gridSize || 0));

      const box = previewRoot.querySelector('.fa-nexus-flatten-preview__box');
      const snappedEl = previewRoot.querySelector('.fa-nexus-flatten-preview__snapped');
      const expandedEl = previewRoot.querySelector('.fa-nexus-flatten-preview__expanded');
      if (!box || !snappedEl || !expandedEl) {
        previewRoot.hidden = true;
        return;
      }

      previewRoot.hidden = false;
      const maxSize = 160;
      const scale = maxSize / Math.max(1, snapped.width, snapped.height);
      const width = Math.max(60, Math.round(snapped.width * scale));
      const height = Math.max(60, Math.round(snapped.height * scale));
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;

      snappedEl.style.width = `${width}px`;
      snappedEl.style.height = `${height}px`;
      snappedEl.style.left = '0px';
      snappedEl.style.top = '0px';

      const offsetX = Math.round((expanded.x - snapped.x) * scale);
      const offsetY = Math.round((expanded.y - snapped.y) * scale);
      expandedEl.style.width = `${Math.max(1, Math.round(expanded.width * scale))}px`;
      expandedEl.style.height = `${Math.max(1, Math.round(expanded.height * scale))}px`;
      expandedEl.style.left = `${offsetX}px`;
      expandedEl.style.top = `${offsetY}px`;

      const boundsLabel = previewRoot.querySelector('[data-flatten-preview-expanded]');
      const snappedLabel = previewRoot.querySelector('[data-flatten-preview-snapped]');
      if (boundsLabel && gridSize) {
        const w = expanded.width / gridSize;
        const h = expanded.height / gridSize;
        boundsLabel.textContent = `Current: ${w.toFixed(2)} x ${h.toFixed(2)} squares`;
      }
      if (snappedLabel && gridSize) {
        const w = snapped.width / gridSize;
        const h = snapped.height / gridSize;
        snappedLabel.textContent = `Snapped: ${w.toFixed(2)} x ${h.toFixed(2)} squares`;
      }
      this._updateCanvasPreview(estimate, chunkMeta, debugEnabled);
    } catch (_) {}
  }

  _updatePreviewFromInputs() {
    const refs = this._inputRefs;
    if (!refs) return;
    this._updatePreview(
      refs.ppiInput,
      refs.paddingSnapInput,
      refs.paddingExtraInput,
      refs.exportChunkInput
    );
  }

  _schedulePreviewBounds(ppi) {
    if (!this._previewBoundsResolver) return;
    const numericPpi = Number(ppi) || 200;
    if (this._previewBounds?.ppi === numericPpi) return;
    if (this._previewBoundsPendingKey === numericPpi) return;
    if (this._previewBoundsTimer) {
      clearTimeout(this._previewBoundsTimer);
    }
    this._previewBoundsTimer = setTimeout(() => {
      this._previewBoundsTimer = null;
      this._ensurePreviewBounds(numericPpi);
    }, 150);
  }

  async _ensurePreviewBounds(ppi) {
    if (!this._previewBoundsResolver) return;
    const numericPpi = Number(ppi) || 200;
    if (this._previewBounds?.ppi === numericPpi) return;
    if (this._previewBoundsPending && this._previewBoundsPendingKey === numericPpi) return;
    const requestId = ++this._previewBoundsRequestId;
    this._previewBoundsPendingKey = numericPpi;
    const tiles = Array.isArray(this.tiles) ? this.tiles : [];
    try {
      this._previewBoundsPending = Promise.resolve(
        this._previewBoundsResolver({ tiles, ppi: numericPpi })
      );
      const result = await this._previewBoundsPending;
      if (this._previewBoundsRequestId !== requestId) return;
      this._previewBoundsPending = null;
      this._previewBoundsPendingKey = null;
      if (result?.bounds) {
        this._previewBounds = {
          bounds: result.bounds,
          gridSize: result.gridSize ?? null,
          ppi: numericPpi
        };
      } else {
        this._previewBounds = null;
      }
      this._updatePreviewFromInputs();
    } catch (error) {
      if (this._previewBoundsRequestId !== requestId) return;
      this._previewBoundsPending = null;
      this._previewBoundsPendingKey = null;
      Logger.debug?.('TileFlatten.previewBounds.failed', { error: String(error?.message || error) });
    }
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
      const x = Number(doc?.x) || 0;
      const y = Number(doc?.y) || 0;
      const width = Number(doc?.width) || 0;
      const height = Number(doc?.height) || 0;
      const rotation = Number(doc?.rotation) || 0;
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

  _normalizePaddingExtra(value, gridSize) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric === 0) return 0;
    const size = Math.max(1, Number(gridSize) || 100);
    return numeric * size;
  }

  _isDropShadowEnabled() {
    try { return !!game?.settings?.get?.('fa-nexus', 'assetDropShadow'); }
    catch (_) { return true; }
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

  _ensureCanvasPreview() {
    if (!this._canvasPreview) this._canvasPreview = new TileFlattenCanvasPreview();
    return this._canvasPreview;
  }

  _destroyCanvasPreview() {
    try { this._canvasPreview?.destroy?.(); } catch (_) {}
    this._canvasPreview = null;
  }

  _updateCanvasPreview(estimate, chunkMeta = null, debugEnabled = false) {
    if (!estimate?.snapped || !estimate?.expanded) {
      this._canvasPreview?.clear?.();
      return;
    }
    const preview = this._ensureCanvasPreview();
    preview.update({
      expanded: estimate.expanded,
      snapped: estimate.snapped,
      chunk: debugEnabled ? chunkMeta : null
    });
  }

  _getExportActionStrings(action) {
    const isExport = action === 'export';
    return {
      description: isExport
        ? 'Export the scene background/foreground images and tiles to a WebP image cropped to the scene borders.'
        : 'Flatten the scene tiles into WebP tile(s) cropped to the scene borders.',
      submitLabel: isExport ? 'Export Scene' : 'Flatten Scene',
      submitIcon: isExport ? 'fa-file-export' : 'fa-compress-arrows-alt',
      actionHint: isExport
        ? 'Exports a WebP image of the scene.'
        : 'Creates tiles without scene background/foreground images. Originals can be deconstructed.',
      splitHint: isExport
        ? 'Background image + tiles below, foreground image + tiles above.'
        : 'Tiles below foreground elevation in one tile, tiles at/above in another.'
    };
  }

  _readExportAction(exportActionInputs) {
    if (!Array.isArray(exportActionInputs) || exportActionInputs.length === 0) {
      return this._exportDefaults?.action === 'export' ? 'export' : 'flatten';
    }
    const selected = exportActionInputs.find((input) => input?.checked);
    return selected?.value === 'export' ? 'export' : 'flatten';
  }

  _updateExportActionUI(exportActionInputs) {
    if (this._mode !== 'export') return;
    const action = this._readExportAction(exportActionInputs);
    const strings = this._getExportActionStrings(action);
    const descriptionEl = this.element?.querySelector?.('[data-dialog-description]');
    if (descriptionEl && strings.description) {
      descriptionEl.textContent = strings.description;
    }
    const actionHintEl = this.element?.querySelector?.('[data-export-action-hint]');
    if (actionHintEl && strings.actionHint) {
      actionHintEl.textContent = strings.actionHint;
    }
    const splitHintEl = this.element?.querySelector?.('[data-export-split-hint]');
    if (splitHintEl && strings.splitHint) {
      splitHintEl.textContent = strings.splitHint;
    }
    const submitLabelEl = this.element?.querySelector?.('[data-submit-label]');
    if (submitLabelEl && strings.submitLabel) {
      submitLabelEl.textContent = strings.submitLabel;
    }
    const submitIconEl = this.element?.querySelector?.('[data-submit-icon]');
    if (submitIconEl && strings.submitIcon) {
      submitIconEl.classList.remove('fa-file-export', 'fa-compress-arrows-alt');
      submitIconEl.classList.add(strings.submitIcon);
    }
  }

  _updateExportChunkHint(exportChunkInput, fallbackText = null) {
    const hintEl = this.element?.querySelector?.('[data-export-chunk-hint]');
    if (!hintEl) return;
    const enabled = !!exportChunkInput?.checked;
    const text = enabled
      ? 'Auto-chunks large output.'
      : (fallbackText || 'Creates a single image by default.');
    hintEl.textContent = text;
  }

  _normalizeBaseBounds(value) {
    if (!value || typeof value !== 'object') return null;
    const base = value.bounds && typeof value.bounds === 'object' ? value.bounds : value;
    const x = Number(base.x);
    const y = Number(base.y);
    const width = Number(base.width);
    const height = Number(base.height);
    if (![x, y, width, height].every(Number.isFinite)) return null;
    if (width <= 0 || height <= 0) return null;
    const rawGrid = Number(value.gridSize ?? base.gridSize);
    const gridSize = Number.isFinite(rawGrid) && rawGrid > 0 ? rawGrid : null;
    return {
      bounds: { x, y, width, height },
      gridSize
    };
  }

  _readPersistedOptions() {
    try {
      const stored = game?.settings?.get?.('fa-nexus', 'flattenOptions');
      if (stored && typeof stored === 'object') return stored;
    } catch (_) {}
    return {};
  }

  _persistOptions(options) {
    try {
      game?.settings?.set?.('fa-nexus', 'flattenOptions', options);
    } catch (_) {}
  }

  _normalizePaddingSnap(value) {
    const snap = String(value || 'none').toLowerCase();
    if (snap === 'half' || snap === 'full') return snap;
    return 'none';
  }
}
