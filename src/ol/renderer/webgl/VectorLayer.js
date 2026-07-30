/**
 * @module ol/renderer/webgl/VectorLayer
 */
import ViewHint from '../../ViewHint.js';
import {assert} from '../../asserts.js';
import {listen, unlistenByKey} from '../../events.js';
import {
  buffer,
  createEmpty,
  equals,
  getHeight,
  getWidth,
} from '../../extent.js';
import BaseVector from '../../layer/BaseVector.js';
import {
  get as getProjection,
  getTransform,
  getTransformFromProjections,
  getUserProjection,
  toUserExtent,
  toUserResolution,
} from '../../proj.js';
import MixedGeometryBatch from '../../render/webgl/MixedGeometryBatch.js';
import VectorStyleRenderer, {
  toFlatStyleLike,
} from '../../render/webgl/VectorStyleRenderer.js';
import {colorDecodeId} from '../../render/webgl/encodeUtil.js';
import {hasTextStyle} from '../../render/webgl/textUtil.js';
import VectorEventType from '../../source/VectorEventType.js';
import {
  apply as applyTransform,
  create as createTransform,
  translate as translateTransform,
} from '../../transform.js';
import {getUid} from '../../util.js';
import {DefaultUniform} from '../../webgl/Helper.js';
import WebGLRenderTarget from '../../webgl/RenderTarget.js';
import WarpField from '../../webgl/reproj/WarpField.js';
import {
  calculateFinestSourceExtentResolution,
  estimateSourceExtentForView,
  needsReprojection,
  padSourceExtentForWarp,
  targetAllowsUnwrappedSourceX,
} from '../../webgl/reproj/util.js';
import WebGLLayerRenderer from './Layer.js';
import {
  applyVectorUniforms,
  applyWarpUniforms,
  VectorUniforms,
} from './vectorUtil.js';
import {getWorldParameters} from './worldUtil.js';

export const Uniforms = {
  ...DefaultUniform,
  ...VectorUniforms,
  RENDER_EXTENT: 'u_renderExtent', // intersection of layer, source, and view extent
  GLOBAL_ALPHA: 'u_globalAlpha',
};

/**
 * @typedef {import('../../render/webgl/VectorStyleRenderer.js').StyleShaders} StyleShaders
 */
/**
 * @typedef {import('../../style/flat.js').FlatStyleLike | Array<StyleShaders> | StyleShaders} LayerStyle
 */

/**
 * @typedef {Object} Options
 * @property {string} [className='ol-layer'] A CSS class name to set to the canvas element.
 * @property {LayerStyle} style Flat vector style; also accepts shaders
 * @property {Object<string, number|Array<number>|string|boolean>} variables Style variables
 * @property {boolean} [disableHitDetection=false] Setting this to true will provide a slight performance boost, but will
 * prevent all hit detection on the layer.
 * @property {Array<import("./Layer.js").PostProcessesOptions>} [postProcesses] Post-processes definitions
 */

/**
 * @classdesc
 * Experimental WebGL vector renderer. Supports polygons, lines and points:
 *  Polygons are broken down into triangles
 *  Lines are rendered as strips of quads
 *  Points are rendered as quads
 *
 * You need to provide vertex and fragment shaders as well as custom attributes for each type of geometry. All shaders
 * can access the uniforms in the {@link module:ol/webgl/Helper~DefaultUniform} enum.
 * The vertex shaders can access the following attributes depending on the geometry type:
 *  For polygons: {@link module:ol/render/webgl/PolygonBatchRenderer~Attributes}
 *  For line strings: {@link module:ol/render/webgl/LineStringBatchRenderer~Attributes}
 *  For points: {@link module:ol/render/webgl/PointBatchRenderer~Attributes}
 *
 * Please note that the fragment shaders output should have premultiplied alpha, otherwise visual anomalies may occur.
 *
 * Note: this uses {@link module:ol/webgl/Helper~WebGLHelper} internally.
 * @extends {WebGLLayerRenderer<import("../../layer/Vector.js").default>}
 */
class WebGLVectorLayerRenderer extends WebGLLayerRenderer {
  /**
   * @param {import("../../layer/Layer.js").default} layer Layer.
   * @param {Options} options Options.
   */
  constructor(layer, options) {
    const uniforms = {
      [Uniforms.RENDER_EXTENT]: [0, 0, 0, 0],
      [Uniforms.GLOBAL_ALPHA]: 1,
      [Uniforms.ONE]: 1,
    };

    super(/** @type {import("../../layer/Vector.js").default} */ (layer), {
      uniforms: uniforms,
      postProcesses: options.postProcesses ?? [],
    });

    /**
     * @type {boolean}
     * @private
     */
    this.hitDetectionEnabled_ = !options.disableHitDetection;

    /**
     * @type {WebGLRenderTarget}
     * @private
     */
    this.hitRenderTarget_;

    /**
     * @private
     */
    this.sourceRevision_ = -1;

    /**
     * @private
     */
    this.layerRevision_ = -1;

    /**
     * @private
     */
    this.skipNextTextRender_ = false;

    /**
     * @private
     */
    this.previousExtent_ = createEmpty();

    /**
     * This transform is updated on every frame and is the composition of:
     * - invert of the world->screen transform that was used when rebuilding buffers (see `this.renderTransform_`)
     * - current world->screen transform
     * @type {import("../../transform.js").Transform}
     * @private
     */
    this.currentTransform_ = createTransform();

    /**
     * @type {import("../../transform.js").Transform}
     * @private
     */
    this.currentFrameStateTransform_ = createTransform();

    /**
     * @type {import('../../style/flat.js').StyleVariables}
     * @private
     */
    this.styleVariables_ = {};

    /**
     * @type {LayerStyle}
     * @private
     */
    this.style_ = [];

    /**
     * @private
     */
    this.hasText_ = false;

    /**
     * @type {VectorStyleRenderer|null}
     * @public
     */
    this.styleRenderer_ = null;

    /**
     * @type {import('../../render/webgl/VectorStyleRenderer.js').WebGLBuffers|null}
     * @private
     */
    this.buffers_ = null;

    /**
     * @private
     */
    this.batch_ = new MixedGeometryBatch();

    /**
     * @private
     * @type {boolean}
     */
    this.initialFeaturesAdded_ = false;

    /**
     * @private
     * @type {Array<import("../../events.js").EventsKey|null>|null}
     */
    this.sourceListenKeys_ = null;

    /**
     * When reprojecting, geometries stay in source CRS and this field warps
     * them to the view projection at draw time.
     * @type {WarpField|null}
     * @private
     */
    this.warpField_ = null;

    /**
     * @type {boolean}
     * @private
     */
    this.reprojecting_ = false;

    /**
     * @type {string|undefined}
     * @private
     */
    this.previousViewProjectionUid_;

    /**
     * Transform applied when adding geometries to the batch (user→feature CRS).
     * @type {import("../../proj.js").TransformFunction|undefined}
     * @private
     */
    this.batchProjectionTransform_;

    /**
     * Incremented when starting a buffer rebuild so stale async results are ignored.
     * @type {number}
     * @private
     */
    this.bufferGeneration_ = 0;

    /**
     * True while a generateBuffers promise is outstanding (coalesce CRS spam).
     * @type {boolean}
     * @private
     */
    this.buffersBuilding_ = false;

    /**
     * Cached source footprint estimate for the warp field (avoids re-sampling
     * every frame when the view has not moved meaningfully).
     * @type {{viewExtent: import("../../extent.js").Extent, viewResolution: number, neededExtent: import("../../extent.js").Extent, sourceResolution: number}|null}
     * @private
     */
    this.warpEstimate_ = null;

    /**
     * Stable dateline unwrap center shared by GPU buffers and the warp field.
     * @type {number|undefined}
     * @private
     */
    this.unwrapCenterX_;

    /**
     * Warp field key used for the current GPU buffers. When the field rebuilds
     * for a new footprint, fills must be regenerated so vertices stay inside
     * the field (UV clamp of out-of-range verts creates screen-spanning slivers).
     * @type {string}
     * @private
     */
    this.buffersWarpKey_ = '';

    this.applyOptions_(options);
  }

  /**
   * Resolve and record a feature CRS when the source has none, so WebGL can
   * always keep geometries in a fixed CRS and reproject at draw time.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @private
   */
  ensureFeatureProjection_(frameState) {
    const source = this.getLayer().getSource();
    if (source.getProjection()) {
      return;
    }
    const format = source.getFormat();
    const dataProjection = format?.dataProjection
      ? getProjection(format.dataProjection)
      : null;
    if (dataProjection) {
      source.setProjection(dataProjection);
      return;
    }
    source.setProjection(frameState.viewState.projection);
  }

  /**
   * Transform from user coordinates into the feature (source) CRS.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {import("../../proj.js").TransformFunction|undefined} Transform.
   * @private
   */
  getBatchProjectionTransform_(frameState) {
    const source = this.getLayer().getSource();
    if (!source) {
      return undefined;
    }
    const viewProj = frameState.viewState.projection;
    const sourceProj = source.getProjection() || viewProj;
    this.reprojecting_ = needsReprojection(source, viewProj);
    const userProjection = getUserProjection();
    if (userProjection) {
      return getTransformFromProjections(userProjection, sourceProj);
    }
    return undefined;
  }

  /**
   * @private
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   */
  addInitialFeatures_(frameState) {
    const source = this.getLayer().getSource();
    if (!source) {
      return;
    }
    this.batchProjectionTransform_ =
      this.getBatchProjectionTransform_(frameState);
    this.batch_.addFeatures(
      source.getFeatures(),
      this.batchProjectionTransform_,
    );
    this.sourceListenKeys_ = [
      listen(
        source,
        VectorEventType.ADDFEATURE,
        this.handleSourceFeatureAdded_,
        this,
      ),
      listen(
        source,
        VectorEventType.CHANGEFEATURE,
        this.handleSourceFeatureChanged_,
        this,
      ),
      listen(
        source,
        VectorEventType.REMOVEFEATURE,
        /** @type {import("../../events.js").ListenerFunction} */ (
          this.handleSourceFeatureDelete_
        ),
        this,
      ),
      listen(
        source,
        VectorEventType.CLEAR,
        /** @type {import("../../events.js").ListenerFunction} */ (
          this.handleSourceFeatureClear_
        ),
        this,
      ),
    ];
  }

  /**
   * @param {Options} options Options.
   * @private
   */
  applyOptions_(options) {
    this.styleVariables_ = options.variables;
    this.style_ = options.style;

    const flatStyle = toFlatStyleLike(this.style_);
    this.hasText_ = !!flatStyle && hasTextStyle(flatStyle);
  }

  /**
   * @private
   */
  createRenderers_() {
    if (this.buffers_) {
      this.disposeBuffers(this.buffers_);
      this.buffers_ = null;
    }
    if (this.styleRenderer_) {
      this.styleRenderer_.dispose();
    }
    this.styleRenderer_ = new VectorStyleRenderer(
      this.style_,
      this.styleVariables_,
      this.helper,
      this.hitDetectionEnabled_,
    );
  }

  /**
   * @param {Options} options Options.
   * @override
   */
  reset(options) {
    this.applyOptions_(options);
    if (this.helper) {
      this.createRenderers_();
    }
    super.reset(options);
  }

  /**
   * @override
   */
  afterHelperCreated() {
    if (this.styleRenderer_) {
      // To reuse buffers
      this.styleRenderer_.setHelper(this.helper, this.buffers_);
    } else {
      this.createRenderers_();
    }

    if (this.hitDetectionEnabled_) {
      this.hitRenderTarget_ = new WebGLRenderTarget(this.helper);
    }
  }

  /**
   * @param {import("../../source/Vector.js").VectorSourceEvent} event Event.
   * @private
   */
  handleSourceFeatureAdded_(event) {
    const feature = event.feature;
    if (!feature) {
      return;
    }
    this.batch_.addFeature(feature, this.batchProjectionTransform_);
  }

  /**
   * @param {import("../../source/Vector.js").VectorSourceEvent} event Event.
   * @private
   */
  handleSourceFeatureChanged_(event) {
    const feature = event.feature;
    if (!feature) {
      return;
    }
    this.batch_.changeFeature(feature, this.batchProjectionTransform_);
  }

  /**
   * @param {import("../../source/Vector.js").VectorSourceEvent} event Event.
   * @private
   */
  handleSourceFeatureDelete_(event) {
    const feature = event.feature;
    if (!feature) {
      return;
    }
    this.batch_.removeFeature(feature);
  }

  /**
   * @private
   */
  handleSourceFeatureClear_() {
    this.batch_.clear();
  }

  /**
   * @param {import("../../transform.js").Transform} batchInvertTransform Inverse of the transformation in which geometries are expressed
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @private
   */
  applyUniforms_(batchInvertTransform, frameState) {
    applyVectorUniforms(
      this.helper,
      this.currentFrameStateTransform_,
      batchInvertTransform,
      frameState,
      this.reprojecting_ ? {patternsInSourceSpace: true} : undefined,
    );
    const viewExtent = frameState.extent;
    const viewCut =
      viewExtent && this.warpField_
        ? Math.min(getWidth(viewExtent), getHeight(viewExtent))
        : 0;
    applyWarpUniforms(
      this.helper,
      this.warpField_,
      undefined,
      frameState.viewState.projection,
      viewCut,
    );
  }

  /**
   * Build or refresh the warp field for the current view footprint.
   * Recreates when the footprint leaves the field, the field is too coarse for
   * the current zoom, or when forced (e.g. view projection change).
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {import("../../extent.js").Extent} viewExtent Buffered view extent.
   * @param {boolean} [force] Always rebuild.
   * @private
   */
  updateWarpField_(frameState, viewExtent, force) {
    if (!this.reprojecting_) {
      if (this.warpField_) {
        this.warpField_.delete(this.helper);
        this.warpField_ = null;
      }
      this.warpEstimate_ = null;
      this.unwrapCenterX_ = undefined;
      return;
    }
    const source = this.getLayer().getSource();
    const sourceProj = source.getProjection();
    const viewProj = frameState.viewState.projection;
    if (!sourceProj || !viewProj) {
      return;
    }
    const viewResolution = frameState.viewState.resolution;
    const estimateReusable =
      !force &&
      this.warpEstimate_ &&
      this.warpEstimate_.viewResolution === viewResolution &&
      equals(this.warpEstimate_.viewExtent, viewExtent);

    let neededExtent;
    let sourceResolution;
    if (estimateReusable) {
      neededExtent = this.warpEstimate_.neededExtent;
      sourceResolution = this.warpEstimate_.sourceResolution;
    } else {
      // Estimate without a sticky unwrap center — a stale center from another
      // hemisphere biases the footprint and places NZ verts far west of Aus.
      neededExtent = estimateSourceExtentForView(
        viewExtent,
        sourceProj,
        viewProj,
        undefined,
        8,
      );
      if (!neededExtent) {
        return;
      }
      const sourceWorld = sourceProj.getExtent();
      const worldWidth =
        sourceProj.canWrapX() && sourceWorld ? getWidth(sourceWorld) : 0;
      if (
        worldWidth > 0 &&
        getWidth(neededExtent) <= worldWidth * 0.5 &&
        targetAllowsUnwrappedSourceX(sourceProj, viewProj)
      ) {
        let unwrapCenter = (neededExtent[0] + neededExtent[2]) / 2;
        const centered = estimateSourceExtentForView(
          viewExtent,
          sourceProj,
          viewProj,
          undefined,
          8,
          unwrapCenter,
        );
        if (centered && getWidth(centered) <= worldWidth * 0.5) {
          neededExtent = centered;
          unwrapCenter = (centered[0] + centered[2]) / 2;
        }
        this.unwrapCenterX_ = unwrapCenter;
      } else {
        this.unwrapCenterX_ = undefined;
      }
      sourceResolution = calculateFinestSourceExtentResolution(
        sourceProj,
        viewProj,
        viewExtent,
        viewResolution,
      );
      this.warpEstimate_ = {
        viewExtent: viewExtent.slice(),
        viewResolution,
        neededExtent,
        sourceResolution,
      };
    }
    if (
      !force &&
      this.warpField_ &&
      this.warpField_.covers(neededExtent, sourceResolution)
    ) {
      return;
    }
    if (this.warpField_) {
      this.warpField_.delete(this.helper);
      this.warpField_ = null;
    }
    // Same unwrap center as GPU buffers for dateline-local views; global
    // footprints clamp to the world (see padSourceExtentForWarp). Targets that
    // fold at the antimeridian (Mollweide) never unwrap past ±180°.
    const sourceWorld = sourceProj.getExtent();
    const worldWidth =
      sourceProj.canWrapX() && sourceWorld ? getWidth(sourceWorld) : 0;
    const allowUnwrap = targetAllowsUnwrappedSourceX(sourceProj, viewProj);
    const sourceExtent = padSourceExtentForWarp(
      neededExtent,
      sourceProj,
      0.5,
      allowUnwrap ? this.unwrapCenterX_ : undefined,
      viewProj,
    );
    // If padding fell back to a world-clamped field, drop unwrap so buffer
    // verts stay inside the texture (unwrapped X past ±180 would UV-clamp).
    if (worldWidth > 0 && getWidth(sourceExtent) > worldWidth * 0.5) {
      this.unwrapCenterX_ = undefined;
    }
    this.warpField_ = new WarpField({
      sourceProj,
      targetProj: viewProj,
      sourceExtent,
      sourceResolution,
    });
  }

  /**
   * Render the layer.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {HTMLElement} The rendered element.
   * @override
   */
  renderFrame(frameState) {
    const gl = this.helper.getGL();
    this.preRender(gl, frameState);

    const layer = this.getLayer();

    const [startWorld, endWorld, worldWidth] = getWorldParameters(
      frameState,
      layer,
    );

    // draw the normal canvas
    this.helper.prepareDraw(frameState);
    this.renderWorlds(frameState, false, startWorld, endWorld, worldWidth);

    this.helper.finalizeDraw(
      frameState,
      this.dispatchPreComposeEvent,
      this.dispatchPostComposeEvent,
    );

    const canvas = this.helper.getCanvas();

    if (this.hitDetectionEnabled_ && this.hitRenderTarget_) {
      this.renderWorlds(frameState, true, startWorld, endWorld, worldWidth);
      this.hitRenderTarget_.clearCachedData();
    }

    this.postRender(gl, frameState);

    return canvas;
  }

  /**
   * Determine whether renderFrame should be called.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {boolean} Layer is ready to be rendered.
   * @override
   */
  prepareFrameInternal(frameState) {
    this.ensureFeatureProjection_(frameState);

    if (!this.initialFeaturesAdded_) {
      this.addInitialFeatures_(frameState);
      this.initialFeaturesAdded_ = true;
    }

    const layer = this.getLayer();
    const vectorSource = layer.getSource();
    if (!vectorSource) {
      return true;
    }
    const viewState = frameState.viewState;
    const viewNotMoving =
      !frameState.viewHints[ViewHint.ANIMATING] &&
      !frameState.viewHints[ViewHint.INTERACTING];
    const frameExtent = frameState.extent;
    if (!frameExtent) {
      return true;
    }
    const extentChanged = !equals(this.previousExtent_, frameExtent);
    const sourceChanged = this.sourceRevision_ < vectorSource.getRevision();
    const layerChanged = this.layerRevision_ < layer.getRevision();
    const viewProjectionUid = getUid(viewState.projection);
    const viewProjectionChanged =
      this.previousViewProjectionUid_ !== viewProjectionUid;

    this.sourceRevision_ = vectorSource.getRevision();
    this.layerRevision_ = layer.getRevision();

    // if layer/extent/source changed the next text overlay render should not be skipped
    if (
      layerChanged ||
      extentChanged ||
      sourceChanged ||
      viewProjectionChanged
    ) {
      this.skipNextTextRender_ = false;
    }

    const projection = viewState.projection;
    const resolution = viewState.resolution;
    const renderBuffer =
      (layer instanceof BaseVector ? layer.getRenderBuffer() : 0) ?? 0;
    const extent = buffer(frameExtent, renderBuffer * resolution);
    this.reprojecting_ = needsReprojection(vectorSource, projection);
    const sourceProj = vectorSource.getProjection();

    if (viewProjectionChanged) {
      // Drop GPU geometry immediately so CRS spam cannot stack textures.
      // Invalidate in-flight builds without starting a second generation bump
      // below (rebuild path increments bufferGeneration_ once).
      if (this.buffers_) {
        this.disposeBuffers(this.buffers_);
        this.buffers_ = null;
      }
      this.buffersWarpKey_ = '';
      this.unwrapCenterX_ = undefined;
      this.warpEstimate_ = null;
      if (this.buffersBuilding_) {
        ++this.bufferGeneration_;
        this.buffersBuilding_ = false;
      }
    }

    // Keep the warp field covering the view while animating; only rebuild when
    // the footprint leaves the cached field (avoids sample reshuffle on zoom).
    if (this.reprojecting_) {
      this.updateWarpField_(frameState, extent, viewProjectionChanged);
    } else if (this.warpField_) {
      this.updateWarpField_(frameState, extent, true);
    }

    if (
      viewNotMoving &&
      (extentChanged || sourceChanged || viewProjectionChanged)
    ) {
      const userProjection = getUserProjection();
      // Always load in the feature CRS (set by ensureFeatureProjection_).
      if (this.reprojecting_ && sourceProj) {
        const sourceExtent = estimateSourceExtentForView(
          extent,
          sourceProj,
          projection,
        );
        const sourceResolution = calculateFinestSourceExtentResolution(
          sourceProj,
          projection,
          extent,
          resolution,
        );
        if (sourceExtent) {
          if (userProjection) {
            vectorSource.loadFeatures(
              toUserExtent(sourceExtent, userProjection),
              toUserResolution(sourceResolution, sourceProj),
              userProjection,
            );
          } else {
            vectorSource.loadFeatures(
              sourceExtent,
              sourceResolution,
              sourceProj,
            );
          }
        }
      } else if (userProjection) {
        vectorSource.loadFeatures(
          toUserExtent(extent, userProjection),
          toUserResolution(resolution, sourceProj || projection),
          userProjection,
        );
      } else {
        vectorSource.loadFeatures(extent, resolution, sourceProj || projection);
      }

      // Same-CRS: buffers are view-independent (draw uses current×invert).
      // Reproj: rebuild when the warp field moves so verts stay in-field.
      const warpKey =
        this.reprojecting_ && this.warpField_ ? this.warpField_.key : '';
      const warpFieldChanged =
        this.reprojecting_ && warpKey !== this.buffersWarpKey_;
      const rebuildBuffers =
        !this.buffers_ ||
        sourceChanged ||
        viewProjectionChanged ||
        warpFieldChanged;

      // Coalesce zoom/warp churn while a build runs, but always restart on
      // source/projection changes (or when buffers are missing).
      if (
        rebuildBuffers &&
        this.buffersBuilding_ &&
        (sourceChanged || viewProjectionChanged || !this.buffers_)
      ) {
        ++this.bufferGeneration_;
        this.buffersBuilding_ = false;
      }
      if (rebuildBuffers && !this.buffersBuilding_) {
        const styleRenderer = this.styleRenderer_;
        if (!styleRenderer) {
          return true;
        }
        this.ready = false;
        this.buffersBuilding_ = true;
        const bufferGeneration = ++this.bufferGeneration_;
        this.buffersWarpKey_ = warpKey;

        const transform = this.reprojecting_
          ? createTransform()
          : this.helper.makeProjectionTransform(
              frameState,
              createTransform(),
              true,
            );

        // Stable densify step (bucketed) so zoom does not change topology.
        /** @type {import("../../render/webgl/VectorStyleRenderer.js").GenerateBuffersOptions} */
        let bufferOptions = {
          viewRotation: frameState.viewState.rotation || 0,
        };
        if (this.reprojecting_ && sourceProj) {
          const sourceResolution = calculateFinestSourceExtentResolution(
            sourceProj,
            projection,
            extent,
            resolution,
          );
          const bucket = Math.pow(2, Math.round(Math.log2(sourceResolution)));
          const sourceWorld = sourceProj.getExtent();
          const worldWidth =
            sourceProj.canWrapX() && sourceWorld ? getWidth(sourceWorld) : 0;
          // Prefer an unwrap-centered source footprint so dateline/polar views
          // (EPSG:5479) stay continuous; global views still world-clamp the warp.
          // Always re-derive from the current view (no sticky hemisphere bias).
          let viewSourceExtent = estimateSourceExtentForView(
            extent,
            sourceProj,
            projection,
            undefined,
            8,
          );
          let unwrapCenterX;
          const allowUnwrap = targetAllowsUnwrappedSourceX(
            sourceProj,
            projection,
          );
          if (
            allowUnwrap &&
            sourceProj.canWrapX() &&
            worldWidth > 0 &&
            viewSourceExtent
          ) {
            if (getWidth(viewSourceExtent) <= worldWidth * 0.5) {
              unwrapCenterX = (viewSourceExtent[0] + viewSourceExtent[2]) / 2;
              const centered = estimateSourceExtentForView(
                extent,
                sourceProj,
                projection,
                undefined,
                8,
                unwrapCenterX,
              );
              if (centered && getWidth(centered) <= worldWidth * 0.5) {
                viewSourceExtent = centered;
                unwrapCenterX = (centered[0] + centered[2]) / 2;
              }
              this.unwrapCenterX_ = unwrapCenterX;
            } else {
              // Truly global footprint — no buffer unwrap; warp clamps to world.
              unwrapCenterX = undefined;
              this.unwrapCenterX_ = undefined;
            }
          } else {
            unwrapCenterX = undefined;
            if (!allowUnwrap) {
              this.unwrapCenterX_ = undefined;
            }
          }
          // Clip fill triangles to the warp footprint (partial keep via
          // Sutherland–Hodgman) so UV clamp cannot streak and fill still meets
          // the stroke at the view edge.
          const warpField = this.warpField_;
          const clipExtent = warpField
            ? warpField.getSourceExtent()
            : viewSourceExtent
              ? padSourceExtentForWarp(
                  viewSourceExtent,
                  sourceProj,
                  0.5,
                  unwrapCenterX,
                  projection,
                )
              : undefined;
          // Warp wider than ½ world is world-clamped — do not unwrap buffers.
          if (
            unwrapCenterX !== undefined &&
            clipExtent &&
            worldWidth > 0 &&
            getWidth(clipExtent) > worldWidth * 0.5
          ) {
            unwrapCenterX = undefined;
            this.unwrapCenterX_ = undefined;
          }
          // Cut threshold: smaller view side. Drops true projection folds only
          // (target-space earcut handles concave / hole diagonals).
          const viewCut = Math.min(getWidth(extent), getHeight(extent));
          /** @type {function(import("../../coordinate.js").Coordinate): (import("../../coordinate.js").Coordinate|null)|undefined} */
          let forward = undefined;
          if (warpField) {
            forward = (coord) => warpField.projectExact(coord);
          } else {
            const transformFn = getTransform(sourceProj, projection);
            if (transformFn) {
              forward = (coord) => transformFn(coord) || null;
            }
          }
          bufferOptions = {
            ...bufferOptions,
            maxSegmentLength: bucket * 32,
            maxTriangleEdgeLength: worldWidth > 0 ? worldWidth * 0.5 : 0,
            unwrapCenterX,
            // Always pass world width when wrap is possible so densify can
            // refuse antimeridian chords even if buffer unwrap is cleared.
            worldWidth,
            clipExtent,
            maxTargetTriangleEdgeLength: viewCut > 0 && warpField ? viewCut : 0,
            // Exact forward proj for fill clipping and line-label angles.
            projectToTarget: forward,
          };
        }

        styleRenderer
          .generateBuffers(
            this.batch_,
            transform,
            frameState.viewState.resolution,
            bufferOptions,
          )
          .then((buffers) => {
            this.buffersBuilding_ = false;
            if (bufferGeneration !== this.bufferGeneration_) {
              this.disposeBuffers(buffers);
              return;
            }
            if (this.buffers_) {
              this.disposeBuffers(this.buffers_);
            }
            this.buffers_ = buffers;
            this.ready = true;
            this.getLayer()?.changed();
          })
          .catch(() => {
            this.buffersBuilding_ = false;
          });
      }

      this.previousExtent_ = frameExtent.slice();
      this.previousViewProjectionUid_ = viewProjectionUid;
    }

    return true;
  }

  /**
   * Render the world, either to the main framebuffer or to the hit framebuffer
   * @param {import("../../Map.js").FrameState} frameState current frame state
   * @param {boolean} forHitDetection whether the rendering is for hit detection
   * @param {number} startWorld the world to render in the first iteration
   * @param {number} endWorld the last world to render
   * @param {number} worldWidth the width of the worlds being rendered
   */
  renderWorlds(frameState, forHitDetection, startWorld, endWorld, worldWidth) {
    let world = startWorld;

    if (forHitDetection) {
      const hitRenderTarget = this.hitRenderTarget_;
      if (!hitRenderTarget) {
        return;
      }
      hitRenderTarget.setSize([
        Math.floor(frameState.size[0] / 2),
        Math.floor(frameState.size[1] / 2),
      ]);
      this.helper.prepareDrawToRenderTarget(frameState, hitRenderTarget, true);
    }

    do {
      this.helper.makeProjectionTransform(
        frameState,
        this.currentFrameStateTransform_,
      );
      translateTransform(
        this.currentFrameStateTransform_,
        world * worldWidth,
        0,
      );
      const buffers = this.buffers_;
      if (!buffers) {
        continue;
      }
      const styleRenderer = this.styleRenderer_;
      if (!styleRenderer) {
        continue;
      }
      styleRenderer.render(buffers, frameState, () => {
        this.applyUniforms_(buffers.invertVerticesTransform, frameState);
        this.helper.applyHitDetectionUniform(forHitDetection);
      });
    } while (++world < endWorld);
  }

  /**
   * @param {import("../../coordinate.js").Coordinate} coordinate Coordinate.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {number} hitTolerance Hit tolerance in pixels.
   * @param {import("../vector.js").FeatureCallback<T>} callback Feature callback.
   * @param {Array<import("../Map.js").HitMatch<T>>} matches The hit detected matches with tolerance.
   * @return {T|undefined} Callback result.
   * @template T
   * @override
   */
  forEachFeatureAtCoordinate(
    coordinate,
    frameState,
    hitTolerance,
    callback,
    matches,
  ) {
    assert(
      this.hitDetectionEnabled_,
      '`forEachFeatureAtCoordinate` cannot be used on a WebGL layer if the hit detection logic has been disabled using the `disableHitDetection: true` option.',
    );
    if (!this.styleRenderer_ || !this.hitDetectionEnabled_) {
      return undefined;
    }

    const pixel = applyTransform(
      frameState.coordinateToPixelTransform,
      coordinate.slice(),
    );

    const data = this.hitRenderTarget_?.readPixel(pixel[0] / 2, pixel[1] / 2);
    if (!data) {
      return undefined;
    }
    const color = [data[0] / 255, data[1] / 255, data[2] / 255, data[3] / 255];
    const ref = colorDecodeId(color);
    const feature = this.batch_.getFeatureFromRef(ref);
    if (feature) {
      return callback(
        feature,
        this.getLayer(),
        /** @type {import("../../geom/SimpleGeometry.js").default} */ (
          /** @type {unknown} */ (null)
        ),
      );
    }
    return undefined;
  }

  /**
   * Will release a set of Webgl buffers
   * @param {import('../../render/webgl/VectorStyleRenderer.js').WebGLBuffers} buffers Buffers
   */
  disposeBuffers(buffers) {
    if (!this.helper) {
      return;
    }

    /**
     * @param {Array<import('../../webgl/Buffer.js').default>} typeBuffers Buffers
     */
    const disposeBuffersOfType = (typeBuffers) => {
      for (const buffer of typeBuffers) {
        if (buffer) {
          this.helper.deleteBuffer(buffer);
        }
      }
    };
    if (buffers.pointBuffers) {
      disposeBuffersOfType(buffers.pointBuffers);
    }
    if (buffers.lineStringBuffers) {
      disposeBuffersOfType(buffers.lineStringBuffers);
    }
    if (buffers.polygonBuffers) {
      disposeBuffersOfType(buffers.polygonBuffers);
    }
    if (buffers.glyphBuffers) {
      disposeBuffersOfType(buffers.glyphBuffers);
    }
  }

  /**
   * Clean up.
   * @override
   */
  disposeInternal() {
    if (this.buffers_) {
      this.disposeBuffers(this.buffers_);
    }
    if (this.sourceListenKeys_) {
      this.sourceListenKeys_.forEach(function (key) {
        if (key) {
          unlistenByKey(key);
        }
      });
      this.sourceListenKeys_ = null;
    }
    if (this.warpField_) {
      this.warpField_.delete(this.helper);
      this.warpField_ = null;
    }
    if (this.styleRenderer_) {
      this.styleRenderer_.dispose();
    }
    super.disposeInternal();
  }

  renderDeclutter() {}
}

export default WebGLVectorLayerRenderer;
