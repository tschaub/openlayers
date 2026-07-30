/**
 * @module ol/webgl/reproj/grid
 */
import {getWidth} from '../../extent.js';
import {getTransform, transform as transformCoordinate} from '../../proj.js';
import {
  apply as applyTransform,
  create as createTransform,
  makeInverse,
} from '../../transform.js';
import {getUid} from '../../util.js';

/**
 * Relative inset from a wrap-X world edge before forward projection.
 * Mercator max-x converts to lon 180+ε, which Mollweide (and similar)
 * maps into the opposite hemisphere — pulling dateline tile edges across
 * the map. Nudge just inside the world so the east edge stays east.
 * @type {number}
 */
const WRAP_EDGE_INSET = 1e-9;

/**
 * Hard cap on samples per axis for warp/mesh grids (avoids OOM on fine
 * resolution over large source extents).
 * @type {number}
 */
export const MAX_GRID_AXIS_SAMPLES = 256;

/**
 * @type {Map<string, number>}
 */
const pixelsPerSampleCache = new Map();

/**
 * Max entries kept in {@link pixelsPerSampleCache}.
 * @type {number}
 */
const PIXELS_PER_SAMPLE_CACHE_MAX = 64;

/**
 * Estimate how many source pixels per mesh cell based on warp severity.
 * @param {import("../../proj/Projection.js").default} sourceProj Source projection.
 * @param {import("../../proj/Projection.js").default} targetProj Target projection.
 * @param {number} sourceResolution Source resolution.
 * @param {import("../../transform.js").Transform} [transformMatrix] Source matrix.
 * @return {number} Source pixels per sample.
 */
export function getPixelsPerSample(
  sourceProj,
  targetProj,
  sourceResolution,
  transformMatrix,
) {
  const cacheKey = [
    getUid(sourceProj),
    getUid(targetProj),
    sourceResolution,
    transformMatrix ? transformMatrix.join(',') : '',
  ].join('|');
  if (pixelsPerSampleCache.has(cacheKey)) {
    return /** @type {number} */ (pixelsPerSampleCache.get(cacheKey));
  }

  if (transformMatrix) {
    setPixelsPerSampleCache_(cacheKey, 24);
    return 24;
  }

  const forward = getTransform(sourceProj, targetProj);
  const extent = sourceProj.getExtent();
  let maxErrPx = 0;
  const span = sourceResolution * 256;
  /** @type {Array<import("../../coordinate.js").Coordinate>} */
  const anchors = extent
    ? [
        [extent[0] + span, (extent[1] + extent[3]) / 2],
        [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2],
        [extent[2] - span, (extent[1] + extent[3]) / 2],
        [(extent[0] + extent[2]) / 2, extent[1] + span],
        [(extent[0] + extent[2]) / 2, extent[3] - span],
      ]
    : [
        [0, 0],
        [span, 0],
        [0, span],
      ];

  for (let a = 0; a < anchors.length; ++a) {
    const origin = anchors[a];
    const corners = [
      [origin[0], origin[1]],
      [origin[0] + span, origin[1]],
      [origin[0] + span, origin[1] + span],
      [origin[0], origin[1] + span],
    ];
    /** @type {Array<import("../../coordinate.js").Coordinate>} */
    const projected = [];
    let ok = true;
    for (let i = 0; i < 4; ++i) {
      const p = forward(corners[i]);
      if (!isFinite(p[0]) || !isFinite(p[1])) {
        ok = false;
        break;
      }
      projected.push(p);
    }
    if (!ok) {
      continue;
    }
    for (let i = 0; i < 4; ++i) {
      const j = (i + 1) % 4;
      const midSource = [
        (corners[i][0] + corners[j][0]) / 2,
        (corners[i][1] + corners[j][1]) / 2,
      ];
      const midActual = forward(midSource);
      if (!isFinite(midActual[0]) || !isFinite(midActual[1])) {
        continue;
      }
      const midLinear = [
        (projected[i][0] + projected[j][0]) / 2,
        (projected[i][1] + projected[j][1]) / 2,
      ];
      const dx = midActual[0] - midLinear[0];
      const dy = midActual[1] - midLinear[1];
      const cornerDist = Math.hypot(
        projected[j][0] - projected[i][0],
        projected[j][1] - projected[i][1],
      );
      const errPx =
        cornerDist > 0 ? (Math.hypot(dx, dy) / cornerDist) * 256 : 0;
      if (errPx > maxErrPx) {
        maxErrPx = errPx;
      }
    }
  }

  let pixelsPerSample;
  if (maxErrPx < 0.75) {
    pixelsPerSample = 64;
  } else if (maxErrPx < 2) {
    pixelsPerSample = 48;
  } else if (maxErrPx < 5) {
    pixelsPerSample = 32;
  } else {
    pixelsPerSample = 16;
  }
  setPixelsPerSampleCache_(cacheKey, pixelsPerSample);
  return pixelsPerSample;
}

/**
 * @param {string} key Cache key.
 * @param {number} value Pixels per sample.
 */
function setPixelsPerSampleCache_(key, value) {
  if (pixelsPerSampleCache.has(key)) {
    pixelsPerSampleCache.delete(key);
  } else if (pixelsPerSampleCache.size >= PIXELS_PER_SAMPLE_CACHE_MAX) {
    const oldest = pixelsPerSampleCache.keys().next().value;
    pixelsPerSampleCache.delete(oldest);
  }
  pixelsPerSampleCache.set(key, value);
}

/**
 * @param {import("../../proj/Projection.js").default} sourceProj Source projection.
 * @param {import("../../proj/Projection.js").default} targetProj Target projection.
 * @param {number} sourceResolution Source resolution.
 * @param {import("../../transform.js").Transform} [transformMatrix] Source matrix.
 * @return {number} Spacing in source units.
 */
export function getSampleSpacing(
  sourceProj,
  targetProj,
  sourceResolution,
  transformMatrix,
) {
  return (
    sourceResolution *
    getPixelsPerSample(
      sourceProj,
      targetProj,
      sourceResolution,
      transformMatrix,
    )
  );
}

/**
 * @param {number} min Min coordinate.
 * @param {number} max Max coordinate.
 * @param {number} spacing Sample spacing.
 * @return {Array<number>} Sample coordinates ascending.
 */
export function getAxisSamples(min, max, spacing) {
  /** @type {Array<number>} */
  const samples = [min];
  if (!(spacing > 0) || max <= min) {
    if (max !== min) {
      samples.push(max);
    }
    return samples;
  }
  const first = Math.ceil((min + spacing * 1e-9) / spacing) * spacing;
  for (let v = first; v < max - spacing * 1e-9; v += spacing) {
    samples.push(v);
    if (samples.length >= MAX_GRID_AXIS_SAMPLES - 1) {
      break;
    }
  }
  if (samples[samples.length - 1] !== max) {
    samples.push(max);
  }
  return samples;
}

/**
 * Shift X by whole worlds so it lies as close as possible to `centerX`.
 * @param {number} x X coordinate.
 * @param {number} centerX Center to unwrap toward.
 * @param {number} worldWidth World width.
 * @return {number} Unwrapped X.
 */
export function unwrapX(x, centerX, worldWidth) {
  if (!(worldWidth > 0)) {
    return x;
  }
  return x - worldWidth * Math.round((x - centerX) / worldWidth);
}

/**
 * Wrap X into the projection world extent (inverse of unwrap for projection).
 * @param {import("../../coordinate.js").Coordinate} coord Source coordinate.
 * @param {import("../../proj/Projection.js").default} sourceProj Source projection.
 * @return {import("../../coordinate.js").Coordinate} Coordinate in world X range.
 */
export function wrapToWorldX(coord, sourceProj) {
  if (!sourceProj.canWrapX()) {
    return coord;
  }
  const world = sourceProj.getExtent();
  if (!world) {
    return coord;
  }
  const worldWidth = getWidth(world);
  if (!(worldWidth > 0)) {
    return coord;
  }
  const x = coord[0];
  if (x >= world[0] && x <= world[2]) {
    return coord;
  }
  const wrapped =
    ((((x - world[0]) % worldWidth) + worldWidth) % worldWidth) + world[0];
  return [wrapped, coord[1]];
}

/**
 * Nudge wrap-X coordinates off the world edge before forward projection so
 * float error (e.g. mercator max → lon 180+ε) does not flip the hemisphere.
 * @param {import("../../coordinate.js").Coordinate} coord Source coordinate.
 * @param {import("../../proj/Projection.js").default} sourceProj Source projection.
 * @return {import("../../coordinate.js").Coordinate} Coordinate safe to project.
 */
export function insetWrapXEdges(coord, sourceProj) {
  if (!sourceProj.canWrapX()) {
    return coord;
  }
  const world = sourceProj.getExtent();
  if (!world) {
    return coord;
  }
  const worldWidth = getWidth(world);
  if (!(worldWidth > 0)) {
    return coord;
  }
  const inset = worldWidth * WRAP_EDGE_INSET;
  const x = coord[0];
  if (x > world[2] - inset && x < world[2] + inset) {
    return [world[2] - inset, coord[1]];
  }
  if (x < world[0] + inset && x > world[0] - inset) {
    return [world[0] + inset, coord[1]];
  }
  return coord;
}

/**
 * @param {import("../../coordinate.js").Coordinate} sourceCoord Source coordinate.
 * @param {import("../../proj/Projection.js").default} sourceProj Source projection.
 * @param {import("../../proj/Projection.js").default} targetProj Target projection.
 * @param {import("../../transform.js").Transform|undefined} transformMatrix Source matrix.
 * @param {import("../../proj.js").TransformFunction} forward Transform without matrix.
 * @param {import("../../transform.js").Transform} [inverseMatrix] Inverse of transformMatrix.
 * @return {import("../../coordinate.js").Coordinate|null} Target coordinate, or null if invalid.
 */
export function projectSourceToTarget(
  sourceCoord,
  sourceProj,
  targetProj,
  transformMatrix,
  forward,
  inverseMatrix,
) {
  // Keep unwrapped X (e.g. 181° in a dateline-centered warp field). Wrapping
  // back into ±180 puts a discontinuity in the warp texture at lon 180; LINEAR
  // filtering across that seam produces east↔west fill streaks.
  let coord = insetWrapXEdges(sourceCoord, sourceProj);
  if (transformMatrix && inverseMatrix) {
    coord = applyTransform(inverseMatrix, coord.slice());
    coord = transformCoordinate(coord, sourceProj, targetProj);
  } else {
    coord = forward(coord);
  }
  if (!isFinite(coord[0]) || !isFinite(coord[1])) {
    return null;
  }
  return coord;
}

/**
 * @typedef {Object} GridOptions
 * @property {import("../../proj/Projection.js").default} sourceProj Source projection.
 * @property {import("../../proj/Projection.js").default} targetProj Target projection.
 * @property {import("../../extent.js").Extent} sourceExtent Source extent.
 * @property {number} sourceResolution Source resolution.
 * @property {import("../../transform.js").Transform} [transformMatrix] Source matrix.
 * @property {number} [sourceOffsetX] Wrap X offset.
 * @property {boolean} [uniformSpacing] If true, space samples evenly across the
 *     extent (required for texture UV lookup). If false, use a world-aligned
 *     grid so adjacent raster meshes share exact edge vertices.
 */

/**
 * @typedef {Object} SourceTargetGrid
 * @property {Array<number>} xs Ascending source X samples.
 * @property {Array<number>} ys Ascending source Y samples (bottom→top).
 * @property {Float32Array} targetXY Interleaved target X/Y, row-major bottom→top.
 * @property {number} cols Column count.
 * @property {number} rows Row count.
 * @property {import("../../extent.js").Extent} sourceExtent Source extent used.
 */

/**
 * Evenly spaced samples from min to max (inclusive), with step ≈ spacing.
 * Matches GPU texture UV mapping used by {@link module:ol/webgl/reproj/WarpField}.
 * @param {number} min Min coordinate.
 * @param {number} max Max coordinate.
 * @param {number} spacing Ideal sample spacing.
 * @return {Array<number>} Sample coordinates ascending.
 */
export function getUniformAxisSamples(min, max, spacing) {
  if (!(max > min)) {
    return [min];
  }
  if (!(spacing > 0)) {
    return [min, max];
  }
  const count = Math.min(
    MAX_GRID_AXIS_SAMPLES,
    Math.max(2, Math.ceil((max - min) / spacing) + 1),
  );
  /** @type {Array<number>} */
  const samples = new Array(count);
  const last = count - 1;
  for (let i = 0; i < count; ++i) {
    samples[i] = min + ((max - min) * i) / last;
  }
  return samples;
}

/**
 * Build a regular source→target sample grid.
 * @param {GridOptions} options Options.
 * @return {SourceTargetGrid} Grid.
 */
export function buildSourceTargetGrid(options) {
  const offsetX = options.sourceOffsetX || 0;
  const extent = options.sourceExtent;
  const spacing = getSampleSpacing(
    options.sourceProj,
    options.targetProj,
    options.sourceResolution,
    options.transformMatrix,
  );
  const axisSamples = options.uniformSpacing
    ? getUniformAxisSamples
    : getAxisSamples;
  const xs = axisSamples(extent[0], extent[2], spacing);
  const ys = axisSamples(extent[1], extent[3], spacing);
  const cols = xs.length;
  const rows = ys.length;
  const forward = getTransform(options.sourceProj, options.targetProj);
  const inverseMatrix = options.transformMatrix
    ? makeInverse(createTransform(), options.transformMatrix)
    : undefined;

  const targetXY = new Float32Array(cols * rows * 2);
  for (let row = 0; row < rows; ++row) {
    const sy = ys[row];
    for (let col = 0; col < cols; ++col) {
      const sourceX = xs[col] + offsetX;
      const targetCoord = projectSourceToTarget(
        [sourceX, sy],
        options.sourceProj,
        options.targetProj,
        options.transformMatrix,
        forward,
        inverseMatrix,
      );
      const index = (row * cols + col) * 2;
      if (targetCoord) {
        targetXY[index] = targetCoord[0];
        targetXY[index + 1] = targetCoord[1];
      } else {
        targetXY[index] = NaN;
        targetXY[index + 1] = NaN;
      }
    }
  }

  return {
    xs,
    ys,
    targetXY,
    cols,
    rows,
    sourceExtent: extent.slice(),
  };
}

/**
 * Bilinear sample of a source→target grid.
 * @param {SourceTargetGrid} grid Grid.
 * @param {import("../../coordinate.js").Coordinate} sourcePos Source position.
 * @return {import("../../coordinate.js").Coordinate|null} Target position.
 */
export function sampleGrid(grid, sourcePos) {
  const {xs, ys, targetXY, cols, rows} = grid;
  if (cols < 2 || rows < 2) {
    return null;
  }
  // Clamp to grid bounds so CPU sampling matches GPU UV clamp.
  const x = Math.min(Math.max(sourcePos[0], xs[0]), xs[cols - 1]);
  const y = Math.min(Math.max(sourcePos[1], ys[0]), ys[rows - 1]);
  let col0 = 0;
  while (col0 < cols - 2 && xs[col0 + 1] < x) {
    ++col0;
  }
  let row0 = 0;
  while (row0 < rows - 2 && ys[row0 + 1] < y) {
    ++row0;
  }
  const col1 = Math.min(col0 + 1, cols - 1);
  const row1 = Math.min(row0 + 1, rows - 1);
  const x0 = xs[col0];
  const x1 = xs[col1];
  const y0 = ys[row0];
  const y1 = ys[row1];
  const tx = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
  const ty = y1 === y0 ? 0 : (y - y0) / (y1 - y0);

  /**
   * @param {number} row Row.
   * @param {number} col Column.
   * @return {import("../../coordinate.js").Coordinate|null} Target.
   */
  function at(row, col) {
    const i = (row * cols + col) * 2;
    const txv = targetXY[i];
    const tyv = targetXY[i + 1];
    if (!isFinite(txv) || !isFinite(tyv)) {
      return null;
    }
    return [txv, tyv];
  }

  const p00 = at(row0, col0);
  const p10 = at(row0, col1);
  const p01 = at(row1, col0);
  const p11 = at(row1, col1);
  if (!p00 || !p10 || !p01 || !p11) {
    return p00 || p10 || p01 || p11;
  }
  const a = p00[0] * (1 - tx) + p10[0] * tx;
  const b = p01[0] * (1 - tx) + p11[0] * tx;
  const c = p00[1] * (1 - tx) + p10[1] * tx;
  const d = p01[1] * (1 - tx) + p11[1] * tx;
  return [a * (1 - ty) + b * ty, c * (1 - ty) + d * ty];
}
