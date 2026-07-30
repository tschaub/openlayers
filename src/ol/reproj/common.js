/**
 * @module ol/reproj/common
 */

/**
 * Default maximum allowed threshold  (in pixels) for reprojection
 * triangulation.
 * @type {number}
 */
export const ERROR_THRESHOLD = 0.5;

/**
 * Maximum allowed triangle edge length relative to the target projection
 * world width. When transforming corners of world extent between certain
 * projections, the resulting triangulation seems to have zero error and no
 * subdivision is performed. If the triangle width is more than this
 * (relative to world width; 0-1), subdivision is forced (up to
 * `MAX_SUBDIVISION`). Also used by WebGL mesh/warp cut detection.
 * @type {number}
 */
export const MAX_TRIANGLE_WIDTH = 0.25;
