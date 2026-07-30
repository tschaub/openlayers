/**
 * @module ol/webgl/reproj/WarpField
 */

import {getTransform} from '../../proj.js';
import {create as createTransform, makeInverse} from '../../transform.js';
import {Uniforms, getReprojGridCacheKey} from './common.js';
import {
  buildSourceTargetGrid,
  projectSourceToTarget,
  sampleGrid,
} from './grid.js';
import {clampExtentForWarp} from './util.js';

/**
 * @typedef {Object} WarpFieldOptions
 * @property {import("../../proj/Projection.js").default} sourceProj Source projection.
 * @property {import("../../proj/Projection.js").default} targetProj Target (view) projection.
 * @property {import("../../extent.js").Extent} sourceExtent Source coverage extent.
 * @property {number} sourceResolution Source resolution (map units per pixel).
 * @property {import("../../transform.js").Transform} [transformMatrix] Optional source matrix.
 * @property {number} [sourceOffsetX] World-width offset (wrapX).
 */

/**
 * Max ratio of (field resolution / needed resolution) before the field is
 * considered too coarse and rebuilt.
 * @type {number}
 */
const RESOLUTION_REBUILD_FACTOR = 1.75;

/**
 * @param {WarpFieldOptions} options Options.
 * @return {string} Cache key.
 */
export function getWarpFieldCacheKey(options) {
  return getReprojGridCacheKey(options);
}

/**
 * GLSL helper for sampling a warp field texture.
 * Expects uniforms: u_warpTexture, u_warpSourceExtent, u_warpSize, u_warpEnabled.
 * @return {string} GLSL function source.
 */
export function getSourceToTargetGlsl() {
  return `
uniform float ${Uniforms.WARP_ENABLED};
uniform sampler2D ${Uniforms.WARP_TEXTURE};
uniform vec4 ${Uniforms.WARP_SOURCE_EXTENT};
uniform vec2 ${Uniforms.WARP_SIZE};
uniform vec2 ${Uniforms.WARP_SOURCE_ORIGIN};
uniform float ${Uniforms.WARP_MAX_EDGE_LENGTH};

vec2 sourceToTarget(vec2 pos) {
  if (${Uniforms.WARP_ENABLED} < 0.5) {
    return pos;
  }
  vec2 sourcePos = pos + ${Uniforms.WARP_SOURCE_ORIGIN};
  vec2 size = ${Uniforms.WARP_SIZE};
  vec4 extent = ${Uniforms.WARP_SOURCE_EXTENT};
  float u = (sourcePos.x - extent[0]) / (extent[2] - extent[0]);
  float v = (sourcePos.y - extent[1]) / (extent[3] - extent[1]);
  u = clamp(u, 0.0, 1.0) * (size.x - 1.0) / size.x + 0.5 / size.x;
  v = clamp(v, 0.0, 1.0) * (size.y - 1.0) / size.y + 0.5 / size.y;
  return texture2D(${Uniforms.WARP_TEXTURE}, vec2(u, v)).xy;
}

// True when an edge crosses the projection cut (antimeridian, etc.).
bool crossesProjectionCut(vec2 a, vec2 b) {
  return ${Uniforms.WARP_MAX_EDGE_LENGTH} > 0.0 &&
    distance(sourceToTarget(a), sourceToTarget(b)) > ${Uniforms.WARP_MAX_EDGE_LENGTH};
}
`;
}

/**
 * @classdesc
 * CPU/GPU lookup of target coordinates from source positions. Uses an evenly
 * spaced source grid so texture UVs match sample locations (raster
 * {@link module:ol/webgl/reproj/Mesh~Mesh} keeps a world-aligned grid for seams).
 */
class WarpField {
  /**
   * @param {WarpFieldOptions} options Options.
   */
  constructor(options) {
    /**
     * @type {string}
     */
    this.key = getWarpFieldCacheKey(options);

    /**
     * @type {import("../../proj/Projection.js").default}
     * @private
     */
    this.sourceProj_ = options.sourceProj;

    /**
     * @type {import("../../proj/Projection.js").default}
     * @private
     */
    this.targetProj_ = options.targetProj;

    /**
     * @type {import("../../transform.js").Transform|undefined}
     * @private
     */
    this.transformMatrix_ = options.transformMatrix;

    /**
     * @type {number}
     * @private
     */
    this.sourceOffsetX_ = options.sourceOffsetX || 0;

    /**
     * @type {number}
     * @private
     */
    this.sourceResolution_ = options.sourceResolution;

    /**
     * @type {import("./grid.js").SourceTargetGrid}
     * @private
     */
    // Even spacing so GPU UV (linear in extent) matches sample positions.
    // Preserve unwrapped dateline windows; clamp X only for world-aligned fields.
    const world = options.sourceProj.getExtent();
    const allowUnwrappedX = !!(
      world &&
      options.sourceProj.canWrapX() &&
      (options.sourceExtent[0] < world[0] || options.sourceExtent[2] > world[2])
    );
    this.grid_ = buildSourceTargetGrid({
      ...options,
      sourceExtent: clampExtentForWarp(
        options.sourceExtent,
        options.sourceProj,
        allowUnwrappedX,
      ),
      uniformSpacing: true,
    });

    /**
     * RGBA float pixels (R=targetX, G=targetY).
     * @type {Float32Array}
     * @private
     */
    this.pixels_ = new Float32Array(this.grid_.cols * this.grid_.rows * 4);
    for (let i = 0, j = 0; i < this.grid_.targetXY.length; i += 2, j += 4) {
      this.pixels_[j] = this.grid_.targetXY[i];
      this.pixels_[j + 1] = this.grid_.targetXY[i + 1];
      this.pixels_[j + 2] = 0;
      this.pixels_[j + 3] = 1;
    }

    /**
     * @type {WebGLTexture|null}
     * @private
     */
    this.texture_ = null;

    /**
     * @type {boolean}
     * @private
     */
    this.canInterpolate_ = false;

    /**
     * @type {boolean}
     * @private
     */
    this.uploaded_ = false;

    /**
     * False when the GL context cannot store float textures.
     * @type {boolean}
     * @private
     */
    this.usable_ = true;
  }

  /**
   * @return {import("../../extent.js").Extent} Source extent covered by the field.
   */
  getSourceExtent() {
    return this.grid_.sourceExtent;
  }

  /**
   * @return {import("../../size.js").Size} Texture size [cols, rows].
   */
  getSize() {
    return [this.grid_.cols, this.grid_.rows];
  }

  /**
   * @return {number} Source resolution used to build the field.
   */
  getSourceResolution() {
    return this.sourceResolution_;
  }

  /**
   * Whether this field can serve a view footprint at the given resolution.
   * @param {import("../../extent.js").Extent} sourceExtent Needed source extent.
   * @param {number} sourceResolution Needed source resolution.
   * @return {boolean} True if the field still covers the footprint finely enough.
   */
  covers(sourceExtent, sourceResolution) {
    if (!this.usable_) {
      return false;
    }
    const extent = this.grid_.sourceExtent;
    if (
      sourceExtent[0] < extent[0] ||
      sourceExtent[1] < extent[1] ||
      sourceExtent[2] > extent[2] ||
      sourceExtent[3] > extent[3]
    ) {
      return false;
    }
    // Smaller resolution = finer; rebuild when the field is much coarser.
    return (
      this.sourceResolution_ <= sourceResolution * RESOLUTION_REBUILD_FACTOR
    );
  }

  /**
   * Bilinear sample (CPU), matching GPU LINEAR when float filtering is available.
   * @param {import("../../coordinate.js").Coordinate} sourcePos Source position
   * (without wrap offset; offset is applied when the field was built).
   * @return {import("../../coordinate.js").Coordinate|null} Target position.
   */
  sample(sourcePos) {
    const offset = this.sourceOffsetX_;
    return sampleGrid(this.grid_, [sourcePos[0] - offset, sourcePos[1]]);
  }

  /**
   * Exact forward projection at a source position (for accuracy tests).
   * @param {import("../../coordinate.js").Coordinate} sourcePos Source position.
   * @return {import("../../coordinate.js").Coordinate|null} Target position.
   */
  projectExact(sourcePos) {
    const forward = getTransform(this.sourceProj_, this.targetProj_);
    const inverseMatrix = this.transformMatrix_
      ? makeInverse(createTransform(), this.transformMatrix_)
      : undefined;
    return projectSourceToTarget(
      sourcePos,
      this.sourceProj_,
      this.targetProj_,
      this.transformMatrix_,
      forward,
      inverseMatrix,
    );
  }

  /**
   * Upload the field to a float texture if needed.
   * @param {import("../Helper.js").default} helper WebGL helper.
   */
  flush(helper) {
    if (this.uploaded_) {
      return;
    }
    const gl = helper.getGL();
    const floatExt = helper.getExtension('OES_texture_float');
    const isWebGL2 =
      typeof WebGL2RenderingContext !== 'undefined' &&
      gl instanceof WebGL2RenderingContext;
    if (!floatExt && !isWebGL2) {
      // World coordinates cannot be packed into UNSIGNED_BYTE meaningfully.
      this.usable_ = false;
      this.uploaded_ = true;
      return;
    }
    const linearExt = helper.getExtension('OES_texture_float_linear');
    this.canInterpolate_ = linearExt !== null;
    this.usable_ = true;

    if (!this.texture_) {
      this.texture_ = gl.createTexture();
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texture_);
    const filter = this.canInterpolate_ ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.grid_.cols,
      this.grid_.rows,
      0,
      gl.RGBA,
      gl.FLOAT,
      this.pixels_,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.uploaded_ = true;
  }

  /**
   * Bind the warp texture and return uniform values for the current program.
   * @param {import("../Helper.js").default} helper WebGL helper.
   * @return {Object<string, number|Array<number>|WebGLTexture>} Uniform map.
   */
  getUniforms(helper) {
    this.flush(helper);
    if (!this.usable_ || !this.texture_) {
      return WarpField.disabledUniforms();
    }
    const extent = this.grid_.sourceExtent;
    return {
      [Uniforms.WARP_ENABLED]: 1,
      [Uniforms.WARP_TEXTURE]: this.texture_,
      [Uniforms.WARP_SOURCE_EXTENT]: [
        extent[0] + this.sourceOffsetX_,
        extent[1],
        extent[2] + this.sourceOffsetX_,
        extent[3],
      ],
      [Uniforms.WARP_SIZE]: [this.grid_.cols, this.grid_.rows],
    };
  }

  /**
   * Uniforms that disable warping (identity sourceToTarget).
   * @return {Object<string, number>} Uniform map.
   */
  static disabledUniforms() {
    return {
      [Uniforms.WARP_ENABLED]: 0,
    };
  }

  /**
   * @param {import("../Helper.js").default} helper WebGL helper.
   */
  delete(helper) {
    if (!helper || !this.texture_) {
      this.texture_ = null;
      this.uploaded_ = false;
      return;
    }
    helper.getGL().deleteTexture(this.texture_);
    this.texture_ = null;
    this.uploaded_ = false;
  }
}

export default WarpField;
