/**
 * @module ol/renderer/webgpu/VectorLayer
 */
import {listen, unlistenByKey} from '../../events.js';
import EventType from '../../events/EventType.js';
import {
  buffer,
  createEmpty,
  equals,
  getHeight,
  getWidth,
} from '../../extent.js';
import {
  get as getProjection,
  getTransform,
  getUserProjection,
  toUserExtent,
  toUserResolution,
} from '../../proj.js';
import {
  buildVectorBuffers,
  decodeHitColor,
} from '../../render/webgpu/buffers.js';
import {
  collectStickyIds,
  resolveDeclutter,
  stickyIdsForView,
} from '../../render/webgpu/declutter.js';
import {
  LABEL_FADE_MATCH_PIXELS,
  LabelFade,
} from '../../render/webgpu/labelFade.js';
import {compileStyle} from '../../render/webgpu/style.js';
import {apply as applyTransform} from '../../transform.js';
import FontAtlas from '../../webgpu/FontAtlas.js';
import {
  estimateSourceExtent,
  needsReprojection,
  sourceResolutionForView,
  viewCoordinateToSource,
} from '../../webgpu/reproj.js';
import WebGPULayerRenderer from './Layer.js';
import {
  FRAME_UNIFORM_SIZE,
  GpuScratch,
  createVectorPipelines,
  drawFills,
  drawStrokes,
  drawSymbolsAndText,
  labelsToScreen,
  writeFrameUniforms,
} from './vectorUtil.js';

/**
 * @typedef {Object} Options
 * @property {import("../../style/flat.js").FlatStyleLike|import("../../style/Style.js").StyleLike} style Style.
 * @property {import("../../style/flat.js").StyleVariables} [variables] Variables.
 * @property {boolean} [disableHitDetection=false] Disable hit detection.
 * @property {boolean|string|number} [declutter=false] Declutter group.
 */

/**
 * @param {import("../../style/flat.js").StyleVariables} variables Variables.
 * @return {string} Cache key.
 */
function variablesKey(variables) {
  let key = '';
  for (const name in variables) {
    key += name + ':' + String(variables[name]) + ';';
  }
  return key;
}

/**
 * Pixel buffer around the view used when loading and querying features.
 * Matches {@link module:ol/layer/BaseVector} default `renderBuffer`.
 */
const RENDER_BUFFER = 100;

/**
 * Keep geometries in a fixed feature CRS so a view CRS change does not mutate
 * coordinates. Matches the webgl-reproj VectorLayer approach.
 *
 * @param {import("../../source/Vector.js").default} source Source.
 * @param {import("../../Map.js").FrameState} frameState Frame.
 */
function ensureFeatureProjection(source, frameState) {
  if (source.getProjection()) {
    return;
  }
  const format = /** @type {any} */ (source).getFormat?.();
  const dataProjection = format?.dataProjection
    ? getProjection(format.dataProjection)
    : null;
  if (dataProjection) {
    source.setProjection(dataProjection);
  }
}

/**
 * Ask the vector source to load features for the current view (URL / bbox
 * strategies). When the view CRS differs from the source, the query is in the
 * source CRS.
 *
 * @param {import("../../source/Vector.js").default} source Source.
 * @param {import("../../Map.js").FrameState} frameState Frame state.
 * @return {import("../../extent.js").Extent|null} Query extent in the source's projection.
 */
function loadSourceFeatures(source, frameState) {
  const extent = frameState.extent;
  if (!extent || typeof source.loadFeatures !== 'function') {
    return null;
  }
  const viewState = frameState.viewState;
  const buffered = buffer(extent, RENDER_BUFFER * viewState.resolution);
  const sourceProj = source.getProjection();
  const viewProj = viewState.projection;
  let queryExtent = buffered;
  let queryResolution = viewState.resolution;
  let queryProj = viewProj;
  if (needsReprojection(source, viewProj) && sourceProj) {
    const sourceExtent = estimateSourceExtent(buffered, sourceProj, viewProj);
    if (sourceExtent) {
      queryExtent = sourceExtent;
      queryResolution = sourceResolutionForView(
        sourceProj,
        viewProj,
        viewState.center,
        viewState.resolution,
      );
      queryProj = sourceProj;
    }
  }
  const userProjection = getUserProjection();
  if (userProjection) {
    const userExtent = toUserExtent(queryExtent, queryProj);
    source.loadFeatures(
      userExtent,
      toUserResolution(queryResolution, queryProj),
      userProjection,
    );
    return userExtent;
  }
  source.loadFeatures(queryExtent, queryResolution, queryProj);
  return queryExtent;
}

/**
 * @param {import("../../source/Vector.js").default} source Source.
 * @param {import("../../Map.js").FrameState} frameState Frame.
 * @return {import("../../render/webgpu/tessellate.js").TessellateOptions|undefined} Options.
 */
function getReprojOptions(source, frameState) {
  const viewState = frameState.viewState;
  const viewProj = viewState.projection;
  if (!needsReprojection(source, viewProj)) {
    return undefined;
  }
  const sourceProj = source.getProjection();
  if (!sourceProj) {
    return undefined;
  }
  const transformFn = getTransform(sourceProj, viewProj);
  if (!transformFn) {
    return undefined;
  }
  const extent = frameState.extent;
  if (!extent) {
    return undefined;
  }
  const viewExtent = buffer(extent, RENDER_BUFFER * viewState.resolution);
  const sourceResolution = sourceResolutionForView(
    sourceProj,
    viewProj,
    viewState.center,
    viewState.resolution,
  );
  const bucket = Math.pow(2, Math.round(Math.log2(sourceResolution) || 0));
  const sourceWorld = sourceProj.getExtent();
  const worldWidth =
    sourceProj.canWrapX() && sourceWorld ? getWidth(sourceWorld) : 0;
  const viewCut = Math.min(getWidth(viewExtent), getHeight(viewExtent));
  return {
    projectToTarget: (coord) => {
      const projected = transformFn(coord);
      if (!projected || !isFinite(projected[0]) || !isFinite(projected[1])) {
        return null;
      }
      return [projected[0], projected[1]];
    },
    clipExtent: viewExtent,
    maxSegmentLength: bucket * 32,
    maxSpanX: worldWidth > 0 ? worldWidth * 0.5 : 0,
    maxTargetEdge: viewCut > 0 ? viewCut : 0,
  };
}

/**
 * @classdesc
 * WebGPU vector renderer with decluttering for text and symbols.
 * @extends {WebGPULayerRenderer<import("../../layer/Layer.js").default>}
 */
class WebGPUVectorLayerRenderer extends WebGPULayerRenderer {
  /**
   * @param {import("../../layer/Layer.js").default} layer Layer.
   * @param {Options} options Options.
   */
  constructor(layer, options) {
    super(layer);

    /**
     * @private
     */
    this.styleFunction_ = compileStyle(options.style, options.variables);

    /**
     * @private
     * @type {import("../../style/flat.js").StyleVariables}
     */
    this.variables_ = options.variables || {};

    /**
     * @private
     * @type {string}
     */
    this.renderedVariablesKey_ = '';

    /**
     * @private
     */
    this.hitDetectionEnabled_ = !options.disableHitDetection;

    /**
     * @private
     * @type {string|undefined}
     */
    this.declutterGroup_ =
      options.declutter === true
        ? 'true'
        : options.declutter
          ? String(options.declutter)
          : undefined;

    /**
     * @private
     * @type {FontAtlas}
     */
    this.atlas_ = new FontAtlas();

    /**
     * @private
     * @type {import("../../render/webgpu/buffers.js").VectorBuffers|null}
     */
    this.buffers_ = null;

    /**
     * @private
     * @type {number}
     */
    this.sourceRevision_ = -1;

    /**
     * @private
     * @type {import("../../extent.js").Extent}
     */
    this.renderedExtent_ = createEmpty();

    /**
     * @private
     * @type {import("../../proj/Projection.js").default|null}
     */
    this.renderedProjection_ = null;

    /**
     * @private
     * @type {number}
     */
    this.renderedPixelRatio_ = 0;

    /**
     * @private
     * @type {GPUBuffer|null}
     */
    this.frameUniformBuffer_ = null;

    /**
     * @private
     * @type {Float32Array}
     */
    this.frameUniformData_ = new Float32Array(FRAME_UNIFORM_SIZE / 4);

    /**
     * @private
     * @type {Float32Array}
     */
    this.projMat_ = new Float32Array(16);

    /**
     * @private
     * @type {GPUBuffer|null}
     */
    this.cornerBuffer_ = null;

    /**
     * @private
     * @type {import("../../events.js").EventsKey|undefined}
     */
    this.sourceListenKey_;

    /**
     * @private
     * @type {Array<boolean>|null}
     */
    this.visibility_ = null;

    /**
     * @private
     * @type {number|undefined}
     */
    this.declutterResolution_;

    /**
     * @private
     * @type {Set<number>}
     */
    this.declutterStickyIds_ = new Set();

    /**
     * @private
     * @type {LabelFade}
     */
    this.labelFade_ = new LabelFade();

    /**
     * @private
     * @type {GpuScratch}
     */
    this.scratch_ = new GpuScratch();
  }

  /**
   * @return {string|undefined} Declutter group.
   */
  getDeclutterGroup() {
    return this.declutterGroup_;
  }

  /**
   * @override
   */
  afterHelperCreated() {
    const helper = this.helper;
    if (!helper) {
      return;
    }
    const device = helper.getDevice();
    this.frameUniformBuffer_ = device.createBuffer({
      size: FRAME_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.cornerBuffer_ = helper.createBuffer(
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    );
    createVectorPipelines(helper);
    const source = this.getLayer().getSource();
    if (source && !this.sourceListenKey_) {
      this.sourceListenKey_ = listen(
        source,
        EventType.CHANGE,
        () => {
          this.buffers_ = null;
          this.getLayer().changed();
        },
        this,
      );
    }
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {boolean} Ready.
   * @override
   */
  prepareFrameInternal(frameState) {
    const source =
      /** @type {import("../../source/Vector.js").default|null} */ (
        this.getLayer().getSource()
      );
    if (!source) {
      return false;
    }
    ensureFeatureProjection(source, frameState);
    loadSourceFeatures(source, frameState);
    return true;
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame.
   * @private
   */
  rebuildBuffers_(frameState) {
    const layer = this.getLayer();
    const source = /** @type {import("../../source/Vector.js").default} */ (
      layer.getSource()
    );
    if (!source) {
      return;
    }
    const extent = frameState.extent;
    if (!extent) {
      return;
    }
    ensureFeatureProjection(source, frameState);
    const queryExtent = loadSourceFeatures(source, frameState);
    const features = source.getFeaturesInExtent
      ? source.getFeaturesInExtent(
          queryExtent || extent,
          source.getProjection() || frameState.viewState.projection,
        )
      : source.getFeatures();
    this.buffers_ = buildVectorBuffers(
      features,
      this.styleFunction_,
      frameState.viewState.resolution,
      this.atlas_,
      getReprojOptions(source, frameState),
      frameState.pixelRatio,
    );
    this.sourceRevision_ = source.getRevision();
    this.renderedExtent_ = extent.slice();
    this.renderedProjection_ = frameState.viewState.projection;
    this.renderedPixelRatio_ = frameState.pixelRatio;
    this.renderedVariablesKey_ = variablesKey(this.variables_);
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame.
   * @param {HTMLElement|null} target Target.
   * @return {HTMLElement} Canvas.
   * @override
   */
  renderFrame(frameState, target) {
    const helper = this.helper;
    if (!helper) {
      return /** @type {HTMLElement} */ (target);
    }
    this.preRender(frameState);
    const source = this.getLayer().getSource();
    if (
      !this.buffers_ ||
      (source && source.getRevision() !== this.sourceRevision_) ||
      !equals(this.renderedExtent_, frameState.extent || createEmpty()) ||
      this.renderedProjection_ !== frameState.viewState.projection ||
      this.renderedPixelRatio_ !== frameState.pixelRatio ||
      this.renderedVariablesKey_ !== variablesKey(this.variables_)
    ) {
      this.rebuildBuffers_(frameState);
    }
    this.scratch_.destroy();
    const buffers = this.buffers_;
    helper.prepareDraw(frameState, false);
    if (this.frameUniformBuffer_) {
      writeFrameUniforms(
        helper,
        this.frameUniformBuffer_,
        this.frameUniformData_,
        this.projMat_,
        frameState,
        0,
      );
    }
    if (buffers && this.frameUniformBuffer_) {
      drawFills(helper, this.frameUniformBuffer_, buffers, this.scratch_);
      drawStrokes(helper, this.frameUniformBuffer_, buffers, this.scratch_);
    }
    if (
      !this.declutterGroup_ &&
      buffers &&
      this.frameUniformBuffer_ &&
      this.cornerBuffer_
    ) {
      this.visibility_ = new Array(buffers.labels.length).fill(true);
      if (
        drawSymbolsAndText(
          helper,
          this.frameUniformBuffer_,
          buffers,
          this.visibility_,
          this.atlas_,
          this.cornerBuffer_,
          this.scratch_,
          this.labelFade_,
          frameState.time,
          frameState.viewState.resolution * LABEL_FADE_MATCH_PIXELS,
        )
      ) {
        frameState.animate = true;
      }
    }
    helper.finalizeDraw(frameState);
    this.postRender(frameState);
    return helper.getCanvas();
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame.
   * @param {import("../../layer/Layer.js").State} layerState Layer state.
   */
  renderDeclutter(frameState, layerState) {
    const helper = this.helper;
    const buffers = this.buffers_;
    if (
      !helper ||
      !buffers ||
      !this.declutterGroup_ ||
      !this.frameUniformBuffer_ ||
      !this.cornerBuffer_
    ) {
      return;
    }
    const pixelRatio = frameState.pixelRatio;
    const width = frameState.size[0] * pixelRatio;
    const height = frameState.size[1] * pixelRatio;
    const screenLabels = labelsToScreen(buffers, frameState);
    const resolution = frameState.viewState.resolution;
    const stickyIds = stickyIdsForView(
      this.declutterResolution_,
      resolution,
      this.declutterStickyIds_,
    );
    this.visibility_ = resolveDeclutter(
      screenLabels,
      8,
      width,
      height,
      this.declutterGroup_,
      frameState.index,
      stickyIds,
    );
    this.declutterResolution_ = resolution;
    this.declutterStickyIds_ = collectStickyIds(screenLabels, this.visibility_);

    helper.prepareDraw(frameState, false);
    writeFrameUniforms(
      helper,
      this.frameUniformBuffer_,
      this.frameUniformData_,
      this.projMat_,
      frameState,
      0,
    );
    if (
      drawSymbolsAndText(
        helper,
        this.frameUniformBuffer_,
        buffers,
        this.visibility_,
        this.atlas_,
        this.cornerBuffer_,
        this.scratch_,
        this.labelFade_,
        frameState.time,
        frameState.viewState.resolution * LABEL_FADE_MATCH_PIXELS,
      )
    ) {
      frameState.animate = true;
    }
    helper.finalizeDraw(frameState);
  }

  /**
   * @param {import("../../coordinate.js").Coordinate} coordinate Coordinate.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {number} hitTolerance Hit tolerance.
   * @param {import("../vector.js").FeatureCallback<T>} callback Callback.
   * @param {Array<import("../Map.js").HitMatch<T>>} matches Matches.
   * @return {T|undefined} Result.
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
    const buffers = this.buffers_;
    if (!this.hitDetectionEnabled_ || !buffers) {
      return undefined;
    }
    const pixel = applyTransform(
      frameState.coordinateToPixelTransform,
      coordinate.slice(),
    );
    for (let i = 0; i < buffers.labels.length; ++i) {
      if (this.visibility_ && !this.visibility_[i]) {
        continue;
      }
      const label = buffers.labels[i];
      const extra = /** @type {any} */ (label);
      const anchor =
        /** @type {import("../../coordinate.js").Coordinate|undefined} */ (
          extra._anchor
        );
      if (!anchor) {
        continue;
      }
      const p = applyTransform(
        frameState.coordinateToPixelTransform,
        anchor.slice(),
      );
      if (
        pixel[0] >= p[0] + label.minX - hitTolerance &&
        pixel[0] <= p[0] + label.maxX + hitTolerance &&
        pixel[1] >= p[1] + label.minY - hitTolerance &&
        pixel[1] <= p[1] + label.maxY + hitTolerance
      ) {
        let feature;
        if (label.glyphCount) {
          const glyph = buffers.glyphs[label.glyphStart || 0];
          feature =
            buffers.featuresByRef[
              decodeHitColor([glyph.hitR, glyph.hitG, glyph.hitB, 1])
            ];
        } else if (extra.symbolIndex !== undefined) {
          const o = extra.symbolIndex * 14;
          feature =
            buffers.featuresByRef[
              decodeHitColor([
                buffers.symbolInstances[o + 10],
                buffers.symbolInstances[o + 11],
                buffers.symbolInstances[o + 12],
                1,
              ])
            ];
        }
        if (feature) {
          const result = callback(
            feature,
            this.getLayer(),
            /** @type {import("../../geom/SimpleGeometry.js").default} */ (
              feature.getGeometry()
            ),
          );
          if (result) {
            return result;
          }
        }
      }
    }
    const source =
      /** @type {import("../../source/Vector.js").default|null} */ (
        this.getLayer().getSource()
      );
    const featureCoord = viewCoordinateToSource(
      coordinate,
      source?.getProjection() || null,
      frameState.viewState.projection,
    );
    if (!featureCoord) {
      return undefined;
    }
    const features = Object.values(buffers.featuresByRef);
    for (const feature of features) {
      const geometry = feature.getGeometry();
      if (geometry && geometry.containsXY(featureCoord[0], featureCoord[1])) {
        const result = callback(
          feature,
          this.getLayer(),
          /** @type {import("../../geom/SimpleGeometry.js").default} */ (
            geometry
          ),
        );
        if (result) {
          return result;
        }
      }
    }
    return undefined;
  }

  /**
   * @override
   */
  disposeInternal() {
    if (this.sourceListenKey_) {
      unlistenByKey(this.sourceListenKey_);
    }
    this.scratch_.destroy();
    super.disposeInternal();
  }
}

export default WebGPUVectorLayerRenderer;
