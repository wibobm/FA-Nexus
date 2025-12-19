import { NexusLogger as Logger } from '../core/nexus-logger.js';

const GAP_DISTANCE_EPSILON = 0.5;
const GAP_MIN_HALF_LENGTH = 8;

function normalizeBuildingPoint(point) {
  if (!point) return null;
  const x = Number(point.x ?? point[0]);
  const y = Number(point.y ?? point[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

export function normalizeBuildingLoop(points = [], { closed = true } = {}) {
  const loop = [];
  for (const point of points) {
    const normalized = normalizeBuildingPoint(point);
    if (!normalized) continue;
    if (loop.length) {
      const last = loop[loop.length - 1];
      if (Math.abs(last.x - normalized.x) < 0.001 && Math.abs(last.y - normalized.y) < 0.001) continue;
    }
    loop.push(normalized);
  }
  if (closed && loop.length >= 2) {
    const first = loop[0];
    const last = loop[loop.length - 1];
    if (Math.abs(first.x - last.x) < 0.001 && Math.abs(first.y - last.y) < 0.001) {
      loop.pop();
    }
  }
  loop.closed = closed;
  return loop;
}

export function gatherBuildingLoops(data = {}) {
  try {
    const shapes = Array.isArray(data.shapes) && data.shapes.length
      ? data.shapes
      : (data.polygon ? [data.polygon] : []);
    const descriptors = [];
    shapes.forEach((shape, shapeIndex) => {
      const closed = shape?.closed !== false;
      const minPoints = closed ? 3 : 2;
      if (Array.isArray(shape?.outer) && shape.outer.length >= minPoints) {
        const loop = normalizeBuildingLoop(shape.outer, { closed });
        loop.faLoopRef = { shapeIndex, holeIndex: null };
        descriptors.push({ loop, closed, key: serializeLoopRef(shapeIndex, null) });
      }
      if (!closed) return;
      const holes = Array.isArray(shape?.holes) ? shape.holes : [];
      holes.forEach((hole, holeIndex) => {
        const pts = hole?.points || hole;
        if (!Array.isArray(pts) || pts.length < 3) return;
        const loop = normalizeBuildingLoop(pts, { closed: true });
        loop.faLoopRef = { shapeIndex, holeIndex };
        descriptors.push({ loop, closed: true, key: serializeLoopRef(shapeIndex, holeIndex) });
      });
    });
    const gaps = normalizeWallGaps(data?.meta?.wallGaps || []);
    const loops = applyWallGaps(descriptors, gaps);
    return loops.filter((loop) => Array.isArray(loop) && loop.length >= (loop?.closed === false ? 2 : 3));
  } catch (error) {
    Logger?.warn?.('BuildingShapeHelpers.gather.failed', { error: String(error?.message || error) });
    return [];
  }
}

function serializeLoopRef(shapeIndex, holeIndex = null) {
  if (!Number.isInteger(shapeIndex)) return null;
  return `${shapeIndex}:${Number.isInteger(holeIndex) ? holeIndex : 'outer'}`;
}

function normalizeWallGaps(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((gap) => {
      const shapeIndex = Number.isInteger(gap?.loopRef?.shapeIndex) ? gap.loopRef.shapeIndex : null;
      if (shapeIndex == null) return null;
      const holeIndex = Number.isInteger(gap.loopRef.holeIndex) ? gap.loopRef.holeIndex : null;
      const key = serializeLoopRef(shapeIndex, holeIndex);
      if (!key) return null;
      const center = Number(gap?.center ?? gap?.centerDistance ?? 0);
      const half = Number(gap?.halfLength ?? GAP_MIN_HALF_LENGTH);
      return {
        key,
        centerDistance: Number.isFinite(center) ? center : 0,
        halfLength: Number.isFinite(half) ? Math.max(GAP_MIN_HALF_LENGTH, Math.abs(half)) : GAP_MIN_HALF_LENGTH
      };
    })
    .filter(Boolean);
}

function applyWallGaps(descriptors = [], gaps = []) {
  if (!Array.isArray(descriptors) || !descriptors.length) return [];
  if (!Array.isArray(gaps) || !gaps.length) return descriptors.map((descriptor) => descriptor.loop);
  const grouped = new Map();
  gaps.forEach((gap) => {
    if (!grouped.has(gap.key)) grouped.set(gap.key, []);
    grouped.get(gap.key).push(gap);
  });
  const result = [];
  descriptors.forEach((descriptor) => {
    const list = descriptor.key ? grouped.get(descriptor.key) : null;
    if (!list || !list.length) {
      result.push(descriptor.loop);
      return;
    }
    const sections = splitLoopByGaps(descriptor.loop, list);
    if (sections.length) result.push(...sections);
  });
  return result;
}

function splitLoopByGaps(loop, gaps = []) {
  if (!Array.isArray(loop) || !gaps.length) return [loop];
  const closed = loop.closed !== false;
  const metrics = computeLoopMetrics(loop, closed);
  if (!(metrics.length > 0)) return [loop];
  const total = metrics.length;
  const intervals = [];
  gaps.forEach((gap) => {
    const startRaw = (gap.centerDistance ?? 0) - (gap.halfLength ?? 0);
    const endRaw = (gap.centerDistance ?? 0) + (gap.halfLength ?? 0);
    if (closed) {
      const start = ((startRaw % total) + total) % total;
      const end = ((endRaw % total) + total) % total;
      if (end >= start) intervals.push({ start, end });
      else {
        intervals.push({ start, end: total });
        intervals.push({ start: 0, end });
      }
    } else {
      const start = Math.max(0, Math.min(total, startRaw));
      const end = Math.max(0, Math.min(total, endRaw));
      if (end - start > GAP_DISTANCE_EPSILON) intervals.push({ start, end });
    }
  });
  if (!intervals.length) return [loop];
  intervals.sort((a, b) => a.start - b.start);
  const merged = [];
  intervals.forEach((entry) => {
    if (!merged.length || entry.start > merged[merged.length - 1].end + GAP_DISTANCE_EPSILON) merged.push({ ...entry });
    else merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, entry.end);
  });
  const keep = [];
  if (closed) {
    if (merged.length === 1 && merged[0].end - merged[0].start >= total - GAP_DISTANCE_EPSILON) {
      return [];
    }
    for (let i = 0; i < merged.length; i++) {
      const current = merged[i];
      const next = merged[(i + 1) % merged.length];
      let start = current.end;
      let end = next.start;
      if (i === merged.length - 1) end += total;
      if (end - start <= GAP_DISTANCE_EPSILON) continue;
      keep.push({ start, end });
    }
  } else {
    let cursor = 0;
    merged.forEach((interval) => {
      if (interval.start - cursor > GAP_DISTANCE_EPSILON) keep.push({ start: cursor, end: interval.start });
      cursor = Math.max(cursor, interval.end);
    });
    if (total - cursor > GAP_DISTANCE_EPSILON) keep.push({ start: cursor, end: total });
  }
  if (!keep.length) return [];
  const sections = keep
    .map((range) => buildLoopSection(loop, metrics, range.start, range.end))
    .filter((section) => Array.isArray(section) && section.length >= 2);
  return sections.length ? sections : [];
}

function computeLoopMetrics(points = [], closed = true) {
  if (!Array.isArray(points) || points.length < (closed ? 3 : 2)) {
    return { length: 0, vertexDistances: [], segments: [], closed };
  }
  const count = points.length;
  const maxIndex = closed ? count : count - 1;
  const vertexDistances = new Array(count).fill(0);
  const segments = [];
  let accumulated = 0;
  for (let i = 0; i < maxIndex; i++) {
    const start = points[i];
    const end = points[(i + 1) % count];
    const dx = (end?.x ?? 0) - (start?.x ?? 0);
    const dy = (end?.y ?? 0) - (start?.y ?? 0);
    const length = Math.hypot(dx, dy);
    vertexDistances[i] = accumulated;
    if (length <= 0) continue;
    const startDistance = accumulated;
    accumulated += length;
    segments.push({
      startIndex: i,
      endIndex: (i + 1) % count,
      startDistance,
      endDistance: accumulated,
      length
    });
  }
  if (!closed) vertexDistances[count - 1] = accumulated;
  return { length: accumulated, vertexDistances, segments, closed };
}

function interpolateLoopPoint(points = [], metrics, distance, { clamp = true } = {}) {
  if (!metrics || !Array.isArray(metrics.segments) || !metrics.segments.length) return null;
  const total = metrics.length;
  if (!(total > 0)) return null;
  let target = Number(distance);
  if (!Number.isFinite(target)) target = 0;
  if (metrics.closed) target = ((target % total) + total) % total;
  else if (clamp) target = Math.min(Math.max(0, target), total);
  for (const segment of metrics.segments) {
    const segStart = segment.startDistance;
    const segEnd = segment.endDistance;
    if (target < segStart) continue;
    if (target > segEnd && segment !== metrics.segments[metrics.segments.length - 1]) continue;
    const span = Math.max(segment.length, 1e-6);
    const ratio = Math.min(1, Math.max(0, (target - segStart) / span));
    const start = points[segment.startIndex];
    const end = points[segment.endIndex];
    return {
      x: (start?.x ?? 0) + ((end?.x ?? 0) - (start?.x ?? 0)) * ratio,
      y: (start?.y ?? 0) + ((end?.y ?? 0) - (start?.y ?? 0)) * ratio
    };
  }
  return points[points.length - 1] || null;
}

function buildLoopSection(loop, metrics, startDistance, endDistance) {
  if (!metrics || !(metrics.length > 0)) return null;
  const total = metrics.length;
  const closed = metrics.closed !== false;
  const span = (endDistance ?? 0) - (startDistance ?? 0);
  if (!(span > GAP_DISTANCE_EPSILON)) return null;

  const buildRangeSection = (rangeStart, rangeEnd) => {
    const start = interpolateLoopPoint(loop, metrics, rangeStart, { clamp: !closed });
    const end = interpolateLoopPoint(loop, metrics, rangeEnd, { clamp: !closed });
    if (!start || !end) return null;
    const section = [{ x: start.x, y: start.y }];
    const vertices = metrics.vertexDistances || [];
    vertices.forEach((distance, index) => {
      if (distance <= rangeStart + GAP_DISTANCE_EPSILON) return;
      if (distance >= rangeEnd - GAP_DISTANCE_EPSILON) return;
      const vertex = loop[index];
      if (!vertex) return;
      section.push({ x: vertex.x, y: vertex.y });
    });
    section.push({ x: end.x, y: end.y });
    section.closed = false;
    return section;
  };

  const mergeSections = (primary, secondary) => {
    if (!primary) return secondary;
    if (!secondary) return primary;
    const merged = [...primary];
    const last = primary[primary.length - 1];
    const first = secondary[0];
    let startIndex = 0;
    if (last && first) {
      const dx = (last.x ?? 0) - (first.x ?? 0);
      const dy = (last.y ?? 0) - (first.y ?? 0);
      if (Math.hypot(dx, dy) < GAP_DISTANCE_EPSILON) {
        startIndex = 1;
      }
    }
    for (let i = startIndex; i < secondary.length; i++) {
      merged.push(secondary[i]);
    }
    merged.closed = false;
    return merged;
  };

  if (!closed) {
    const clampedStart = Math.max(0, Math.min(total, startDistance));
    const clampedEnd = Math.max(clampedStart, Math.min(total, endDistance));
    return buildRangeSection(clampedStart, clampedEnd);
  }

  const normalizedStart = ((startDistance % total) + total) % total;
  if (endDistance - startDistance <= total + GAP_DISTANCE_EPSILON) {
    if (endDistance <= total) {
      return buildRangeSection(normalizedStart, Math.max(normalizedStart, Math.min(endDistance, total)));
    }
    const first = buildRangeSection(normalizedStart, total);
    const second = buildRangeSection(0, endDistance - total);
    return mergeSections(first, second);
  }

  // Handle multi-wrap sections defensively
  let section = buildRangeSection(normalizedStart, total);
  let remaining = endDistance - total;
  while (remaining > GAP_DISTANCE_EPSILON) {
    const nextEnd = Math.min(remaining, total);
    section = mergeSections(section, buildRangeSection(0, nextEnd));
    remaining -= nextEnd;
  }
  return section;
}
