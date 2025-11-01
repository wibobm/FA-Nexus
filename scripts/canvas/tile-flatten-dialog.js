import { NexusLogger as Logger } from '../core/nexus-logger.js';

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
    
    super({ position: { left, top, width: 400, height: 'auto' } });
    
    this.tiles = options.tiles || [];
    this._resolved = false;
    this._resolveCallback = null;
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
    const defaultPPI = 200;
    const defaultQuality = 0.85;
    const estimated = this._estimateDimensions(defaultPPI);

    return {
      tileCount,
      defaultPPI,
      defaultQuality,
      estimatedWidth: estimated?.width || null,
      estimatedHeight: estimated?.height || null,
      pluralSuffix: tileCount !== 1
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
    if (ppiInput) ppiInput.value = context.defaultPPI;
    if (qualityInput) qualityInput.value = context.defaultQuality;

    // Event handlers
    this.element.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.getAttribute('data-action');
      
      if (action === 'flatten') {
        event.preventDefault();
        const ppi = parseFloat(ppiInput?.value) || 200;
        const quality = parseFloat(qualityInput?.value) || 0.85;
        
        // Validate
        if (ppi < 50 || ppi > 1000) {
          ui?.notifications?.warn?.('PPI must be between 50 and 1000');
          return;
        }
        if (quality < 0 || quality > 1) {
          ui?.notifications?.warn?.('Quality must be between 0 and 1');
          return;
        }

        this._resolve({ ppi, quality, cancelled: false });
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
    super._onClose();
  }

  _estimateDimensions(ppi) {
    try {
      const bounds = this._computeBounds(this.tiles);
      if (!bounds) return null;
      const gridSize = Math.max(1, Number(canvas?.scene?.grid?.size || 100));
      const resolution = Math.max(0.1, Math.min(8, (Number(ppi) || 200) / gridSize));
      return {
        width: Math.max(1, Math.round(bounds.width * resolution)),
        height: Math.max(1, Math.round(bounds.height * resolution))
      };
    } catch (_) {
      return null;
    }
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
}
