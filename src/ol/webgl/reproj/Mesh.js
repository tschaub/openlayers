/**
 * @module ol/webgl/reproj/Mesh
 */

import {containsXY, getWidth} from '../../extent.js';
import {ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, STATIC_DRAW} from '../../webgl.js';
import WebGLArrayBuffer from '../Buffer.js';
import {AttributeType} from '../Helper.js';
import {
  Attributes,
  MAX_TRIANGLE_WIDTH,
  getReprojGridCacheKey,
} from './common.js';
import {buildSourceTargetGrid} from './grid.js';

/**
 * @typedef {Object} MeshOptions
 * @property {import("../../proj/Projection.js").default} sourceProj Source projection.
 * @property {import("../../proj/Projection.js").default} targetProj Target (view) projection.
 * @property {import("../../extent.js").Extent} sourceExtent Source tile extent (unoffset).
 * @property {number} sourceResolution Source tile resolution (map units per pixel).
 * @property {import("../../transform.js").Transform} [transformMatrix] Optional source transform matrix.
 * @property {number} [sourceOffsetX] World-width offset applied to source coordinates (wrapX).
 * @property {boolean} [buildEdges] Build line buffers for triangle edges (debug / tests).
 */

/**
 * Attribute layout for Mesh vertex buffers (`a_targetPos`, `a_sourcePos`).
 * @type {Array<import('../Helper.js').AttributeDescription>}
 */
export const attributeDescriptions = [
  {
    name: Attributes.TARGET_POS,
    size: 2,
    type: AttributeType.FLOAT,
  },
  {
    name: Attributes.SOURCE_POS,
    size: 2,
    type: AttributeType.FLOAT,
  },
];

/**
 * @param {MeshOptions} options Mesh options.
 * @return {string} Cache key.
 */
export function getMeshCacheKey(options) {
  return getReprojGridCacheKey(options, options.buildEdges ? '1' : '0');
}

/**
 * @classdesc
 * WebGL buffers for a reprojection mesh built from a regular grid in source
 * projection space. Adjacent tiles share exact edge coordinates, so forward
 * transforms produce matching target vertices and seams stay closed while zooming.
 */
class Mesh {
  /**
   * @param {MeshOptions} options Mesh options.
   */
  constructor(options) {
    /**
     * @type {string}
     */
    this.key = getMeshCacheKey(options);

    const buildEdges = Boolean(options.buildEdges);
    const grid = buildSourceTargetGrid({
      sourceProj: options.sourceProj,
      targetProj: options.targetProj,
      sourceExtent: options.sourceExtent,
      sourceResolution: options.sourceResolution,
      sourceOffsetX: options.sourceOffsetX,
      transformMatrix: options.transformMatrix,
      uniformSpacing: false,
    });
    const {xs, ys, targetXY, cols, rows} = grid;
    // Top→bottom in source Y so UV v increases downward like the texture.
    // buildSourceTargetGrid stores rows bottom→top; reverse when packing.
    /** @type {Array<number>} */
    const vertices = [];
    /** @type {Array<number>} */
    const indices = [];
    /** @type {Array<number>|null} */
    const edgeVertices = buildEdges ? [] : null;

    /** @type {Array<boolean>} */
    const valid = new Array(rows * cols);
    const offsetX = options.sourceOffsetX || 0;

    for (let row = 0; row < rows; ++row) {
      const srcRow = rows - 1 - row;
      const sy = ys[srcRow];
      for (let col = 0; col < cols; ++col) {
        const sourceX = xs[col] + offsetX;
        const gridIndex = (srcRow * cols + col) * 2;
        const tx = targetXY[gridIndex];
        const ty = targetXY[gridIndex + 1];
        const index = row * cols + col;
        if (isFinite(tx) && isFinite(ty)) {
          valid[index] = true;
          vertices.push(tx, ty, sourceX, sy);
        } else {
          valid[index] = false;
          vertices.push(0, 0, sourceX, sy);
        }
      }
    }

    const targetExtent = options.targetProj.getExtent();
    // Pad slightly so samples on the world rim stay valid; reject far
    // outliers (e.g. south-hemisphere mercator → EPSG:3413) that blow up
    // clip-space precision and paint viewport rays.
    /** @type {import("../../extent.js").Extent|null} */
    let validTargetExtent = null;
    if (targetExtent && getWidth(targetExtent) > 0) {
      const pad = getWidth(targetExtent) * 0.05;
      validTargetExtent = [
        targetExtent[0] - pad,
        targetExtent[1] - pad,
        targetExtent[2] + pad,
        targetExtent[3] + pad,
      ];
      for (let i = 0; i < valid.length; ++i) {
        if (
          valid[i] &&
          !containsXY(validTargetExtent, vertices[i * 4], vertices[i * 4 + 1])
        ) {
          valid[i] = false;
        }
      }
    }

    const maxEdgeSq =
      targetExtent && getWidth(targetExtent) > 0
        ? Math.pow(getWidth(targetExtent) * MAX_TRIANGLE_WIDTH, 2)
        : Infinity;

    /**
     * @param {number} i Vertex index.
     * @param {number} j Vertex index.
     * @return {boolean} Edge crosses the projection cut.
     */
    const crossesCut = (i, j) => {
      const dx = vertices[i * 4] - vertices[j * 4];
      const dy = vertices[i * 4 + 1] - vertices[j * 4 + 1];
      return dx * dx + dy * dy > maxEdgeSq;
    };

    for (let row = 0; row < rows - 1; ++row) {
      for (let col = 0; col < cols - 1; ++col) {
        const i00 = row * cols + col;
        const i10 = i00 + 1;
        const i01 = i00 + cols;
        const i11 = i01 + 1;
        if (!valid[i00] || !valid[i10] || !valid[i01] || !valid[i11]) {
          continue;
        }
        // Drop quads that span the antimeridian / projection cut (stretched
        // triangles that paint a tile edge across the whole map). Check
        // diagonals too — split edges can exceed the threshold when sides do not.
        if (
          crossesCut(i00, i10) ||
          crossesCut(i00, i01) ||
          crossesCut(i10, i11) ||
          crossesCut(i01, i11) ||
          crossesCut(i00, i11) ||
          crossesCut(i10, i01)
        ) {
          continue;
        }
        indices.push(i00, i10, i01, i10, i11, i01);
        if (edgeVertices) {
          edgeVertices.push(
            vertices[i00 * 4],
            vertices[i00 * 4 + 1],
            vertices[i10 * 4],
            vertices[i10 * 4 + 1],
            vertices[i10 * 4],
            vertices[i10 * 4 + 1],
            vertices[i11 * 4],
            vertices[i11 * 4 + 1],
            vertices[i11 * 4],
            vertices[i11 * 4 + 1],
            vertices[i01 * 4],
            vertices[i01 * 4 + 1],
            vertices[i01 * 4],
            vertices[i01 * 4 + 1],
            vertices[i00 * 4],
            vertices[i00 * 4 + 1],
          );
        }
      }
    }

    /**
     * @type {WebGLArrayBuffer}
     */
    this.vertices = new WebGLArrayBuffer(ARRAY_BUFFER, STATIC_DRAW);
    this.vertices.fromArray(vertices);

    /**
     * @type {WebGLArrayBuffer}
     */
    this.indices = new WebGLArrayBuffer(ELEMENT_ARRAY_BUFFER, STATIC_DRAW);
    this.indices.fromArray(indices);

    /**
     * @type {WebGLArrayBuffer|null}
     */
    this.edgeVertices = edgeVertices
      ? new WebGLArrayBuffer(ARRAY_BUFFER, STATIC_DRAW)
      : null;
    if (this.edgeVertices && edgeVertices) {
      this.edgeVertices.fromArray(edgeVertices);
    }

    /**
     * @type {boolean}
     * @private
     */
    this.flushed_ = false;
  }

  /**
   * @return {boolean} True if the mesh has no triangles.
   */
  isEmpty() {
    return this.indices.getSize() === 0;
  }

  /**
   * @return {number} Number of indices.
   */
  getIndexCount() {
    return this.indices.getSize();
  }

  /**
   * @return {number} Number of edge vertices (2 components each, for LINES).
   */
  getEdgeVertexCount() {
    return this.edgeVertices ? this.edgeVertices.getSize() / 2 : 0;
  }

  /**
   * Upload buffers to the GPU if needed.
   * @param {import("../Helper.js").default} helper WebGL helper.
   */
  flush(helper) {
    if (this.flushed_) {
      return;
    }
    helper.flushBufferData(this.vertices);
    helper.flushBufferData(this.indices);
    if (this.edgeVertices) {
      helper.flushBufferData(this.edgeVertices);
    }
    this.flushed_ = true;
  }

  /**
   * Delete GPU resources.
   * @param {import("../Helper.js").default} helper WebGL helper.
   */
  delete(helper) {
    if (!helper) {
      return;
    }
    helper.deleteBuffer(this.vertices);
    helper.deleteBuffer(this.indices);
    if (this.edgeVertices) {
      helper.deleteBuffer(this.edgeVertices);
    }
    this.flushed_ = false;
  }
}

export default Mesh;
