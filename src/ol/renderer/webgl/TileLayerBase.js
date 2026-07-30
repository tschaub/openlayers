/**
 * @module ol/renderer/webgl/TileLayerBase
 */
import TileRange from '../../TileRange.js';
import TileState from '../../TileState.js';
import {descending} from '../../array.js';
import {getIntersection, getRotatedViewport, isEmpty} from '../../extent.js';
import {fromUserExtent} from '../../proj.js';
import {toSize} from '../../size.js';
import LRUCache from '../../structs/LRUCache.js';
import {
  createOrUpdate as createTileCoord,
  getKey as getTileCoordKey,
} from '../../tilecoord.js';
import {
  apply as applyTransform,
  create as createTransform,
  reset as resetTransform,
  rotate as rotateTransform,
  scale as scaleTransform,
  translate as translateTransform,
} from '../../transform.js';
import {abstract, getUid} from '../../util.js';
import {create as createMat4} from '../../vec/mat4.js';
import {DefaultUniform} from '../../webgl/Helper.js';
import {
  getSourceTileQuery,
  getSourceTileRefs,
  needsReprojection,
} from '../../webgl/reproj/util.js';
import WebGLLayerRenderer from './Layer.js';

export const Uniforms = {
  ...DefaultUniform,
  TILE_TRANSFORM: 'u_tileTransform',
  TRANSITION_ALPHA: 'u_transitionAlpha',
  DEPTH: 'u_depth',
  RENDER_EXTENT: 'u_renderExtent', // intersection of layer, source, and view extent
  GLOBAL_ALPHA: 'u_globalAlpha',
};

/**
 * Transform a zoom level into a depth value; zoom level zero has a depth value of 0.5, and increasing values
 * have a depth trending towards 0
 * @param {number} z A zoom level.
 * @return {number} A depth value.
 */
function depthForZ(z) {
  return 1 / (z + 2);
}

/**
 * @typedef {import("../../webgl/BaseTileRepresentation.js").default<import("../../Tile.js").default>} AbstractTileRepresentation
 */
/**
 * @typedef {Object} TileRepresentationLookup
 * @property {Set<string>} tileIds The set of tile ids in the lookup.
 * @property {Object<number, Set<AbstractTileRepresentation>>} representationsByZ Tile representations by zoom level.
 */

/**
 * @return {TileRepresentationLookup} A new tile representation lookup.
 */
export function newTileRepresentationLookup() {
  return {tileIds: new Set(), representationsByZ: {}};
}

/**
 * Check if a tile is already in the tile representation lookup.
 * @param {TileRepresentationLookup} tileRepresentationLookup Lookup of tile representations by zoom level.
 * @param {import("../../Tile.js").default} tile A tile.
 * @return {boolean} The tile is already in the lookup.
 */
function lookupHasTile(tileRepresentationLookup, tile) {
  return tileRepresentationLookup.tileIds.has(getUid(tile));
}

/**
 * Add a tile representation to the lookup.
 * @param {TileRepresentationLookup} tileRepresentationLookup Lookup of tile representations by zoom level.
 * @param {AbstractTileRepresentation} tileRepresentation A tile representation.
 * @param {number} z The zoom level.
 */
function addTileRepresentationToLookup(
  tileRepresentationLookup,
  tileRepresentation,
  z,
) {
  const representationsByZ = tileRepresentationLookup.representationsByZ;
  if (!(z in representationsByZ)) {
    representationsByZ[z] = new Set();
  }
  representationsByZ[z].add(tileRepresentation);
  tileRepresentationLookup.tileIds.add(getUid(tileRepresentation.tile));
}

/**
 * Remove a tile representation from the lookup.
 * @param {TileRepresentationLookup} tileRepresentationLookup Lookup of tile representations by zoom level.
 * @param {AbstractTileRepresentation} tileRepresentation A tile representation.
 * @param {number} z The zoom level.
 */
function removeTileRepresentationFromLookup(
  tileRepresentationLookup,
  tileRepresentation,
  z,
) {
  const representations = tileRepresentationLookup.representationsByZ[z];
  if (representations) {
    representations.delete(tileRepresentation);
  }
  tileRepresentationLookup.tileIds.delete(getUid(tileRepresentation.tile));
}

/**
 * @param {import("../../Map.js").FrameState} frameState Frame state.
 * @param {import("../../extent.js").Extent} extent The frame extent.
 * @return {import("../../extent.js").Extent} Frame extent intersected with layer extents.
 */
function getRenderExtent(frameState, extent) {
  const layerState = frameState.layerStatesArray[frameState.layerIndex];
  if (layerState.extent) {
    extent = getIntersection(
      extent,
      fromUserExtent(layerState.extent, frameState.viewState.projection),
    );
  }
  const layer = layerState.layer;
  if (!layer) {
    return extent;
  }
  const source = /** @type {import("../../source/Tile.js").default} */ (
    layer.getRenderSource()
  );
  if (!source.getWrapX()) {
    const gridExtent = source
      .getTileGridForProjection(frameState.viewState.projection)
      .getExtent();
    if (gridExtent) {
      extent = getIntersection(extent, gridExtent);
    }
  }
  return extent;
}

/**
 * @param {import("../../source/Tile.js").default} source The source.
 * @param {import('../../tilecoord.js').TileCoord} tileCoord The tile coordinate.
 * @param {string} [key] The source key to use; defaults to the current key.
 * @return {string} The cache key.
 */
export function getCacheKey(source, tileCoord, key = source.getKey()) {
  return `${getUid(source)},${key},${getTileCoordKey(tileCoord)}`;
}

/**
 * @typedef {Object} Options
 * @property {Object<string, import("../../webgl/Helper.js").UniformValue>} [uniforms] Additional uniforms
 * made available to shaders.
 * @property {number} [cacheSize=512] The tile representation cache size.
 * @property {Array<import('./Layer.js').PostProcessesOptions>} [postProcesses] Post-processes definitions.
 */

/**
 * @typedef {import("../../layer/BaseTile.js").default<any, any>} BaseLayerType
 */

/**
 * @classdesc
 * Base WebGL renderer for tile layers.
 * @template {BaseLayerType} LayerType
 * @template {import("../../Tile.js").default} TileType
 * @template {import("../../webgl/BaseTileRepresentation.js").default<TileType>} TileRepresentation
 * @extends {WebGLLayerRenderer<LayerType>}
 */
class WebGLBaseTileLayerRenderer extends WebGLLayerRenderer {
  /**
   * @param {LayerType} tileLayer Tile layer.
   * @param {Options} options Options.
   */
  constructor(tileLayer, options) {
    super(tileLayer, {
      uniforms: options.uniforms,
      postProcesses: options.postProcesses,
    });

    /**
     * The last call to `renderFrame` was completed with all tiles loaded
     * @type {boolean}
     */
    this.renderComplete = false;

    /**
     * This transform converts representation coordinates to screen coordinates.
     * @type {import("../../transform.js").Transform}
     * @private
     */
    this.tileTransform_ = createTransform();

    /**
     * @protected
     */
    this.tmpCoords_ = [0, 0];
    /**
     * @protected
     */
    this.tmpCoords2_ = [0, 0];
    /**
     * @protected
     */
    this.tmpExtent_ = [0, 0, 0, 0];
    /**
     * @protected
     */
    this.tmpTransform_ = createTransform();
    /**
     * @protected
     */
    this.tmpMat4_ = createMat4();

    /**
     * @type {import("../../TileRange.js").default}
     * @private
     */
    this.tempTileRange_ = new TileRange(0, 0, 0, 0);

    /**
     * @type {import("../../tilecoord.js").TileCoord}
     * @private
     */
    this.tempTileCoord_ = createTileCoord(0, 0, 0);

    /**
     * @type {import("../../size.js").Size}
     * @private
     */
    this.tempSize_ = [0, 0];

    const cacheSize = options.cacheSize !== undefined ? options.cacheSize : 512;
    /**
     * @type {import("../../structs/LRUCache.js").default<TileRepresentation>}
     * @protected
     */
    this.tileRepresentationCache = new LRUCache(cacheSize);

    this.maxStaleKeys = cacheSize * 0.5;

    /**
     * @protected
     * @type {import("../../Map.js").FrameState|null}
     */
    this.frameState = null;

    /**
     * @private
     * @type {import("../../proj/Projection.js").default|undefined}
     */
    this.renderedProjection_ = undefined;

    /**
     * Whether the current frame draws source tiles with a reprojection mesh.
     * @type {boolean}
     * @protected
     */
    this.reprojecting_ = false;

    /**
     * Per-frame list of source-tile draws when reprojecting (includes wrap offsets).
     * @type {Array<{tileRepresentation: TileRepresentation, offset: number, z: number}>}
     * @protected
     */
    this.reprojDrawList_ = [];

    /**
     * Cached reprojection resources (`Mesh` for raster, `WarpField` for vector
     * tiles), keyed by tile cache key, offset, and projection.
     * @type {import("../../structs/LRUCache.js").default<{delete: function(import("../../webgl/Helper.js").default): void}>}
     * @protected
     */
    this.reprojCache_ = new LRUCache(512);

    /**
     * Render extent for the current frame (reproj shared uniforms).
     * @type {import("../../extent.js").Extent|null}
     * @protected
     */
    this.renderExtent_ = null;
  }

  /**
   * @param {Options} options Options.
   * @override
   */
  reset(options) {
    super.reset({
      uniforms: options.uniforms,
    });
  }

  /**
   * Determine whether renderFrame should be called.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {boolean} Layer is ready to be rendered.
   * @override
   */
  prepareFrameInternal(frameState) {
    if (!this.renderedProjection_) {
      this.renderedProjection_ = frameState.viewState.projection;
    } else if (frameState.viewState.projection !== this.renderedProjection_) {
      this.clearCache();
      this.renderedProjection_ = frameState.viewState.projection;
    }

    const layer = this.getLayer();
    const source = layer.getRenderSource();
    if (!source) {
      return false;
    }

    const extent = frameState.extent;
    if (!extent || isEmpty(getRenderExtent(frameState, extent))) {
      return false;
    }
    return source.getState() === 'ready';
  }

  /**
   * @abstract
   * @param {import("../../webgl/BaseTileRepresentation.js").TileRepresentationOptions<TileType>} options tile representation options
   * @return {TileRepresentation} A new tile representation
   * @protected
   */
  createTileRepresentation(options) {
    return abstract();
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {import("../../extent.js").Extent} extent The extent to be rendered.
   * @param {number} initialZ The zoom level.
   * @param {TileRepresentationLookup} tileRepresentationLookup The zoom level.
   * @param {number} preload Number of additional levels to load.
   */
  enqueueTiles(
    frameState,
    extent,
    initialZ,
    tileRepresentationLookup,
    preload,
  ) {
    const tileLayer = this.getLayer();
    const tileSource = tileLayer.getRenderSource();
    if (needsReprojection(tileSource, frameState.viewState.projection)) {
      this.enqueueReprojTiles_(
        frameState,
        extent,
        tileRepresentationLookup,
        preload,
      );
      return;
    }

    const viewState = frameState.viewState;
    const tileGrid = tileSource.getTileGridForProjection(viewState.projection);
    const gutter = tileSource.getGutterForProjection(viewState.projection);

    const tileSourceKey = getUid(tileSource);
    if (!(tileSourceKey in frameState.wantedTiles)) {
      frameState.wantedTiles[tileSourceKey] = {};
    }

    const wantedTiles = frameState.wantedTiles[tileSourceKey];
    const tileRepresentationCache = this.tileRepresentationCache;

    const map = tileLayer.getMapInternal();
    const minZ = Math.max(
      initialZ - preload,
      tileGrid.getMinZoom(),
      tileGrid.getZForResolution(
        Math.min(
          tileLayer.getMaxResolution(),
          map
            ? map
                .getView()
                .getResolutionForZoom(Math.max(tileLayer.getMinZoom(), 0))
            : tileGrid.getResolution(0),
        ),
        tileSource.zDirection,
      ),
    );
    const rotation = viewState.rotation;
    const viewport = rotation
      ? getRotatedViewport(
          viewState.center,
          viewState.resolution,
          rotation,
          frameState.size,
        )
      : undefined;
    for (let z = initialZ; z >= minZ; --z) {
      const tileRange = tileGrid.getTileRangeForExtentAndZ(
        extent,
        z,
        this.tempTileRange_,
      );

      const tileResolution = tileGrid.getResolution(z);

      for (let x = tileRange.minX; x <= tileRange.maxX; ++x) {
        for (let y = tileRange.minY; y <= tileRange.maxY; ++y) {
          if (
            rotation &&
            !tileGrid.tileCoordIntersectsViewport([z, x, y], viewport)
          ) {
            continue;
          }
          const tileCoord = createTileCoord(z, x, y, this.tempTileCoord_);
          const cacheKey = getCacheKey(tileSource, tileCoord);

          /** @type {TileRepresentation|undefined} */
          let tileRepresentation;

          /** @type {TileType|undefined} */
          let tile;

          if (tileRepresentationCache.containsKey(cacheKey)) {
            tileRepresentation = tileRepresentationCache.get(cacheKey);
            tile = tileRepresentation.tile;
          }
          if (
            !tileRepresentation ||
            tileRepresentation.tile.key !== tileSource.getKey()
          ) {
            tile = tileSource.getTile(
              z,
              x,
              y,
              frameState.pixelRatio,
              viewState.projection,
            );
            if (!tile) {
              continue;
            }
          }

          if (!tile) {
            continue;
          }

          if (lookupHasTile(tileRepresentationLookup, tile)) {
            continue;
          }

          if (!tileRepresentation) {
            tileRepresentation = this.createTileRepresentation({
              tile: tile,
              grid: tileGrid,
              helper: this.helper,
              gutter: gutter,
            });
            tileRepresentationCache.set(cacheKey, tileRepresentation);
          } else {
            tileRepresentation.setTile(tile);
          }

          addTileRepresentationToLookup(
            tileRepresentationLookup,
            tileRepresentation,
            z,
          );

          const tileQueueKey = tile.getKey();
          wantedTiles[tileQueueKey] = true;

          if (tile.getState() === TileState.IDLE) {
            if (!frameState.tileQueue.isKeyQueued(tileQueueKey)) {
              frameState.tileQueue.enqueue([
                tile,
                tileSourceKey,
                tileGrid.getTileCoordCenter(tileCoord),
                tileResolution,
              ]);
            }
          }
        }
      }
    }
  }

  /**
   * Enqueue native source-projection tiles for GPU mesh reprojection.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {import("../../extent.js").Extent} extent View render extent.
   * @param {TileRepresentationLookup} tileRepresentationLookup Lookup.
   * @param {number} preload Extra zoom levels to prefetch.
   * @private
   */
  enqueueReprojTiles_(frameState, extent, tileRepresentationLookup, preload) {
    const viewState = frameState.viewState;
    const tileLayer = this.getLayer();
    const tileSource = tileLayer.getRenderSource();
    const sourceProj = tileSource.getProjection() || viewState.projection;
    const tileGrid =
      tileSource.getTileGrid() ||
      tileSource.getTileGridForProjection(sourceProj);
    if (!tileGrid) {
      return;
    }
    const gutter = tileSource.getGutterForProjection(sourceProj);

    const query = getSourceTileQuery(
      tileSource,
      viewState.projection,
      extent,
      viewState.resolution,
    );
    if (!query) {
      return;
    }

    const tileSourceKey = getUid(tileSource);
    if (!(tileSourceKey in frameState.wantedTiles)) {
      frameState.wantedTiles[tileSourceKey] = {};
    }
    const wantedTiles = frameState.wantedTiles[tileSourceKey];
    const tileRepresentationCache = this.tileRepresentationCache;

    const minZ = Math.max(query.z - preload, tileGrid.getMinZoom());
    for (let z = query.z; z >= minZ; --z) {
      // Reuse the view-derived source extent for preload levels.  Passing
      // source-grid resolution into getSourceTileQuery would mix CRS units.
      const refs = getSourceTileRefs(
        tileSource,
        sourceProj,
        query.sourceExtent,
        z,
      );
      const tileResolution = tileGrid.getResolution(z);

      for (let i = 0; i < refs.length; ++i) {
        const ref = refs[i];
        const tileCoord = createTileCoord(
          ref.z,
          ref.x,
          ref.y,
          this.tempTileCoord_,
        );
        const cacheKey = getCacheKey(tileSource, tileCoord);

        /** @type {TileRepresentation} */
        let tileRepresentation;
        /** @type {TileType} */
        let tile;

        if (tileRepresentationCache.containsKey(cacheKey)) {
          tileRepresentation = tileRepresentationCache.get(cacheKey);
          tile = tileRepresentation.tile;
        }
        if (
          !tileRepresentation ||
          tileRepresentation.tile.key !== tileSource.getKey()
        ) {
          tile = tileSource.getTile(
            ref.z,
            ref.x,
            ref.y,
            frameState.pixelRatio,
            // Request tiles in the source projection; the renderer warps them.
            sourceProj,
          );
          if (!tile) {
            continue;
          }
        }

        if (!tileRepresentation) {
          tileRepresentation = this.createTileRepresentation({
            tile: tile,
            grid: tileGrid,
            helper: this.helper,
            gutter: typeof gutter === 'number' ? gutter : 0,
          });
          tileRepresentationCache.set(cacheKey, tileRepresentation);
        } else {
          tileRepresentation.setTile(tile);
        }

        if (!lookupHasTile(tileRepresentationLookup, tile)) {
          addTileRepresentationToLookup(
            tileRepresentationLookup,
            tileRepresentation,
            z,
          );
        }

        this.reprojDrawList_.push({
          tileRepresentation,
          offset: ref.offset,
          z,
        });

        const tileQueueKey = tile.getKey();
        wantedTiles[tileQueueKey] = true;

        if (tile.getState() === TileState.IDLE) {
          if (!frameState.tileQueue.isKeyQueued(tileQueueKey)) {
            frameState.tileQueue.enqueue([
              tile,
              tileSourceKey,
              tileGrid.getTileCoordCenter(tileCoord),
              tileResolution,
            ]);
          }
        }
      }
    }
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {boolean} tilesWithAlpha True if at least one of the rendered tiles has alpha
   * @protected
   */
  beforeTilesRender(frameState, tilesWithAlpha) {
    const currentFrameState = this.frameState ?? frameState;
    this.helper.prepareDraw(currentFrameState, !tilesWithAlpha, true);
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {boolean} If returns false, tile mask rendering will be skipped
   * @protected
   */
  beforeTilesMaskRender(frameState) {
    return false;
  }

  /**
   * @param {TileRepresentation} tileRepresentation Tile representation
   * @param {import("../../transform.js").Transform} tileTransform Tile transform
   * @param {import("../../Map.js").FrameState} frameState Frame state
   * @param {import("../../extent.js").Extent} renderExtent Render extent
   * @param {number} tileResolution Tile resolution
   * @param {import("../../size.js").Size} tileSize Tile size
   * @param {import("../../coordinate.js").Coordinate} tileOrigin Tile origin
   * @param {import("../../extent.js").Extent} tileExtent tile Extent
   * @param {number} depth Depth
   * @param {number} gutter Gutter
   * @param {number} alpha Alpha
   * @protected
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
  ) {}

  /**
   * @param {TileRepresentation} tileRepresentation Tile representation
   * @param {number} tileZ Tile Z
   * @param {import("../../extent.js").Extent} extent Render extent
   * @param {number} depth Depth
   * @protected
   */
  renderTileMask(tileRepresentation, tileZ, extent, depth) {}

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @param {TileRepresentation} tileRepresentation Tile representation.
   * @param {number} tileZ Tile Z.
   * @param {number} gutter Gutter.
   * @param {import("../../extent.js").Extent} extent Render extent.
   * @param {Object<string, number>} alphaLookup Alpha lookup.
   * @param {import("../../tilegrid/TileGrid.js").default} tileGrid Tile grid.
   * @param {number} [reprojOffset] Horizontal world wrap offset when reprojecting.
   * @private
   */
  drawTile_(
    frameState,
    tileRepresentation,
    tileZ,
    gutter,
    extent,
    alphaLookup,
    tileGrid,
    reprojOffset,
  ) {
    if (!tileRepresentation.ready) {
      return;
    }
    const tile = tileRepresentation.tile;
    const tileCoord = tile.tileCoord;
    const tileCoordKey = getTileCoordKey(tileCoord);
    const alpha = tileCoordKey in alphaLookup ? alphaLookup[tileCoordKey] : 1;

    const tileResolution = tileGrid.getResolution(tileZ);
    const tileSize = toSize(tileGrid.getTileSize(tileZ), this.tempSize_);
    const tileOrigin = tileGrid.getOrigin(tileZ);
    const tileExtent = tileGrid.getTileCoordExtent(tileCoord);
    // tiles with alpha are rendered last to allow blending
    const depth = alpha < 1 ? -1 : depthForZ(tileZ);
    if (alpha < 1) {
      frameState.animate = true;
    }

    if (this.reprojecting_) {
      this.renderReprojTile(
        /** @type {TileRepresentation} */ (tileRepresentation),
        frameState,
        extent,
        tileExtent,
        depth,
        gutter,
        alpha,
        reprojOffset || 0,
      );
      return;
    }

    const viewState = frameState.viewState;
    const centerX = viewState.center[0];
    const centerY = viewState.center[1];

    const tileWidthWithGutter = tileSize[0] + 2 * gutter;
    const tileHeightWithGutter = tileSize[1] + 2 * gutter;

    const aspectRatio = tileWidthWithGutter / tileHeightWithGutter;

    const centerI = (centerX - tileOrigin[0]) / (tileSize[0] * tileResolution);
    const centerJ = (tileOrigin[1] - centerY) / (tileSize[1] * tileResolution);

    const tileScale = viewState.resolution / tileResolution;

    const tileCenterI = tileCoord[1];
    const tileCenterJ = tileCoord[2];

    resetTransform(this.tileTransform_);
    scaleTransform(
      this.tileTransform_,
      2 / ((frameState.size[0] * tileScale) / tileWidthWithGutter),
      -2 / ((frameState.size[1] * tileScale) / tileWidthWithGutter),
    );
    rotateTransform(this.tileTransform_, viewState.rotation);
    scaleTransform(this.tileTransform_, 1, 1 / aspectRatio);
    translateTransform(
      this.tileTransform_,
      (tileSize[0] * (tileCenterI - centerI) - gutter) / tileWidthWithGutter,
      (tileSize[1] * (tileCenterJ - centerJ) - gutter) / tileHeightWithGutter,
    );

    this.renderTile(
      /** @type {TileRepresentation} */ (tileRepresentation),
      this.tileTransform_,
      frameState,
      extent,
      tileResolution,
      tileSize,
      tileOrigin,
      tileExtent,
      depth,
      gutter,
      alpha,
    );
  }

  /**
   * Render a source tile with a warped reprojection mesh.
   * Subclasses that support GPU reprojection override this.
   * @param {TileRepresentation} tileRepresentation Tile representation
   * @param {import("../../Map.js").FrameState} frameState Frame state
   * @param {import("../../extent.js").Extent} renderExtent Render extent
   * @param {import("../../extent.js").Extent} tileExtent Source tile extent
   * @param {number} depth Depth
   * @param {number} gutter Gutter
   * @param {number} alpha Alpha
   * @param {number} offset Wrap X offset
   * @protected
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
  ) {}

  /**
   * Render the layer.
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @return {HTMLElement} The rendered element.
   * @override
   */
  renderFrame(frameState) {
    this.frameState = frameState;
    this.renderComplete = true;
    const gl = this.helper.getGL();
    this.preRender(gl, frameState);

    const viewState = frameState.viewState;
    const tileLayer = this.getLayer();
    const tileSource = tileLayer.getRenderSource();
    this.reprojecting_ = needsReprojection(tileSource, viewState.projection);
    this.reprojDrawList_.length = 0;

    const tileGrid = this.reprojecting_
      ? tileSource.getTileGrid() ||
        tileSource.getTileGridForProjection(
          tileSource.getProjection() || viewState.projection,
        )
      : tileSource.getTileGridForProjection(viewState.projection);
    const gutter = this.reprojecting_
      ? tileSource.getGutterForProjection(
          tileSource.getProjection() || viewState.projection,
        )
      : tileSource.getGutterForProjection(viewState.projection);
    const frameExtent = frameState.extent;
    if (!frameExtent) {
      return this.helper.getCanvas();
    }
    const extent = getRenderExtent(frameState, frameExtent);
    const sourceQuery = this.reprojecting_
      ? getSourceTileQuery(
          tileSource,
          viewState.projection,
          extent,
          viewState.resolution,
        )
      : null;
    const z = sourceQuery
      ? sourceQuery.z
      : tileGrid.getZForResolution(viewState.resolution, tileSource.zDirection);

    this.updateStaleKeys(tileSource.getKey());

    /**
     * @type {TileRepresentationLookup}
     */
    const tileRepresentationLookup = newTileRepresentationLookup();

    const preload = tileLayer.getPreload();
    if (frameState.nextExtent) {
      const targetZ = tileGrid.getZForResolution(
        viewState.nextResolution,
        tileSource.zDirection,
      );
      const nextExtent = getRenderExtent(frameState, frameState.nextExtent);
      this.enqueueTiles(
        frameState,
        nextExtent,
        targetZ,
        tileRepresentationLookup,
        preload,
      );
    }

    this.enqueueTiles(frameState, extent, z, tileRepresentationLookup, 0);
    if (preload > 0) {
      setTimeout(() => {
        this.enqueueTiles(
          frameState,
          extent,
          z - 1,
          tileRepresentationLookup,
          preload - 1,
        );
      }, 0);
    }

    /**
     * A lookup of alpha values for tiles at the target rendering resolution
     * for tiles that are in transition.  If a tile coord key is absent from
     * this lookup, the tile should be rendered at alpha 1.
     * @type {Object<string, number>}
     */
    const alphaLookup = {};

    let blend = false;
    const representationsByZ = tileRepresentationLookup.representationsByZ;

    // look for cached tiles to use if a target tile is not ready
    if (z in representationsByZ) {
      const uid = getUid(this);
      const time = frameState.time;
      for (const tileRepresentation of representationsByZ[z]) {
        const tile = tileRepresentation.tile;
        if (tile.getState() === TileState.EMPTY) {
          continue;
        }
        const tileCoord = tile.tileCoord;

        const tileCoordKey = getTileCoordKey(tileCoord);
        if (tileRepresentation.ready) {
          const alpha = tile.getAlpha(uid, time);
          if (alpha === 1) {
            // no need to look for alt tiles
            tile.endTransition(uid);
            continue;
          }
          blend = true;
          alphaLookup[tileCoordKey] = alpha;
        }
        this.renderComplete = false;

        // look for a tile from a previous key before falling back to other zoom levels
        const hasStaleTile = this.findStaleTile_(
          tileCoord,
          tileRepresentationLookup,
        );
        if (hasStaleTile) {
          // show the stale tile at full opacity until the new tile has faded in
          delete alphaLookup[tileCoordKey];
          removeTileRepresentationFromLookup(
            tileRepresentationLookup,
            tileRepresentation,
            z,
          );
          frameState.animate = true;
          continue;
        }

        // first look for child tiles (at z + 1)
        const coveredByChildren = this.findAltTiles_(
          tileGrid,
          tileCoord,
          z + 1,
          tileRepresentationLookup,
        );

        if (coveredByChildren) {
          continue;
        }

        // next look for parent tiles
        const minZoom = tileGrid.getMinZoom();
        for (let parentZ = z - 1; parentZ >= minZoom; --parentZ) {
          const coveredByParent = this.findAltTiles_(
            tileGrid,
            tileCoord,
            parentZ,
            tileRepresentationLookup,
          );

          if (coveredByParent) {
            break;
          }
        }
      }
    }

    const zs = Object.keys(representationsByZ).map(Number).sort(descending);

    const renderTileMask = this.beforeTilesMaskRender(frameState);

    if (renderTileMask) {
      for (let j = 0, jj = zs.length; j < jj; ++j) {
        const tileZ = zs[j];
        for (const tileRepresentation of representationsByZ[tileZ]) {
          const tileCoord = tileRepresentation.tile.tileCoord;
          const tileCoordKey = getTileCoordKey(tileCoord);
          // do not render the tile mask if alpha < 1
          if (tileCoordKey in alphaLookup) {
            continue;
          }
          const tileExtent = tileGrid.getTileCoordExtent(tileCoord);
          this.renderTileMask(
            /** @type {TileRepresentation} */ (tileRepresentation),
            tileZ,
            tileExtent,
            depthForZ(tileZ),
          );
        }
      }
    }

    this.renderExtent_ = extent;
    this.beforeTilesRender(frameState, blend);

    /**
     * Wrap-X offsets per tile coord from the reprojection enqueue pass.
     * Alt tiles (parent/child/stale) fall back to the unique offsets used this frame.
     * @type {Object<string, Array<number>>}
     */
    const reprojOffsetsByKey = {};
    /** @type {Array<number>} */
    const reprojOffsets = [];
    if (this.reprojecting_) {
      for (let i = 0; i < this.reprojDrawList_.length; ++i) {
        const item = this.reprojDrawList_[i];
        const key = getTileCoordKey(item.tileRepresentation.tile.tileCoord);
        if (!(key in reprojOffsetsByKey)) {
          reprojOffsetsByKey[key] = [];
        }
        if (!reprojOffsetsByKey[key].includes(item.offset)) {
          reprojOffsetsByKey[key].push(item.offset);
        }
        if (!reprojOffsets.includes(item.offset)) {
          reprojOffsets.push(item.offset);
        }
      }
      if (reprojOffsets.length === 0) {
        reprojOffsets.push(0);
      }
    }

    for (let j = 0, jj = zs.length; j < jj; ++j) {
      const tileZ = zs[j];
      for (const tileRepresentation of representationsByZ[tileZ]) {
        const tileCoord = tileRepresentation.tile.tileCoord;
        const tileCoordKey = getTileCoordKey(tileCoord);
        if (tileCoordKey in alphaLookup) {
          continue;
        }

        if (this.reprojecting_) {
          const offsets = reprojOffsetsByKey[tileCoordKey] || reprojOffsets;
          for (let o = 0; o < offsets.length; ++o) {
            this.drawTile_(
              frameState,
              /** @type {TileRepresentation} */ (tileRepresentation),
              tileZ,
              gutter,
              extent,
              alphaLookup,
              tileGrid,
              offsets[o],
            );
          }
        } else {
          this.drawTile_(
            frameState,
            /** @type {TileRepresentation} */ (tileRepresentation),
            tileZ,
            gutter,
            extent,
            alphaLookup,
            tileGrid,
          );
        }
      }
    }

    if (z in representationsByZ) {
      for (const tileRepresentation of representationsByZ[z]) {
        const tileCoord = tileRepresentation.tile.tileCoord;
        const tileCoordKey = getTileCoordKey(tileCoord);
        if (tileCoordKey in alphaLookup) {
          if (this.reprojecting_) {
            const offsets = reprojOffsetsByKey[tileCoordKey] || reprojOffsets;
            for (let o = 0; o < offsets.length; ++o) {
              this.drawTile_(
                frameState,
                /** @type {TileRepresentation} */ (tileRepresentation),
                z,
                gutter,
                extent,
                alphaLookup,
                tileGrid,
                offsets[o],
              );
            }
          } else {
            this.drawTile_(
              frameState,
              /** @type {TileRepresentation} */ (tileRepresentation),
              z,
              gutter,
              extent,
              alphaLookup,
              tileGrid,
            );
          }
        }
      }
    }

    this.beforeFinalize(frameState);
    this.helper.finalizeDraw(
      frameState,
      this.dispatchPreComposeEvent,
      this.dispatchPostComposeEvent,
    );

    const canvas = this.helper.getCanvas();

    const tileRepresentationCache = this.tileRepresentationCache;
    tileRepresentationCache.expireCache();
    this.expireReprojCache_();

    this.postRender(gl, frameState);
    return canvas;
  }

  /**
   * Evict cached Mesh / WarpField entries and free their GPU resources.
   * LRUCache.expireCache only disposes Disposable entries; these use delete().
   * @private
   */
  expireReprojCache_() {
    const helper = this.helper;
    while (this.reprojCache_.canExpireCache()) {
      const entry = this.reprojCache_.pop();
      if (entry && typeof entry.delete === 'function') {
        entry.delete(helper);
      }
    }
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame state.
   * @protected
   */
  beforeFinalize(frameState) {}

  /**
   * Look for a ready tile at the same coordinate from a previous source key.
   * A match is added to the provided lookup at the target zoom level.
   * @param {import("../../tilecoord.js").TileCoord} tileCoord The target tile coordinate.
   * @param {TileRepresentationLookup} tileRepresentationLookup Lookup of
   * tile representations by zoom level.
   * @return {boolean} A stale tile was found and added to the lookup.
   * @private
   */
  findStaleTile_(tileCoord, tileRepresentationLookup) {
    const tileRepresentationCache = this.tileRepresentationCache;
    const source = this.getLayer().getRenderSource();
    const z = tileCoord[0];
    const staleKeys = this.getStaleKeys();
    for (let i = 0, ii = staleKeys.length; i < ii; ++i) {
      const cacheKey = getCacheKey(source, tileCoord, staleKeys[i]);
      if (tileRepresentationCache.containsKey(cacheKey)) {
        const tileRepresentation = tileRepresentationCache.get(cacheKey);
        if (
          tileRepresentation.ready &&
          !lookupHasTile(tileRepresentationLookup, tileRepresentation.tile)
        ) {
          // end the transition so the stale tile renders opaque and is not
          // re-processed as a target tile (which could loop)
          tileRepresentation.tile.endTransition(getUid(this));
          addTileRepresentationToLookup(
            tileRepresentationLookup,
            tileRepresentation,
            z,
          );
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Look for tiles covering the provided tile coordinate at an alternate
   * zoom level.  Loaded tiles will be added to the provided tile representation lookup.
   * @param {import("../../tilegrid/TileGrid.js").default} tileGrid The tile grid.
   * @param {import("../../tilecoord.js").TileCoord} tileCoord The target tile coordinate.
   * @param {number} altZ The alternate zoom level.
   * @param {TileRepresentationLookup} tileRepresentationLookup Lookup of
   * tile representations by zoom level.
   * @return {boolean} The tile coordinate is covered by loaded tiles at the alternate zoom level.
   * @private
   */
  findAltTiles_(tileGrid, tileCoord, altZ, tileRepresentationLookup) {
    const tileRange = tileGrid.getTileRangeForTileCoordAndZ(
      tileCoord,
      altZ,
      this.tempTileRange_,
    );

    if (!tileRange) {
      return false;
    }

    let covered = true;
    const tileRepresentationCache = this.tileRepresentationCache;
    const source = this.getLayer().getRenderSource();
    for (let x = tileRange.minX; x <= tileRange.maxX; ++x) {
      for (let y = tileRange.minY; y <= tileRange.maxY; ++y) {
        const cacheKey = getCacheKey(source, [altZ, x, y]);
        let loaded = false;
        if (tileRepresentationCache.containsKey(cacheKey)) {
          const tileRepresentation = tileRepresentationCache.get(cacheKey);
          if (
            tileRepresentation.ready &&
            !lookupHasTile(tileRepresentationLookup, tileRepresentation.tile)
          ) {
            addTileRepresentationToLookup(
              tileRepresentationLookup,
              tileRepresentation,
              altZ,
            );
            loaded = true;
          }
        }
        if (!loaded) {
          covered = false;
        }
      }
    }
    return covered;
  }

  /**
   * @override
   */
  clearCache() {
    super.clearCache();

    const tileRepresentationCache = this.tileRepresentationCache;
    tileRepresentationCache.forEach((tileRepresentation) =>
      tileRepresentation.dispose(),
    );
    tileRepresentationCache.clear();

    const helper = this.helper;
    this.reprojCache_.forEach((entry) => entry.delete(helper));
    this.reprojCache_.clear();
  }

  /**
   * @override
   */
  afterHelperCreated() {
    super.afterHelperCreated();

    this.tileRepresentationCache.forEach((tileRepresentation) =>
      tileRepresentation.setHelper(this.helper),
    );
  }

  /**
   * Clean up.
   * @override
   */
  disposeInternal() {
    super.disposeInternal();
    this.frameState = null;
  }

  /**
   * Apply the render extent as a uniform; the render extent uniform is expressed in the same coordinate space as the geometries in the render buffers,
   * whereas the input render extent is expressed in full world coordinates.
   * @protected
   * @param {import("../../extent.js").Extent} renderExtent Render extent in map units (world coordinates)
   * @param {import('../../transform.js').Transform} worldToLocalTransform Transform.
   */
  applyRenderExtentUniform(renderExtent, worldToLocalTransform) {
    // minx, miny
    this.tmpCoords_[0] = renderExtent[0];
    this.tmpCoords_[1] = renderExtent[1];
    applyTransform(worldToLocalTransform, this.tmpCoords_);

    // maxx, maxy
    this.tmpCoords2_[0] = renderExtent[2];
    this.tmpCoords2_[1] = renderExtent[3];
    applyTransform(worldToLocalTransform, this.tmpCoords2_);

    this.tmpExtent_[0] = this.tmpCoords_[0];
    this.tmpExtent_[1] = this.tmpCoords_[1];
    this.tmpExtent_[2] = this.tmpCoords2_[0];
    this.tmpExtent_[3] = this.tmpCoords2_[1];
    this.helper.setUniformFloatVec4(Uniforms.RENDER_EXTENT, this.tmpExtent_);
  }
}

export default WebGLBaseTileLayerRenderer;
