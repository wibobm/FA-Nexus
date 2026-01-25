import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { ensureTileMesh, getTransparentTexture, loadTexture } from '../textures/texture-render.js';

const MODULE_ID = 'fa-nexus';

function resolveFlattenedMeta(doc) {
  if (!doc) return null;
  try {
    const meta = doc.getFlag?.(MODULE_ID, 'flattened');
    if (meta && typeof meta === 'object') return meta;
  } catch (_) {}
  try {
    const flags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID];
    if (flags?.flattened && typeof flags.flattened === 'object') return flags.flattened;
  } catch (_) {}
  return null;
}

function resolveChunkEntries(doc) {
  const meta = resolveFlattenedMeta(doc);
  const chunks = Array.isArray(meta?.chunks) ? meta.chunks : [];
  if (!chunks.length) return [];
  const normalized = [];
  for (const chunk of chunks) {
    const src = String(chunk?.src || '').trim();
    if (!src) continue;
    const width = Number(chunk?.width) || 0;
    const height = Number(chunk?.height) || 0;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
    normalized.push({
      src,
      x: Number(chunk?.x) || 0,
      y: Number(chunk?.y) || 0,
      width,
      height
    });
  }
  return normalized;
}

function buildRenderKey(chunks) {
  if (!chunks?.length) return '';
  return chunks.map((chunk) => `${chunk.src}|${chunk.x}|${chunk.y}|${chunk.width}|${chunk.height}`).join(';');
}

function ensureFlattenMeshTransparent(mesh) {
  try {
    if (!mesh || mesh.destroyed) return;
    if (!mesh.faNexusFlattenOriginalTexture) mesh.faNexusFlattenOriginalTexture = mesh.texture;
    const placeholder = getTransparentTexture();
    if (mesh.texture !== placeholder) mesh.texture = placeholder;
    mesh.alpha = 1;
    mesh.renderable = true;
  } catch (_) {}
}

function restoreFlattenMeshTexture(mesh) {
  try {
    if (!mesh || mesh.destroyed) return;
    if (mesh.faNexusFlattenOriginalTexture) {
      mesh.texture = mesh.faNexusFlattenOriginalTexture;
      mesh.faNexusFlattenOriginalTexture = null;
    }
  } catch (_) {}
}

export async function applyFlattenedChunks(tile) {
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    const chunks = resolveChunkEntries(doc);
    if (!chunks.length) {
      cleanupFlattenedChunks(tile);
      return;
    }

    const mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) return;

    ensureFlattenMeshTransparent(mesh);

    let container = tile.faNexusFlattenChunkContainer || mesh.faNexusFlattenChunkContainer;
    const renderKey = buildRenderKey(chunks);
    const reuse = container && !container.destroyed && container.faNexusFlattenChunkRenderKey === renderKey;

    if (!container || container.destroyed) {
      container = new PIXI.Container();
      container.eventMode = 'none';
      container.sortableChildren = false;
      mesh.addChild(container);
      mesh.faNexusFlattenChunkContainer = container;
      tile.faNexusFlattenChunkContainer = container;
    } else if (container.parent !== mesh) {
      try { container.parent?.removeChild?.(container); } catch (_) {}
      mesh.addChild(container);
      mesh.faNexusFlattenChunkContainer = container;
      tile.faNexusFlattenChunkContainer = container;
    }

    try {
      const docAlpha = Number(doc?.alpha);
      const containerAlpha = Number.isFinite(docAlpha) ? Math.min(1, Math.max(0, docAlpha)) : 1;
      container.alpha = containerAlpha;
    } catch (_) {}

    const docWidth = Math.max(1, Number(doc?.width) || 0) || Math.max(1, Number(mesh?.width) || 1);
    const docHeight = Math.max(1, Number(doc?.height) || 0) || Math.max(1, Number(mesh?.height) || 1);
    const sx = Number(mesh?.scale?.x ?? 1) || 1;
    const sy = Number(mesh?.scale?.y ?? 1) || 1;
    const anchorX = Number(doc?.texture?.anchorX);
    const anchorY = Number(doc?.texture?.anchorY);
    const ax = Number.isFinite(anchorX) ? anchorX : 0.5;
    const ay = Number.isFinite(anchorY) ? anchorY : 0.5;
    try {
      container.scale?.set?.(1 / sx, 1 / sy);
      container.position?.set?.(-(docWidth * ax) / (sx || 1), -(docHeight * ay) / (sy || 1));
    } catch (_) {
      try { container.scale?.set?.(1, 1); } catch (_) {}
      container.position?.set?.(-docWidth / 2, -docHeight / 2);
    }

    if (reuse) return;

    const existingBuild = tile._faNexusFlattenChunkBuild;
    if (existingBuild && existingBuild.key === renderKey) {
      return existingBuild.promise;
    }

    const build = { key: renderKey, promise: null };
    tile._faNexusFlattenChunkBuild = build;
    build.promise = (async () => {
      const loadJobs = chunks.map(async (chunk) => {
        try {
          const texture = await loadTexture(chunk.src, { attempts: 3, timeout: 5000 });
          return { chunk, texture };
        } catch (error) {
          Logger.debug?.('TileFlatten.chunkTextureFailed', {
            error: String(error?.message || error),
            src: chunk.src
          });
          return null;
        }
      });
      const results = await Promise.all(loadJobs);

      if (tile._faNexusFlattenChunkBuild !== build) {
        return;
      }

      const nextSprites = [];
      for (const result of results) {
        if (!result) continue;
        const { chunk, texture } = result;
        const sprite = new PIXI.Sprite(texture);
        sprite.eventMode = 'none';
        sprite.position.set(chunk.x, chunk.y);
        sprite.width = chunk.width;
        sprite.height = chunk.height;
        nextSprites.push(sprite);
      }

      if (tile._faNexusFlattenChunkBuild !== build) {
        for (const sprite of nextSprites) {
          try { sprite.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
        }
        return;
      }

      const prevChildren = container.children?.slice() || [];
      container.removeChildren();
      for (const child of prevChildren) {
        try { child.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }
      for (const sprite of nextSprites) {
        container.addChild(sprite);
      }

      container.faNexusFlattenChunkRenderKey = renderKey;
      mesh.faNexusFlattenChunkContainer = container;
      tile.faNexusFlattenChunkContainer = container;
    })();

    try {
      await build.promise;
    } finally {
      if (tile._faNexusFlattenChunkBuild === build) {
        delete tile._faNexusFlattenChunkBuild;
      }
    }
  } catch (error) {
    Logger.debug?.('TileFlatten.applyChunks.failed', { error: String(error?.message || error) });
  }
}

export function cleanupFlattenedChunks(tile) {
  try {
    if (!tile) return;
    try { delete tile._faNexusFlattenChunkBuild; } catch (_) {}
    const mesh = tile.mesh;
    const container = mesh?.faNexusFlattenChunkContainer || tile.faNexusFlattenChunkContainer;
    if (container) {
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    }
    if (mesh) restoreFlattenMeshTexture(mesh);
    if (mesh) mesh.faNexusFlattenChunkContainer = null;
    tile.faNexusFlattenChunkContainer = null;
  } catch (_) {}
}

export function rehydrateAllFlattenedChunks() {
  try {
    const tiles = canvas?.tiles?.placeables;
    if (!Array.isArray(tiles)) return;
    for (const tile of tiles) {
      try { applyFlattenedChunks(tile); } catch (_) {}
    }
  } catch (_) {}
}

try {
  Hooks.on('canvasReady', () => {
    try { rehydrateAllFlattenedChunks(); } catch (_) {}
  });
  Hooks.on('drawTile', (tile) => {
    try { applyFlattenedChunks(tile); } catch (_) {}
  });
  Hooks.on('refreshTile', (tile) => {
    try { applyFlattenedChunks(tile); } catch (_) {}
  });
  Hooks.on('hoverTile', (tile) => {
    try { applyFlattenedChunks(tile); } catch (_) {}
  });
  Hooks.on('controlTile', (tile) => {
    try { applyFlattenedChunks(tile); } catch (_) {}
  });
  Hooks.on('createTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) applyFlattenedChunks(tile);
    } catch (_) {}
  });
  Hooks.on('updateTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) applyFlattenedChunks(tile);
    } catch (_) {}
  });
  Hooks.on('deleteTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) cleanupFlattenedChunks(tile);
    } catch (_) {}
  });
} catch (_) {}
