import {
  applyMaskedTilingToTile,
  rehydrateAllMaskedTiles,
  cancelGlobalRehydrate,
  clearMaskedOverlaysOnDelete
} from './texture-render.js';

export { rehydrateAllMaskedTiles };

const EDITING_TILE_SET_KEY = '__faNexusTextureEditingTileIds';

function isEditingTile(tile) {
  try {
    const id = tile?.document?.id || tile?.id;
    if (!id) return false;
    const set = globalThis?.[EDITING_TILE_SET_KEY];
    return set instanceof Set && set.has(id);
  } catch (_) {
    return false;
  }
}

function scheduleMaskRefresh(tile) {
  try {
    if (!tile) return;
    const run = () => {
      try { applyMaskedTilingToTile(tile); } catch (_) {}
    };
    run();
    if (!isEditingTile(tile)) return;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  } catch (_) {}
}

function ensureMaskedRefreshPatch() {
  try {
    const Tile = globalThis?.foundry?.canvas?.placeables?.Tile
      || canvas?.tiles?.constructor?.placeableClass
      || globalThis?.CONFIG?.Tile?.objectClass;
    if (!Tile?.prototype?._refreshState) return;
    if (Tile.prototype._faNexusMaskedTilingRefreshPatched) return;
    Tile.prototype._faNexusMaskedTilingRefreshPatched = true;
    const original = Tile.prototype._refreshState;
    Tile.prototype._faNexusMaskedTilingRefreshOriginal = original;
    Tile.prototype._refreshState = function (...args) {
      const result = original.apply(this, args);
      try {
        const tile = this;
        const hasMask = !!tile?.document?.getFlag?.('fa-nexus', 'maskedTiling');
        if (hasMask || isEditingTile(tile)) scheduleMaskRefresh(tile);
      } catch (_) {}
      return result;
    };
  } catch (_) {}
}

try {
  ensureMaskedRefreshPatch();
  Hooks.on('canvasReady', () => {
    ensureMaskedRefreshPatch();
    try { rehydrateAllMaskedTiles({ attempts: 6, interval: 250 }); } catch (_) {}
  });
  Hooks.on('drawTile', (tile) => {
    scheduleMaskRefresh(tile);
  });
  Hooks.on('refreshTile', (tile) => {
    scheduleMaskRefresh(tile);
  });
  Hooks.on('hoverTile', (tile) => {
    scheduleMaskRefresh(tile);
  });
  Hooks.on('controlTile', (tile) => {
    scheduleMaskRefresh(tile);
  });
  Hooks.on('updateTile', async (doc, change) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) {
        scheduleMaskRefresh(tile);
        rehydrateAllMaskedTiles({ attempts: 2, interval: 200 });
      }
    } catch (_) {}
  });
  Hooks.on('deleteTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) clearMaskedOverlaysOnDelete(tile);;
    } catch (_) {}
  });
  Hooks.on('canvasTearDown', () => {
    try { cancelGlobalRehydrate(); } catch (_) {}
  });
} catch (_) {}
