/**
 * @module ol/renderer/webgl/vectorUtil
 */

import {getWidth} from '../../extent.js';
import {getHighPart, getLowPart} from '../../render/webgl/float64Util.js';
import {
  apply as applyTransform,
  compose as composeTransform,
  create as createTransform,
  makeInverse as makeInverseTransform,
  multiply as multiplyTransform,
  setFromArray as setFromTransform,
} from '../../transform.js';
import {
  create as createMat4,
  fromTransform as mat4FromTransform,
} from '../../vec/mat4.js';
import {DefaultUniform} from '../../webgl/Helper.js';
import {
  MAX_TRIANGLE_WIDTH,
  Uniforms as ReprojUniforms,
} from '../../webgl/reproj/common.js';

export const VectorUniforms = {
  // the patterns origin is computed on the CPU; it is expressed in the same coordinate system as the geometries rendered,
  // except the rotation which is left to 0 in order to efficiently compute pattern offsets without involving sin/cos
  PATTERN_ORIGIN_X_DOUBLE: 'u_df_patternOriginX',
  PATTERN_ORIGIN_Y_DOUBLE: 'u_df_patternOriginY',

  // patterns are scaled slightly up/down to match zoom levels; this is computed on the CPU for better precision and passed as a double float
  PATTERN_SCALE_RATIO_DOUBLE: 'u_df_patternScaleRatio',

  // this is used in double-float arithmetics to prevent precision-handling logic from being compiled out
  ONE: 'u_one',
};

const tmpCoords = [0, 0];
const tmpCoords2 = [0, 0];
const tmpTransform = createTransform();
const tmpMat4 = createMat4();

/**
 * Applies uniforms used in vector rendering
 * @param {import('../../webgl/Helper.js').default} helper Helper
 * @param {import('../../transform.js').Transform} worldToViewTransform Transform
 * @param {import('../../transform.js').Transform} geometryInvertTransform Transform.
 * @param {import('../../Map.js').FrameState} frameState Frame state.
 * @param {Object} [options] Options.
 * @param {boolean} [options.patternsInSourceSpace] When true, pattern origin is
 *     computed in buffer/source space (used while GPU-warping). Residual error
 *     vs a Euclidean pattern in target space is expected under strong warps.
 */
export function applyVectorUniforms(
  helper,
  worldToViewTransform,
  geometryInvertTransform,
  frameState,
  options,
) {
  // world to screen matrix
  setFromTransform(tmpTransform, worldToViewTransform);
  multiplyTransform(tmpTransform, geometryInvertTransform);
  helper.setUniformMatrixValue(
    DefaultUniform.PROJECTION_MATRIX,
    mat4FromTransform(tmpMat4, tmpTransform),
  );

  // screen to world matrix
  makeInverseTransform(tmpTransform, tmpTransform);
  helper.setUniformMatrixValue(
    DefaultUniform.INVERT_PROJECTION_MATRIX,
    mat4FromTransform(tmpMat4, tmpTransform),
  );

  // pattern origin: compute pixel position of world [0,0] in pixel coordinates _without rotation_
  // these coordinates will be given as double-floats to the shader to avoid float32 precision loss
  // (see https://github.com/openlayers/openlayers/issues/16705)
  tmpCoords[0] = 0;
  tmpCoords[1] = 0;

  // compute & apply the transformation from world to pixel (without rotation)
  const size = frameState.size;
  const resolution = frameState.viewState.resolution;
  const center = frameState.viewState.center;
  composeTransform(
    tmpTransform,
    size[0] / 2,
    size[1] / 2,
    1 / resolution,
    1 / resolution,
    0,
    -center[0],
    -center[1],
  );
  if (options?.patternsInSourceSpace) {
    // Anchor patterns in the same CRS as buffer positions (source when warping).
    multiplyTransform(tmpTransform, geometryInvertTransform);
  }
  applyTransform(tmpTransform, tmpCoords);

  // set uniforms
  tmpCoords2[0] = getHighPart(tmpCoords[0]);
  tmpCoords2[1] = getLowPart(tmpCoords[0]);
  helper.setUniformFloatVec2(
    VectorUniforms.PATTERN_ORIGIN_X_DOUBLE,
    tmpCoords2,
  );
  tmpCoords2[0] = getHighPart(tmpCoords[1]);
  tmpCoords2[1] = getLowPart(tmpCoords[1]);
  helper.setUniformFloatVec2(
    VectorUniforms.PATTERN_ORIGIN_Y_DOUBLE,
    tmpCoords2,
  );

  // we're also computing the scale ratio of the pattern so that we don't encounter
  // precision issues on the GPU
  const scaleRatio = Math.pow(2, ((frameState.viewState.zoom + 0.5) % 1) - 0.5);
  tmpCoords[0] = getHighPart(scaleRatio);
  tmpCoords[1] = getLowPart(scaleRatio);
  helper.setUniformFloatVec2(
    VectorUniforms.PATTERN_SCALE_RATIO_DOUBLE,
    tmpCoords,
  );
}

/**
 * Texture unit reserved for the source→target warp field.
 * @type {number}
 */
export const WARP_TEXTURE_SLOT = 10;

/**
 * @type {WebGLTexture|null}
 */
let dummyWarpTexture = null;

/**
 * @param {import('../../webgl/Helper.js').default} helper Helper.
 * @return {WebGLTexture} 1×1 placeholder texture.
 */
function getDummyWarpTexture(helper) {
  if (dummyWarpTexture) {
    return dummyWarpTexture;
  }
  const gl = helper.getGL();
  dummyWarpTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, dummyWarpTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0]),
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
  return dummyWarpTexture;
}

/**
 * Bind warp-field uniforms for vector shaders (`sourceToTarget`).
 * @param {import('../../webgl/Helper.js').default} helper Helper.
 * @param {import('../../webgl/reproj/WarpField.js').default|null|undefined} warpField Active warp field, or null to disable.
 * @param {import('../../coordinate.js').Coordinate} [sourceOrigin] Added to
 *     attribute positions before lookup (tile origin + wrap offset).
 * @param {import('../../proj/Projection.js').default} [targetProj] Target
 *     projection (for cut-crossing edge length threshold).
 * @param {number} [maxEdgeLength] Optional view-sized cut threshold in target
 *     units. When omitted, falls back to a fraction of the target CRS width.
 */
export function applyWarpUniforms(
  helper,
  warpField,
  sourceOrigin,
  targetProj,
  maxEdgeLength,
) {
  const origin = sourceOrigin || [0, 0];
  if (warpField) {
    const uniforms = warpField.getUniforms(helper);
    if (
      uniforms[ReprojUniforms.WARP_ENABLED] &&
      uniforms[ReprojUniforms.WARP_TEXTURE]
    ) {
      helper.setUniformFloatValue(ReprojUniforms.WARP_ENABLED, 1);
      helper.bindTexture(
        /** @type {WebGLTexture} */ (uniforms[ReprojUniforms.WARP_TEXTURE]),
        WARP_TEXTURE_SLOT,
        ReprojUniforms.WARP_TEXTURE,
      );
      helper.setUniformFloatVec4(
        ReprojUniforms.WARP_SOURCE_EXTENT,
        /** @type {Array<number>} */ (
          uniforms[ReprojUniforms.WARP_SOURCE_EXTENT]
        ),
      );
      helper.setUniformFloatVec2(
        ReprojUniforms.WARP_SIZE,
        /** @type {Array<number>} */ (uniforms[ReprojUniforms.WARP_SIZE]),
      );
      helper.setUniformFloatVec2(ReprojUniforms.WARP_SOURCE_ORIGIN, origin);
      const targetExtent = targetProj && targetProj.getExtent();
      const crsMaxEdge =
        targetExtent && getWidth(targetExtent) > 0
          ? getWidth(targetExtent) * MAX_TRIANGLE_WIDTH
          : 0;
      const maxEdge =
        maxEdgeLength > 0
          ? crsMaxEdge > 0
            ? Math.min(maxEdgeLength, crsMaxEdge)
            : maxEdgeLength
          : crsMaxEdge;
      helper.setUniformFloatValue(ReprojUniforms.WARP_MAX_EDGE_LENGTH, maxEdge);
      return;
    }
  }
  helper.setUniformFloatValue(ReprojUniforms.WARP_ENABLED, 0);
  helper.bindTexture(
    getDummyWarpTexture(helper),
    WARP_TEXTURE_SLOT,
    ReprojUniforms.WARP_TEXTURE,
  );
  helper.setUniformFloatVec4(ReprojUniforms.WARP_SOURCE_EXTENT, [0, 0, 1, 1]);
  helper.setUniformFloatVec2(ReprojUniforms.WARP_SIZE, [1, 1]);
  helper.setUniformFloatVec2(ReprojUniforms.WARP_SOURCE_ORIGIN, [0, 0]);
  helper.setUniformFloatValue(ReprojUniforms.WARP_MAX_EDGE_LENGTH, 0);
}
