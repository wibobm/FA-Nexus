import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { TileFlattenManager } from '../canvas/tile-flatten-manager.js';
import { createCanvasGestureSession } from '../canvas/canvas-gesture-session.js';
import { computeNextSortAtElevation } from '../canvas/canvas-interaction-controller.js';
import { isKeepTokensAboveTileElevationsEnabled } from '../canvas/elevation-band-utils.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { AbstractSidebarTab, Sidebar } = foundry.applications.sidebar;

const MODULE_ID = 'fa-nexus';
const TAB_ID = 'layer-manager';
const RANGE_MIN_SETTING = 'layerManagerElevationMin';
const RANGE_MAX_SETTING = 'layerManagerElevationMax';
const SKIP_LOCKED_SETTING = 'layerManagerSkipLocked';
const SKIP_HIDDEN_SETTING = 'layerManagerSkipHidden';
const IGNORE_FOREGROUND_SETTING = 'layerManagerIgnoreForeground';
const LAYER_HIDDEN_FLAG = 'layerHidden';
const CONTEXT_DOUBLE_CLICK_MS = 350;
const BG_RENDER_OVERRIDE_KEY = 'faNexusBgBandRenderElevation';
const EDITING_TILE_SET_KEYS = [
  '__faNexusTextureEditingTileIds',
  '__faNexusBuildingEditingTileIds',
  '__faNexusPathEditingTiles'
];

const selectionFilterState = {
  active: false,
  min: null,
  max: null,
  skipLocked: false,
  skipHidden: false,
  ignoreForeground: false
};
const layerHiddenState = {
  hooksBound: false
};

const hoverEventStub = { buttons: 0 };
const clickEventStub = { shiftKey: false, stopPropagation: () => {} };

let _tileFlattenManager = null;
let _altKeyHeld = false;

function getTileFlattenManager() {
  if (!_tileFlattenManager) _tileFlattenManager = new TileFlattenManager();
  return _tileFlattenManager;
}

function parseElevationInput(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatElevation(value) {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function quantizeElevation(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const quantized = Math.round(numeric * 100) / 100;
  return Object.is(quantized, -0) ? 0 : quantized;
}

function isAltModifierActive() {
  if (_altKeyHeld) return true;
  try {
    return !!game?.keyboard?.isModifierActive?.('ALT');
  } catch (_) {
    return false;
  }
}

function collectEditedTileIds() {
  const hiddenIds = new Set();
  try {
    for (const key of EDITING_TILE_SET_KEYS) {
      const set = globalThis?.[key];
      if (!(set instanceof Set)) continue;
      for (const id of set) {
        if (id) hiddenIds.add(id);
      }
    }

    const buildingSet = globalThis?.__faNexusBuildingEditingTileIds;
    if (!(buildingSet instanceof Set) || !buildingSet.size) return hiddenIds;

    const wallGroupIds = new Set();
    const primaryIds = new Set();
    const tiles = canvas?.scene?.tiles
      ? Array.from(canvas.scene.tiles)
      : (Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables.map(tile => tile?.document).filter(Boolean) : []);

    for (const doc of tiles) {
      const id = doc?.id;
      if (!id || !buildingSet.has(id)) continue;
      primaryIds.add(id);
      hiddenIds.add(id);
      const data = doc.getFlag?.('fa-nexus', 'building');
      const meta = data?.meta || {};
      if (meta?.wallGroupId) wallGroupIds.add(meta.wallGroupId);
      if (meta?.fillTileId) hiddenIds.add(meta.fillTileId);
    }

    if (!wallGroupIds.size && !primaryIds.size) return hiddenIds;

    for (const doc of tiles) {
      const id = doc?.id;
      if (!id || hiddenIds.has(id)) continue;
      const data = doc.getFlag?.('fa-nexus', 'building');
      if (data) {
        const meta = data?.meta || {};
        if (meta?.parentWallTileId && primaryIds.has(meta.parentWallTileId)) {
          hiddenIds.add(id);
          continue;
        }
        if (meta?.parentWallGroupId && wallGroupIds.has(meta.parentWallGroupId)) {
          hiddenIds.add(id);
          continue;
        }
        if (meta?.wallGroupId && wallGroupIds.has(meta.wallGroupId)) {
          hiddenIds.add(id);
          continue;
        }
      }
      const door = doc.getFlag?.('fa-nexus', 'buildingDoorFrame');
      if (door?.wallGroupId && wallGroupIds.has(door.wallGroupId)) {
        hiddenIds.add(id);
        continue;
      }
      const sill = doc.getFlag?.('fa-nexus', 'buildingWindowSill');
      const window = doc.getFlag?.('fa-nexus', 'buildingWindowWindow');
      const frame = doc.getFlag?.('fa-nexus', 'buildingWindowFrame');
      const windowFlag = sill || window || frame;
      if (windowFlag?.wallGroupId && wallGroupIds.has(windowFlag.wallGroupId)) {
        hiddenIds.add(id);
      }
    }

    return hiddenIds;
  } catch (_) {
    return hiddenIds;
  }
}

function isTileBeingEdited(tile, hiddenIds) {
  try {
    const id = tile?.document?.id || tile?.id;
    if (!id) return false;
    if (hiddenIds instanceof Set) return hiddenIds.has(id);
    for (const key of EDITING_TILE_SET_KEYS) {
      const set = globalThis?.[key];
      if (set instanceof Set && set.has(id)) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function isTilesLayerActive() {
  try {
    return !!canvas?.tiles && canvas?.activeLayer === canvas.tiles;
  } catch (_) {
    return false;
  }
}

function forceHideEditedTile(tile) {
  try {
    if (!tile || tile.destroyed) return;
    if (!isTileBeingEdited(tile)) return;
    try { tile.visible = false; } catch (_) {}
    try { if (typeof tile.renderable === 'boolean') tile.renderable = false; } catch (_) {}
    try { tile.alpha = 0; } catch (_) {}
    if (tile.mesh && tile.mesh.visible !== false) {
      try { tile.mesh.visible = false; } catch (_) {}
    }
    if (tile.bg && tile.bg.visible !== false) {
      try { tile.bg.visible = false; } catch (_) {}
    }
    if (tile.frame && tile.frame.visible !== false) {
      try { tile.frame.visible = false; } catch (_) {}
    }
    if (typeof tile.eventMode !== 'undefined') {
      try { tile.eventMode = 'none'; } catch (_) {}
    }
  } catch (_) {}
}

function shouldSuppressTileHover() {
  return !!selectionFilterState.active && isAltModifierActive() && isTilesLayerActive();
}

function clearTileHover() {
  const hover = canvas?.tiles?.hover;
  if (!hover) return;
  try { hover._onHoverOut?.(hoverEventStub); } catch (_) {}
}

function setAltKeyHeld(active) {
  const next = !!active;
  if (_altKeyHeld === next) return;
  _altKeyHeld = next;
  if (!selectionFilterState.active) return;
  if (shouldSuppressTileHover()) {
    clearTileHover();
    try { canvas?.highlightObjects?.(false); } catch (_) {}
  }
}

function getForegroundElevation() {
  try {
    const fg = canvas?.scene?.foregroundElevation ?? canvas?.scene?._source?.foregroundElevation;
    const numeric = Number(fg);
    return Number.isFinite(numeric) ? numeric : null;
  } catch (_) {
    return null;
  }
}

function sceneHasBackgroundImage() {
  try {
    const scene = canvas?.scene;
    const raw = scene?.background?.src
      ?? scene?.background?.texture?.src
      ?? scene?._source?.background?.src
      ?? scene?._source?.background?.texture?.src;
    return !!String(raw ?? '').trim();
  } catch (_) {
    return false;
  }
}

function sceneHasForegroundImage() {
  try {
    const scene = canvas?.scene;
    const raw = scene?.foreground
      ?? scene?.foreground?.src
      ?? scene?._source?.foreground
      ?? scene?._source?.foreground?.src;
    return !!String(raw ?? '').trim();
  } catch (_) {
    return false;
  }
}

function resolveBackgroundBaseElevation() {
  const extract = (target) => {
    if (!target) return null;
    const base = Number(target.faNexusBgBandBaseElevation);
    return Number.isFinite(base) ? base : null;
  };
  const roots = [];
  if (canvas?.primary?.background) roots.push(canvas.primary.background);
  if (canvas?.background) roots.push(canvas.background);
  for (const root of roots) {
    const direct = extract(root);
    if (direct !== null) return direct;
    const candidates = [root.mesh, root.sprite, root.background, root._background];
    for (const candidate of candidates) {
      const base = extract(candidate);
      if (base !== null) return base;
    }
  }
  return null;
}

function resolveBackgroundRenderElevation() {
  const allowOverride = isKeepTokensAboveTileElevationsEnabled();
  if (allowOverride) {
    const sceneOverride = Number(canvas?.scene?.[BG_RENDER_OVERRIDE_KEY]);
    if (Number.isFinite(sceneOverride)) return sceneOverride;
  }
  const extract = (target) => {
    if (!target) return null;
    if (allowOverride) {
      const override = Number(target[BG_RENDER_OVERRIDE_KEY]);
      if (Number.isFinite(override)) return override;
    }
    const elevation = Number(target.elevation);
    return Number.isFinite(elevation) ? elevation : null;
  };
  const roots = [];
  if (canvas?.primary?.background) roots.push(canvas.primary.background);
  if (canvas?.background) roots.push(canvas.background);
  for (const root of roots) {
    const direct = extract(root);
    if (direct !== null) return direct;
    const candidates = [root.mesh, root.sprite, root.background, root._background];
    for (const candidate of candidates) {
      const value = extract(candidate);
      if (value !== null) return value;
    }
  }
  return null;
}

function getBackgroundElevation() {
  try {
    const render = resolveBackgroundRenderElevation();
    if (render !== null) return render;
    const base = resolveBackgroundBaseElevation();
    if (base !== null) return base;
    const bg = canvas?.scene?.background?.elevation
      ?? canvas?.scene?.backgroundElevation
      ?? canvas?.scene?._source?.backgroundElevation;
    if (bg === null || bg === undefined || bg === '') return 0;
    const numeric = Number(bg);
    return Number.isFinite(numeric) ? numeric : 0;
  } catch (_) {
    return 0;
  }
}

function getBackgroundDisplayElevation() {
  const render = getBackgroundElevation();
  if (!Number.isFinite(render)) return render;
  if (!isKeepTokensAboveTileElevationsEnabled()) return render;
  return quantizeElevation(render + 1);
}

function setBackgroundRenderElevation(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return;
  try {
    if (canvas?.scene) canvas.scene[BG_RENDER_OVERRIDE_KEY] = numeric;
  } catch (_) {}
  const targets = [];
  if (canvas?.primary?.background) targets.push(canvas.primary.background);
  if (canvas?.background) targets.push(canvas.background);
  const apply = (target) => {
    if (!target) return;
    try { target[BG_RENDER_OVERRIDE_KEY] = numeric; } catch (_) {}
    try { if ('elevation' in target) target.elevation = numeric; } catch (_) {}
  };
  for (const target of targets) {
    apply(target);
    apply(target.mesh);
    apply(target.sprite);
    apply(target.background);
    apply(target._background);
  }
  try { if (canvas?.primary) canvas.primary.sortDirty = true; } catch (_) {}
}

function readSetting(key) {
  try { return game?.settings?.get?.(MODULE_ID, key) ?? ''; } catch (_) { return ''; }
}

function writeSetting(key, value) {
  try { return game?.settings?.set?.(MODULE_ID, key, value); } catch (_) { return null; }
}

function getElevationRangeFromSettings() {
  const minRaw = readSetting(RANGE_MIN_SETTING);
  const maxRaw = readSetting(RANGE_MAX_SETTING);
  const skipLocked = !!readSetting(SKIP_LOCKED_SETTING);
  const skipHidden = !!readSetting(SKIP_HIDDEN_SETTING);
  const ignoreForeground = !!readSetting(IGNORE_FOREGROUND_SETTING);
  return {
    minRaw,
    maxRaw,
    min: parseElevationInput(minRaw),
    max: parseElevationInput(maxRaw),
    skipLocked,
    skipHidden,
    ignoreForeground
  };
}

function readFaFlag(doc, key) {
  try {
    const direct = doc?.getFlag?.(MODULE_ID, key);
    if (direct !== undefined) return direct;
  } catch (_) {}
  const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
  return flags ? flags[key] : null;
}

function isLayerHidden(doc) {
  return !!readFaFlag(doc, LAYER_HIDDEN_FLAG);
}

function isTileHidden(doc) {
  if (!doc) return false;
  return isLayerHidden(doc);
}

function setLayerHidden(doc, hidden) {
  if (!doc) return;
  try {
    if (hidden) {
      if (typeof doc.setFlag === 'function') {
        doc.setFlag(MODULE_ID, LAYER_HIDDEN_FLAG, true);
      } else {
        doc.update({ [`flags.${MODULE_ID}.${LAYER_HIDDEN_FLAG}`]: true });
      }
      return;
    }
    if (typeof doc.unsetFlag === 'function') {
      doc.unsetFlag(MODULE_ID, LAYER_HIDDEN_FLAG);
    } else {
      doc.update({ [`flags.${MODULE_ID}.${LAYER_HIDDEN_FLAG}`]: false });
    }
  } catch (_) {}
}

function resolveTileType(doc) {
  if (!doc) return { icon: 'fa-solid fa-image', label: 'Asset' };
  if (readFaFlag(doc, 'assetScatter')) return { icon: 'fa-solid fa-braille', label: 'Scatter' };
  if (readFaFlag(doc, 'building')) return { icon: 'fa-solid fa-building', label: 'Wall/Building' };
  if (readFaFlag(doc, 'pathsV2') || readFaFlag(doc, 'pathV2') || readFaFlag(doc, 'path')) {
    return { icon: 'fa-solid fa-route', label: 'Path' };
  }
  if (readFaFlag(doc, 'maskedTiling')) return { icon: 'fa-solid fa-paint-roller', label: 'Texture' };
  return { icon: 'fa-solid fa-image', label: 'Asset' };
}

function syncSelectionFilterFromSettings() {
  const { min, max, minRaw, maxRaw, skipLocked, skipHidden, ignoreForeground } = getElevationRangeFromSettings();
  const wasIgnoreForeground = selectionFilterState.ignoreForeground;
  const wasSkipHidden = selectionFilterState.skipHidden;
  selectionFilterState.min = min;
  selectionFilterState.max = max;
  selectionFilterState.skipLocked = !!skipLocked;
  selectionFilterState.skipHidden = !!skipHidden;
  const hasRange = !!String(minRaw ?? '').trim() || !!String(maxRaw ?? '').trim();
  let nextIgnoreForeground = !!ignoreForeground;
  if (hasRange && !nextIgnoreForeground) {
    nextIgnoreForeground = true;
    writeSetting(IGNORE_FOREGROUND_SETTING, true);
  }
  selectionFilterState.ignoreForeground = nextIgnoreForeground;
  if (wasIgnoreForeground !== nextIgnoreForeground || wasSkipHidden !== selectionFilterState.skipHidden) {
    refreshTileInteractionState();
  }
}

function selectionFilterActive() {
  return !!selectionFilterState.active && (
    Number.isFinite(selectionFilterState.min)
    || Number.isFinite(selectionFilterState.max)
    || !!selectionFilterState.skipLocked
    || !!selectionFilterState.skipHidden
  );
}

function selectionIgnoresForeground() {
  return !!selectionFilterState.active && !!selectionFilterState.ignoreForeground;
}

function canSelectPlaceable(placeable, { ignoreForeground = false, filterActive = false } = {}) {
  if (!placeable) return false;
  if (ignoreForeground) {
    if (!placeable.visible || !placeable.renderable) return false;
  }
  if (filterActive) {
    const elevation = Number(placeable?.document?.elevation ?? 0);
    if (!elevationInRange(elevation)) return false;
    if (selectionFilterState.skipLocked && placeable?.document?.locked) return false;
    if (selectionFilterState.skipHidden && isTileHidden(placeable?.document)) return false;
  }
  return true;
}

function elevationInRange(value) {
  if (!selectionFilterActive()) return true;
  if (!Number.isFinite(value)) return false;
  if (Number.isFinite(selectionFilterState.min) && value < selectionFilterState.min) return false;
  if (Number.isFinite(selectionFilterState.max) && value > selectionFilterState.max) return false;
  return true;
}

function refreshTileInteractionState() {
  if (!canvas?.ready || !canvas?.tiles?.setAllRenderFlags) return;
  try { canvas.tiles.setAllRenderFlags({ refreshState: true }); } catch (_) {}
}

function ensureTileSelectionPatch() {
  const TilesLayer = globalThis?.foundry?.canvas?.layers?.TilesLayer || canvas?.tiles?.constructor;
  if (!TilesLayer?.prototype?.selectObjects) return;
  if (TilesLayer.prototype._faNexusSelectObjectsPatched) return;
  TilesLayer.prototype._faNexusSelectObjectsPatched = true;
  const original = TilesLayer.prototype.selectObjects;
  TilesLayer.prototype._faNexusSelectObjectsOriginal = original;

  TilesLayer.prototype.selectObjects = function ({ x, y, width, height, releaseOptions = {}, controlOptions = {} } = {}, { releaseOthers = true } = {}) {
    const filterActive = selectionFilterActive();
    const ignoreForeground = selectionIgnoresForeground();
    if (!filterActive && !ignoreForeground) return original.call(this, { x, y, width, height, releaseOptions, controlOptions }, { releaseOthers });
    if (!this.options.controllableObjects) return false;

    const oldSet = new Set(this.controlled);
    const newSet = new Set();
    const rectangle = new PIXI.Rectangle(x, y, width, height);

    const placeables = ignoreForeground ? this.placeables : this.controllableObjects();
    for (const placeable of placeables) {
      if (!canSelectPlaceable(placeable, { ignoreForeground, filterActive })) continue;
      if (placeable._overlapsSelection(rectangle)) newSet.add(placeable);
    }

    const toRelease = oldSet.difference(newSet);
    if (releaseOthers) toRelease.forEach(placeable => placeable.release(releaseOptions));

    if (foundry.utils.isEmpty(controlOptions)) controlOptions.releaseOthers = false;
    const toControl = newSet.difference(oldSet);
    toControl.forEach(placeable => placeable.control(controlOptions));

    return (releaseOthers && (toRelease.size > 0)) || (toControl.size > 0);
  };
}

function ensureTileSelectAllPatch() {
  const TilesLayer = globalThis?.foundry?.canvas?.layers?.TilesLayer || canvas?.tiles?.constructor;
  if (!TilesLayer?.prototype?._onSelectAllKey) return;
  if (TilesLayer.prototype._faNexusSelectAllPatched) return;
  TilesLayer.prototype._faNexusSelectAllPatched = true;
  const original = TilesLayer.prototype._onSelectAllKey;
  TilesLayer.prototype._faNexusSelectAllOriginal = original;

  TilesLayer.prototype._onSelectAllKey = function (event) {
    const filterActive = selectionFilterActive();
    const ignoreForeground = selectionIgnoresForeground();
    if (!filterActive && !ignoreForeground) return original.call(this, event);
    if (!this.options.controllableObjects) return false;

    const oldSet = new Set(this.controlled);
    const newSet = new Set();
    const placeables = ignoreForeground ? this.placeables : this.controllableObjects();

    for (const placeable of placeables) {
      if (!canSelectPlaceable(placeable, { ignoreForeground, filterActive })) continue;
      newSet.add(placeable);
    }

    const toRelease = oldSet.difference(newSet);
    toRelease.forEach(placeable => placeable.release());

    const toControl = newSet.difference(oldSet);
    const controlOptions = { releaseOthers: false };
    toControl.forEach(placeable => placeable.control(controlOptions));

    return true;
  };
}

function ensureTileForegroundSelectionPatch() {
  const Tile = globalThis?.foundry?.canvas?.placeables?.Tile
    || canvas?.tiles?.constructor?.placeableClass
    || globalThis?.CONFIG?.Tile?.objectClass;
  if (!Tile?.prototype?._refreshState) return;
  if (Tile.prototype._faNexusIgnoreForegroundPatched) return;
  Tile.prototype._faNexusIgnoreForegroundPatched = true;
  const original = Tile.prototype._refreshState;
  Tile.prototype._faNexusIgnoreForegroundOriginal = original;

  Tile.prototype._refreshState = function (...args) {
    if (!selectionIgnoresForeground()) {
      const result = original.apply(this, args);
      try { forceHideEditedTile(this); } catch (_) {}
      return result;
    }
    const fgTool = ui?.controls?.control?.tools?.foreground;
    if (!fgTool || typeof fgTool.active !== 'boolean') {
      const result = original.apply(this, args);
      if (this.layer?.active && this.eventMode !== 'static') this.eventMode = 'static';
      try { forceHideEditedTile(this); } catch (_) {}
      return result;
    }
    const prev = fgTool.active;
    const overhead = Number(this.document?.elevation ?? 0) >= Number(this.document?.parent?.foregroundElevation ?? 0);
    fgTool.active = overhead;
    try {
      const result = original.apply(this, args);
      try { forceHideEditedTile(this); } catch (_) {}
      return result;
    } finally {
      fgTool.active = prev;
    }
  };
}

function ensureTileHoverSuppressionPatch() {
  const Tile = globalThis?.foundry?.canvas?.placeables?.Tile
    || canvas?.tiles?.constructor?.placeableClass
    || globalThis?.CONFIG?.Tile?.objectClass;
  if (!Tile?.prototype?._onHoverIn) return;
  if (Tile.prototype._faNexusHoverSuppressionPatched) return;
  Tile.prototype._faNexusHoverSuppressionPatched = true;
  const original = Tile.prototype._onHoverIn;
  Tile.prototype._faNexusHoverSuppressionOriginal = original;

  Tile.prototype._onHoverIn = function (...args) {
    if (shouldSuppressTileHover()) return;
    return original.apply(this, args);
  };
}

function ensureCanvasHighlightSuppressionPatch() {
  const Canvas = globalThis?.foundry?.canvas?.Canvas || canvas?.constructor;
  if (!Canvas?.prototype?.highlightObjects) return;
  if (Canvas.prototype._faNexusHighlightSuppressionPatched) return;
  Canvas.prototype._faNexusHighlightSuppressionPatched = true;
  const original = Canvas.prototype.highlightObjects;
  Canvas.prototype._faNexusHighlightSuppressionOriginal = original;

  Canvas.prototype.highlightObjects = function (active) {
    if (active && shouldSuppressTileHover()) return;
    return original.call(this, active);
  };
}

function applyLayerHiddenState(tile) {
  if (!tile || tile.destroyed) return;
  const doc = tile.document;
  if (!isLayerHidden(doc)) return;
  if (tile.mesh && tile.mesh.visible !== false) {
    try { tile.mesh.visible = false; } catch (_) {}
  }
  if (tile.bg && tile.bg.visible !== false) {
    try { tile.bg.visible = false; } catch (_) {}
  }
  if (tile.frame && tile.frame.visible !== false) {
    try { tile.frame.visible = false; } catch (_) {}
  }
  if (typeof tile.eventMode !== 'undefined') {
    try { tile.eventMode = 'none'; } catch (_) {}
  }
}

function restoreLayerHiddenState(tile) {
  if (!tile || tile.destroyed) return;
  const doc = tile.document;
  if (isLayerHidden(doc)) return;
  if (tile.mesh && tile.mesh.visible === false) {
    try { tile.mesh.visible = tile.isVisible; } catch (_) {}
  }
  if (tile.bg && tile.bg.visible === false) {
    try { tile.bg.visible = !!tile.layer?.active; } catch (_) {}
  }
  if (tile.frame && tile.frame.visible === false) {
    try { tile.frame.visible = true; } catch (_) {}
  }
}

function hasLayerHiddenChange(changes) {
  if (!changes?.flags) return false;
  const scoped = changes.flags[MODULE_ID];
  if (scoped === null) return true;
  if (!scoped) return false;
  if (Object.prototype.hasOwnProperty.call(scoped, LAYER_HIDDEN_FLAG)) return true;
  const unsetKey = `-=${LAYER_HIDDEN_FLAG}`;
  return Object.prototype.hasOwnProperty.call(scoped, unsetKey);
}

function requestTileRefresh(tile) {
  try { tile?.renderFlags?.set?.({ refreshState: true }); } catch (_) {}
}

function handleLayerHiddenUpdate(doc, changes) {
  const tile = doc?.object;
  if (!tile) return;
  const hiddenNow = isLayerHidden(doc);
  if (hasLayerHiddenChange(changes)) requestTileRefresh(tile);
  if (hiddenNow) applyLayerHiddenState(tile);
  else restoreLayerHiddenState(tile);
}

function applyLayerHiddenToCanvas() {
  if (!canvas?.ready || !canvas?.tiles) return;
  const placeables = Array.isArray(canvas.tiles.placeables) ? canvas.tiles.placeables : [];
  for (const tile of placeables) {
    if (isLayerHidden(tile?.document)) applyLayerHiddenState(tile);
    else restoreLayerHiddenState(tile);
  }
}

function ensureLayerHiddenHooks() {
  if (layerHiddenState.hooksBound) return;
  layerHiddenState.hooksBound = true;
  const hooks = globalThis?.Hooks;
  if (hooks && typeof hooks.on === 'function') {
    try { hooks.on('drawTile', (tile) => applyLayerHiddenState(tile)); } catch (_) {}
    try { hooks.on('refreshTile', (tile) => applyLayerHiddenState(tile)); } catch (_) {}
    try { hooks.on('updateTile', (doc, changes) => handleLayerHiddenUpdate(doc, changes)); } catch (_) {}
    try { hooks.on('controlTile', (tile) => applyLayerHiddenState(tile)); } catch (_) {}
    try { hooks.on('canvasReady', () => applyLayerHiddenToCanvas()); } catch (_) {}
  }
  if (canvas?.ready) queueMicrotask(() => applyLayerHiddenToCanvas());
}

function computeTileName(tile, index) {
  const doc = tile?.document;
  const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
  const explicit = flags?.name || flags?.label || doc?.name || doc?.label;
  if (explicit) return String(explicit);
  const masked = readFaFlag(doc, 'maskedTiling');
  if (masked?.baseColor) return 'Solid Color';
  const src = String(doc?.texture?.src || '').trim();
  if (src) {
    const filename = src.split('/').pop() || src;
    const base = filename.replace(/\.[^/.]+$/, '');
    return base || filename;
  }
  return `Tile ${index + 1}`;
}

function resolvePreviewElevation(container) {
  if (!container) return 0;
  const candidate = Number(
    container.faNexusPathPreviewElevation
    ?? container.faNexusElevationDoc
    ?? container.elevation
    ?? 0
  );
  return quantizeElevation(candidate);
}

function resolvePreviewSort(container) {
  if (!container) return 0;
  const candidate = Number(container.faNexusSort ?? container.sort ?? container.zIndex ?? 0);
  return Number.isFinite(candidate) ? candidate : 0;
}

function buildPreviewEntry(container, { label, icon, kind, previewActiveOverride }) {
  if (!container || container.destroyed) return null;
  const elevation = resolvePreviewElevation(container);
  const previewActive = previewActiveOverride !== undefined
    ? !!previewActiveOverride
    : !!container?.faNexusPreviewActive;
  return {
    preview: true,
    previewId: `${kind}-${container?.faNexusPathPreviewKey || container?.faNexusScatterPreviewKey || container?.name || String(elevation)}`,
    previewActive,
    name: label,
    elevation,
    sort: resolvePreviewSort(container),
    typeIcon: icon,
    typeLabel: label
  };
}

function buildSceneMarkerEntry(kind, elevation) {
  const numeric = Number(elevation);
  if (!Number.isFinite(numeric)) return null;
  const label = kind === 'foreground' ? 'Scene Foreground' : 'Scene Background';
  const icon = kind === 'foreground' ? 'fa-solid fa-layer-group' : 'fa-solid fa-image';
  return {
    marker: true,
    markerKind: kind,
    markerId: `scene-${kind}`,
    name: label,
    elevation: quantizeElevation(numeric),
    sort: Number.NEGATIVE_INFINITY,
    typeIcon: icon,
    typeLabel: label
  };
}

function collectPreviewEntries() {
  if (!canvas?.ready) return [];
  const roots = new Set();
  if (canvas?.primary) roots.add(canvas.primary);
  if (canvas?.stage) roots.add(canvas.stage);
  const entries = [];
  const seen = new Set();
  const scatterCandidates = [];
  const buildingPreviewRoots = [];
  const buildingFillRoots = [];
  let scatterEntries = 0;
  const shouldInclude = (container) => !!container?.faNexusPreviewActive || !!container?.faNexusPreviewHasContent;
  const push = (container, meta) => {
    if (!container || container.destroyed) return;
    if (seen.has(container)) return;
    const entry = buildPreviewEntry(container, meta);
    if (entry) {
      entries.push(entry);
      seen.add(container);
      if (meta?.kind === 'scatter-preview') scatterEntries += 1;
    }
  };
  const pushScatterCandidate = (container) => {
    if (!container || container.destroyed) return;
    scatterCandidates.push(container);
  };
  const pushBuildingRoot = (container, collection) => {
    if (!container || container.destroyed) return;
    collection.push(container);
  };
  const walk = (container, depth = 0) => {
    if (!container || container.destroyed) return;
    if (container.faNexusScatterPreview) {
      if (shouldInclude(container)) {
        push(container, { label: 'Scatter Preview', icon: 'fa-solid fa-braille', kind: 'scatter-preview' });
      } else {
        pushScatterCandidate(container);
      }
    } else if (container.faNexusPathPreview) {
      if (shouldInclude(container)) {
        push(container, { label: 'Path Preview', icon: 'fa-solid fa-route', kind: 'path-preview' });
      }
    } else if (container.faNexusTexturePreview) {
      if (shouldInclude(container)) {
        push(container, { label: 'Texture Preview', icon: 'fa-solid fa-paint-roller', kind: 'texture-preview' });
      }
    } else if (container.name === 'fa-nexus-building-preview-root') {
      pushBuildingRoot(container, buildingPreviewRoots);
    } else if (container.name === 'fa-nexus-building-fill-preview-root') {
      pushBuildingRoot(container, buildingFillRoots);
    }
    if (depth >= 3) return;
    const children = Array.isArray(container.children) ? container.children : [];
    for (const child of children) {
      walk(child, depth + 1);
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }

  const buildingManagerActive = (() => {
    try {
      return !!globalThis?.faNexus?.premiumFeatures?.buildingEditor?.activeManager?.isActive;
    } catch (_) {
      return false;
    }
  })();
  const buildingActive = buildingManagerActive || [...buildingPreviewRoots, ...buildingFillRoots].some(
    (container) => !!container?.faNexusPreviewActive
  );
  for (const container of buildingPreviewRoots) {
    push(container, {
      label: 'Building Preview',
      icon: 'fa-solid fa-building',
      kind: 'building-preview',
      previewActiveOverride: buildingActive ? true : undefined
    });
  }
  for (const container of buildingFillRoots) {
    push(container, {
      label: 'Building Fill Preview',
      icon: 'fa-solid fa-fill-drip',
      kind: 'building-fill-preview',
      previewActiveOverride: buildingActive ? true : undefined
    });
  }

  if (!scatterEntries && scatterCandidates.length) {
    let fallback = scatterCandidates[0];
    for (const candidate of scatterCandidates) {
      if (!candidate || candidate.destroyed) continue;
      if (resolvePreviewSort(candidate) > resolvePreviewSort(fallback)) {
        fallback = candidate;
      }
    }
    push(fallback, {
      label: 'Scatter Preview',
      icon: 'fa-solid fa-braille',
      kind: 'scatter-preview',
      previewActiveOverride: true
    });
  }

  return entries;
}

function buildEntriesFromCanvas() {
  if (!canvas?.ready || !canvas?.tiles) return [];
  const hiddenIds = collectEditedTileIds();
  const entries = [];
  const tiles = canvas.tiles.placeables || [];
  const sortedTiles = tiles
    .filter((tile) => tile && !tile.destroyed && !isTileBeingEdited(tile, hiddenIds))
    .slice()
    .sort((a, b) => {
      const elevDiff = (Number(b.document?.elevation ?? 0) - Number(a.document?.elevation ?? 0));
      if (elevDiff) return elevDiff;
      const sortDiff = (Number(b.document?.sort ?? 0) - Number(a.document?.sort ?? 0));
      if (sortDiff) return sortDiff;
      const aId = String(a.document?.id ?? a.id ?? '');
      const bId = String(b.document?.id ?? b.id ?? '');
      if (aId && bId) return aId.localeCompare(bId);
      if (aId) return -1;
      if (bId) return 1;
      return 0;
    });
  const elevationGroups = new Map();
  for (const tile of sortedTiles) {
    const elevation = quantizeElevation(Number(tile.document?.elevation ?? 0));
    let group = elevationGroups.get(elevation);
    if (!group) {
      group = { tiles: [], canToggleVisibility: false, canToggleLock: false };
      elevationGroups.set(elevation, group);
    }
    group.tiles.push(tile);
    if (tile.document?.canUserModify?.(game.user, 'update')) {
      group.canToggleVisibility = true;
      group.canToggleLock = true;
    }
  }
  const controlled = new Set((canvas.tiles.controlled || []).map(tile => tile.document?.id || tile.id));
  const tileEntries = [];
  for (let i = 0; i < sortedTiles.length; i += 1) {
    const tile = sortedTiles[i];
    const elevation = quantizeElevation(Number(tile.document?.elevation ?? 0));
    const id = tile.document?.id || tile.id;
    const typeInfo = resolveTileType(tile.document);
    tileEntries.push({
      id,
      name: computeTileName(tile, i),
      elevation,
      sort: Number(tile.document?.sort ?? 0),
      selected: controlled.has(id),
      hidden: isLayerHidden(tile.document),
      locked: !!tile.document?.locked,
      canToggleVisibility: !!tile.document?.canUserModify?.(game.user, 'update'),
      canToggleLock: !!tile.document?.canUserModify?.(game.user, 'update'),
      typeIcon: typeInfo.icon,
      typeLabel: typeInfo.label,
      index: i
    });
  }

  const previewEntries = collectPreviewEntries();
  const hasBackground = sceneHasBackgroundImage();
  const hasForeground = sceneHasForegroundImage();
  const foregroundElevation = hasForeground ? getForegroundElevation() : null;
  const backgroundElevation = hasBackground ? getBackgroundDisplayElevation() : null;
  const markerEntries = [];
  if (hasBackground) {
    const entry = buildSceneMarkerEntry('background', backgroundElevation);
    if (entry) markerEntries.push(entry);
  }
  if (hasForeground) {
    const entry = buildSceneMarkerEntry('foreground', foregroundElevation);
    if (entry) markerEntries.push(entry);
  }
  const items = tileEntries.concat(previewEntries, markerEntries);
  items.sort((a, b) => {
    const elevDiff = (Number(b.elevation ?? 0) - Number(a.elevation ?? 0));
    if (elevDiff) return elevDiff;
    const sortDiff = (Number(b.sort ?? 0) - Number(a.sort ?? 0));
    if (sortDiff) return sortDiff;
    const aRank = a.marker ? 2 : (a.preview ? 1 : 0);
    const bRank = b.marker ? 2 : (b.preview ? 1 : 0);
    if (aRank !== bRank) return aRank - bRank;
    const aIndex = Number.isFinite(a.index) ? a.index : null;
    const bIndex = Number.isFinite(b.index) ? b.index : null;
    if (aIndex !== null && bIndex !== null && aIndex !== bIndex) return aIndex - bIndex;
    const aKey = String(a.previewId ?? a.markerId ?? a.id ?? '');
    const bKey = String(b.previewId ?? b.markerId ?? b.id ?? '');
    if (aKey && bKey) return aKey.localeCompare(bKey);
    return 0;
  });

  let lastElevation = null;
  for (const item of items) {
    const elevation = Number(item.elevation ?? 0);
    if (lastElevation === null || elevation !== lastElevation) {
      const group = elevationGroups.get(elevation);
      const groupTiles = group?.tiles || [];
      const groupHidden = groupTiles.length ? groupTiles.every((groupTile) => isLayerHidden(groupTile.document)) : false;
      const groupLocked = groupTiles.length ? groupTiles.every((groupTile) => !!groupTile.document?.locked) : false;
      entries.push({
        separator: true,
        elevation: formatElevation(elevation),
        elevationValue: elevation,
        groupHidden,
        groupLocked,
        canToggleVisibility: !!group?.canToggleVisibility && groupTiles.length > 0,
        canToggleLock: !!group?.canToggleLock && groupTiles.length > 0
      });
      lastElevation = elevation;
    }
    entries.push(item);
  }
  if (hasForeground && Number.isFinite(foregroundElevation)) {
    const foregroundEntry = {
      separator: true,
      foregroundSeparator: true,
      foregroundElevation: formatElevation(foregroundElevation),
      foregroundElevationValue: foregroundElevation
    };
    const insertIndex = entries.findIndex((entry) => (
      entry?.separator && !entry?.foregroundSeparator
      && Number(entry.elevationValue) < foregroundElevation
    ));
    if (insertIndex === -1) entries.push(foregroundEntry);
    else entries.splice(insertIndex, 0, foregroundEntry);
  }
  return entries;
}

function insertTabAfterScenes() {
  const tabs = Sidebar.TABS;
  if (tabs[TAB_ID]) return;
  const descriptor = {
    tooltip: 'FA-NEXUS.LayerManager',
    icon: 'fa-solid fa-layer-group'
  };
  const entries = Object.entries(tabs);
  const next = [];
  let inserted = false;
  for (const [key, value] of entries) {
    next.push([key, value]);
    if (key === 'scenes') {
      next.push([TAB_ID, descriptor]);
      inserted = true;
    }
  }
  if (!inserted) next.push([TAB_ID, descriptor]);
  Sidebar.TABS = Object.fromEntries(next);
}

function registerLayerManagerTab() {
  try {
    insertTabAfterScenes();
    if (!CONFIG.ui[TAB_ID]) CONFIG.ui[TAB_ID] = LayerManagerTab;
    syncSelectionFilterFromSettings();
    ensureTileSelectionPatch();
    ensureTileSelectAllPatch();
    ensureTileForegroundSelectionPatch();
    ensureTileHoverSuppressionPatch();
    ensureCanvasHighlightSuppressionPatch();
    ensureLayerHiddenHooks();
  } catch (error) {
    Logger.warn('LayerManager.register.failed', { error: String(error?.message || error) });
  }
}

export class LayerManagerTab extends HandlebarsApplicationMixin(AbstractSidebarTab) {
  static tabName = TAB_ID;

  static DEFAULT_OPTIONS = {
    id: TAB_ID,
    classes: ['fa-nexus-layer-manager'],
    actions: {}
  };

  static PARTS = {
    content: {
      template: 'modules/fa-nexus/templates/layer-manager-tab.hbs',
      scrollable: ['.fa-nexus-layer-manager__list']
    }
  };

  constructor(options = {}) {
    super(options);
    this._hookIds = [];
    this._lastClickedIndex = -1;
    this._hoveredTileId = null;
    this._scrollQueued = false;
    this._scrollTargetId = null;
    this._scrollPreviewQueued = false;
    this._scrollPreviewTargetId = null;
    this._lastActivePreviewId = null;
    this._lastContextClick = { id: null, time: 0 };
    this._wheelSession = null;
    this._selectedSceneMarkers = new Set();
    this._lastElevationAnnounce = 0;
    this._elevationAnnounceTimer = null;
    this._pendingElevationAnnouncePoint = null;
    this._pendingElevationAnnounceMessage = null;
  }

  get title() {
    return game.i18n.localize('FA-NEXUS.LayerManager');
  }

  _onActivate() {
    this._setActiveClass(true);
    this._setFilterActive(true);
    this._ensureHooks();
    this._startWheelSession();
    this._clearHover();
    this._activateTilesLayer();
    this.render({ force: true });
  }

  _onDeactivate() {
    this._setActiveClass(false);
    this._setFilterActive(false);
    this._clearHover();
    this._stopWheelSession();
    this._clearElevationAnnounceTimer();
    this._selectedSceneMarkers?.clear?.();
    this._removeHooks();
  }

  async _prepareContext() {
    const { minRaw, maxRaw, skipLocked, skipHidden, ignoreForeground } = getElevationRangeFromSettings();
    const flattenState = this._getFlattenState();
    const entries = buildEntriesFromCanvas();
    if (this._selectedSceneMarkers?.size) {
      for (const entry of entries) {
        if (!entry?.marker) continue;
        entry.selected = this._selectedSceneMarkers.has(entry.markerKind);
      }
    }
    return {
      canvasReady: !!canvas?.ready,
      elevationMin: minRaw,
      elevationMax: maxRaw,
      skipLocked,
      skipHidden,
      ignoreForeground,
      flattenVisible: flattenState.visible,
      flattenDisabled: flattenState.disabled,
      flattenLabel: flattenState.label,
      flattenAriaLabel: flattenState.ariaLabel,
      flattenAction: flattenState.action,
      flattenIconClass: flattenState.iconClass,
      entries
    };
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this._setActiveClass(this.active);
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    const list = root.querySelector('.fa-nexus-layer-manager__list');
    const minInput = root.querySelector('input[data-range="min"]');
    const maxInput = root.querySelector('input[data-range="max"]');
    const skipLockedInput = root.querySelector('input[data-action="skip-locked"]');
    const skipHiddenInput = root.querySelector('input[data-action="skip-hidden"]');
    const ignoreForegroundInput = root.querySelector('input[data-action="ignore-foreground"]');
    const flattenButton = root.querySelector('button[data-action="flatten"]');

    if (list) {
      list.addEventListener('click', (event) => this._onListClick(event));
      list.addEventListener('dblclick', (event) => this._onListDoubleClick(event));
      list.addEventListener('contextmenu', (event) => this._onListContextMenu(event));
      list.addEventListener('mouseover', (event) => this._onListHover(event));
      list.addEventListener('mouseleave', () => this._clearHover());
      list.addEventListener('wheel', (event) => this._onListWheel(event), { passive: false });
    }

    if (minInput) {
      minInput.addEventListener('change', () => this._onRangeChange());
      minInput.addEventListener('input', () => this._onRangeChange(true));
    }

    if (maxInput) {
      maxInput.addEventListener('change', () => this._onRangeChange());
      maxInput.addEventListener('input', () => this._onRangeChange(true));
    }

    if (skipLockedInput) {
      skipLockedInput.addEventListener('change', () => this._onSkipLockedChange());
    }

    if (skipHiddenInput) {
      skipHiddenInput.addEventListener('change', () => this._onSkipHiddenChange());
    }

    if (ignoreForegroundInput) {
      ignoreForegroundInput.addEventListener('change', () => this._onIgnoreForegroundChange());
    }

    if (flattenButton) {
      if (flattenButton._faNexusFlattenHandler) {
        flattenButton.removeEventListener('click', flattenButton._faNexusFlattenHandler);
      }
      const handler = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const manager = getTileFlattenManager();
        const state = this._getFlattenState();
        this._updateFlattenFooter();
        if (state.action === 'deconstruct') {
          const selection = TileFlattenManager.getSelectedTiles();
          const doc = Array.isArray(selection) ? selection[0] : null;
          if (!doc) return;
          manager.confirmAndDeconstructTile(doc).catch((error) => {
            Logger.warn('LayerManager.deconstruct.failed', { error: String(error?.message || error) });
            ui?.notifications?.error?.(`Failed to deconstruct tile: ${error?.message || error}`);
          }).finally(() => {
            this._updateFlattenFooter();
          });
          return;
        }
        if (state.action === 'export') {
          manager.showExportDialog().catch((error) => {
            Logger.warn('LayerManager.export.failed', { error: String(error?.message || error) });
            ui?.notifications?.error?.(`Failed to export scene: ${error?.message || error}`);
          }).finally(() => {
            this._updateFlattenFooter();
          });
          return;
        }
        manager.showFlattenDialog().catch((error) => {
          Logger.warn('LayerManager.flatten.failed', { error: String(error?.message || error) });
          ui?.notifications?.error?.(`Failed to flatten tiles: ${error?.message || error}`);
        }).finally(() => {
          this._updateFlattenFooter();
        });
      };
      flattenButton._faNexusFlattenHandler = handler;
      flattenButton.addEventListener('click', handler);
    }

    this._updateFlattenFooter();
    this._syncPreviewScroll();
  }

  _getFlattenState() {
    const selection = TileFlattenManager.getSelectedTiles();
    const count = Array.isArray(selection) ? selection.length : 0;
    const singleDoc = count === 1 ? selection[0] : null;
    const singleFlattened = !!singleDoc && TileFlattenManager.isFlattenedTile(singleDoc);
    const singleMerged = !!singleDoc && TileFlattenManager.isMergedTile(singleDoc);
    const allowExport = count === 0;
    const allowFlatten = count > 1 || singleMerged || singleFlattened;
    const visible = allowExport || allowFlatten;
    const manager = getTileFlattenManager();
    const busy = manager?.isBusy ? manager.isBusy() : false;
    const action = singleFlattened ? 'deconstruct' : (allowExport ? 'export' : 'flatten');
    const label = singleFlattened
      ? 'Deconstruct flattened tile'
      : (action === 'export'
        ? 'Export / Flatten Scene'
        : (count > 1
          ? `Flatten ${count} selected tile${count === 1 ? '' : 's'}`
          : (singleMerged ? 'Flatten merged tile' : 'Flatten tiles')));
    const ariaLabel = singleFlattened
      ? 'Deconstruct flattened tile in FA Nexus'
      : (action === 'export'
        ? 'Export or flatten scene in FA Nexus'
        : (count > 1
          ? `Flatten ${count} selected tile${count === 1 ? '' : 's'} in FA Nexus`
          : (singleMerged ? 'Flatten merged tile in FA Nexus' : 'Flatten tiles in FA Nexus')));
    const iconClass = singleFlattened
      ? 'fa-object-ungroup'
      : (action === 'export' ? 'fa-file-export' : 'fa-compress-arrows-alt');
    const canvasReady = !!canvas?.ready;
    return {
      visible,
      disabled: !visible || busy || !canvasReady,
      label,
      ariaLabel,
      count,
      action,
      iconClass
    };
  }

  _updateFlattenFooter() {
    const root = this.element;
    if (!root) return;
    const footer = root.querySelector('.fa-nexus-layer-manager__footer');
    const button = root.querySelector('button[data-action="flatten"]');
    if (!footer || !button) return;
    const state = this._getFlattenState();
    if (state.visible) footer.removeAttribute('hidden');
    else footer.setAttribute('hidden', 'hidden');
    button.disabled = state.disabled;
    button.classList.toggle('disabled', state.disabled);
    const label = state.label || 'Flatten tiles';
    const labelEl = button.querySelector('.fa-nexus-layer-manager__flatten-label');
    if (labelEl) labelEl.textContent = label;
    const iconEl = button.querySelector('.fa-nexus-layer-manager__flatten-icon');
    if (iconEl && state.iconClass) {
      iconEl.className = `fas ${state.iconClass} fa-nexus-layer-manager__flatten-icon`;
    }
    button.dataset.mode = state.action || 'flatten';
    button.setAttribute('aria-label', state.ariaLabel || label);
    button.title = state.ariaLabel || label;
    if (state.disabled) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
  }

  _ensureHooks() {
    if (!globalThis.Hooks || this._hookIds.length) return;
    const hook = (name, fn) => {
      try { Hooks.on(name, fn); } catch (_) { return; }
      this._hookIds.push({ name, fn });
    };

    const refresh = () => {
      if (this.active || this.isPopout) this._startWheelSession();
      this._scheduleRender();
    };
    const syncSelection = (tile, controlled) => this._syncSelectionFromCanvas(tile, controlled);

    hook('createTile', refresh);
    hook('updateTile', refresh);
    hook('deleteTile', refresh);
    hook('canvasReady', refresh);
    hook('canvasTearDown', refresh);
    hook('updateScene', refresh);
    hook('fa-nexus-preview-layers-changed', refresh);
    hook('controlTile', syncSelection);
  }

  _removeHooks() {
    if (!globalThis.Hooks || !this._hookIds.length) return;
    for (const { name, fn } of this._hookIds) {
      try { Hooks.off(name, fn); } catch (_) {}
    }
    this._hookIds = [];
  }

  _scheduleRender() {
    if (!this.rendered || (!this.active && !this.isPopout)) return;
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this.render({ parts: ['content'] });
    });
  }

  _activateTilesLayer() {
    try {
      if (canvas?.tiles && canvas.activeLayer !== canvas.tiles) canvas.tiles.activate();
    } catch (_) {}
  }

  _onRangeChange(isInput = false) {
    const root = this.element;
    if (!root) return;
    const minInput = root.querySelector('input[data-range="min"]');
    const maxInput = root.querySelector('input[data-range="max"]');
    const minRaw = minInput?.value ?? '';
    const maxRaw = maxInput?.value ?? '';
    const minValue = minRaw.trim();
    const maxValue = maxRaw.trim();
    selectionFilterState.min = parseElevationInput(minValue);
    selectionFilterState.max = parseElevationInput(maxValue);
    if ((minValue || maxValue) && !selectionFilterState.ignoreForeground) {
      selectionFilterState.ignoreForeground = true;
      const ignoreInput = root.querySelector('input[data-action="ignore-foreground"]');
      if (ignoreInput) ignoreInput.checked = true;
      if (!isInput) writeSetting(IGNORE_FOREGROUND_SETTING, true);
      refreshTileInteractionState();
    }
    if (!isInput) {
      writeSetting(RANGE_MIN_SETTING, minValue);
      writeSetting(RANGE_MAX_SETTING, maxValue);
    }
  }

  _onSkipLockedChange() {
    const root = this.element;
    if (!root) return;
    const input = root.querySelector('input[data-action="skip-locked"]');
    const value = !!input?.checked;
    selectionFilterState.skipLocked = value;
    writeSetting(SKIP_LOCKED_SETTING, value);
  }

  _onSkipHiddenChange() {
    const root = this.element;
    if (!root) return;
    const input = root.querySelector('input[data-action="skip-hidden"]');
    const value = !!input?.checked;
    selectionFilterState.skipHidden = value;
    writeSetting(SKIP_HIDDEN_SETTING, value);
    refreshTileInteractionState();
  }

  _onIgnoreForegroundChange() {
    const root = this.element;
    if (!root) return;
    const input = root.querySelector('input[data-action="ignore-foreground"]');
    const value = !!input?.checked;
    selectionFilterState.ignoreForeground = value;
    writeSetting(IGNORE_FOREGROUND_SETTING, value);
    refreshTileInteractionState();
  }

  _setFilterActive(active) {
    const next = !!active;
    if (selectionFilterState.active === next) return;
    selectionFilterState.active = next;
    if (next) setAltKeyHeld(isAltModifierActive());
    if (selectionFilterState.ignoreForeground) refreshTileInteractionState();
  }

  _setActiveClass(active) {
    const el = this.element;
    if (!el) return;
    el.classList.toggle('active', this.isPopout ? true : !!active);
    if (!el.dataset.tab) el.dataset.tab = TAB_ID;
    if (!el.dataset.group) el.dataset.group = 'primary';
  }

  _onListClick(event) {
    const sceneMarker = event.target?.closest?.('[data-scene-marker]');
    if (sceneMarker) {
      event.preventDefault();
      event.stopPropagation();
      this._selectSceneMarker(sceneMarker, event);
      return;
    }

    const elevationToggle = event.target?.closest?.('[data-action="toggle-elevation-visibility"]');
    if (elevationToggle) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleElevationVisibility(elevationToggle);
      return;
    }

    const elevationLockToggle = event.target?.closest?.('[data-action="toggle-elevation-lock"]');
    if (elevationLockToggle) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleElevationLock(elevationLockToggle);
      return;
    }

    const visibilityToggle = event.target?.closest?.('[data-action="toggle-visibility"]');
    if (visibilityToggle) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleVisibility(visibilityToggle);
      return;
    }

    const lockToggle = event.target?.closest?.('[data-action="toggle-lock"]');
    if (lockToggle) {
      event.preventDefault();
      event.stopPropagation();
      this._toggleLock(lockToggle);
      return;
    }

    const separator = event.target?.closest?.('.fa-nexus-layer-manager__separator');
    if (separator) {
      event.preventDefault();
      event.stopPropagation();
      this._selectElevation(separator, event);
      return;
    }

    const target = event.target?.closest?.('[data-tile-id]');
    if (!target) return;
    const list = target.parentElement;
    const items = list ? Array.from(list.querySelectorAll('[data-tile-id]')) : [target];
    const currentIndex = items.indexOf(target);
    const tileId = target.dataset.tileId;
    if (!tileId) return;

    this._activateTilesLayer();

    const tile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === tileId);
    if (!tile) return;

    const isMeta = !!(event.ctrlKey || event.metaKey);
    const isShift = !!event.shiftKey;

    if (!isMeta) this._clearSceneMarkerSelection();

    if (isShift && this._lastClickedIndex >= 0) {
      const start = Math.min(this._lastClickedIndex, currentIndex);
      const end = Math.max(this._lastClickedIndex, currentIndex);
      if (!isMeta) {
        try { canvas.tiles.releaseAll(); } catch (_) {}
      }
      for (let i = start; i <= end; i += 1) {
        const rangeId = items[i]?.dataset?.tileId;
        if (!rangeId) continue;
        const rangeTile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === rangeId);
        if (!rangeTile) continue;
        try { rangeTile.control({ releaseOthers: false }); } catch (_) {}
      }
    } else if (isMeta) {
      try {
        if (tile.controlled) tile.release();
        else tile.control({ releaseOthers: false });
      } catch (_) {}
    } else {
      try { tile.control({ releaseOthers: true }); } catch (_) {}
    }

    this._lastClickedIndex = currentIndex;
    this._syncSelectionFromCanvas();
  }

  _onListDoubleClick(event) {
    if (event.target?.closest?.('[data-action="toggle-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-lock"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-lock"]')) return;
    if (event.target?.closest?.('[data-scene-marker]')) {
      this._openSceneSettings();
      return;
    }
    const target = event.target?.closest?.('[data-tile-id]');
    if (!target) return;
    const tileId = target.dataset.tileId;
    if (!tileId) return;
    const tile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === tileId);
    if (!tile) return;
    this._activateTilesLayer();
    try {
      const center = tile.center || { x: tile.document?.x ?? 0, y: tile.document?.y ?? 0 };
      canvas.animatePan({ x: center.x, y: center.y, duration: 250 });
    } catch (_) {}
  }

  _onListContextMenu(event) {
    if (event.target?.closest?.('[data-action="toggle-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-visibility"]')) return;
    if (event.target?.closest?.('[data-action="toggle-lock"]')) return;
    if (event.target?.closest?.('[data-action="toggle-elevation-lock"]')) return;
    const target = event.target?.closest?.('[data-tile-id]');
    if (!target) return;
    event.preventDefault();
    const tileId = target.dataset.tileId;
    if (!tileId) return;
    this._activateTilesLayer();
    const tile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === tileId);
    if (!tile) return;
    if (this._isDoubleContextClick(tileId)) {
      this._openTileSettings(tile);
      return;
    }
    const stub = Object.assign({}, clickEventStub, { shiftKey: !!event.shiftKey });
    try { tile._onClickRight?.(stub); } catch (_) {}
    this._syncSelectionFromCanvas();
  }

  _onListHover(event) {
    const target = event.target?.closest?.('[data-tile-id]');
    if (!target) return;
    const tileId = target.dataset.tileId;
    if (!tileId || tileId === this._hoveredTileId) return;
    this._clearHover();
    const tile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === tileId);
    if (!tile) return;
    if (isTileBeingEdited(tile)) return;
    try { tile._onHoverIn(hoverEventStub, { hoverOutOthers: true }); } catch (_) {}
    this._hoveredTileId = tileId;
  }

  _startWheelSession() {
    if (this._wheelSession || !canvas?.ready) return;
    this._wheelSession = createCanvasGestureSession({
      wheel: { handler: (event, { pointer }) => this._onCanvasWheel(event, pointer), respectZIndex: true },
      keydown: (event) => this._onCanvasKeyDown(event),
      keyup: (event) => this._onCanvasKeyUp(event)
    }, {
      onCanvasTearDown: () => this._stopWheelSession()
    });
  }

  _stopWheelSession() {
    if (!this._wheelSession) return;
    try { this._wheelSession.stop('layer-manager'); } catch (_) {}
    this._wheelSession = null;
    this._clearElevationAnnounceTimer();
  }

  _onCanvasKeyDown(event) {
    if (!event) return;
    if (event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight') {
      setAltKeyHeld(true);
    }
  }

  _onCanvasKeyUp(event) {
    if (!event) return;
    if (event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight') {
      setAltKeyHeld(false);
    }
  }

  _onCanvasWheel(event, pointer) {
    if (!this.active && !this.isPopout) return;
    if (!pointer?.overCanvas || !pointer?.zOk) return;
    this._handleElevationWheel(event, pointer);
  }

  _handleElevationWheel(event, pointer = null) {
    const altActive = !!event?.altKey;
    if (event) setAltKeyHeld(altActive);
    if (!altActive) return;

    const direction = event.deltaY < 0 ? 1 : -1;
    const fineModifier = event.ctrlKey || event.metaKey;
    const baseStep = fineModifier ? 0.01 : 0.1;
    const step = event.shiftKey ? baseStep * 5 : baseStep;

    if (!canvas?.ready || !canvas?.scene) return;
    let markerAdjusted = false;
    if (this._selectedSceneMarkers?.size) {
      for (const markerKind of this._selectedSceneMarkers) {
        if (this._adjustSceneMarkerElevation(markerKind, direction, step, pointer)) {
          markerAdjusted = true;
        }
      }
    }

    if (!canvas?.tiles && !markerAdjusted) return;
    if (!canvas?.tiles) {
      if (markerAdjusted && event) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
      }
      return;
    }
    const selection = Array.isArray(canvas.tiles.controlled) ? canvas.tiles.controlled : [];
    if (!selection.length && !markerAdjusted) return;
    const minElevation = -1000;
    const maxElevation = 1000;
    const groups = new Map();
    let announceElevation = null;

    for (const tile of selection) {
      const doc = tile?.document;
      if (!doc?.canUserModify?.(game.user, 'update')) continue;
      if (doc?.locked) continue;
      const current = Number(doc.elevation ?? 0) || 0;
      const clamped = Math.min(maxElevation, Math.max(minElevation, current + direction * step));
      const next = quantizeElevation(clamped);
      if (next === current) continue;
      const id = doc.id || doc._id;
      if (!id) continue;
      if (announceElevation === null) announceElevation = next;
      let group = groups.get(next);
      if (!group) {
        group = [];
        groups.set(next, group);
      }
      group.push({ id, elevation: next });
    }

    if (!groups.size && !markerAdjusted) return;
    if (!groups.size && markerAdjusted && event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      return;
    }
    const updates = [];
    for (const [elevation, items] of groups.entries()) {
      let nextSort = computeNextSortAtElevation(elevation);
      if (!Number.isFinite(nextSort)) nextSort = 0;
      for (const item of items) {
        updates.push({ _id: item.id, elevation, sort: nextSort });
        nextSort += 2;
      }
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    if (updates.length) {
      try { canvas.scene.updateEmbeddedDocuments('Tile', updates); } catch (_) {}
    }
    if (Number.isFinite(announceElevation)) {
      this._queueElevationAnnounce(pointer?.world || null, announceElevation);
    }
  }

  _onListWheel(event) {
    this._handleElevationWheel(event);
  }

  _clearElevationAnnounceTimer() {
    if (this._elevationAnnounceTimer) {
      clearTimeout(this._elevationAnnounceTimer);
      this._elevationAnnounceTimer = null;
    }
    this._pendingElevationAnnouncePoint = null;
    this._pendingElevationAnnounceMessage = null;
  }

  _queueElevationAnnounce(worldPoint, elevation, options = {}) {
    if (!Number.isFinite(elevation)) return;
    const now = Date.now();
    const delta = now - this._lastElevationAnnounce;
    const throttleMs = 75;
    const immediate = options?.immediate === true;
    this._pendingElevationAnnouncePoint = worldPoint ?? this._pendingElevationAnnouncePoint ?? null;
    this._pendingElevationAnnounceMessage = `Elevation: ${formatElevation(elevation)}`;

    if (immediate || delta >= throttleMs) {
      this._flushElevationAnnounce();
      return;
    }

    const remaining = Math.max(0, throttleMs - delta);
    if (this._elevationAnnounceTimer) clearTimeout(this._elevationAnnounceTimer);
    this._elevationAnnounceTimer = setTimeout(() => {
      this._elevationAnnounceTimer = null;
      this._flushElevationAnnounce();
    }, remaining);
  }

  _flushElevationAnnounce() {
    try {
      this._lastElevationAnnounce = Date.now();
      const worldPoint = this._pendingElevationAnnouncePoint ?? null;
      const message = this._pendingElevationAnnounceMessage ?? '';
      this._pendingElevationAnnouncePoint = null;
      this._pendingElevationAnnounceMessage = null;
      if (!worldPoint || !message) return;
      if (canvas?.interface?.createScrollingText && globalThis.CONST?.TEXT_ANCHOR_POINTS) {
        canvas.interface.createScrollingText(worldPoint, message, {
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

  _clearHover() {
    if (!this._hoveredTileId) return;
    const tile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === this._hoveredTileId);
    if (tile) {
      try { tile._onHoverOut(hoverEventStub); } catch (_) {}
    }
    this._hoveredTileId = null;
  }

  _toggleVisibility(buttonEl) {
    const item = buttonEl?.closest?.('[data-tile-id]');
    if (!item) return;
    const tileId = item.dataset.tileId;
    if (!tileId) return;
    const tile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === tileId);
    if (!tile) return;
    const selection = Array.isArray(canvas?.tiles?.controlled) ? canvas.tiles.controlled : [];
    const useSelection = tile.controlled && selection.length > 1;
    const targets = useSelection ? selection : [tile];
    const toggleTargets = targets.filter((target) => target?.document?.canUserModify?.(game.user, 'update'));
    if (!toggleTargets.length) return;
    const allHidden = toggleTargets.every((target) => isLayerHidden(target.document));
    const nextHidden = !allHidden;
    for (const target of toggleTargets) {
      setLayerHidden(target.document, nextHidden);
    }
  }

  _toggleElevationVisibility(buttonEl) {
    const separator = buttonEl?.closest?.('.fa-nexus-layer-manager__separator');
    const rawElevation = buttonEl?.dataset?.elevation || separator?.dataset?.elevation;
    const elevation = Number(rawElevation);
    if (!Number.isFinite(elevation)) return;
    const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    const targets = tiles.filter((tile) => {
      if (!tile || tile.destroyed) return false;
      const docElevation = Number(tile.document?.elevation ?? 0);
      return docElevation === elevation;
    });
    const toggleTargets = targets.filter((target) => target?.document?.canUserModify?.(game.user, 'update'));
    if (!toggleTargets.length) return;
    const allHidden = toggleTargets.every((target) => isLayerHidden(target.document));
    const nextHidden = !allHidden;
    for (const target of toggleTargets) {
      setLayerHidden(target.document, nextHidden);
    }
  }

  _toggleLock(buttonEl) {
    const item = buttonEl?.closest?.('[data-tile-id]');
    if (!item) return;
    const tileId = item.dataset.tileId;
    if (!tileId) return;
    const tile = canvas?.tiles?.placeables?.find((t) => (t?.document?.id || t?.id) === tileId);
    if (!tile) return;
    const selection = Array.isArray(canvas?.tiles?.controlled) ? canvas.tiles.controlled : [];
    const useSelection = tile.controlled && selection.length > 1;
    const targets = useSelection ? selection : [tile];
    const toggleTargets = targets.filter((target) => target?.document?.canUserModify?.(game.user, 'update'));
    if (!toggleTargets.length) return;
    const allLocked = toggleTargets.every((target) => !!target.document?.locked);
    const nextLocked = !allLocked;
    for (const target of toggleTargets) {
      try { target.document.update({ locked: nextLocked }); } catch (_) {}
    }
  }

  _toggleElevationLock(buttonEl) {
    const separator = buttonEl?.closest?.('.fa-nexus-layer-manager__separator');
    const rawElevation = buttonEl?.dataset?.elevation || separator?.dataset?.elevation;
    const elevation = Number(rawElevation);
    if (!Number.isFinite(elevation)) return;
    const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    const targets = tiles.filter((tile) => {
      if (!tile || tile.destroyed) return false;
      const docElevation = Number(tile.document?.elevation ?? 0);
      return docElevation === elevation;
    });
    const toggleTargets = targets.filter((target) => target?.document?.canUserModify?.(game.user, 'update'));
    if (!toggleTargets.length) return;
    const allLocked = toggleTargets.every((target) => !!target.document?.locked);
    const nextLocked = !allLocked;
    for (const target of toggleTargets) {
      try { target.document.update({ locked: nextLocked }); } catch (_) {}
    }
  }

  _clearSceneMarkerSelection() {
    if (!this._selectedSceneMarkers?.size) return;
    this._selectedSceneMarkers.clear();
    this._scheduleRender();
  }

  _selectSceneMarker(markerEl, event = null) {
    const kindRaw = markerEl?.dataset?.sceneMarker;
    const kind = kindRaw === 'foreground' ? 'foreground' : (kindRaw === 'background' ? 'background' : null);
    if (!kind) return;
    const isMeta = !!(event?.ctrlKey || event?.metaKey);
    const isShift = !!event?.shiftKey;
    const allowMulti = isMeta || isShift;
    if (!allowMulti) {
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      this._selectedSceneMarkers.clear();
      this._selectedSceneMarkers.add(kind);
    } else if (this._selectedSceneMarkers.has(kind)) {
      this._selectedSceneMarkers.delete(kind);
    } else {
      this._selectedSceneMarkers.add(kind);
    }
    this._scheduleRender();
    this._updateFlattenFooter();
  }

  _adjustSceneMarkerElevation(kind, direction, step, pointer = null) {
    const current = kind === 'foreground' ? getForegroundElevation() : getBackgroundElevation();
    if (!Number.isFinite(current)) return false;
    const minElevation = -1000;
    const maxElevation = 1000;
    const raw = current + (direction * step);
    const clamped = Math.min(maxElevation, Math.max(minElevation, raw));
    const next = quantizeElevation(clamped);
    if (next === current) return false;

    if (kind === 'foreground') {
      try { canvas?.scene?.update?.({ foregroundElevation: next }); } catch (_) {}
    } else {
      try {
        if (canvas?.scene && ('backgroundElevation' in canvas.scene)) {
          canvas.scene.update?.({ backgroundElevation: next });
        }
      } catch (_) {}
      setBackgroundRenderElevation(next);
      try {
        const enabled = isKeepTokensAboveTileElevationsEnabled();
        Hooks?.callAll?.('fa-nexus-token-elevation-offset-changed', { enabled });
      } catch (_) {}
    }

    const announceElevation = (kind === 'background')
      ? getBackgroundDisplayElevation()
      : next;
    this._queueElevationAnnounce(pointer?.world || null, announceElevation, { immediate: true });
    this._scheduleRender();
    return true;
  }

  _selectElevation(separatorEl, event) {
    const rawElevation = separatorEl?.dataset?.elevation;
    const elevation = Number(rawElevation);
    if (!Number.isFinite(elevation)) return;
    const tiles = Array.isArray(canvas?.tiles?.placeables) ? canvas.tiles.placeables : [];
    const targets = tiles.filter((tile) => {
      if (!tile || tile.destroyed) return false;
      const docElevation = Number(tile.document?.elevation ?? 0);
      return docElevation === elevation;
    });
    if (!targets.length) return;
    this._activateTilesLayer();
    const retain = !!(event?.ctrlKey || event?.metaKey);
    if (!retain) this._clearSceneMarkerSelection();
    if (!retain) {
      try { canvas.tiles.releaseAll(); } catch (_) {}
    }
    for (const target of targets) {
      try { target.control({ releaseOthers: false }); } catch (_) {}
    }
    this._syncSelectionFromCanvas();
  }

  _isDoubleContextClick(tileId) {
    const now = Date.now();
    const last = this._lastContextClick || { id: null, time: 0 };
    const isDouble = last.id === tileId && (now - last.time) < CONTEXT_DOUBLE_CLICK_MS;
    this._lastContextClick = { id: tileId, time: now };
    return isDouble;
  }

  _openTileSettings(tile) {
    const canView = tile.document?.testUserPermission?.(game.user, 'LIMITED');
    if (!canView) return;
    const stub = Object.assign({}, clickEventStub);
    if (typeof tile._onClickRight2 === 'function') {
      try { tile._onClickRight2(stub); } catch (_) {}
      return;
    }
    try { tile.sheet?.render?.({ force: true }); } catch (_) {}
  }

  _openSceneSettings() {
    try { canvas?.scene?.sheet?.render?.({ force: true }); } catch (_) {}
  }

  _queueScrollToTile(tileId) {
    if (!tileId || (!this.active && !this.isPopout)) return;
    this._scrollTargetId = tileId;
    if (this._scrollQueued) return;
    this._scrollQueued = true;
    requestAnimationFrame(() => {
      this._scrollQueued = false;
      const targetId = this._scrollTargetId;
      this._scrollTargetId = null;
      this._scrollToTile(targetId);
    });
  }

  _queueScrollToPreview(previewId) {
    if (!previewId || (!this.active && !this.isPopout)) return;
    this._scrollPreviewTargetId = previewId;
    if (this._scrollPreviewQueued) return;
    this._scrollPreviewQueued = true;
    requestAnimationFrame(() => {
      this._scrollPreviewQueued = false;
      const targetId = this._scrollPreviewTargetId;
      this._scrollPreviewTargetId = null;
      this._scrollToPreview(targetId);
    });
  }

  _scrollToTile(tileId) {
    const root = this.element;
    if (!root || !tileId) return;
    const list = root.querySelector('.fa-nexus-layer-manager__list');
    if (!list) return;
    const item = list.querySelector(`[data-tile-id="${CSS.escape(tileId)}"]`);
    if (!item) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
      try { item.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    }
  }

  _scrollToPreview(previewId) {
    const root = this.element;
    if (!root || !previewId) return;
    const list = root.querySelector('.fa-nexus-layer-manager__list');
    if (!list) return;
    const item = list.querySelector(`[data-preview-id="${CSS.escape(previewId)}"]`);
    if (!item) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
      try { item.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    }
  }

  _syncPreviewScroll() {
    const root = this.element;
    if (!root) return;
    const list = root.querySelector('.fa-nexus-layer-manager__list');
    if (!list) return;
    const activePreview = list.querySelector('.fa-nexus-layer-manager__item.is-preview.is-selected');
    if (!activePreview) {
      this._lastActivePreviewId = null;
      return;
    }
    const previewId = activePreview.dataset?.previewId || null;
    if (!previewId) return;
    if (previewId !== this._lastActivePreviewId) {
      this._lastActivePreviewId = previewId;
      this._queueScrollToPreview(previewId);
      return;
    }
    const listRect = list.getBoundingClientRect();
    const itemRect = activePreview.getBoundingClientRect();
    if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
      this._queueScrollToPreview(previewId);
    }
  }

  _syncSelectionFromCanvas(tile = null, controlled = null) {
    const root = this.element;
    if (!root) return;
    const list = root.querySelector('.fa-nexus-layer-manager__list');
    if (!list) return;
    if (tile) {
      const id = tile?.document?.id || tile?.id;
      if (!id) return;
      const item = list.querySelector(`[data-tile-id="${CSS.escape(id)}"]`);
      if (item) {
        const isSelected = controlled === null ? !!tile.controlled : !!controlled;
        item.classList.toggle('is-selected', isSelected);
        item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        if (isSelected) this._queueScrollToTile(id);
      }
      this._updateFlattenFooter();
      return;
    }

    const selectedIds = new Set((canvas?.tiles?.controlled || []).map((t) => t?.document?.id || t?.id));
    for (const item of list.querySelectorAll('[data-tile-id]')) {
      const id = item.dataset.tileId;
      const isSelected = selectedIds.has(id);
      item.classList.toggle('is-selected', isSelected);
      item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    }
    this._updateFlattenFooter();
  }
}

try {
  Hooks.once('init', () => {
    registerLayerManagerTab();
  });
} catch (_) {}

try {
  Hooks.once('canvasReady', () => {
    ensureTileSelectionPatch();
    ensureTileSelectAllPatch();
    ensureTileForegroundSelectionPatch();
    ensureTileHoverSuppressionPatch();
    ensureCanvasHighlightSuppressionPatch();
    ensureLayerHiddenHooks();
  });
} catch (_) {}
