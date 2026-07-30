/**
 * @module ol/webgl/reproj/util
 */

import {
  containsXY,
  createEmpty,
  extendCoordinate,
  getArea,
  getCenter,
  getHeight,
  getIntersection,
  getWidth,
  wrapAndSliceX,
} from '../../extent.js';
import {clamp} from '../../math.js';
import {equivalent, getTransform} from '../../proj.js';
import {
  calculateSourceExtentResolution,
  calculateSourceResolution,
} from '../../reproj.js';
import {apply as applyTransform} from '../../transform.js';
import {unwrapX} from './grid.js';
import Mesh from './Mesh.js';

/**
 * @param {import("../../source/Source.js").default} source Source.
 * @param {import("../../proj/Projection.js").default} viewProj View projection.
 * @return {boolean} The renderer should warp source data into the view projection.
 */
export function needsReprojection(source, viewProj) {
  const dataSource = /** @type {import("../../source/DataTile.js").default} */ (
    /** @type {*} */ (source)
  );
  if (dataSource.transformMatrix) {
    return true;
  }
  const sourceProj = source.getProjection();
  return !!(sourceProj && viewProj && !equivalent(sourceProj, viewProj));
}

/**
 * Inverse-project a view coordinate into source data space.
 * Matches Triangulation's inverse path (optional source matrix after proj).
 * @param {import("../../coordinate.js").Coordinate} viewCoord View coordinate.
 * @param {import("../../proj.js").TransformFunction} inverse Proj transform view→source.
 * @param {import("../../transform.js").Transform} [transformMatrix] Source matrix.
 * @return {import("../../coordinate.js").Coordinate|null} Source coordinate.
 */
function viewToSource(viewCoord, inverse, transformMatrix) {
  let coord = inverse(viewCoord);
  if (transformMatrix) {
    coord = applyTransform(transformMatrix, coord.slice());
  }
  if (!isFinite(coord[0]) || !isFinite(coord[1])) {
    return null;
  }
  return coord;
}

/**
 * Clamp a source extent used for a warp field so it does not extend past the
 * projection's world. Padding past ±180° creates adjacent texture columns on
 * opposite sides of the antimeridian unless `allowUnwrappedX` is set.
 * @param {import("../../extent.js").Extent} extent Candidate source extent.
 * @param {import("../../proj/Projection.js").default} projection Source projection.
 * @param {boolean} [allowUnwrappedX] Keep X outside the world (dateline window).
 * @return {import("../../extent.js").Extent} Clamped extent.
 */
export function clampExtentForWarp(
  extent,
  projection,
  allowUnwrappedX = false,
) {
  const world = projection.getExtent();
  if (!world) {
    return extent.slice();
  }
  const result = extent.slice();
  result[1] = clamp(result[1], world[1], world[3]);
  result[3] = clamp(result[3], world[1], world[3]);
  if (projection.canWrapX()) {
    if (!allowUnwrappedX) {
      // Global / non-dateline views: clamp X so adjacent texture columns are
      // not opposite antimeridian sides (Mollweide streak source).
      result[0] = Math.max(result[0], world[0]);
      result[2] = Math.min(result[2], world[2]);
    }
  } else {
    const intersection = getIntersection(result, world);
    if (intersection && getArea(intersection)) {
      return intersection;
    }
  }
  if (result[0] >= result[2] || result[1] >= result[3]) {
    return world.slice();
  }
  return result;
}

/**
 * Whether an unwrapped source X window (past ±180°) stays continuous after
 * forward projection. Mercator/LCC near the dateline do; Mollweide jumps to
 * the opposite limb and must not build unwrapped warp fields (fill streaks).
 *
 * @param {import("../../proj/Projection.js").default} sourceProj Source projection.
 * @param {import("../../proj/Projection.js").default} targetProj Target projection.
 * @return {boolean} True when unwrapped source X is safe for warp sampling.
 */
export function targetAllowsUnwrappedSourceX(sourceProj, targetProj) {
  if (!sourceProj || !targetProj || !sourceProj.canWrapX()) {
    return false;
  }
  const world = sourceProj.getExtent();
  if (!world) {
    return false;
  }
  const worldWidth = getWidth(world);
  if (!(worldWidth > 0)) {
    return false;
  }
  const forward = getTransform(sourceProj, targetProj);
  const y = (world[1] + world[3]) / 2;
  const eps = worldWidth * 1e-6;
  const inside = forward([world[2] - eps, y]);
  const outside = forward([world[2] + eps, y]);
  if (
    !inside ||
    !outside ||
    !isFinite(inside[0]) ||
    !isFinite(inside[1]) ||
    !isFinite(outside[0]) ||
    !isFinite(outside[1])
  ) {
    return false;
  }
  const jump = Math.hypot(outside[0] - inside[0], outside[1] - inside[1]);
  const deg = Math.min(1, worldWidth * 0.01);
  const inside2 = forward([world[2] - deg, y]);
  if (!inside2 || !isFinite(inside2[0]) || !isFinite(inside2[1])) {
    return false;
  }
  const step = Math.hypot(inside[0] - inside2[0], inside[1] - inside2[1]);
  // Crossing the cut should look like a normal step, not a hemisphere jump.
  return jump < Math.max(step * 20, 1e-6);
}

/**
 * Pad a source extent then clamp for warp fields / buffer clip extents.
 * When `unwrapCenterX` is set on a wrap-X projection, the extent is recentered
 * into a continuous (possibly beyond ±180°) window around that center so the
 * warp field does not span the long way through the antimeridian cut.
 *
 * Pass `targetProj` when available: targets that fold across the antimeridian
 * (e.g. Mollweide) never get an unwrapped X window — samples past ±180° jump
 * to the opposite limb and LINEAR filtering draws continent-spanning fills.
 *
 * @param {import("../../extent.js").Extent} extent Source extent.
 * @param {import("../../proj/Projection.js").default} projection Source projection.
 * @param {number} [padFraction] Fraction of extent width to pad on each side.
 * @param {number} [unwrapCenterX] Preferred X center for dateline unwrap.
 * @param {import("../../proj/Projection.js").default} [targetProj] View projection.
 * @return {import("../../extent.js").Extent} Padded and clamped extent.
 */
export function padSourceExtentForWarp(
  extent,
  projection,
  padFraction = 0.25,
  unwrapCenterX = undefined,
  targetProj = undefined,
) {
  let working = extent;
  let allowUnwrappedX = false;
  const world = projection.getExtent();
  const worldWidth = world && projection.canWrapX() ? getWidth(world) : 0;
  const allowTargetUnwrap =
    !targetProj || targetAllowsUnwrappedSourceX(projection, targetProj);
  if (worldWidth > 0 && unwrapCenterX !== undefined && allowTargetUnwrap) {
    // Global footprints: keep world-clamped field (unwrapped half-world
    // windows break Mollweide / equal-area global views).
    if (getWidth(extent) > worldWidth * 0.5) {
      working = world.slice();
      working[1] = extent[1];
      working[3] = extent[3];
    } else {
      const minU = unwrapX(extent[0], unwrapCenterX, worldWidth);
      const maxU = unwrapX(extent[2], unwrapCenterX, worldWidth);
      working = [
        Math.min(minU, maxU),
        extent[1],
        Math.max(minU, maxU),
        extent[3],
      ];
      allowUnwrappedX = true;
    }
  }
  const pad = getWidth(working) * padFraction;
  /** @type {import("../../extent.js").Extent} */
  let padded = [
    working[0] - pad,
    working[1] - pad,
    working[2] + pad,
    working[3] + pad,
  ];
  // Near-hemispheric views (e.g. Africa→NZ) pad to >½ world. An unwrapped
  // field that wide still UV-clamps edge verts into continent-spanning streaks.
  if (allowUnwrappedX && getWidth(padded) > worldWidth * 0.5) {
    allowUnwrappedX = false;
    const fallbackPad = getWidth(extent) * padFraction;
    padded = [
      extent[0] - fallbackPad,
      extent[1] - fallbackPad,
      extent[2] + fallbackPad,
      extent[3] + fallbackPad,
    ];
  }
  return clampExtentForWarp(padded, projection, allowUnwrappedX);
}

/**
 * Sample rings around a view-space point into a source extent.
 * @param {import("../../coordinate.js").Coordinate} origin Ring center.
 * @param {number} halfScale Radius scale (typically half the smaller view side).
 * @param {function(import("../../coordinate.js").Coordinate): void} addSample Add sample.
 * @param {import("../../extent.js").Extent} [clipExtent] Only sample points inside.
 */
function addNearPointRings(origin, halfScale, addSample, clipExtent) {
  if (!(halfScale > 0)) {
    return;
  }
  for (const frac of [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.35]) {
    const r = halfScale * frac;
    for (let k = 0; k < 32; ++k) {
      const angle = (Math.PI * 2 * k) / 32;
      const x = origin[0] + r * Math.cos(angle);
      const y = origin[1] + r * Math.sin(angle);
      if (clipExtent && !containsXY(clipExtent, x, y)) {
        continue;
      }
      addSample([x, y]);
    }
  }
}

/**
 * Approximate the source-projection extent that covers a view extent by
 * sampling a coarse grid. Avoids Triangulation, which can explode (and blow
 * the inverse-transform object cache) for large / world-sized view extents.
 *
 * Also samples rings around the view center and, when present, the view
 * origin.  On wide polar views an even axis-aligned grid never hits near the
 * pole / antimeridian, so the estimated source extent can omit northern
 * mercator tiles or a dateline column and leave a radial gap.
 *
 * @param {import("../../extent.js").Extent} viewExtent View extent.
 * @param {import("../../proj/Projection.js").default} sourceProj Source projection.
 * @param {import("../../proj/Projection.js").default} viewProj View projection.
 * @param {import("../../transform.js").Transform} [transformMatrix] Source matrix.
 * @param {number} [samples] Samples along each axis (inclusive ends).
 * @param {number} [unwrapCenterX] Stable X center for dateline unwrap (buffers / warp field).
 * @return {import("../../extent.js").Extent|null} Source extent.
 */
export function estimateSourceExtentForView(
  viewExtent,
  sourceProj,
  viewProj,
  transformMatrix,
  samples = 8,
  unwrapCenterX = undefined,
) {
  const inverse = getTransform(viewProj, sourceProj);
  /** @type {Array<import("../../coordinate.js").Coordinate>} */
  const sourceSamples = [];
  /**
   * @param {import("../../coordinate.js").Coordinate} viewCoord View coordinate.
   */
  const addSample = (viewCoord) => {
    const sourceCoord = viewToSource(viewCoord, inverse, transformMatrix);
    if (sourceCoord) {
      sourceSamples.push(sourceCoord);
    }
  };

  const n = Math.max(2, samples);
  for (let j = 0; j < n; ++j) {
    const ty = j / (n - 1);
    const y = viewExtent[1] + ty * (viewExtent[3] - viewExtent[1]);
    for (let i = 0; i < n; ++i) {
      const tx = i / (n - 1);
      const x = viewExtent[0] + tx * (viewExtent[2] - viewExtent[0]);
      addSample([x, y]);
    }
  }

  const half = Math.min(getWidth(viewExtent), getHeight(viewExtent)) / 2;
  addNearPointRings(getCenter(viewExtent), half, addSample);

  // Rings around the origin catch polar singularities (e.g. EPSG:3413) when
  // the view is panned so the center rings miss the antimeridian.
  if (containsXY(viewExtent, 0, 0)) {
    addNearPointRings([0, 0], half, addSample, viewExtent);
  }

  if (!sourceSamples.length) {
    return null;
  }

  // Unwrap X around the view center in source space so a dateline-crossing
  // footprint does not become a near-world-wide bbox through lon 0.
  const world = sourceProj.getExtent();
  const worldWidth = sourceProj.canWrapX() && world ? getWidth(world) : 0;
  const centerSource = viewToSource(
    getCenter(viewExtent),
    inverse,
    transformMatrix,
  );
  const unwrapCenter =
    worldWidth > 0
      ? unwrapCenterX !== undefined
        ? unwrapCenterX
        : centerSource
          ? centerSource[0]
          : undefined
      : undefined;

  const extent = createEmpty();
  for (let i = 0; i < sourceSamples.length; ++i) {
    const sample = sourceSamples[i];
    if (unwrapCenter !== undefined) {
      extendCoordinate(extent, [
        unwrapX(sample[0], unwrapCenter, worldWidth),
        sample[1],
      ]);
    } else {
      extendCoordinate(extent, sample);
    }
  }
  return extent;
}

/**
 * Finest (smallest) source resolution over a target extent.  Using only the
 * view center is unstable near singularities (e.g. polar stereo ↔ mercator):
 * a slight pan can jump from a fine z to z=0 and leave radial coverage gaps.
 * @param {import("../../proj/Projection.js").default} sourceProj Source projection.
 * @param {import("../../proj/Projection.js").default} targetProj Target projection.
 * @param {import("../../extent.js").Extent} targetExtent Target extent.
 * @param {number} targetResolution Target resolution.
 * @param {number} [samples] Samples along each axis (inclusive ends).
 * @return {number} Finest positive finite source resolution, or the center-based fallback.
 */
export function calculateFinestSourceExtentResolution(
  sourceProj,
  targetProj,
  targetExtent,
  targetResolution,
  samples = 5,
) {
  let finest = Infinity;
  const n = Math.max(2, samples);
  for (let j = 0; j < n; ++j) {
    const ty = j / (n - 1);
    const y = targetExtent[1] + ty * (targetExtent[3] - targetExtent[1]);
    for (let i = 0; i < n; ++i) {
      const tx = i / (n - 1);
      const x = targetExtent[0] + tx * (targetExtent[2] - targetExtent[0]);
      const sourceResolution = calculateSourceResolution(
        sourceProj,
        targetProj,
        [x, y],
        targetResolution,
      );
      if (
        isFinite(sourceResolution) &&
        sourceResolution > 0 &&
        sourceResolution < finest
      ) {
        finest = sourceResolution;
      }
    }
  }
  if (isFinite(finest)) {
    return finest;
  }
  return calculateSourceExtentResolution(
    sourceProj,
    targetProj,
    targetExtent,
    targetResolution,
  );
}

/**
 * @typedef {Object} SourceTileQuery
 * @property {number} z Source zoom level.
 * @property {import("../../extent.js").Extent} sourceExtent Extent in source projection (may wrap).
 * @property {number} sourceResolution Ideal source resolution.
 */

/**
 * Compute the source zoom and extent needed to cover a view render extent.
 * @param {import("../../source/Tile.js").default} source Tile source.
 * @param {import("../../proj/Projection.js").default} viewProj View projection.
 * @param {import("../../extent.js").Extent} viewExtent View render extent.
 * @param {number} viewResolution View resolution.
 * @return {SourceTileQuery|null} Query parameters, or null if nothing to draw.
 */
export function getSourceTileQuery(
  source,
  viewProj,
  viewExtent,
  viewResolution,
) {
  const sourceProj = source.getProjection() || viewProj;
  const sourceTileGrid =
    source.getTileGrid() || source.getTileGridForProjection(sourceProj);
  if (!sourceTileGrid) {
    return null;
  }

  const sourceProjExtent = sourceProj.getExtent();
  const sourceTileGridExtent = sourceTileGrid.getExtent();
  let maxSourceExtent = sourceTileGridExtent;
  if (sourceProjExtent) {
    maxSourceExtent = maxSourceExtent
      ? getIntersection(maxSourceExtent, sourceProjExtent)
      : sourceProjExtent;
  }

  const sourceResolution = calculateFinestSourceExtentResolution(
    sourceProj,
    viewProj,
    viewExtent,
    viewResolution,
  );
  if (!isFinite(sourceResolution) || sourceResolution <= 0) {
    return null;
  }

  const dataSource = /** @type {import("../../source/DataTile.js").default} */ (
    /** @type {*} */ (source)
  );

  let sourceExtent = estimateSourceExtentForView(
    viewExtent,
    sourceProj,
    viewProj,
    dataSource.transformMatrix || undefined,
  );
  if (!sourceExtent) {
    return null;
  }

  // Polar ↔ mercator (and similar) estimates often span nearly the full
  // wrap-X world but still miss one dateline column, which shows up as a
  // radial white wedge.  Expand X to the full world when coverage is already
  // mostly global in longitude.
  if (sourceProj.canWrapX() && sourceProjExtent) {
    const worldWidth = getWidth(sourceProjExtent);
    if (worldWidth > 0 && getWidth(sourceExtent) > worldWidth * 0.5) {
      sourceExtent[0] = sourceProjExtent[0];
      sourceExtent[2] = sourceProjExtent[2];
    }
  }

  if (maxSourceExtent) {
    if (sourceProj.canWrapX()) {
      sourceExtent[1] = clamp(
        sourceExtent[1],
        maxSourceExtent[1],
        maxSourceExtent[3],
      );
      sourceExtent[3] = clamp(
        sourceExtent[3],
        maxSourceExtent[1],
        maxSourceExtent[3],
      );
    } else {
      sourceExtent = getIntersection(sourceExtent, maxSourceExtent);
    }
  }

  if (!sourceExtent || !getArea(sourceExtent)) {
    return null;
  }

  const z = sourceTileGrid.getZForResolution(
    sourceResolution,
    source.zDirection,
  );

  return {
    z,
    sourceExtent,
    sourceResolution,
  };
}

/**
 * @typedef {Object} SourceTileRef
 * @property {number} z Zoom.
 * @property {number} x Tile x.
 * @property {number} y Tile y.
 * @property {number} offset World-width offset for wrapX.
 */

/**
 * Enumerate source tiles covering a source extent (with wrapX slicing).
 * @param {import("../../source/Tile.js").default} source Tile source.
 * @param {import("../../proj/Projection.js").default} sourceProj Source projection.
 * @param {import("../../extent.js").Extent} sourceExtent Source extent.
 * @param {number} z Zoom level.
 * @return {Array<SourceTileRef>} Source tile references.
 */
export function getSourceTileRefs(source, sourceProj, sourceExtent, z) {
  const sourceTileGrid =
    source.getTileGrid() || source.getTileGridForProjection(sourceProj);
  /** @type {Array<SourceTileRef>} */
  const refs = [];
  if (!sourceTileGrid) {
    return refs;
  }

  let worldWidth = 0;
  let worldsAway = 0;
  const sourceProjExtent = sourceProj.getExtent();
  if (sourceProj.canWrapX() && sourceProjExtent) {
    worldWidth = getWidth(sourceProjExtent);
    worldsAway = Math.floor(
      (sourceExtent[0] - sourceProjExtent[0]) / worldWidth,
    );
  }

  const sourceExtents = wrapAndSliceX(sourceExtent.slice(), sourceProj, true);
  for (let e = 0; e < sourceExtents.length; ++e) {
    const extent = sourceExtents[e];
    const range = sourceTileGrid.getTileRangeForExtentAndZ(extent, z);
    for (let x = range.minX; x <= range.maxX; ++x) {
      for (let y = range.minY; y <= range.maxY; ++y) {
        refs.push({
          z,
          x,
          y,
          offset: worldsAway * worldWidth,
        });
      }
    }
    ++worldsAway;
  }
  return refs;
}

/**
 * Build a warped mesh for one source tile.
 *
 * Vertices are a regular grid in source projection space. The grid is expanded
 * by half a source pixel so adjacent tiles overlap slightly in target space —
 * without that, separate draw calls leave a 1px white seam under GPU
 * rasterization / UV precision (e.g. OSM → EPSG:4326 at XYZ meridians).
 * Texture UVs still use the unexpanded tile extent (see SOURCE_EXTENT), with
 * edge samples clamped in the fragment shader.
 *
 * @param {Object} options Options.
 * @param {import("../../proj/Projection.js").default} options.sourceProj Source projection.
 * @param {import("../../proj/Projection.js").default} options.targetProj Target projection.
 * @param {import("../../extent.js").Extent} options.sourceTileExtent Unoffset source tile extent.
 * @param {number} options.sourceResolution Source tile resolution (map units per pixel).
 * @param {number} [options.offsetX] Wrap offset.
 * @param {import("../../transform.js").Transform} [options.transformMatrix] Matrix.
 * @return {Mesh|null} Mesh or null if empty.
 */
export function createTileMesh(options) {
  const extent = options.sourceTileExtent;
  const halfPx = options.sourceResolution * 0.5;
  const mesh = new Mesh({
    sourceProj: options.sourceProj,
    targetProj: options.targetProj,
    sourceExtent: [
      extent[0] - halfPx,
      extent[1] - halfPx,
      extent[2] + halfPx,
      extent[3] + halfPx,
    ],
    sourceResolution: options.sourceResolution,
    sourceOffsetX: options.offsetX || 0,
    transformMatrix: options.transformMatrix,
  });

  if (mesh.isEmpty()) {
    return null;
  }
  return mesh;
}
