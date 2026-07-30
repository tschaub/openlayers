/**
 * @module ol/renderer/webgl/VectorTileLayer
 */
import EventType from '../../events/EventType.js';
import {getWidth} from '../../extent.js';
import {getTransform} from '../../proj.js';
import {ShaderBuilder} from '../../render/webgl/ShaderBuilder.js';
import {hasTextStyle} from '../../render/webgl/textUtil.js';
import VectorStyleRenderer, {
  convertStyleToShaders,
  toFlatStyleLike,
} from '../../render/webgl/VectorStyleRenderer.js';
import {
  create as createTransform,
  makeInverse as makeInverseTransform,
  multiply as multiplyTransform,
  setFromArray as setFromTransform,
} from '../../transform.js';
import {getUid} from '../../util.js';
import {fromTransform as mat4FromTransform} from '../../vec/mat4.js';
import {ELEMENT_ARRAY_BUFFER, STATIC_DRAW} from '../../webgl.js';
import WebGLArrayBuffer from '../../webgl/Buffer.js';
import {AttributeType} from '../../webgl/Helper.js';
import WebGLRenderTarget from '../../webgl/RenderTarget.js';
import WarpField from '../../webgl/reproj/WarpField.js';
import TileGeometry from '../../webgl/TileGeometry.js';
import WebGLBaseTileLayerRenderer, {
  Uniforms as BaseUniforms,
  getCacheKey,
} from './TileLayerBase.js';
import {
  applyVectorUniforms,
  applyWarpUniforms,
  VectorUniforms,
} from './vectorUtil.js';

export const Uniforms = {
  ...BaseUniforms,
  ...VectorUniforms,
  TILE_MASK_TEXTURE: 'u_depthMask',
  TILE_ZOOM_LEVEL: 'u_tileZoomLevel',
};

export const Attributes = {
  POSITION: 'a_position',
};

/**
 * @typedef {import('../../render/webgl/VectorStyleRenderer.js').StyleShaders} StyleShaders
 */
/**
 * @typedef {import('../../style/flat.js').FlatStyleLike | Array<StyleShaders> | StyleShaders} LayerStyle
 */

/**
 * @typedef {Object} Options
 * @property {LayerStyle} style Flat vector style; also accepts shaders
 * @property {import('../../style/flat.js').StyleVariables} [variables] Style variables. Each variable must hold a literal value (not
 * an expression). These variables can be used as {@link import("../../expr/expression.js").ExpressionValue expressions} in the styles properties
 * using the `['var', 'varName']` operator.
 * @property {boolean} [disableHitDetection=false] Setting this to true will provide a slight performance boost, but will
 * prevent all hit detection on the layer.
 * @property {Array<import("./Layer.js").PostProcessesOptions>} [postProcesses] Post-processes definitions
 * @property {number} [cacheSize=512] The vector tile cache size.
 */

/**
 * @typedef {import("../../layer/VectorTile.js").default} LayerType
 */

/**
 * @classdesc
 * WebGL renderer for vector tile layers. Experimental.
 * @extends {WebGLBaseTileLayerRenderer<any, import("../../VectorRenderTile.js").default, import("../../webgl/TileGeometry.js").default>}
 */
class WebGLVectorTileLayerRenderer extends WebGLBaseTileLayerRenderer {
  /**
   * @param {import("../../layer/VectorTile.js").default} tileLayer Tile layer.
   * @param {Options} options Options.
   */
  constructor(tileLayer, options) {
    super(/** @type {LayerType} */ (/** @type {unknown} */ (tileLayer)), {
      cacheSize: options.cacheSize,
      uniforms: {
        [Uniforms.TILE_MASK_TEXTURE]: () =>
          this.tileMaskTarget_?.getTexture() ?? null,
        [Uniforms.ONE]: 1,
      },
      postProcesses: options.postProcesses ?? [],
    });

    /**
     * @type {boolean}
     * @private
     */
    this.hitDetectionEnabled_ = !options.disableHitDetection;

    /**
     * @type {LayerStyle|null}
     * @private
     */
    this.style_ = null;

    /**
     * @private
     */
    this.hasText_ = false;

    /**
     * @type {import('../../style/flat.js').StyleVariables|undefined}
     * @private
     */
    this.styleVariables_ = undefined;

    /**
     * @type {VectorStyleRenderer|null}
     * @private
     */
    this.styleRenderer_ = null;

    /**
     * Transform that projects from world to viewport [-1,1]
     * @private
     */
    this.currentFrameStateTransform_ = createTransform();

    /**
     * @type {WebGLRenderTarget|null}
     * @private
     */
    this.tileMaskTarget_ = null;

    /**
     * @private
     */
    this.tileMaskIndices_ = new WebGLArrayBuffer(
      ELEMENT_ARRAY_BUFFER,
      STATIC_DRAW,
    );
    this.tileMaskIndices_.fromArray([0, 1, 3, 1, 2, 3]);

    /**
     * @type {Array<import('../../webgl/Helper.js').AttributeDescription>}
     * @private
     */
    this.tileMaskAttributes_ = [
      {
        name: Attributes.POSITION,
        size: 2,
        type: AttributeType.FLOAT,
      },
    ];

    /**
     * @type {WebGLProgram|undefined}
     * @private
     */
    this.tileMaskProgram_;

    /**
     * @private
     */
    this.layerRevision_ = -1;

    /**
     * @private
     */
    this.skipNextTextRender_ = false;

    this.applyOptions_(options);
  }

  /**
   * @param {Options} options Options.
   * @override
   */
  reset(options) {
    super.reset(options);

    this.applyOptions_(options);
    if (this.helper) {
      this.createRenderers_();
      this.initTileMask_();
    }
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
    /**
     * @param {import('../../render/webgl/ShaderBuilder.js').ShaderBuilder} builder Shader builder to configure.
     */
    function addBuilderParams(builder) {
      const exisitingDiscard = builder.getFragmentDiscardExpression();
      const discardFromMask = `texture2D(${Uniforms.TILE_MASK_TEXTURE}, gl_FragCoord.xy / u_pixelRatio / u_viewportSizePx).r * 50. > ${Uniforms.TILE_ZOOM_LEVEL} + 0.5`;
      builder.setFragmentDiscardExpression(
        exisitingDiscard !== null
          ? `(${exisitingDiscard}) || (${discardFromMask})`
          : discardFromMask,
      );
      builder.addUniform(Uniforms.TILE_MASK_TEXTURE, 'sampler2D');
      builder.addUniform(Uniforms.TILE_ZOOM_LEVEL, 'float');
    }

    const styleShaders = convertStyleToShaders(
      /** @type {import('../../style/flat.js').FlatStyleLike} */ (this.style_),
      this.styleVariables_ ?? {},
    );
    for (const styleShader of styleShaders) {
      addBuilderParams(styleShader.builder);
    }

    this.styleRenderer_ = new VectorStyleRenderer(
      styleShaders,
      this.styleVariables_ ?? {},
      this.helper,
      this.hitDetectionEnabled_,
    );
  }

  /**
   * @private
   */
  initTileMask_() {
    this.tileMaskTarget_ = new WebGLRenderTarget(this.helper);
    const builder = new ShaderBuilder()
      .setFillColorExpression(
        `vec4(${Uniforms.TILE_ZOOM_LEVEL} / 50., 0., 0., 1.)`,
      )
      .addUniform(Uniforms.TILE_ZOOM_LEVEL, 'float');
    this.tileMaskProgram_ = this.helper.getProgram(
      /** @type {string} */ (builder.getFillFragmentShader()),
      /** @type {string} */ (builder.getFillVertexShader()),
    );
    this.helper.flushBufferData(this.tileMaskIndices_);
  }

  /**
   * @override
   */
  afterHelperCreated() {
    this.createRenderers_();
    this.initTileMask_();
  }

  /**
   * @param {import("../../webgl/BaseTileRepresentation.js").TileRepresentationOptions<import("../../VectorRenderTile.js").default>} options tile representation options
   * @override
   */
  createTileRepresentation(options) {
    const tileRep = new TileGeometry(
      options,
      /** @type {import("../../render/webgl/VectorStyleRenderer.js").default} */ (
        this.styleRenderer_
      ),
      () => {
        const viewRotation = this.frameState?.viewState.rotation || 0;
        if (!this.reprojecting_) {
          return {viewRotation};
        }
        const source = this.getLayer().getSource();
        const sourceProj = source?.getProjection();
        const sourceWorld = sourceProj && sourceProj.getExtent();
        const maxTriangleEdgeLength =
          sourceProj && sourceProj.canWrapX() && sourceWorld
            ? getWidth(sourceWorld) * 0.5
            : 0;
        const viewProj =
          this.frameState?.viewState.projection ||
          this.getLayer().getMapInternal()?.getView()?.getProjection();
        if (!sourceProj || !viewProj) {
          return {maxTriangleEdgeLength, viewRotation};
        }
        const sourceTiles = options.tile.getSourceTiles();
        const tileExtent = sourceTiles[0]?.extent;
        const originX = tileExtent ? tileExtent[0] : 0;
        const originY = tileExtent ? tileExtent[1] : 0;
        const forward = getTransform(sourceProj, viewProj);
        if (!forward) {
          return {maxTriangleEdgeLength, viewRotation};
        }
        return {
          maxTriangleEdgeLength,
          viewRotation,
          // Tile-local XY → source world → view CRS for line-label angles.
          projectToTarget: (coord) =>
            forward([coord[0] + originX, coord[1] + originY]),
        };
      },
    );
    // redraw the layer when the tile is ready
    const listener = () => {
      if (tileRep.ready) {
        this.getLayer().changed();
        tileRep.removeEventListener(EventType.CHANGE, listener);
      }
    };
    tileRep.addEventListener(EventType.CHANGE, listener);
    return tileRep;
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {boolean} tilesWithAlpha Whether tiles need alpha blending.
   * @override
   */
  beforeTilesRender(frameState, tilesWithAlpha) {
    super.beforeTilesRender(frameState, true); // always consider that tiles need alpha blending

    const layerChanged = this.layerRevision_ < this.getLayer().getRevision();
    this.layerRevision_ = this.getLayer().getRevision();

    if (layerChanged) {
      this.skipNextTextRender_ = false;
    }

    this.helper.makeProjectionTransform(
      frameState,
      this.currentFrameStateTransform_,
    );
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @override
   */
  beforeTilesMaskRender(frameState) {
    // Tile masks assume a linear view-CRS transform; skip when warping.
    if (this.reprojecting_) {
      return false;
    }
    const tileMaskTarget = this.tileMaskTarget_;
    const tileMaskProgram = this.tileMaskProgram_;
    if (!tileMaskTarget || !tileMaskProgram) {
      return false;
    }
    this.helper.makeProjectionTransform(
      frameState,
      this.currentFrameStateTransform_,
    );
    const pixelRatio = frameState.pixelRatio;
    const size = frameState.size;
    tileMaskTarget.setSize([size[0] * pixelRatio, size[1] * pixelRatio]);
    this.helper.prepareDrawToRenderTarget(
      frameState,
      tileMaskTarget,
      true,
      true,
    );
    this.helper.useProgram(tileMaskProgram, frameState);
    return true;
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @override
   */
  beforeFinalize(frameState) {}

  /**
   * @param {import("../../webgl/TileGeometry.js").default} tileRepresentation Tile representation.
   * @param {number} tileZ Tile Z.
   * @param {import("../../extent.js").Extent} extent Render extent.
   * @param {number} depth Depth.
   * @override
   */
  renderTileMask(tileRepresentation, tileZ, extent, depth) {
    if (!tileRepresentation.ready) {
      return;
    }
    const geomTile = /** @type {TileGeometry} */ (tileRepresentation);
    const buffers = geomTile.buffers;
    if (!buffers) {
      return;
    }
    const invertTransform = buffers.invertVerticesTransform;
    setFromTransform(this.tmpTransform_, this.currentFrameStateTransform_);
    multiplyTransform(this.tmpTransform_, invertTransform);
    this.helper.setUniformMatrixValue(
      Uniforms.PROJECTION_MATRIX,
      mat4FromTransform(this.tmpMat4_, this.tmpTransform_),
    );
    makeInverseTransform(this.tmpTransform_, this.tmpTransform_);
    this.helper.setUniformMatrixValue(
      Uniforms.INVERT_PROJECTION_MATRIX,
      mat4FromTransform(this.tmpMat4_, this.tmpTransform_),
    );
    this.helper.setUniformFloatValue(Uniforms.DEPTH, depth);
    this.helper.setUniformFloatValue(Uniforms.TILE_ZOOM_LEVEL, tileZ);
    this.helper.setUniformFloatValue(Uniforms.GLOBAL_ALPHA, 1);
    this.applyRenderExtentUniform(
      extent,
      makeInverseTransform(this.tmpTransform_, invertTransform),
    );
    this.helper.bindBuffer(
      /** @type {TileGeometry} */ (tileRepresentation).maskVertices,
    );
    this.helper.bindBuffer(this.tileMaskIndices_);
    this.helper.enableAttributes(this.tileMaskAttributes_);
    const renderCount = this.tileMaskIndices_.getSize();
    this.helper.drawElements(0, renderCount);
  }

  /**
   * @param {number} alpha Alpha value of the tile
   * @param {import("../../extent.js").Extent} renderExtent Which extent to restrict drawing to
   * @param {import("../../transform.js").Transform} batchInvertTransform Inverse of the transformation in which tile geometries are expressed
   * @param {number} tileZ Tile zoom level
   * @param {number} depth Depth of the tile
   * @param {import("../../Map.js").FrameState} frameState Frame state
   * @param {import("../../webgl/reproj/WarpField.js").default|null|undefined} warpField Warp field when reprojecting
   * @param {import("../../coordinate.js").Coordinate|undefined} sourceOrigin Tile origin in source CRS when reprojecting
   * @private
   */
  applyUniforms_(
    alpha,
    renderExtent,
    batchInvertTransform,
    tileZ,
    depth,
    frameState,
    warpField,
    sourceOrigin,
  ) {
    applyVectorUniforms(
      this.helper,
      this.currentFrameStateTransform_,
      batchInvertTransform,
      frameState,
      warpField ? {patternsInSourceSpace: true} : undefined,
    );
    applyWarpUniforms(
      this.helper,
      warpField || null,
      sourceOrigin,
      frameState.viewState.projection,
    );

    this.helper.setUniformFloatValue(Uniforms.GLOBAL_ALPHA, alpha);
    this.helper.setUniformFloatValue(Uniforms.DEPTH, depth);
    this.helper.setUniformFloatValue(Uniforms.TILE_ZOOM_LEVEL, tileZ);
    this.applyRenderExtentUniform(
      renderExtent,
      makeInverseTransform(this.tmpTransform_, batchInvertTransform),
    );
  }

  /**
   * @param {import("../../webgl/TileGeometry.js").default} tileRepresentation Tile representation.
   * @param {import("../../transform.js").Transform} tileTransform Tile transform.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {import("../../extent.js").Extent} renderExtent Render extent.
   * @param {number} tileResolution Tile resolution.
   * @param {import("../../size.js").Size} tileSize Tile size.
   * @param {import("../../coordinate.js").Coordinate} tileOrigin Tile origin.
   * @param {import("../../extent.js").Extent} tileExtent Tile extent.
   * @param {number} depth Depth.
   * @param {number} gutter Gutter.
   * @param {number} alpha Alpha.
   * @override
   */
  renderTile(
    tileRepresentation,
    tileTransform,
    frameState,
    renderExtent,
    tileResolution,
    tileSize,
    tileOrigin,
    tileExtent,
    depth,
    gutter,
    alpha,
  ) {
    const styleRenderer = this.styleRenderer_;
    if (!styleRenderer) {
      return;
    }
    const tileZ = tileRepresentation.tile.getTileCoord()[0];
    const buffers = tileRepresentation.buffers;
    if (!buffers) {
      return;
    }
    styleRenderer.render(buffers, frameState, () => {
      this.applyUniforms_(
        alpha,
        tileExtent,
        buffers.invertVerticesTransform,
        tileZ,
        depth,
        frameState,
        null,
        null,
      );
    });
  }

  /**
   * @override
   */
  renderReprojTile(
    tileRepresentation,
    frameState,
    renderExtent,
    tileExtent,
    depth,
    gutter,
    alpha,
    offset,
  ) {
    const geomTile = /** @type {TileGeometry} */ (tileRepresentation);
    const buffers = geomTile.buffers;
    if (!geomTile.ready || !buffers) {
      return;
    }

    const layer = this.getLayer();
    const source = layer.getRenderSource();
    const viewState = frameState.viewState;
    const sourceProj = source.getProjection() || viewState.projection;
    const targetProj = viewState.projection;
    const tileGrid =
      source.getTileGrid() || source.getTileGridForProjection(sourceProj);
    const tileCoord = geomTile.tile.getTileCoord();
    const sourceResolution = tileGrid.getResolution(tileCoord[0]);

    const warpKey = [
      getCacheKey(source, tileCoord),
      offset,
      getUid(sourceProj),
      getUid(targetProj),
      sourceResolution,
    ].join('|');

    /** @type {WarpField} */
    let warpField;
    if (this.reprojCache_.containsKey(warpKey)) {
      warpField = /** @type {WarpField} */ (this.reprojCache_.get(warpKey));
    } else {
      warpField = new WarpField({
        sourceProj,
        targetProj,
        sourceExtent: tileExtent,
        sourceResolution,
        sourceOffsetX: offset,
      });
      this.reprojCache_.set(warpKey, warpField);
    }

    const sourceOrigin = [tileExtent[0] + offset, tileExtent[1]];
    const tileZ = tileCoord[0];
    this.styleRenderer_.render(buffers, frameState, () => {
      this.applyUniforms_(
        alpha,
        renderExtent,
        buffers.invertVerticesTransform,
        tileZ,
        depth,
        frameState,
        warpField,
        sourceOrigin,
      );
    });
  }

  /**
   * Render declutter items for this layer
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   */
  renderDeclutter(frameState) {}

  /**
   * Clean up.
   * @override
   */
  disposeInternal() {
    this.styleRenderer_?.dispose();
    super.disposeInternal();
  }
}

export default WebGLVectorTileLayerRenderer;
