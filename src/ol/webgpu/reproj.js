/**
 * @module ol/webgpu/reproj
 */
import {
  containsXY,
  createEmpty,
  extendCoordinate,
  getWidth,
} from '../extent.js';
import {equivalent, getTransform} from '../proj.js';
import {calculateSourceResolution} from '../reproj.js';
import {getKey as getTileCoordKey} from '../tilecoord.js';
import {getUid} from '../util.js';

/**
 * @param {import("../source/Source.js").default} source Source.
 * @param {import("../proj/Projection.js").default} viewProj View projection.
 * @return {boolean} Source data must be warped into the view projection.
 */
export function needsReprojection(source, viewProj) {
  const sourceProj = source.getProjection();
  return !!(sourceProj && viewProj && !equivalent(sourceProj, viewProj));
}

/**
 * Map a view-CRS coordinate into the feature (source) CRS for hit tests.
 * Geometries stay in the source CRS; the pointer is in the view CRS.
 *
 * @param {import("../coordinate.js").Coordinate} coordinate View coordinate.
 * @param {import("../proj/Projection.js").default|null} sourceProj Feature CRS.
 * @param {import("../proj/Projection.js").default} viewProj View projection.
 * @return {import("../coordinate.js").Coordinate|null} Source coordinate, or
 *     the input when the CRS match, or null if the inverse transform fails.
 */
export function viewCoordinateToSource(coordinate, sourceProj, viewProj) {
  if (!sourceProj || !viewProj || equivalent(sourceProj, viewProj)) {
    return coordinate;
  }
  const inverse = getTransform(viewProj, sourceProj);
  if (!inverse) {
    return null;
  }
  const projected = inverse(coordinate);
  if (!projected || !isFinite(projected[0]) || !isFinite(projected[1])) {
    return null;
  }
  return [projected[0], projected[1]];
}

/**
 * Cache identity for a GPU reprojection mesh. The target (view) projection
 * must be part of the key so a CRS change does not reuse vertices built for
 * a previous view projection.
 *
 * @param {import("../tilecoord.js").TileCoord} tileCoord Tile coord.
 * @param {import("../proj/Projection.js").default} sourceProj Source projection.
 * @param {import("../proj/Projection.js").default} targetProj Target projection.
 * @return {string} Key.
 */
export function reprojMeshCacheKey(tileCoord, sourceProj, targetProj) {
  return (
    getTileCoordKey(tileCoord) +
    '/' +
    getUid(sourceProj) +
    '/' +
    getUid(targetProj)
  );
}

/**
 * Approximate the source-projection extent covering a view extent.
 *
 * @param {import("../extent.js").Extent} viewExtent View extent.
 * @param {import("../proj/Projection.js").default} sourceProj Source projection.
 * @param {import("../proj/Projection.js").default} viewProj View projection.
 * @param {number} [samples] Samples along each axis.
 * @return {import("../extent.js").Extent|null} Source extent.
 */
export function estimateSourceExtent(
  viewExtent,
  sourceProj,
  viewProj,
  samples = 8,
) {
  const inverse = getTransform(viewProj, sourceProj);
  if (!inverse) {
    return null;
  }
  const extent = createEmpty();
  const n = Math.max(2, samples);
  let count = 0;
  for (let j = 0; j < n; ++j) {
    const y = viewExtent[1] + (j / (n - 1)) * (viewExtent[3] - viewExtent[1]);
    for (let i = 0; i < n; ++i) {
      const x = viewExtent[0] + (i / (n - 1)) * (viewExtent[2] - viewExtent[0]);
      const sourceCoord = inverse([x, y], undefined, undefined, 2);
      if (isFinite(sourceCoord[0]) && isFinite(sourceCoord[1])) {
        extendCoordinate(extent, sourceCoord);
        count += 1;
      }
    }
  }
  return count ? extent : null;
}

/**
 * Clip a source-space extent to the projection's valid area. Inverse samples
 * of EPSG:4326 poles are finite but lie far outside Web Mercator; using them
 * as a tile query invents coords whose meshes collapse to ±90° and never
 * appear. X is left unclipped when `wrapX` is set so dateline queries can
 * still wrap.
 *
 * @param {import("../extent.js").Extent} extent Source extent.
 * @param {import("../proj/Projection.js").default} projection Source projection.
 * @param {boolean} [wrapX] Source wraps in X.
 * @return {import("../extent.js").Extent|null} Clipped extent, or null if empty.
 */
export function clipExtentToProjection(extent, projection, wrapX) {
  const world = projection.getExtent();
  if (!world) {
    return extent.slice();
  }
  const clipped = extent.slice();
  clipped[1] = Math.max(clipped[1], world[1]);
  clipped[3] = Math.min(clipped[3], world[3]);
  if (!wrapX) {
    clipped[0] = Math.max(clipped[0], world[0]);
    clipped[2] = Math.min(clipped[2], world[2]);
  }
  if (clipped[1] > clipped[3] || (!wrapX && clipped[0] > clipped[2])) {
    return null;
  }
  return clipped;
}

/**
 * Source zoom for a view resolution (center-based).
 *
 * @param {import("../proj/Projection.js").default} sourceProj Source projection.
 * @param {import("../proj/Projection.js").default} viewProj View projection.
 * @param {import("../coordinate.js").Coordinate} viewCenter View center.
 * @param {number} viewResolution View resolution.
 * @return {number} Source resolution.
 */
export function sourceResolutionForView(
  sourceProj,
  viewProj,
  viewCenter,
  viewResolution,
) {
  return calculateSourceResolution(
    sourceProj,
    viewProj,
    viewCenter,
    viewResolution,
  );
}

/**
 * Maximum triangle size relative to the target world width. Source-grid edges
 * that jump a projection cut (antimeridian, Mollweide limb) become screen-
 * spanning triangles; clamp-to-edge then paints a tile-edge color as a streak.
 * Same threshold as `ol/reproj/Triangulation`.
 * @type {number}
 */
const MAX_TRIANGLE_WIDTH = 0.25;

/**
 * Relative inset from a wrap-X world edge before forward projection.
 * Mercator max-x converts to lon 180+ε, which Mollweide (and similar) maps
 * into the opposite hemisphere — pulling dateline tile edges across the map.
 * @type {number}
 */
const WRAP_EDGE_INSET = 1e-9;

/**
 * Nudge wrap-X coordinates off the world edge so float error does not flip
 * the hemisphere when forwarding into the view projection.
 *
 * @param {number} x Source X.
 * @param {number} y Source Y.
 * @param {import("../proj/Projection.js").default} sourceProj Source projection.
 * @return {Array<number>} Coordinate safe to project.
 */
function insetWrapXEdges(x, y, sourceProj) {
  if (!sourceProj.canWrapX()) {
    return [x, y];
  }
  const world = sourceProj.getExtent();
  if (!world) {
    return [x, y];
  }
  const worldWidth = getWidth(world);
  if (!(worldWidth > 0)) {
    return [x, y];
  }
  const inset = worldWidth * WRAP_EDGE_INSET;
  if (x > world[2] - inset && x < world[2] + inset) {
    return [world[2] - inset, y];
  }
  if (x < world[0] + inset && x > world[0] - inset) {
    return [world[0] + inset, y];
  }
  return [x, y];
}

/**
 * Build a source-to-target mesh for a tile. Positions are in the view projection.
 *
 * Quads whose target-space edges or diagonals exceed a quarter of the target
 * world are omitted so a projection-cut jump cannot stretch a triangle across
 * the map (horizontal streaks from clamp-to-edge sampling).
 *
 * @param {import("../extent.js").Extent} sourceExtent Tile extent in source projection.
 * @param {import("../proj/Projection.js").default} sourceProj Source projection.
 * @param {import("../proj/Projection.js").default} targetProj Target projection.
 * @param {number} [samples] Samples per axis (default 16).
 * @return {{vertices: Float32Array, indices: Uint32Array}|null} Mesh or null if projection failed.
 */
export function buildReprojMesh(
  sourceExtent,
  sourceProj,
  targetProj,
  samples = 16,
) {
  const forward = getTransform(sourceProj, targetProj);
  if (!forward) {
    return null;
  }
  const targetWorld = targetProj.getExtent();
  const worldWidth = targetWorld ? getWidth(targetWorld) : 0;
  const maxEdgeSq =
    worldWidth > 0 ? (worldWidth * MAX_TRIANGLE_WIDTH) ** 2 : Infinity;
  let validTargetExtent = null;
  if (targetWorld && worldWidth > 0) {
    const pad = worldWidth * 0.05;
    validTargetExtent = [
      targetWorld[0] - pad,
      targetWorld[1] - pad,
      targetWorld[2] + pad,
      targetWorld[3] + pad,
    ];
  }

  const cols = samples + 1;
  const vertices = new Float32Array(cols * cols * 4);
  /** @type {Array<boolean>} */
  const valid = new Array(cols * cols);
  let o = 0;
  let validCount = 0;
  for (let j = 0; j <= samples; ++j) {
    const v = j / samples;
    const y = sourceExtent[3] - (sourceExtent[3] - sourceExtent[1]) * v;
    for (let i = 0; i <= samples; ++i) {
      const u = i / samples;
      const x = sourceExtent[0] + (sourceExtent[2] - sourceExtent[0]) * u;
      const [sx, sy] = insetWrapXEdges(x, y, sourceProj);
      const t = forward([sx, sy], undefined, undefined, 2);
      const tx = t[0];
      const ty = t[1];
      const ok =
        isFinite(tx) &&
        isFinite(ty) &&
        (!validTargetExtent || containsXY(validTargetExtent, tx, ty));
      valid[j * cols + i] = ok;
      if (ok) {
        validCount += 1;
        vertices[o++] = tx;
        vertices[o++] = ty;
      } else {
        vertices[o++] = 0;
        vertices[o++] = 0;
      }
      vertices[o++] = u;
      vertices[o++] = v;
    }
  }
  if (validCount < 4) {
    return null;
  }

  /**
   * @param {number} i Vertex index.
   * @param {number} k Vertex index.
   * @return {boolean} Edge longer than the allowed fraction of the target world.
   */
  const crossesCut = (i, k) => {
    const dx = vertices[i * 4] - vertices[k * 4];
    const dy = vertices[i * 4 + 1] - vertices[k * 4 + 1];
    return dx * dx + dy * dy > maxEdgeSq;
  };

  /** @type {Array<number>} */
  const indexList = [];
  for (let j = 0; j < samples; ++j) {
    for (let i = 0; i < samples; ++i) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      if (!valid[a] || !valid[b] || !valid[c] || !valid[d]) {
        continue;
      }
      if (
        crossesCut(a, b) ||
        crossesCut(a, c) ||
        crossesCut(b, d) ||
        crossesCut(c, d) ||
        crossesCut(a, d) ||
        crossesCut(b, c)
      ) {
        continue;
      }
      indexList.push(a, c, b, b, c, d);
    }
  }
  return {vertices, indices: Uint32Array.from(indexList)};
}

/**
 * World-to-clip matrix for view coordinates (center origin, Y up in clip).
 *
 * @param {import("../Map.js").FrameState} frameState Frame state.
 * @param {import("../transform.js").Transform} coordinateToPixel Coordinate to pixel.
 * @param {Float32Array} out 16-float matrix.
 * @return {Float32Array} out
 */
export function projectionMatrixFromFrame(frameState, coordinateToPixel, out) {
  const size = frameState.size;
  const a = coordinateToPixel[0];
  const b = coordinateToPixel[1];
  const c = coordinateToPixel[2];
  const d = coordinateToPixel[3];
  const e = coordinateToPixel[4];
  const f = coordinateToPixel[5];
  const sx = 2 / size[0];
  const sy = -2 / size[1];
  out[0] = a * sx;
  out[1] = b * sy;
  out[2] = 0;
  out[3] = 0;
  out[4] = c * sx;
  out[5] = d * sy;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = 1;
  out[11] = 0;
  out[12] = e * sx - 1;
  out[13] = f * sy + 1;
  out[14] = 0;
  out[15] = 1;
  return out;
}
