import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { getTileRenderElevation, isKeepTokensAboveTileElevationsEnabled } from '../canvas/elevation-band-utils.js';

const EPSILON = 1e-4;
const SCENE_BACKGROUND_RENDER_ELEVATION = -5;
const BG_SORT_NUDGE = -1e9;

function isEnabled() {
  return isKeepTokensAboveTileElevationsEnabled();
}

function applySceneBackgroundBand({ reason = 'refresh', force = false } = {}) {
  try {
    const enabled = isEnabled();
    const targets = [];
    try {
      if (canvas?.primary?.background) targets.push(canvas.primary.background);
    } catch (_) {}
    try {
      if (canvas?.background) targets.push(canvas.background);
    } catch (_) {}
    if (!targets.length) return;

    const applyTo = (obj) => {
      if (!obj) return;
      if (!('elevation' in obj)) return;

      if (!enabled) {
        restoreSceneBackgroundElevation({ reason: `disabled:${reason}` });
        return;
      }

      const baseElevation = Number(obj.faNexusBgBandBaseElevation ?? obj.elevation ?? 0) || 0;
      const target = SCENE_BACKGROUND_RENDER_ELEVATION;
      if (!force && obj.faNexusBgBandApplied && Math.abs(Number(obj.elevation ?? 0) - target) <= EPSILON) return;

      obj.faNexusBgBandApplied = true;
      obj.faNexusBgBandBaseElevation = baseElevation;
      obj.elevation = target;

      // Defensive: ensure background stays behind shifted tiles even if Foundry compares by elevation first.
      try {
        const bgLayerSort = canvas?.primary?.constructor?.SORT_LAYERS?.BACKGROUND;
        if (bgLayerSort != null && 'sortLayer' in obj) obj.sortLayer = bgLayerSort;
      } catch (_) {}
      try { if ('sort' in obj) obj.sort = Math.min(Number(obj.sort ?? 0) || 0, BG_SORT_NUDGE); } catch (_) {}
      try { if ('zIndex' in obj) obj.zIndex = Math.min(Number(obj.zIndex ?? 0) || 0, BG_SORT_NUDGE); } catch (_) {}
    };

    for (const t of targets) {
      applyTo(t);
      // Common Foundry shapes: layer.mesh / layer.sprite / layer.background
      try { applyTo(t.mesh); } catch (_) {}
      try { applyTo(t.sprite); } catch (_) {}
      try { applyTo(t.background); } catch (_) {}
      try { applyTo(t._background); } catch (_) {}
    }

    try { if (canvas?.primary) canvas.primary.sortDirty = true; } catch (_) {}
    Logger.debug('SceneBackgroundBand.apply', { target: SCENE_BACKGROUND_RENDER_ELEVATION, reason });
  } catch (error) {
    Logger.warn('SceneBackgroundBand.apply.failed', String(error?.message || error));
  }
}

function restoreSceneBackgroundElevation({ reason = 'restore' } = {}) {
  try {
    const targets = [];
    try {
      if (canvas?.primary?.background) targets.push(canvas.primary.background);
    } catch (_) {}
    try {
      if (canvas?.background) targets.push(canvas.background);
    } catch (_) {}
    if (!targets.length) return;

    const restore = (obj) => {
      if (!obj) return;
      if (!('elevation' in obj)) return;
      const baseElevation = Number(obj.faNexusBgBandBaseElevation ?? 0) || 0;
      if (obj.faNexusBgBandApplied && Math.abs(Number(obj.elevation ?? 0) - baseElevation) > EPSILON) {
        obj.elevation = baseElevation;
      }
      delete obj.faNexusBgBandApplied;
      delete obj.faNexusBgBandBaseElevation;
    };

    for (const t of targets) {
      restore(t);
      try { restore(t.mesh); } catch (_) {}
      try { restore(t.sprite); } catch (_) {}
      try { restore(t.background); } catch (_) {}
      try { restore(t._background); } catch (_) {}
    }

    try { if (canvas?.primary) canvas.primary.sortDirty = true; } catch (_) {}
    Logger.debug('SceneBackgroundBand.restore', { reason });
  } catch (error) {
    Logger.warn('SceneBackgroundBand.restore.failed', String(error?.message || error));
  }
}

function applyTileBackgroundBand(tile, { reason = 'refresh', force = false } = {}) {
  try {
    if (!tile || tile.destroyed) return;
    const mesh = tile.mesh;
    const doc = tile.document;
    if (!mesh || mesh.destroyed || !doc) return;

    if (!isEnabled()) {
      restoreTileElevation(tile, { reason: 'disabled' });
      return;
    }

    const baseElevation = Number(doc.elevation ?? 0) || 0;
    const renderElevation = getTileRenderElevation(baseElevation, { enabled: true });
    const needsShift = Math.abs(renderElevation - baseElevation) > EPSILON;
    if (!needsShift) {
      if (mesh.faNexusBgBandApplied) restoreTileElevation(tile, { reason: 'no-shift' });
      return;
    }
    if (!force && mesh.faNexusBgBandApplied && Math.abs((mesh.elevation ?? 0) - renderElevation) <= EPSILON) return;

    // Track original so we can restore on disable.
    mesh.faNexusBgBandApplied = true;
    mesh.faNexusBgBandBase = baseElevation;
    mesh.faNexusBgBandValue = renderElevation;

    // Apply render-elevation only.
    mesh.elevation = renderElevation;

    if (mesh.parent) mesh.parent.sortDirty = true;
    Logger.debug('TileBackgroundBand.apply', { tileId: doc.id, baseElevation, renderElevation, reason });
  } catch (error) {
    Logger.warn('TileBackgroundBand.apply.failed', String(error?.message || error));
  }
}

function restoreTileElevation(tile, { reason = 'restore' } = {}) {
  try {
    if (!tile || tile.destroyed) return;
    const mesh = tile.mesh;
    const doc = tile.document;
    if (!mesh || mesh.destroyed || !doc) return;

    const baseElevation = Number(doc.elevation ?? mesh.faNexusBgBandBase ?? 0) || 0;
    if (mesh.faNexusBgBandApplied && Math.abs((mesh.elevation ?? 0) - baseElevation) > EPSILON) {
      mesh.elevation = baseElevation;
    }

    delete mesh.faNexusBgBandApplied;
    delete mesh.faNexusBgBandBase;
    delete mesh.faNexusBgBandValue;

    if (mesh.parent) mesh.parent.sortDirty = true;
    Logger.debug('TileBackgroundBand.restore', { tileId: doc.id, baseElevation, reason });
  } catch (error) {
    Logger.warn('TileBackgroundBand.restore.failed', String(error?.message || error));
  }
}

function applyAllTiles(reason, { force = false } = {}) {
  try {
    const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of tiles) applyTileBackgroundBand(tile, { reason, force });
  } catch (error) {
    Logger.warn('TileBackgroundBand.applyAll.failed', String(error?.message || error));
  }
}

function restoreAllTiles(reason) {
  try {
    const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of tiles) restoreTileElevation(tile, { reason });
  } catch (error) {
    Logger.warn('TileBackgroundBand.restoreAll.failed', String(error?.message || error));
  }
}

// --- Optional: preserve tile elevation when moving via keyboard ---------------
// Foundry v13 floors placeable elevation during keyboard movement to the grid distance,
// which destroys micro-elevations (e.g. 0.50 -> 0.00) when nudging tiles with WASD.
// We restore the current tile document elevation when dz == 0.

const PLACEABLE_SHIFTED_POS_PATCH = Symbol.for('fa-nexus.PlaceableObject.getShiftedPosition.patched');

function patchTileKeyboardMoveElevation() {
  try {
    const PlaceableObject = foundry?.canvas?.placeables?.PlaceableObject ?? globalThis?.PlaceableObject;
    const TileClass = foundry?.canvas?.placeables?.Tile ?? null;
    if (!PlaceableObject?.prototype || PlaceableObject.prototype[PLACEABLE_SHIFTED_POS_PATCH]) return;
    const original = PlaceableObject.prototype._getShiftedPosition;
    if (typeof original !== 'function') return;

    PlaceableObject.prototype._getShiftedPosition = function faNexusGetShiftedPosition(dx, dy, dz) {
      const result = original.call(this, dx, dy, dz);
      try {
        if (dz) return result;
        if (TileClass && !(this instanceof TileClass)) return result;
        const currentElevation = Number(this?.document?.elevation);
        if (Number.isFinite(currentElevation)) result.elevation = currentElevation;
      } catch (_) {}
      return result;
    };
    PlaceableObject.prototype[PLACEABLE_SHIFTED_POS_PATCH] = true;
    Logger.info('TileKeyboardMoveElevation.patched');
  } catch (error) {
    Logger.warn('TileKeyboardMoveElevation.patchFailed', String(error?.message || error));
  }
}

// --- Hook wiring --------------------------------------------------------------

try {
  Hooks.on('refreshTile', (tile) => applyTileBackgroundBand(tile, { reason: 'refresh' }));
  Hooks.on('drawTile', (tile) => applyTileBackgroundBand(tile, { reason: 'draw', force: true }));
  Hooks.on('canvasReady', () => {
    applySceneBackgroundBand({ reason: 'canvasReady', force: true });
    applyAllTiles('canvasReady', { force: true });
  });
  Hooks.on('updateTile', (...args) => {
    try {
      const doc = (args?.[0]?.documentName === 'Tile') ? args[0] : args[1];
      if (!doc?.id) return;
      const tile = canvas?.tiles?.get?.(doc.id);
      if (tile) applyTileBackgroundBand(tile, { reason: 'update', force: true });
    } catch (_) {}
  });
  Hooks.on('fa-nexus-token-elevation-offset-changed', ({ enabled }) => {
    if (enabled) {
      applySceneBackgroundBand({ reason: 'setting-enabled', force: true });
      applyAllTiles('setting-enabled', { force: true });
    } else {
      restoreAllTiles('setting-disabled');
      restoreSceneBackgroundElevation({ reason: 'setting-disabled' });
    }
  });

  Hooks.once('ready', () => {
    try {
      patchTileKeyboardMoveElevation();
      // Apply once on initial ready if the canvas is already up.
      if (canvas?.ready) {
        applySceneBackgroundBand({ reason: 'ready', force: true });
        applyAllTiles('ready', { force: true });
      }
    } catch (_) {}
  });
} catch (error) {
  console.warn('[fa-nexus] token-elevation-offset init failed', error);
}

export { applyTileBackgroundBand, restoreTileElevation };
