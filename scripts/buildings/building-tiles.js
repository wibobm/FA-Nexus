import { NexusLogger as Logger } from '../core/nexus-logger.js';
import BuildingWallMesher from './building-wall-mesher.js';
import { gatherBuildingLoops } from './building-shape-helpers.js';
import {
  loadTexture,
  getTransparentTexture
} from '../textures/texture-render.js';

function shouldSkipLinkedBuildingDeletes() {
  try { return !!globalThis?.FA_NEXUS_SUPPRESS_BUILDING_TILE_DELETE; }
  catch (_) { return false; }
}

function ensureBuildingMeshTransparent(mesh) {
  try {
    if (!mesh || mesh.destroyed) return;
    if (!mesh.faNexusBuildingOriginalTexture) {
      mesh.faNexusBuildingOriginalTexture = mesh.texture;
    }
    const placeholder = getTransparentTexture();
    if (mesh.texture !== placeholder) mesh.texture = placeholder;
    if (!Number.isFinite(mesh.alpha)) mesh.alpha = 1;
    mesh.renderable = true;
  } catch (_) {}
}

const DEFAULT_GRID_SCALE = 200;
const TILE_MESH_WAITERS = new WeakMap();

function sleep(ms = 60) {
  if (foundry?.utils?.sleep) return foundry.utils.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupContainerChildren(container) {
  if (!container) return;
  const children = container.children ? [...container.children] : [];
  container.removeChildren();
  for (const child of children) {
    try { child.destroy?.({ children: true, texture: false, baseTexture: false }); }
    catch (_) {}
  }
  container.faNexusBuildingMeshes = null;
}

function cleanupDoorFrameOverlay(tile) {
  try {
    if (!tile) return;
    const mesh = tile.mesh;
    const container = tile.faNexusDoorFrameContainer || mesh?.faNexusDoorFrameContainer;
    if (container) {
      cleanupContainerChildren(container);
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
    }
    if (mesh) mesh.faNexusDoorFrameContainer = null;
    tile.faNexusDoorFrameContainer = null;
  } catch (_) {}
}

function restoreMeshTexture(mesh) {
  try {
    if (!mesh || mesh.destroyed) return;
    if (mesh.faNexusBuildingOriginalTexture) {
      mesh.texture = mesh.faNexusBuildingOriginalTexture;
      mesh.faNexusBuildingOriginalTexture = null;
    }
  } catch (_) {}
}

function normalizeTextureOffset(offset) {
  const data = offset && typeof offset === 'object' ? offset : {};
  const x = Number(data.x);
  const y = Number(data.y);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0
  };
}

function normalizeTextureFlip(flip) {
  if (!flip || typeof flip !== 'object') {
    return { horizontal: false, vertical: false };
  }
  return {
    horizontal: !!flip.horizontal,
    vertical: !!flip.vertical
  };
}

export function cleanupBuildingOverlay(tile) {
  try {
    if (!tile) return;
    const mesh = tile.mesh;
    const container = tile.faNexusBuildingContainer || mesh?.faNexusBuildingContainer;
    if (container) {
      cleanupContainerChildren(container);
      try { container.parent?.removeChild?.(container); } catch (_) {}
      try { container.destroy({ children: true }); } catch (_) {}
    }
    if (mesh) {
      mesh.faNexusBuildingContainer = null;
      restoreMeshTexture(mesh);
    }
    tile.faNexusBuildingContainer = null;
  } catch (_) {}
}

async function ensureTileMesh(tile, options = {}) {
  try {
    if (!tile || tile.destroyed) return null;
    if (tile.mesh && !tile.mesh.destroyed) return tile.mesh;
    const attempts = Math.max(2, Number(options.attempts) || 8);
    const delay = Math.max(30, Number(options.delay) || 60);
    if (TILE_MESH_WAITERS.has(tile)) return TILE_MESH_WAITERS.get(tile);
    const waiter = (async () => {
      if (typeof tile.draw === 'function') {
        try { await Promise.resolve(tile.draw()); } catch (_) {}
        if (tile.mesh && !tile.mesh.destroyed) return tile.mesh;
      }
      for (let i = 0; i < attempts; i++) {
        await sleep(delay);
        if (!tile || tile.destroyed || !tile.document?.scene) break;
        if (tile.mesh && !tile.mesh.destroyed) return tile.mesh;
      }
      return tile?.mesh && !tile.mesh.destroyed ? tile.mesh : null;
    })();
    TILE_MESH_WAITERS.set(tile, waiter);
    try {
      return await waiter;
    } finally {
      TILE_MESH_WAITERS.delete(tile);
    }
  } catch (_) {
    return null;
  }
}

function ensureBuildingContainer(tile, mesh) {
  let container = tile.faNexusBuildingContainer;
  if (!container || container.destroyed) {
    container = new PIXI.Container();
    container.eventMode = 'none';
    container.sortableChildren = false;
    tile.faNexusBuildingContainer = container;
    mesh.addChild(container);
  } else if (container.parent !== mesh) {
    try { container.parent?.removeChild?.(container); } catch (_) {}
    mesh.addChild(container);
  }
  mesh.faNexusBuildingContainer = container;
  return container;
}

function ensureDoorFrameContainer(tile, mesh) {
  let container = tile.faNexusDoorFrameContainer;
  if (!container || container.destroyed) {
    container = new PIXI.Container();
    container.eventMode = 'none';
    container.sortableChildren = false;
    tile.faNexusDoorFrameContainer = container;
    mesh.addChild(container);
  } else if (container.parent !== mesh) {
    try { container.parent?.removeChild?.(container); } catch (_) {}
    mesh.addChild(container);
  }
  mesh.faNexusDoorFrameContainer = container;
  return container;
}

function applyMeshAlpha(mesh, alpha) {
  try {
    if (!mesh || mesh.destroyed) return;
    mesh.alpha = alpha;
    const shader = mesh.shader || mesh.material?.shader || null;
    const uniforms = shader?.uniforms || null;
    if (!uniforms) return;
    const target = uniforms.uColor;
    if (target instanceof Float32Array && target.length >= 4) {
      target[0] = target[1] = target[2] = target[3] = alpha;
    } else if (Array.isArray(target) && target.length >= 4) {
      target[0] = target[1] = target[2] = target[3] = alpha;
    } else if (target && typeof target.length === 'number' && target.length >= 4) {
      target[0] = target[1] = target[2] = target[3] = alpha;
    } else {
      uniforms.uColor = new Float32Array([alpha, alpha, alpha, alpha]);
    }
  } catch (_) {}
}

function setContainerTransform(container, mesh, doc) {
  if (!container || !mesh || mesh.destroyed) return;
  const docWidth = Math.max(1, Number(doc?.width) || Number(mesh?.width) || 1);
  const docHeight = Math.max(1, Number(doc?.height) || Number(mesh?.height) || 1);
  const sx = Number(mesh.scale?.x ?? 1) || 1;
  const sy = Number(mesh.scale?.y ?? 1) || 1;
  container.scale.set(1 / sx, 1 / sy);
  container.position.set(-(docWidth / 2) / (sx || 1), -(docHeight / 2) / (sy || 1));
}

function computeTextureRepeatDistance(texture, data) {
  const assetPxOverride = Number(
    data?.wall?.assetGridSize ??
    data?.meta?.assetGridSize ??
    data?.meta?.wallTexture?.gridSize
  );
  const assetPx = Math.max(1, assetPxOverride || DEFAULT_GRID_SCALE);
  const sceneGridSize = Math.max(1, Number(canvas?.scene?.grid?.size) || DEFAULT_GRID_SCALE);
  const gridScaleFactor = sceneGridSize / assetPx;
  const texWidth = Math.max(1, Number(texture?.width) || assetPx);
  return texWidth * gridScaleFactor;
}

async function detectVisibleRows(texture) {
  if (!texture || !texture.baseTexture) return null;
  if (texture.faNexusBuildingVisibleData) return texture.faNexusBuildingVisibleData;
  const base = texture.baseTexture;
  if (!base.valid) {
    await new Promise((resolve) => {
      const done = () => { base.off?.('loaded', done); base.off?.('error', done); resolve(); };
      base.once?.('loaded', done);
      base.once?.('error', done);
      if (base.valid) done();
    });
  }
  try {
    const resource = base.resource;
    const source = resource?.source;
    if (!source) return null;
    const width = base.width;
    const height = base.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const alphaThreshold = 10;
    let top = 0;
    let bottom = height - 1;
    const rowVisible = (y) => {
      for (let x = 0; x < width; x++) {
        if (pixels[(y * width + x) * 4 + 3] > alphaThreshold) return true;
      }
      return false;
    };
    while (top < height && !rowVisible(top)) top += 1;
    while (bottom > top && !rowVisible(bottom)) bottom -= 1;
    const data = {
      topRow: top,
      bottomRow: bottom,
      totalHeight: height
    };
    texture.faNexusBuildingVisibleData = data;
    return data;
  } catch (_) {
    return null;
  }
}

function remapVisibleRows(geometry, visibleData) {
  if (!geometry || !visibleData) return;
  const texHeight = Math.max(1, visibleData.totalHeight || 0);
  if (!texHeight) return;
  const uvBuffer = geometry.getBuffer('aTextureCoord');
  if (!uvBuffer?.data) return;
  const vMin = visibleData.topRow / texHeight;
  const vMax = (visibleData.bottomRow + 1) / texHeight;
  const range = Math.max(0.001, vMax - vMin);
  const data = uvBuffer.data;
  for (let i = 1; i < data.length; i += 2) {
    data[i] = vMin + (data[i] * range);
  }
  uvBuffer.update();
}

function createWallShader(texture) {
  if (!texture) return null;
  try {
    if (PIXI?.MeshMaterial) {
      const material = new PIXI.MeshMaterial(texture);
      material.alpha = 1;
      if (material.uvMatrix) {
        material.uvMatrix.isSimple = false;
        material.uvMatrix.clampOffset = false;
        material.uvMatrix.clampMargin = -0.5;
        material.uvMatrix.update();
      }
      return material;
    }
    if (PIXI?.Mesh?.Material) {
      const material = new PIXI.Mesh.Material(texture);
      material.alpha = 1;
      if (material.uvMatrix) {
        material.uvMatrix.isSimple = false;
        material.uvMatrix.clampOffset = false;
        material.uvMatrix.clampMargin = -0.5;
        material.uvMatrix.update();
      }
      return material;
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.shader.create.failed', { error: String(error?.message || error) });
  }
  try {
    const material = new PIXI.MeshMaterial(texture);
    if (material.uvMatrix) {
      material.uvMatrix.isSimple = false;
      material.uvMatrix.clampOffset = false;
      material.uvMatrix.clampMargin = -0.5;
      material.uvMatrix.update();
    }
    return material;
  } catch (_) {
    return null;
  }
}

export async function applyBuildingTile(tile) {
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    const data = doc?.getFlag?.('fa-nexus', 'building');
    if (!data) {
      cleanupBuildingOverlay(tile);
      return;
    }
    const loops = gatherBuildingLoops(data);
    if (!loops.length) {
      // A building tile can legitimately have no drawable wall geometry after portals (gaps)
      // remove 100% of an open polyline (e.g. freestanding portal walls). In that case we
      // still must keep the base mesh transparent so the tile doesn't render as an
      // unmasked rectangle of the wall texture.
      let mesh = tile.mesh;
      if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
      if (!mesh || mesh.destroyed) return;
      ensureBuildingMeshTransparent(mesh);
      try {
        const placeholder = getTransparentTexture();
        mesh.texture = placeholder;
        if (mesh.material) mesh.material.texture = placeholder;
        if (mesh.shader?.uniforms) {
          if ('uSampler' in mesh.shader.uniforms) mesh.shader.uniforms.uSampler = placeholder;
          if ('texture' in mesh.shader.uniforms) mesh.shader.uniforms.texture = placeholder;
        }
      } catch (_) { }
      const container = ensureBuildingContainer(tile, mesh);
      cleanupContainerChildren(container);
      container.faNexusBuildingMeshes = [];
      const docAlpha = Number(doc?.alpha);
      const containerAlpha = Number.isFinite(docAlpha) ? Math.min(1, Math.max(0, docAlpha)) : 1;
      container.alpha = containerAlpha;
      setContainerTransform(container, mesh, doc);
      return;
    }
    let mesh = tile.mesh;
    if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) return;
    ensureBuildingMeshTransparent(mesh);
    // Some tile meshes keep their own material/texture refs; force all to the transparent
    // placeholder so the doc's base texture doesn't render while overlays do.
    try {
      const placeholder = getTransparentTexture();
      mesh.texture = placeholder;
      if (mesh.material) mesh.material.texture = placeholder;
      if (mesh.shader?.uniforms) {
        if ('uSampler' in mesh.shader.uniforms) mesh.shader.uniforms.uSampler = placeholder;
        if ('texture' in mesh.shader.uniforms) mesh.shader.uniforms.texture = placeholder;
      }
    } catch (_) { }

    const textureSrc = data?.wall?.texture || data?.meta?.wallTexture?.src;
    if (!textureSrc) {
      cleanupBuildingOverlay(tile);
      return;
    }
    let texture = null;
    try {
      texture = await loadTexture(textureSrc);
      const base = texture?.baseTexture;
      if (base) {
        base.wrapMode = PIXI.WRAP_MODES.REPEAT;
        base.mipmap = PIXI.MIPMAP_MODES.OFF;
      }
    } catch (error) {
      Logger.warn?.('BuildingTiles.texture.loadFailed', { error: String(error?.message || error), tileId: doc?.id });
      return;
    }
    if (!texture) return;

    const repeatDistance = (() => {
      const stored = Number(data?.wall?.repeatDistance);
      if (Number.isFinite(stored) && stored > 0) return stored;
      return computeTextureRepeatDistance(texture, data);
    })();
    const visibleData = await detectVisibleRows(texture);
    const container = ensureBuildingContainer(tile, mesh);
    cleanupContainerChildren(container);
    container.faNexusBuildingMeshes = [];

    let loopIndex = 0;
    const wallWidth = Math.max(10, Number(data?.wall?.width) || DEFAULT_GRID_SCALE / 2);
    const textureOffset = normalizeTextureOffset(data?.wall?.textureOffset);
    const textureFlip = normalizeTextureFlip(data?.wall?.textureFlip);
    for (const loop of loops) {
      if (!Array.isArray(loop)) continue;
      const closed = loop?.closed !== false;
      const minPoints = closed ? 3 : 2;
      if (loop.length < minPoints) continue;
      const geometryResult = BuildingWallMesher.buildGeometry(loop, {
        width: wallWidth,
        closed,
        joinStyle: 'mitre',
        mitreLimit: 4,
        textureRepeatDistance: repeatDistance,
        textureOffset,
        textureFlip
      });
      const geometry = geometryResult?.geometry;
      if (!geometry || !geometryResult?.data?.positions?.length) continue;
      remapVisibleRows(geometry, visibleData);
      const shader = createWallShader(texture);
      if (!shader) continue;
      const loopMesh = new PIXI.Mesh(geometry, shader);
      loopMesh.name = `fa-nexus-building-wall-${doc?.id || 'tile'}-${loopIndex}`;
      loopMesh.eventMode = 'none';
      loopMesh.interactiveChildren = false;
      container.addChild(loopMesh);
      container.faNexusBuildingMeshes.push(loopMesh);
      applyMeshAlpha(loopMesh, Number(doc?.alpha ?? 1) || 1);
      loopIndex += 1;
    }

    if (!container.children?.length) {
      cleanupBuildingOverlay(tile);
      return;
    }

    const docAlpha = Number(doc?.alpha);
    const containerAlpha = Number.isFinite(docAlpha) ? Math.min(1, Math.max(0, docAlpha)) : 1;
    container.alpha = containerAlpha;
    setContainerTransform(container, mesh, doc);
  } catch (error) {
    Logger.warn?.('BuildingTiles.apply.failed', { error: String(error?.message || error) });
  }
}

export async function applyDoorFrameTile(tile) {
  try {
    if (!tile || tile.destroyed) return;
    const doc = tile.document;
    const data = doc?.getFlag?.('fa-nexus', 'buildingDoorFrame');
    if (!data) {
      cleanupDoorFrameOverlay(tile);
      return;
    }

    const texturePath = data?.sourceTextureLocal || data?.sourceTextureKey || '';
    if (!texturePath) {
      cleanupDoorFrameOverlay(tile);
      return;
    }

    let mesh = tile.mesh;
    if (!mesh || mesh.destroyed) mesh = await ensureTileMesh(tile);
    if (!mesh || mesh.destroyed) return;
    ensureBuildingMeshTransparent(mesh);

    let texture = null;
    try {
      texture = await loadTexture(texturePath);
      const base = texture?.baseTexture;
      if (base) {
        base.mipmap = PIXI.MIPMAP_MODES.OFF;
        base.wrapMode = PIXI.WRAP_MODES.CLAMP;
      }
    } catch (error) {
      Logger.warn?.('BuildingTiles.doorFrame.texture.loadFailed', { error: String(error?.message || error), tileId: doc?.id, texturePath });
      cleanupDoorFrameOverlay(tile);
      return;
    }

    const base = texture?.baseTexture;
    if (!texture || !base?.valid) {
      cleanupDoorFrameOverlay(tile);
      return;
    }

    const container = ensureDoorFrameContainer(tile, mesh);
    cleanupContainerChildren(container);
    container.name = 'fa-nexus-building-door-frame';

    const docWidth = Math.max(2, Number(doc?.width) || Number(tile?.width) || 0);
    const docHeight = Math.max(2, Number(doc?.height) || Number(tile?.height) || 0);
    const gridSize = Number.isFinite(Number(data?.assetGridSize))
      ? Number(data.assetGridSize)
      : Math.max(1, Number(canvas?.scene?.grid?.size) || DEFAULT_GRID_SCALE);
    const baseAssetScale = gridSize / DEFAULT_GRID_SCALE; // FRAME_ASSET_GRID_PX === 200
    const userScaleRaw = Number.isFinite(Number(data?.scale)) ? Number(data.scale) : 1;
    const userScale = Math.min(3, Math.max(0.1, userScaleRaw));
    const assetScale = baseAssetScale * userScale;
    const offsetX = Number.isFinite(Number(data?.offsetX)) ? Number(data.offsetX) : 0;
    const offsetY = Number.isFinite(Number(data?.offsetY)) ? Number(data.offsetY) : 0;
    const rotation = Number.isFinite(Number(data?.rotation)) ? Number(data.rotation) : 0;
    const rotationRad = rotation * (Math.PI / 180);
    const gapLength = Number.isFinite(Number(data?.gapLength)) ? Number(data.gapLength) : docWidth;
    const rawMode = String(data?.mode || '').toLowerCase();
    const mode = rawMode === 'scale' ? 'scale' : (rawMode === 'pillar' ? 'pillar' : 'split');

    const heightScene = Math.max(1, Number(base.height) || 1) * assetScale;

    if (mode === 'scale') {
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(0.5, 0.5);
      sprite.position.set(docWidth / 2, heightScene / 2);
      sprite.scale.set(docWidth / Math.max(1, Number(base.width) || 1), assetScale);
      container.addChild(sprite);
    } else if (mode === 'pillar') {
      // Pillar mode: duplicate the full texture and flip for right side
      const pillarWidthPx = base.width;
      const pillarWidthScene = pillarWidthPx * assetScale;
      const targetWidth = Math.max(docWidth, pillarWidthScene * 2 + 1, gapLength + pillarWidthScene * 2);
      const offsetXPx = offsetX * targetWidth * 0.5;
      const offsetYPx = offsetY * heightScene * 0.5;

      const left = new PIXI.Sprite(texture);
      left.anchor.set(0.5, 0.5);
      left.position.set(pillarWidthScene * 0.5 + offsetXPx, heightScene * 0.5 + offsetYPx);
      left.scale.set(assetScale, assetScale);
      left.rotation = rotationRad;

      const right = new PIXI.Sprite(texture);
      right.anchor.set(0.5, 0.5);
      right.position.set(targetWidth - pillarWidthScene * 0.5 - offsetXPx, heightScene * 0.5 + offsetYPx);
      right.scale.set(-assetScale, assetScale); // Flip horizontally
      right.rotation = -rotationRad; // Counter-rotate for flipped sprite

      container.addChild(left, right);
    } else {
      // Split mode: split door frame texture in half
      const pillarWidthPx = Math.max(1, Math.min(base.height, Math.floor(base.width / 2)));
      const pillarWidthScene = pillarWidthPx * assetScale;
      const targetWidth = Math.max(docWidth, pillarWidthScene * 2 + 1, gapLength + pillarWidthScene * 2);
      const offsetXPx = offsetX * targetWidth * 0.5;
      const offsetYPx = offsetY * heightScene * 0.5;
      const leftRect = new PIXI.Rectangle(0, 0, pillarWidthPx, base.height);
      const rightRect = new PIXI.Rectangle(Math.max(0, base.width - pillarWidthPx), 0, pillarWidthPx, base.height);
      const leftTex = new PIXI.Texture(base, leftRect);
      const rightTex = new PIXI.Texture(base, rightRect);
      const left = new PIXI.Sprite(leftTex);
      left.anchor.set(0.5, 0.5);
      left.position.set(pillarWidthScene * 0.5 + offsetXPx, heightScene * 0.5 + offsetYPx);
      left.scale.set(assetScale, assetScale);
      const right = new PIXI.Sprite(rightTex);
      right.anchor.set(0.5, 0.5);
      right.position.set(targetWidth - pillarWidthScene * 0.5 - offsetXPx, heightScene * 0.5 + offsetYPx);
      right.scale.set(assetScale, assetScale);
      container.addChild(left, right);
    }

    const docAlpha = Number(doc?.alpha);
    const containerAlpha = Number.isFinite(docAlpha) ? Math.min(1, Math.max(0, docAlpha)) : 1;
    container.alpha = containerAlpha;
    setContainerTransform(container, mesh, doc);
  } catch (error) {
    Logger.warn?.('BuildingTiles.doorFrame.apply.failed', { error: String(error?.message || error) });
  }
}

export function rehydrateBuildingTiles() {
  try {
    if (!canvas?.ready) return;
    const tiles = Array.isArray(canvas.tiles?.placeables) ? canvas.tiles.placeables : [];
    for (const tile of tiles) {
      try {
        const data = tile?.document?.getFlag?.('fa-nexus', 'building');
        if (data) applyBuildingTile(tile);
        else cleanupBuildingOverlay(tile);

        const frameData = tile?.document?.getFlag?.('fa-nexus', 'buildingDoorFrame');
        if (frameData) applyDoorFrameTile(tile);
        else cleanupDoorFrameOverlay(tile);
      } catch (_) {}
    }
  } catch (_) {}
}

export function clearBuildingTileMeshWaiters() {
  try { TILE_MESH_WAITERS.clear(); }
  catch (_) {}
}

async function deleteLinkedFillAndWalls(doc) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const data = typeof doc.getFlag === 'function' ? doc.getFlag('fa-nexus', 'building') : null;
    if (!data) return;
    const scene = doc.parent || canvas?.scene;
    if (!scene) return;
    const meta = data?.meta || {};
    const fillTileId = meta?.fillTileId;
    if (fillTileId && fillTileId !== doc.id) {
      try {
        await scene.deleteEmbeddedDocuments('Tile', [fillTileId]);
      } catch (error) {
        Logger.warn?.('BuildingTiles.delete.fill.failed', { error: String(error?.message || error), fillTileId });
      }
    }
    // NOTE: We intentionally do NOT use meta.wallIds here, as those can be stale.
    // When multiple islands are committed, wall IDs may get reassigned to different
    // tiles during _assignWallsToCommittedIslands. The meta.wallIds stored at commit
    // time may contain walls that were later claimed by other islands.
    // Instead, we rely exclusively on the wall's actual flag.tileId and flag.groupId
    // which are the authoritative sources after commit.
    const wallIds = new Set();
    const groupId = meta?.wallGroupId || null;
    const collection = scene.walls;
    if (collection?.size) {
      for (const wall of collection) {
        if (!wall) continue;
        const flag = wall.getFlag?.('fa-nexus', 'buildingWall');
        if (!flag) continue;
        // Only delete walls where the flag actually points to this tile
        if (flag.tileId === doc.id) {
          wallIds.add(wall.id);
        } else if (groupId && flag.groupId === groupId && !flag.tileId) {
          // Also catch walls that have our groupId but no specific tileId
          // (e.g., from interrupted commits or legacy data)
          wallIds.add(wall.id);
        }
      }
    }
    if (!wallIds.size) return;
    try {
      await scene.deleteEmbeddedDocuments('Wall', [...wallIds]);
    } catch (error) {
      Logger.warn?.('BuildingTiles.delete.walls.failed', { error: String(error?.message || error), wallIds: [...wallIds] });
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.cleanup.failed', { error: String(error?.message || error) });
  }
}

async function deleteLinkedDoorFrameTiles(doc) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const data = typeof doc.getFlag === 'function' ? doc.getFlag('fa-nexus', 'building') : null;
    if (!data) return;
    const scene = doc.parent || canvas?.scene;
    if (!scene?.tiles?.size) return;
    const meta = data?.meta || {};
    const wallGroupId = meta?.wallGroupId || null;
    if (!wallGroupId) return;
    const frameTileIds = [];
    for (const tileDoc of scene.tiles) {
      if (!tileDoc || tileDoc.id === doc.id) continue;
      const flag = tileDoc.getFlag?.('fa-nexus', 'buildingDoorFrame');
      if (flag?.wallGroupId === wallGroupId) {
        frameTileIds.push(tileDoc.id);
      }
    }
    if (!frameTileIds.length) return;
    try {
      await scene.deleteEmbeddedDocuments('Tile', frameTileIds);
    } catch (error) {
      Logger.warn?.('BuildingTiles.delete.doorFrames.failed', { error: String(error?.message || error), frameTileIds });
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.doorFrames.cleanup.failed', { error: String(error?.message || error) });
  }
}

async function deleteLinkedWindowTiles(doc) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const data = typeof doc.getFlag === 'function' ? doc.getFlag('fa-nexus', 'building') : null;
    if (!data) return;
    const scene = doc.parent || canvas?.scene;
    if (!scene?.tiles?.size) return;
    const meta = data?.meta || {};
    const wallGroupId = meta?.wallGroupId || null;
    if (!wallGroupId) return;
    const windowTileIds = [];
    for (const tileDoc of scene.tiles) {
      if (!tileDoc || tileDoc.id === doc.id) continue;
      // Check for window sill, window texture, or window frame tiles
      const sillFlag = tileDoc.getFlag?.('fa-nexus', 'buildingWindowSill');
      const windowFlag = tileDoc.getFlag?.('fa-nexus', 'buildingWindowWindow');
      const frameFlag = tileDoc.getFlag?.('fa-nexus', 'buildingWindowFrame');
      const flag = sillFlag || windowFlag || frameFlag;
      if (flag?.wallGroupId === wallGroupId) {
        windowTileIds.push(tileDoc.id);
      }
    }
    if (!windowTileIds.length) return;
    try {
      await scene.deleteEmbeddedDocuments('Tile', windowTileIds);
    } catch (error) {
      Logger.warn?.('BuildingTiles.delete.windowTiles.failed', { error: String(error?.message || error), windowTileIds });
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.windowTiles.cleanup.failed', { error: String(error?.message || error) });
  }
}

async function deleteLinkedInnerWallTiles(doc) {
  try {
    if (!doc || !game?.user?.isGM) return;
    const data = typeof doc.getFlag === 'function' ? doc.getFlag('fa-nexus', 'building') : null;
    if (!data) return;
    const scene = doc.parent || canvas?.scene;
    if (!scene?.tiles?.size) return;
    const meta = data?.meta || {};
    // Only outer wall tiles should cascade delete their inner walls
    const wallType = meta?.wallType || data?.wall?.mode;
    if (wallType === 'inner') return;
    const wallGroupId = meta?.wallGroupId || null;
    const innerWallTileIds = [];
    for (const tileDoc of scene.tiles) {
      if (!tileDoc || tileDoc.id === doc.id) continue;
      const innerData = tileDoc.getFlag?.('fa-nexus', 'building');
      if (!innerData) continue;
      const innerMeta = innerData.meta || {};
      const innerWallType = innerMeta?.wallType || innerData?.wall?.mode;
      // Only consider inner wall tiles
      if (innerWallType !== 'inner') continue;
      // Check if this inner tile is linked to the deleted outer tile
      const matchesTileId = innerMeta.parentWallTileId === doc.id;
      const matchesGroupId = wallGroupId && innerMeta.parentWallGroupId === wallGroupId;
      if (matchesTileId || matchesGroupId) {
        innerWallTileIds.push(tileDoc.id);
      }
    }
    if (!innerWallTileIds.length) return;
    try {
      await scene.deleteEmbeddedDocuments('Tile', innerWallTileIds);
    } catch (error) {
      Logger.warn?.('BuildingTiles.delete.innerWallTiles.failed', { error: String(error?.message || error), innerWallTileIds });
    }
  } catch (error) {
    Logger.warn?.('BuildingTiles.delete.innerWallTiles.cleanup.failed', { error: String(error?.message || error) });
  }
}

try {
  Hooks.on('canvasReady', () => {
    try { rehydrateBuildingTiles(); } catch (_) {}
  });
  Hooks.on('drawTile', (tile) => {
    try { applyBuildingTile(tile); } catch (_) {}
    try { applyDoorFrameTile(tile); } catch (_) {}
  });
  Hooks.on('refreshTile', (tile) => {
    try { applyBuildingTile(tile); } catch (_) {}
    try { applyDoorFrameTile(tile); } catch (_) {}
  });
  Hooks.on('activateTilesLayer', () => {
    try { rehydrateBuildingTiles(); } catch (_) {}
  });
  Hooks.on('controlTile', (tile) => {
    try { applyBuildingTile(tile); } catch (_) {}
    try { applyDoorFrameTile(tile); } catch (_) {}
  });
  Hooks.on('updateTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) {
        applyBuildingTile(tile);
        applyDoorFrameTile(tile);
      }
    } catch (_) {}
  });
  Hooks.on('deleteTile', (doc) => {
    try {
      const tile = canvas.tiles?.placeables?.find((t) => t?.document?.id === doc.id);
      if (tile) {
        cleanupBuildingOverlay(tile);
        cleanupDoorFrameOverlay(tile);
      }
    } catch (_) {}
    if (!shouldSkipLinkedBuildingDeletes() && doc?.getFlag) {
      Promise.resolve(deleteLinkedFillAndWalls(doc)).catch(() => {});
      Promise.resolve(deleteLinkedDoorFrameTiles(doc)).catch(() => {});
      Promise.resolve(deleteLinkedWindowTiles(doc)).catch(() => {});
      Promise.resolve(deleteLinkedInnerWallTiles(doc)).catch(() => {});
    }
  });
  Hooks.on('canvasTearDown', () => {
    try { clearBuildingTileMeshWaiters(); } catch (_) {}
  });
} catch (_) {}
