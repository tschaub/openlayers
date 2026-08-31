/**
 * @module ol/renderer/webgpu/VectorTileLayer
 */
import {
  buildVectorBuffers,
  decodeHitColor,
  mergeLabelBuffers,
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
import LRUCache from '../../structs/LRUCache.js';
import {
  createOrUpdate as createTileCoord,
  getCacheKey,
  getKey as getTileCoordKey,
} from '../../tilecoord.js';
import TileRange from '../../TileRange.js';
import TileState from '../../TileState.js';
import {apply as applyTransform} from '../../transform.js';
import {getUid} from '../../util.js';
import FontAtlas from '../../webgpu/FontAtlas.js';
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
 * @property {import("../../style/flat.js").FlatStyleLike} style Style.
 * @property {import("../../style/flat.js").StyleVariables} [variables] Variables.
 * @property {boolean} [disableHitDetection=false] Disable hit detection.
 * @property {boolean|string|number} [declutter=false] Declutter group.
 * @property {number} [cacheSize=512] Cache size.
 */

/**
 * @typedef {Object} TileBatch
 * @property {import("../../render/webgpu/buffers.js").VectorBuffers} buffers Buffers.
 * @property {string} key Tile key.
 */

/**
 * @classdesc
 * WebGPU vector tile renderer. Labels from all tiles share one map-level declutter pass.
 * @extends {WebGPULayerRenderer<import("../../layer/Layer.js").default>}
 */
class WebGPUVectorTileLayerRenderer extends WebGPULayerRenderer {
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

    const cacheSize = options.cacheSize !== undefined ? options.cacheSize : 512;

    /**
     * @protected
     * @type {import("../../structs/LRUCache.js").default<import("../../VectorRenderTile.js").default>}
     */
    this.renderTiles_ = new LRUCache(cacheSize);

    /**
     * @protected
     * @type {import("../../structs/LRUCache.js").default<TileBatch>}
     */
    this.tileCache_ = new LRUCache(cacheSize);

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
     * @type {GpuScratch}
     */
    this.scratch_ = new GpuScratch();

    /**
     * @private
     * @type {Array<TileBatch>}
     */
    this.renderedBatches_ = [];

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
     * @type {import("../../render/webgpu/buffers.js").VectorBuffers|null}
     */
    this.mergedLabelsBuffers_ = null;

    /**
     * @private
     * @type {import("../../tilecoord.js").TileCoord}
     */
    this.tempTileCoord_ = createTileCoord(0, 0, 0);

    /**
     * @private
     * @type {import("../../TileRange.js").default}
     */
    this.tempTileRange_ = new TileRange(0, 0, 0, 0);

    /**
     * Tile range reused when looking up parent/child fallbacks.
     * @private
     * @type {import("../../TileRange.js").default}
     */
    this.altTileRange_ = new TileRange(0, 0, 0, 0);
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
    this.frameUniformBuffer_ = helper.getDevice().createBuffer({
      size: FRAME_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.cornerBuffer_ = helper.createBuffer(
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    );
    createVectorPipelines(helper);
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame.
   * @return {boolean} Ready.
   * @override
   */
  prepareFrameInternal(frameState) {
    const source = this.getLayer().getRenderSource();
    return !!source && source.getState() === 'ready';
  }

  /**
   * Build a GPU batch for a render tile that has at least one loaded source tile.
   * @param {import("../../VectorRenderTile.js").default} tile Render tile.
   * @param {import("../../tilecoord.js").TileCoord} tileCoord Tile coordinate.
   * @param {number} resolution View resolution used to evaluate styles.
   * @param {number} pixelRatio Device pixel ratio.
   * @return {TileBatch|null} Batch, or null if nothing is ready to draw.
   * @private
   */
  getBatch_(tile, tileCoord, resolution, pixelRatio) {
    const sourceTiles =
      typeof tile.getSourceTiles === 'function' ? tile.getSourceTiles() : [];
    const features = [];
    let hasLoaded = false;
    for (const sourceTile of sourceTiles) {
      if (sourceTile.getState() !== TileState.LOADED) {
        continue;
      }
      hasLoaded = true;
      const tileFeatures = sourceTile.getFeatures() ?? [];
      for (const feature of tileFeatures) {
        features.push(feature);
      }
    }
    if (!hasLoaded) {
      return null;
    }

    const dpr = pixelRatio > 0 ? pixelRatio : 1;
    const cacheKey = getTileCoordKey(tileCoord) + '/' + tile.key + '/' + dpr;
    const cacheable = tile.getState() === TileState.LOADED;
    if (cacheable && this.tileCache_.containsKey(cacheKey)) {
      return this.tileCache_.get(cacheKey);
    }
    const source = /** @type {import("../../source/VectorTile.js").default} */ (
      this.getLayer().getRenderSource()
    );
    const projection = source.getProjection();
    const tileGrid = projection
      ? source.getTileGridForProjection(projection)
      : source.getTileGrid();
    const coord = tile.wrappedTileCoord || tileCoord;
    const clipExtent = tileGrid
      ? tileGrid.getTileCoordExtent(coord)
      : undefined;
    const batch = {
      key: cacheKey,
      buffers: buildVectorBuffers(
        features,
        this.styleFunction_,
        resolution,
        this.atlas_,
        clipExtent ? {clipExtent} : undefined,
        dpr,
      ),
    };
    if (cacheable) {
      this.tileCache_.set(cacheKey, batch);
    }
    return batch;
  }

  /**
   * Look up cached parent or child tiles covering `tileCoord` at `altZ`.
   * Does not enqueue or create tiles — only uses what is already in
   * `renderTiles_`.
   *
   * @param {import("../../tilegrid/TileGrid.js").default} tileGrid Tile grid.
   * @param {import("../../tilecoord.js").TileCoord} tileCoord Current-Z tile that is not ready.
   * @param {number} altZ Alternate zoom to search.
   * @param {import("../../source/Tile.js").default} source Tile source.
   * @param {string} sourceKey Source revision key.
   * @param {number} resolution View resolution.
   * @param {number} pixelRatio Device pixel ratio.
   * @param {Set<string>} added Render keys already queued for drawing.
   * @return {{covered: boolean, items: Array<{renderKey: string, batch: TileBatch}>}}
   * Coverage and batches to draw if committed.
   * @private
   */
  findAltTiles_(
    tileGrid,
    tileCoord,
    altZ,
    source,
    sourceKey,
    resolution,
    pixelRatio,
    added,
  ) {
    const altRange = tileGrid.getTileRangeForTileCoordAndZ(
      tileCoord,
      altZ,
      this.altTileRange_,
    );
    if (!altRange) {
      return {covered: false, items: []};
    }
    /** @type {Array<{renderKey: string, batch: TileBatch}>} */
    const items = [];
    let covered = true;
    for (let x = altRange.minX; x <= altRange.maxX; ++x) {
      for (let y = altRange.minY; y <= altRange.maxY; ++y) {
        const renderKey = getCacheKey(source, sourceKey, altZ, x, y);
        if (added.has(renderKey)) {
          continue;
        }
        if (!this.renderTiles_.containsKey(renderKey)) {
          covered = false;
          continue;
        }
        const tile = this.renderTiles_.get(renderKey);
        if (tile.getState() === TileState.EMPTY) {
          covered = false;
          continue;
        }
        const batch = this.getBatch_(
          tile,
          tile.tileCoord,
          resolution,
          pixelRatio,
        );
        if (!batch) {
          covered = false;
          continue;
        }
        items.push({renderKey, batch});
      }
    }
    return {covered, items};
  }

  /**
   * @param {Array<{renderKey: string, batch: TileBatch}>} items Alt batches.
   * @param {Set<string>} added Render keys already queued.
   * @param {Array<TileBatch>} batches Batches to draw.
   * @private
   */
  commitAltTiles_(items, added, batches) {
    for (const item of items) {
      if (added.has(item.renderKey)) {
        continue;
      }
      added.add(item.renderKey);
      batches.push(item.batch);
    }
  }

  /**
   * @param {import("../../Map.js").FrameState} frameState Frame.
   * @return {Array<TileBatch>} Batches.
   * @private
   */
  collectBatches_(frameState) {
    const layer = this.getLayer();
    const source = /** @type {import("../../source/VectorTile.js").default} */ (
      layer.getRenderSource()
    );
    const viewState = frameState.viewState;
    const tileGrid = source.getTileGridForProjection(viewState.projection);
    const z = tileGrid.getZForResolution(
      viewState.resolution,
      source.zDirection,
    );
    const extent = frameState.extent;
    if (!extent) {
      return [];
    }
    const tileRange = tileGrid.getTileRangeForExtentAndZ(
      extent,
      z,
      this.tempTileRange_,
    );
    const tileSourceKey = getUid(source);
    if (!(tileSourceKey in frameState.wantedTiles)) {
      frameState.wantedTiles[tileSourceKey] = {};
    }
    const wantedTiles = frameState.wantedTiles[tileSourceKey];
    /** @type {Array<TileBatch>} */
    const batches = [];
    /** @type {Set<string>} */
    const added = new Set();
    /** @type {Array<import("../../tilecoord.js").TileCoord>} */
    const holes = [];

    const sourceKey = source.getKey();
    for (let x = tileRange.minX; x <= tileRange.maxX; ++x) {
      for (let y = tileRange.minY; y <= tileRange.maxY; ++y) {
        const tileCoord = createTileCoord(z, x, y, this.tempTileCoord_);
        const renderKey = getCacheKey(source, sourceKey, z, x, y);
        let tile;
        if (this.renderTiles_.containsKey(renderKey)) {
          tile = this.renderTiles_.get(renderKey);
        } else {
          tile = source.getTile(
            z,
            x,
            y,
            frameState.pixelRatio,
            viewState.projection,
          );
          if (tile) {
            this.renderTiles_.set(renderKey, tile);
          }
        }
        if (!tile || tile.getState() === TileState.EMPTY) {
          continue;
        }
        const tileQueueKey = tile.getKey();
        wantedTiles[tileQueueKey] = true;
        if (tile.getState() === TileState.IDLE) {
          if (!frameState.tileQueue.isKeyQueued(tileQueueKey)) {
            frameState.tileQueue.enqueue([
              tile,
              tileSourceKey,
              tileGrid.getTileCoordCenter(tileCoord),
              tileGrid.getResolution(z),
            ]);
          }
        }
        const batch = this.getBatch_(
          tile,
          tile.tileCoord,
          viewState.resolution,
          frameState.pixelRatio,
        );
        if (batch) {
          added.add(renderKey);
          batches.push(batch);
          continue;
        }
        holes.push([z, x, y]);
      }
    }

    const minZoom = tileGrid.getMinZoom();
    for (const hole of holes) {
      const children = this.findAltTiles_(
        tileGrid,
        hole,
        hole[0] + 1,
        source,
        sourceKey,
        viewState.resolution,
        frameState.pixelRatio,
        added,
      );
      if (children.covered) {
        this.commitAltTiles_(children.items, added, batches);
        continue;
      }
      let usedParent = false;
      for (let parentZ = hole[0] - 1; parentZ >= minZoom; --parentZ) {
        const parents = this.findAltTiles_(
          tileGrid,
          hole,
          parentZ,
          source,
          sourceKey,
          viewState.resolution,
          frameState.pixelRatio,
          added,
        );
        if (parents.covered) {
          this.commitAltTiles_(parents.items, added, batches);
          usedParent = true;
          break;
        }
      }
      if (!usedParent) {
        this.commitAltTiles_(children.items, added, batches);
      }
    }

    this.renderTiles_.highWaterMark = Math.max(
      this.renderTiles_.highWaterMark,
      Object.keys(wantedTiles).length * 2,
    );
    this.renderTiles_.expireCache();
    this.tileCache_.expireCache();
    return batches;
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
    this.scratch_.destroy();
    const batches = this.collectBatches_(frameState);
    this.renderedBatches_ = batches;
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
    if (this.frameUniformBuffer_) {
      for (const batch of batches) {
        drawFills(
          helper,
          this.frameUniformBuffer_,
          batch.buffers,
          this.scratch_,
        );
        drawStrokes(
          helper,
          this.frameUniformBuffer_,
          batch.buffers,
          this.scratch_,
        );
      }
    }
    if (
      !this.declutterGroup_ &&
      this.frameUniformBuffer_ &&
      this.cornerBuffer_
    ) {
      const merged = mergeLabelBuffers(batches.map((batch) => batch.buffers));
      this.mergedLabelsBuffers_ = merged;
      this.visibility_ = new Array(merged.labels.length).fill(true);
      if (
        drawSymbolsAndText(
          helper,
          this.frameUniformBuffer_,
          merged,
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
    if (
      !helper ||
      !this.declutterGroup_ ||
      !this.frameUniformBuffer_ ||
      !this.cornerBuffer_
    ) {
      return;
    }
    const merged = mergeLabelBuffers(
      this.renderedBatches_.map((batch) => batch.buffers),
    );
    this.mergedLabelsBuffers_ = merged;
    const pixelRatio = frameState.pixelRatio;
    const screenLabels = labelsToScreen(merged, frameState);
    const resolution = frameState.viewState.resolution;
    const stickyIds = stickyIdsForView(
      this.declutterResolution_,
      resolution,
      this.declutterStickyIds_,
    );
    this.visibility_ = resolveDeclutter(
      screenLabels,
      8,
      frameState.size[0] * pixelRatio,
      frameState.size[1] * pixelRatio,
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
        merged,
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
    if (!this.hitDetectionEnabled_ || !this.mergedLabelsBuffers_) {
      return undefined;
    }
    const buffers = this.mergedLabelsBuffers_;
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
      const anchor = extra._anchor;
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
        const glyph = buffers.glyphs[label.glyphStart || 0];
        let feature = glyph
          ? buffers.featuresByRef[
              decodeHitColor([glyph.hitR, glyph.hitG, glyph.hitB, 1])
            ]
          : undefined;
        if (!feature && extra.symbolIndex !== undefined) {
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
    for (const batch of this.renderedBatches_) {
      for (const feature of Object.values(batch.buffers.featuresByRef)) {
        const geometry = feature.getGeometry();
        if (geometry && geometry.containsXY?.(coordinate[0], coordinate[1])) {
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
    }
    return undefined;
  }

  /**
   * @override
   */
  clearCache() {
    this.renderTiles_.clear();
    this.tileCache_.clear();
  }

  /**
   * @override
   */
  disposeInternal() {
    this.scratch_.destroy();
    super.disposeInternal();
  }
}

export default WebGPUVectorTileLayerRenderer;
