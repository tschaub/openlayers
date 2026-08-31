/**
 * @module ol/render/webgpu/tessellate
 *
 * Polygon fill triangulation for WebGPU. When reprojecting, this follows the
 * webgl-reproj approach: densify in source space, earcut in target space, then
 * clip triangles and drop edges that fold across a projection cut.
 */
import earcut from 'earcut';
import {clipFlatTriangleToExtent} from '../../geom/flat/clip.js';
import {densifyFlatCoordinates} from '../../geom/flat/densify.js';

/**
 * @typedef {Object} TessellateOptions
 * @property {function(import("../../coordinate.js").Coordinate): (import("../../coordinate.js").Coordinate|null)} [projectToTarget]
 *     Source→target. When set, earcut runs on projected coordinates.
 * @property {import("../../extent.js").Extent} [clipExtent] Clip triangles in target space.
 * @property {number} [maxSegmentLength] Densify source rings (source units).
 * @property {number} [maxSpanX] Do not densify source segments with |Δx| larger than this.
 * @property {number} [maxTargetEdge] Drop folding triangles whose target edges exceed this.
 */

/**
 * True when a long source edge is a projection cut (warp folds) rather than a
 * legitimate earcut diagonal. Smooth warps keep the midpoint near the chord;
 * antimeridian / UV-clamp streaks send it far away.
 *
 * @param {import("../../coordinate.js").Coordinate} sa Source A.
 * @param {import("../../coordinate.js").Coordinate} sb Source B.
 * @param {import("../../coordinate.js").Coordinate} ta Target A.
 * @param {import("../../coordinate.js").Coordinate} tb Target B.
 * @param {function(import("../../coordinate.js").Coordinate): (import("../../coordinate.js").Coordinate|null)} projectToTarget Source→target.
 * @param {number} edgeLenSq Squared target edge length.
 * @return {boolean} Edge crosses a cut.
 */
function targetEdgeCrossesCut(sa, sb, ta, tb, projectToTarget, edgeLenSq) {
  const mid = projectToTarget([(sa[0] + sb[0]) * 0.5, (sa[1] + sb[1]) * 0.5]);
  if (!mid) {
    return true;
  }
  const ex = (ta[0] + tb[0]) * 0.5;
  const ey = (ta[1] + tb[1]) * 0.5;
  const errX = mid[0] - ex;
  const errY = mid[1] - ey;
  return errX * errX + errY * errY > edgeLenSq * 0.25;
}

/**
 * Drop fill triangles that fold across a projection cut after warping.
 * Long smooth earcut diagonals (holes, concave rings) are kept.
 *
 * @param {Array<number>|Float32Array} sourceXY Source-space XY vertices.
 * @param {Array<number>|Uint32Array} indexArray Triangle indices.
 * @param {function(import("../../coordinate.js").Coordinate): (import("../../coordinate.js").Coordinate|null)} projectToTarget Source→target.
 * @param {number} maxEdge Max edge length in target units before cut-testing.
 * @return {Array<number>} Filtered triangle indices.
 */
export function filterTrianglesByTargetEdge(
  sourceXY,
  indexArray,
  projectToTarget,
  maxEdge,
) {
  if (!(maxEdge > 0) || !projectToTarget) {
    return Array.from(indexArray);
  }
  const maxEdgeSq = maxEdge * maxEdge;
  /** @type {Array<number>} */
  const out = [];
  for (let i = 0; i < indexArray.length; i += 3) {
    const i0 = indexArray[i];
    const i1 = indexArray[i + 1];
    const i2 = indexArray[i + 2];
    const sa = [sourceXY[i0 * 2], sourceXY[i0 * 2 + 1]];
    const sb = [sourceXY[i1 * 2], sourceXY[i1 * 2 + 1]];
    const sc = [sourceXY[i2 * 2], sourceXY[i2 * 2 + 1]];
    const a = projectToTarget(sa);
    const b = projectToTarget(sb);
    const c = projectToTarget(sc);
    if (!a || !b || !c) {
      continue;
    }
    const ab = (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]);
    const bc = (b[0] - c[0]) * (b[0] - c[0]) + (b[1] - c[1]) * (b[1] - c[1]);
    const ca = (c[0] - a[0]) * (c[0] - a[0]) + (c[1] - a[1]) * (c[1] - a[1]);
    const maxLenSq = Math.max(ab, bc, ca);
    if (
      maxLenSq > maxEdgeSq &&
      ((ab > maxEdgeSq &&
        targetEdgeCrossesCut(sa, sb, a, b, projectToTarget, ab)) ||
        (bc > maxEdgeSq &&
          targetEdgeCrossesCut(sb, sc, b, c, projectToTarget, bc)) ||
        (ca > maxEdgeSq &&
          targetEdgeCrossesCut(sc, sa, c, a, projectToTarget, ca)))
    ) {
      continue;
    }
    out.push(i0, i1, i2);
  }
  return out;
}

/**
 * Densify polygon rings independently and rebuild earcut hole indices.
 *
 * @param {Array<number>} xy Flat XY.
 * @param {Array<number>} holes Earcut hole vertex indices.
 * @param {number} maxSegmentLength Max segment length.
 * @param {number} [maxSpanX] Max |Δx| to densify.
 * @return {{flatCoordinates: Array<number>, holes: Array<number>}} Densified rings.
 */
export function densifyPolygonRings(xy, holes, maxSegmentLength, maxSpanX) {
  const ends = holes.slice();
  ends.push(xy.length / 2);
  /** @type {Array<number>} */
  const out = [];
  /** @type {Array<number>} */
  const newHoles = [];
  let start = 0;
  for (let r = 0; r < ends.length; ++r) {
    const end = ends[r];
    /** @type {Array<number>} */
    const ring = [];
    for (let i = start; i < end; ++i) {
      ring.push(xy[i * 2], xy[i * 2 + 1]);
    }
    const dense = densifyFlatCoordinates(ring, maxSegmentLength, maxSpanX);
    if (r > 0) {
      newHoles.push(out.length / 2);
    }
    out.push(...dense);
    start = end;
  }
  return {flatCoordinates: out, holes: newHoles};
}

/**
 * @typedef {Object} TessellatedPolygon
 * @property {Array<number>} vertices Target-space XY (pairs).
 * @property {Array<number>} indices Triangle indices into `vertices`.
 */

/**
 * Triangulate a polygon. Without `projectToTarget` this is a straight earcut
 * (same as the previous WebGPU fill path). With reprojection, densify, earcut
 * in target space, drop folding triangles, and clip to `clipExtent`.
 *
 * @param {Array<number>} xy Flat XY in source space.
 * @param {Array<number>} holes Earcut hole indices.
 * @param {TessellateOptions} [options] Reprojection options.
 * @return {TessellatedPolygon} Target-space mesh.
 */
export function tessellatePolygon(xy, holes, options) {
  const projectToTarget = options?.projectToTarget;
  const clipExtent = options?.clipExtent;
  const maxSegmentLength = options?.maxSegmentLength || 0;
  const maxSpanX = options?.maxSpanX || 0;
  const maxTargetEdge = options?.maxTargetEdge || 0;

  let sourceXY = xy;
  let sourceHoles = holes;
  if (maxSegmentLength > 0) {
    const dense = densifyPolygonRings(xy, holes, maxSegmentLength, maxSpanX);
    sourceXY = dense.flatCoordinates;
    sourceHoles = dense.holes;
  }

  /** @type {Array<number>} */
  let targetXY = sourceXY;
  if (projectToTarget) {
    targetXY = [];
    for (let i = 0; i < sourceXY.length; i += 2) {
      const projected = projectToTarget([sourceXY[i], sourceXY[i + 1]]);
      if (!projected || !isFinite(projected[0]) || !isFinite(projected[1])) {
        return {vertices: [], indices: []};
      }
      targetXY.push(projected[0], projected[1]);
    }
  }

  const tris = earcut(targetXY, sourceHoles, 2);
  /** @type {Array<number>} */
  const afterSourceCut = [];
  if (maxSpanX > 0) {
    for (let i = 0; i < tris.length; i += 3) {
      const i0 = tris[i];
      const i1 = tris[i + 1];
      const i2 = tris[i + 2];
      const ax = sourceXY[i0 * 2];
      const bx = sourceXY[i1 * 2];
      const cx = sourceXY[i2 * 2];
      if (
        Math.abs(ax - bx) > maxSpanX ||
        Math.abs(bx - cx) > maxSpanX ||
        Math.abs(cx - ax) > maxSpanX
      ) {
        continue;
      }
      afterSourceCut.push(i0, i1, i2);
    }
  }
  const candidates = maxSpanX > 0 ? afterSourceCut : tris;
  const filtered = projectToTarget
    ? filterTrianglesByTargetEdge(
        sourceXY,
        candidates,
        projectToTarget,
        maxTargetEdge,
      )
    : candidates;

  if (!clipExtent) {
    return {vertices: targetXY, indices: Array.from(filtered)};
  }

  /** @type {Array<number>} */
  const vertices = [];
  /** @type {Array<number>} */
  const indices = [];
  for (let i = 0; i < filtered.length; i += 3) {
    const i0 = filtered[i];
    const i1 = filtered[i + 1];
    const i2 = filtered[i + 2];
    const ax = targetXY[i0 * 2];
    const ay = targetXY[i0 * 2 + 1];
    const bx = targetXY[i1 * 2];
    const by = targetXY[i1 * 2 + 1];
    const cx = targetXY[i2 * 2];
    const cy = targetXY[i2 * 2 + 1];
    const clipped = clipFlatTriangleToExtent(
      ax,
      ay,
      bx,
      by,
      cx,
      cy,
      clipExtent,
    );
    for (let t = 0; t < clipped.length; t += 6) {
      const base = vertices.length / 2;
      vertices.push(
        clipped[t],
        clipped[t + 1],
        clipped[t + 2],
        clipped[t + 3],
        clipped[t + 4],
        clipped[t + 5],
      );
      indices.push(base, base + 1, base + 2);
    }
  }
  return {vertices, indices};
}

/**
 * Project a flat XY array. Returns null if any vertex fails.
 *
 * @param {Array<number>} xy Flat XY.
 * @param {function(import("../../coordinate.js").Coordinate): (import("../../coordinate.js").Coordinate|null)} [projectToTarget] Transform.
 * @param {number} [maxSegmentLength] Densify before projecting.
 * @param {number} [maxSpanX] Densify span limit.
 * @return {Array<number>|null} Target XY, or the input if no transform.
 */
export function projectFlatCoordinates(
  xy,
  projectToTarget,
  maxSegmentLength,
  maxSpanX,
) {
  const source = maxSegmentLength
    ? densifyFlatCoordinates(xy, maxSegmentLength, maxSpanX)
    : xy;
  if (!projectToTarget) {
    return source;
  }
  /** @type {Array<number>} */
  const out = [];
  for (let i = 0; i < source.length; i += 2) {
    const projected = projectToTarget([source[i], source[i + 1]]);
    if (!projected || !isFinite(projected[0]) || !isFinite(projected[1])) {
      return null;
    }
    out.push(projected[0], projected[1]);
  }
  return out;
}
