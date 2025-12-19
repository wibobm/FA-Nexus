const MODULE_ID = 'fa-nexus';
const SETTING_KEY = 'tokenElevationOffset';

// Treat tiles below elevation 1 as "background floor 0" for rendering purposes by shifting
// their render-elevation down by 1. This preserves micro-elevation stacking in 0–1 while
// keeping tokens/FX unmodified and avoiding collisions with genuine negative elevations.
const SHIFT_THRESHOLD = 1;
const RENDER_SHIFT = 1;

export function isKeepTokensAboveTileElevationsEnabled() {
  try {
    return game?.settings?.get?.(MODULE_ID, SETTING_KEY) !== false;
  } catch (_) {
    return true;
  }
}

export function isBackgroundElevationBand(elevation) {
  const e = Number(elevation ?? 0);
  if (!Number.isFinite(e)) return false;
  return e < SHIFT_THRESHOLD;
}

/**
 * Convert a tile document elevation into the render-elevation we want to use on the mesh.
 * Only the [0, 1) band is shifted.
 */
export function getTileRenderElevation(documentElevation, { enabled = isKeepTokensAboveTileElevationsEnabled() } = {}) {
  const e = Number(documentElevation ?? 0) || 0;
  if (!enabled) return e;
  if (!isBackgroundElevationBand(e)) return e;
  return e - RENDER_SHIFT;
}
