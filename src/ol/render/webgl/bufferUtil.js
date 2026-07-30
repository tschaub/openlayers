/**
 * Utilities for filling WebGL buffers
 * @module ol/render/webgl/bufferUtil
 */
import earcut from 'earcut';
import {angleBetween} from '../../coordinate.js';
import {clipFlatTriangleToExtent} from '../../geom/flat/clip.js';
import {apply as applyTransform} from '../../transform.js';

export const LINESTRING_ANGLE_COSINE_CUTOFF = 0.985;

/** @type {Array<number>} */
const tmpArray_ = [];

/**
 * An object holding positions both in an index and a vertex buffer.
 * @typedef {Object} BufferPositions
 * @property {number} vertexAttributesPosition Position in the vertex buffer
 * @property {number} instanceAttributesPosition Position in the vertex buffer
 * @property {number} indicesPosition Position in the index buffer
 */
const bufferPositions_ = {
  vertexAttributesPosition: 0,
  instanceAttributesPosition: 0,
  indicesPosition: 0,
};

/**
 * Pushes a quad (two triangles) based on a point geometry
 * @param {Float32Array} instructions Array of render instructions for points.
 * @param {number} elementIndex Index from which render instructions will be read.
 * @param {Float32Array} instanceAttributesBuffer Buffer in the form of a typed array.
 * @param {number} customAttributesSize Amount of custom attributes for each element.
 * @param {BufferPositions} [bufferPositions] Buffer write positions; if not specified, positions will be set at 0.
 * @return {BufferPositions} New buffer positions where to write next
 * @property {number} vertexAttributesPosition New position in the vertex buffer where future writes should start.
 * @property {number} indicesPosition New position in the index buffer where future writes should start.
 * @private
 */
export function writePointFeatureToBuffers(
  instructions,
  elementIndex,
  instanceAttributesBuffer,
  customAttributesSize,
  bufferPositions,
) {
  const x = instructions[elementIndex++];
  const y = instructions[elementIndex++];

  // read custom numerical attributes on the feature
  const customAttrs = tmpArray_;
  customAttrs.length = customAttributesSize;
  for (let i = 0; i < customAttrs.length; i++) {
    customAttrs[i] = instructions[elementIndex + i];
  }

  let instPos = bufferPositions
    ? bufferPositions.instanceAttributesPosition
    : 0;

  instanceAttributesBuffer[instPos++] = x;
  instanceAttributesBuffer[instPos++] = y;
  if (customAttrs.length) {
    instanceAttributesBuffer.set(customAttrs, instPos);
    instPos += customAttrs.length;
  }

  bufferPositions_.instanceAttributesPosition = instPos;
  return bufferPositions_;
}

/**
 * Pushes a single quad to form a line segment; also includes a computation for the join angles with previous and next
 * segment, in order to be able to offset the vertices correctly in the shader.
 * Join angles are between 0 and 2PI.
 * This also computes the length of the current segment and the sum of the join angle tangents in order
 * to store this information on each subsequent segment along the line. This is necessary to correctly render dashes
 * and symbols along the line.
 *
 *   pB (before)                          pA (after)
 *    X             negative             X
 *     \             offset             /
 *      \                              /
 *       \   join              join   /
 *        \ angle 0          angle 1 /
 *         \←---                ←---/      positive
 *          \   ←--          ←--   /        offset
 *           \     ↑       ↓      /
 *            X────┴───────┴─────X
 *            p0                  p1
 *
 * @param {Float32Array} instructions Array of render instructions for lines.s
 * @param {number} segmentStartIndex Index of the segment start point from which render instructions will be read.
 * @param {number} segmentEndIndex Index of the segment end point from which render instructions will be read.
 * @param {number|null} beforeSegmentIndex Index of the point right before the segment (null if none, e.g this is a line start)
 * @param {number|null} afterSegmentIndex Index of the point right after the segment (null if none, e.g this is a line end)
 * @param {Array<number>} instanceAttributesArray Array containing instance attributes.
 * @param {Array<number>} customAttributes Array of custom attributes value
 * @param {import('../../transform.js').Transform} toWorldTransform Transform matrix used to obtain world coordinates from instructions
 * @param {number} currentLength Cumulated length of segments processed so far
 * @param {number} currentAngleTangentSum Cumulated tangents of the join angles processed so far
 * @return {{length: number, angle: number}} Cumulated length with the newly processed segment (in world units), new sum of the join angle tangents
 * @private
 */
export function writeLineSegmentToBuffers(
  instructions,
  segmentStartIndex,
  segmentEndIndex,
  beforeSegmentIndex,
  afterSegmentIndex,
  instanceAttributesArray,
  customAttributes,
  toWorldTransform,
  currentLength,
  currentAngleTangentSum,
) {
  // The segment is composed of two positions called P0[x0, y0] and P1[x1, y1]
  // Depending on whether there are points before and after the segment, its final shape
  // will be different
  const p0 = [
    instructions[segmentStartIndex],
    instructions[segmentStartIndex + 1],
  ];
  const p1 = [instructions[segmentEndIndex], instructions[segmentEndIndex + 1]];

  const m0 = instructions[segmentStartIndex + 2];
  const m1 = instructions[segmentEndIndex + 2];

  // to compute join angles we need to reproject coordinates back in world units
  const p0world = applyTransform(toWorldTransform, [...p0]);
  const p1world = applyTransform(toWorldTransform, [...p1]);

  // a negative angle indicates a line cap
  let angle0 = -1;
  let angle1 = -1;
  let newAngleTangentSum = currentAngleTangentSum;

  const joinBefore = beforeSegmentIndex !== null;
  const joinAfter = afterSegmentIndex !== null;

  // add vertices and adapt offsets for P0 in case of join
  if (joinBefore) {
    // B for before
    const pB = [
      instructions[beforeSegmentIndex],
      instructions[beforeSegmentIndex + 1],
    ];
    const pBworld = applyTransform(toWorldTransform, [...pB]);
    angle0 = angleBetween(p0world, p1world, pBworld);

    // only add to the sum if the angle isn't too close to 0 or 2PI
    if (Math.cos(angle0) <= LINESTRING_ANGLE_COSINE_CUTOFF) {
      newAngleTangentSum += Math.tan((angle0 - Math.PI) / 2);
    }
  }
  // adapt offsets for P1 in case of join; add to angle sum
  if (joinAfter) {
    // A for after
    const pA = [
      instructions[afterSegmentIndex],
      instructions[afterSegmentIndex + 1],
    ];
    const pAworld = applyTransform(toWorldTransform, [...pA]);
    angle1 = angleBetween(p1world, p0world, pAworld);

    // only add to the sum if the angle isn't too close to 0 or 2PI
    if (Math.cos(angle1) <= LINESTRING_ANGLE_COSINE_CUTOFF) {
      newAngleTangentSum += Math.tan((Math.PI - angle1) / 2);
    }
  }

  const maxPrecision = Math.pow(2, 24);
  const distanceLow = currentLength % maxPrecision;
  const distanceHigh = Math.floor(currentLength / maxPrecision) * maxPrecision;

  instanceAttributesArray.push(
    p0[0],
    p0[1],
    m0,
    p1[0],
    p1[1],
    m1,
    angle0,
    angle1,
    distanceLow,
    distanceHigh,
    currentAngleTangentSum,
  );
  instanceAttributesArray.push(...customAttributes);

  return {
    length:
      currentLength +
      Math.sqrt(
        (p1world[0] - p0world[0]) * (p1world[0] - p0world[0]) +
          (p1world[1] - p0world[1]) * (p1world[1] - p0world[1]),
      ),
    angle: newAngleTangentSum,
  };
}

/**
 * @param {number} x X.
 * @param {number} y Y.
 * @param {Array<number>} extent Extent.
 * @return {boolean} Whether the point is inside the extent.
 */
function pointInExtent(x, y, extent) {
  return x >= extent[0] && y >= extent[1] && x <= extent[2] && y <= extent[3];
}

/**
 * Unwrap a single ring/line flat coordinate array (XY stride).
 * @param {Array<number>|Float32Array} flatCoords Interleaved coordinates.
 * @param {number} unwrapCenterX Center X.
 * @param {number} worldWidth World width.
 * @param {number} [stride] Coordinate stride.
 * @return {Array<number>} Unwrapped copy.
 */
export function unwrapFlatCoordinatesX(
  flatCoords,
  unwrapCenterX,
  worldWidth,
  stride = 2,
) {
  if (!(worldWidth > 0) || flatCoords.length < stride) {
    return Array.from(flatCoords);
  }
  /** @type {Array<number>} */
  const out = Array.from(flatCoords);
  for (let i = stride; i < out.length; i += stride) {
    const prev = out[i - stride];
    let x = out[i];
    const delta = x - prev;
    if (Math.abs(delta) > worldWidth * 0.5) {
      x -= worldWidth * Math.round(delta / worldWidth);
      out[i] = x;
    }
  }
  const shift = worldWidth * Math.round((out[0] - unwrapCenterX) / worldWidth);
  if (shift !== 0) {
    for (let i = 0; i < out.length; i += stride) {
      out[i] -= shift;
    }
  }
  return out;
}

/**
 * Unwrap polygon rings independently for earcut (XY stride 2).
 * @param {Array<number>|Float32Array} flatCoords Interleaved XY.
 * @param {Array<number>} holes Earcut hole indices (vertex index).
 * @param {number} unwrapCenterX Center X.
 * @param {number} worldWidth World width.
 * @return {Array<number>} Unwrapped copy.
 */
export function unwrapPolygonFlatCoordinates(
  flatCoords,
  holes,
  unwrapCenterX,
  worldWidth,
) {
  if (!(worldWidth > 0)) {
    return Array.from(flatCoords);
  }
  /** @type {Array<number>} */
  const ends = holes.slice();
  ends.push(flatCoords.length / 2);
  /** @type {Array<number>} */
  const out = [];
  let ringStart = 0;
  for (let r = 0; r < ends.length; ++r) {
    const ringEnd = ends[r];
    const ring = [];
    for (let i = ringStart; i < ringEnd; ++i) {
      ring.push(flatCoords[i * 2], flatCoords[i * 2 + 1]);
    }
    out.push(...unwrapFlatCoordinatesX(ring, unwrapCenterX, worldWidth, 2));
    ringStart = ringEnd;
  }
  return out;
}

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
  // ~50% of edge length: only clear folds (UV-clamp / antimeridian).
  return errX * errX + errY * errY > edgeLenSq * 0.25;
}

/**
 * @typedef {Object} RefinedTriangleBuffers
 * @property {Float32Array} vertices Vertex attributes.
 * @property {Uint32Array} indices Triangle indices.
 */

/**
 * Drop fill triangles that fold across a projection cut after warping.
 * Long smooth earcut diagonals (holes, concave rings) are kept — source-space
 * edge splits are not used because midpoints do not lie on warped edges and
 * create fan-shaped gaps (e.g. EPSG:23032 polygons with holes).
 *
 * @param {Float32Array|Array<number>} vertexArray Interleaved vertices.
 * @param {Uint32Array|Array<number>} indexArray Triangle indices.
 * @param {number} attributesPerVertex Components per vertex (≥ 2).
 * @param {function(import("../../coordinate.js").Coordinate): (import("../../coordinate.js").Coordinate|null)} projectToTarget Source→target.
 * @param {number} maxEdge Max edge length in target units before cut-testing.
 * @param {import("../../extent.js").Extent} [validTargetExtent] Reject verts outside.
 * @return {RefinedTriangleBuffers} Refined buffers.
 */
export function filterTrianglesByTargetEdge(
  vertexArray,
  indexArray,
  attributesPerVertex,
  projectToTarget,
  maxEdge,
  validTargetExtent = null,
) {
  const inputVertices =
    vertexArray instanceof Float32Array
      ? vertexArray
      : Float32Array.from(vertexArray);
  if (!(maxEdge > 0) || !projectToTarget) {
    return {
      vertices: inputVertices,
      indices:
        indexArray instanceof Uint32Array
          ? indexArray
          : Uint32Array.from(indexArray),
    };
  }
  const maxEdgeSq = maxEdge * maxEdge;
  /** @type {Array<number>} */
  const out = [];
  for (let i = 0; i < indexArray.length; i += 3) {
    const i0 = indexArray[i];
    const i1 = indexArray[i + 1];
    const i2 = indexArray[i + 2];
    const sa = [
      inputVertices[i0 * attributesPerVertex],
      inputVertices[i0 * attributesPerVertex + 1],
    ];
    const sb = [
      inputVertices[i1 * attributesPerVertex],
      inputVertices[i1 * attributesPerVertex + 1],
    ];
    const sc = [
      inputVertices[i2 * attributesPerVertex],
      inputVertices[i2 * attributesPerVertex + 1],
    ];
    const a = projectToTarget(sa);
    const b = projectToTarget(sb);
    const c = projectToTarget(sc);
    if (!a || !b || !c) {
      continue;
    }
    if (
      validTargetExtent &&
      (!pointInExtent(a[0], a[1], validTargetExtent) ||
        !pointInExtent(b[0], b[1], validTargetExtent) ||
        !pointInExtent(c[0], c[1], validTargetExtent))
    ) {
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
  return {
    vertices: inputVertices,
    indices: Uint32Array.from(out),
  };
}

/**
 * Pushes several triangles to form a polygon, including holes.
 *
 * When `projectToTarget` is set, earcut runs in target space so interior
 * diagonals stay inside the polygon after nonlinear warp (GPU edges are
 * straight chords between warped vertices). Vertex attributes remain in
 * source CRS for warp-field lookup.
 *
 * @param {Float32Array} instructions Array of render instructions for lines.
 * @param {number} polygonStartIndex Index of the polygon start point from which render instructions will be read.
 * @param {Array<number>} vertexArray Array containing vertices.
 * @param {Array<number>} indexArray Array containing indices.
 * @param {number} customAttributesSize Amount of custom attributes for each element.
 * @param {number} [maxTriangleEdgeLength] If > 0, skip triangles with |Δx| longer
 *     than this (source CRS units) — antimeridian-spanning earcut diagonals.
 * @param {Array<number>} [clipExtent] If set, clip triangles to this source
 *     extent (keeps fill up to the warp footprint instead of dropping).
 * @param {number} [unwrapCenterX] When set with worldWidth, unwrap ring X for earcut.
 * @param {number} [worldWidth] Source world width for X unwrap.
 * @param {function(import("../../coordinate.js").Coordinate): (import("../../coordinate.js").Coordinate|null)} [projectToTarget]
 *     When set, triangulate using projected coordinates.
 * @return {number} Next polygon instructions index
 * @private
 */
export function writePolygonTrianglesToBuffers(
  instructions,
  polygonStartIndex,
  vertexArray,
  indexArray,
  customAttributesSize,
  maxTriangleEdgeLength = 0,
  clipExtent = null,
  unwrapCenterX = undefined,
  worldWidth = 0,
  projectToTarget = undefined,
) {
  const instructionsPerVertex = 2; // x, y
  const attributesPerVertex = 2 + customAttributesSize;
  let instructionsIndex = polygonStartIndex;
  const customAttributes = instructions.slice(
    instructionsIndex,
    instructionsIndex + customAttributesSize,
  );
  instructionsIndex += customAttributesSize;
  const ringsCount = instructions[instructionsIndex++];
  let verticesCount = 0;
  /** @type {Array<number>} */
  const holes = new Array(ringsCount - 1);
  for (let i = 0; i < ringsCount; i++) {
    verticesCount += instructions[instructionsIndex++];
    if (i < ringsCount - 1) {
      holes[i] = verticesCount;
    }
  }
  const flatCoords = instructions.slice(
    instructionsIndex,
    instructionsIndex + verticesCount * instructionsPerVertex,
  );

  // Unwrap for earcut when dateline-centered; GPU verts stay unwrapped so they
  // match the warp field.
  const earcutCoords =
    worldWidth > 0 && unwrapCenterX !== undefined
      ? unwrapPolygonFlatCoordinates(
          flatCoords,
          holes,
          unwrapCenterX,
          worldWidth,
        )
      : Array.from(flatCoords);

  /** @type {Array<number>|null} */
  let projectedCoords = null;
  if (projectToTarget) {
    projectedCoords = [];
    for (let i = 0; i < earcutCoords.length; i += 2) {
      const projected = projectToTarget([earcutCoords[i], earcutCoords[i + 1]]);
      if (!projected) {
        projectedCoords = null;
        break;
      }
      projectedCoords.push(projected[0], projected[1]);
    }
  }

  const triangulationCoords = projectedCoords || earcutCoords;
  const result = earcut(triangulationCoords, holes, instructionsPerVertex);
  const maxDx = maxTriangleEdgeLength > 0 ? maxTriangleEdgeLength : 0;
  const baseVertex = vertexArray.length / attributesPerVertex;

  // Shared ring vertices keep the mesh watertight. Only straddling triangles
  // are clipped (Steiner verts); fully-inside triangles reuse ring indices.
  for (let i = 0; i < earcutCoords.length; i += 2) {
    vertexArray.push(earcutCoords[i], earcutCoords[i + 1], ...customAttributes);
  }

  for (let i = 0; i < result.length; i += 3) {
    const i0 = result[i];
    const i1 = result[i + 1];
    const i2 = result[i + 2];
    const ax = earcutCoords[i0 * 2];
    const ay = earcutCoords[i0 * 2 + 1];
    const bx = earcutCoords[i1 * 2];
    const by = earcutCoords[i1 * 2 + 1];
    const cx = earcutCoords[i2 * 2];
    const cy = earcutCoords[i2 * 2 + 1];
    if (maxDx > 0) {
      if (
        Math.abs(ax - bx) > maxDx ||
        Math.abs(bx - cx) > maxDx ||
        Math.abs(cx - ax) > maxDx
      ) {
        continue;
      }
    }
    if (clipExtent) {
      const aIn = pointInExtent(ax, ay, clipExtent);
      const bIn = pointInExtent(bx, by, clipExtent);
      const cIn = pointInExtent(cx, cy, clipExtent);
      if (aIn && bIn && cIn) {
        indexArray.push(i0 + baseVertex, i1 + baseVertex, i2 + baseVertex);
        continue;
      }
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
        const vi = vertexArray.length / attributesPerVertex;
        vertexArray.push(
          clipped[t],
          clipped[t + 1],
          ...customAttributes,
          clipped[t + 2],
          clipped[t + 3],
          ...customAttributes,
          clipped[t + 4],
          clipped[t + 5],
          ...customAttributes,
        );
        indexArray.push(vi, vi + 1, vi + 2);
      }
      continue;
    }
    indexArray.push(i0 + baseVertex, i1 + baseVertex, i2 + baseVertex);
  }

  return instructionsIndex + verticesCount * instructionsPerVertex;
}
