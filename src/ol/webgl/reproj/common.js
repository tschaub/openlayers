/**
 * @module ol/webgl/reproj/common
 */

import {getUid} from '../../util.js';

export {MAX_TRIANGLE_WIDTH} from '../../reproj/common.js';

/**
 * Shared cache-key pieces for Mesh / WarpField grids.
 * @param {Object} options Options with source/target proj, extent, resolution.
 * @param {import("../../proj/Projection.js").default} options.sourceProj Source projection.
 * @param {import("../../proj/Projection.js").default} options.targetProj Target projection.
 * @param {import("../../extent.js").Extent} options.sourceExtent Source extent.
 * @param {number} options.sourceResolution Source resolution.
 * @param {number} [options.sourceOffsetX] Wrap offset.
 * @param {import("../../transform.js").Transform} [options.transformMatrix] Matrix.
 * @param {string} [extra] Extra key segment (e.g. buildEdges).
 * @return {string} Cache key.
 */
export function getReprojGridCacheKey(options, extra) {
  const se = options.sourceExtent;
  const matrix = options.transformMatrix;
  const parts = [
    getUid(options.sourceProj),
    getUid(options.targetProj),
    se.join(','),
    options.sourceResolution,
    options.sourceOffsetX || 0,
    matrix ? matrix.join(',') : '',
  ];
  if (extra !== undefined) {
    parts.push(extra);
  }
  return parts.join('|');
}

/**
 * Shader attribute names for raster reprojection meshes.
 * `a_targetPos` for clip space, `a_sourcePos` for texture UVs.
 * Vector layers use a {@link module:ol/webgl/reproj/WarpField~WarpField}
 * lookup texture instead of these attributes.
 * @enum {string}
 */
export const Attributes = {
  TARGET_POS: 'a_targetPos',
  SOURCE_POS: 'a_sourcePos',
};

/**
 * Shader uniform names for reprojection (raster mesh + vector warp field).
 * @enum {string}
 */
export const Uniforms = {
  SCREEN_FROM_TARGET: 'u_screenFromTarget',
  SOURCE_EXTENT: 'u_sourceExtent',
  GUTTER: 'u_gutter',
  TEXTURE_PIXEL_SIZE: 'u_texturePixelSize',
  WARP_ENABLED: 'u_warpEnabled',
  WARP_TEXTURE: 'u_warpTexture',
  WARP_SOURCE_EXTENT: 'u_warpSourceExtent',
  WARP_SIZE: 'u_warpSize',
  /** Added to attribute positions before lookup (tile-local → source world). */
  WARP_SOURCE_ORIGIN: 'u_warpSourceOrigin',
  /**
   * Max allowed edge length in target CRS after warp; longer edges are treated
   * as crossing the projection cut (e.g. antimeridian) and discarded.
   */
  WARP_MAX_EDGE_LENGTH: 'u_warpMaxEdgeLength',
};
