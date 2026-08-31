/**
 * @module ol/layer/WebGPUTile
 */
import WebGPUTileLayerRenderer from '../renderer/webgpu/TileLayer.js';
import BaseTileLayer from './BaseTile.js';

/**
 * @typedef {import("../source/DataTile.js").default<import("../DataTile.js").default|import("../ImageTile.js").default>|import("../source/Tile.js").default} SourceType
 */

/**
 * @typedef {Object} Options
 * @property {string} [className='ol-layer'] A CSS class name to set to the layer element.
 * @property {number} [opacity=1] Opacity (0, 1).
 * @property {boolean} [visible=true] Visibility.
 * @property {import("../extent.js").Extent} [extent] The bounding extent for layer rendering.
 * @property {number} [zIndex] The z-index for layer rendering.
 * @property {number} [minResolution] The minimum resolution (inclusive) at which this layer will be visible.
 * @property {number} [maxResolution] The maximum resolution (exclusive) below which this layer will be visible.
 * @property {number} [minZoom] The minimum view zoom level (exclusive) above which this layer will be visible.
 * @property {number} [maxZoom] The maximum view zoom level (inclusive) at which this layer will be visible.
 * @property {number} [preload=0] Preload.
 * @property {SourceType} [source] Source.
 * @property {import("../Map.js").default} [map] Map overlay.
 * @property {number} [cacheSize=512] Texture cache size.
 * @property {import("../expr/wgsl.js").TileStyle} [style] Tile color style (expressions compiled to WGSL).
 * @property {Object<string, *>} [properties] Observable properties.
 */

/**
 * @classdesc
 * Layer for rendering raster tiles with WebGPU.
 *
 * **Important: a `WebGPUTile` layer must be manually disposed when removed.**
 *
 * WebGPU is required. There is no silent fallback to Canvas or WebGL.
 *
 * @extends {BaseTileLayer<SourceType, WebGPUTileLayerRenderer>}
 */
class WebGPUTileLayer extends BaseTileLayer {
  /**
   * @param {Options} [options] Options.
   */
  constructor(options) {
    options = options ? options : {};
    super(options);

    /**
     * @private
     * @type {import("../expr/wgsl.js").TileStyle|undefined}
     */
    this.style_ = options.style;
  }

  /**
   * @override
   */
  createRenderer() {
    return new WebGPUTileLayerRenderer(this, {
      cacheSize: this.getCacheSize(),
      style: this.style_,
    });
  }
}

export default WebGPUTileLayer;
