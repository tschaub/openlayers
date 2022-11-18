/**
 * @module ol/layer/Field
 */
import BaseTileLayer from './BaseTile.js';
import LayerProperty from '../layer/Property.js';
import WebGLFieldLayerRenderer from '../renderer/webgl/FieldLayer.js';

/**
 * @typedef {import("../source/DataTile.js").default} SourceType
 */

/**
 * @typedef {Object} Options
 * @property {string} [className='ol-layer'] A CSS class name to set to the layer element.
 * @property {number} [opacity=1] Opacity (0, 1).
 * @property {boolean} [visible=true] Visibility.
 * @property {import("../extent.js").Extent} [extent] The bounding extent for layer rendering.  The layer will not be
 * rendered outside of this extent.
 * @property {number} [zIndex] The z-index for layer rendering.  At rendering time, the layers
 * will be ordered, first by Z-index and then by position. When `undefined`, a `zIndex` of 0 is assumed
 * for layers that are added to the map's `layers` collection, or `Infinity` when the layer's `setMap()`
 * method was used.
 * @property {number} [minResolution] The minimum resolution (inclusive) at which this layer will be
 * visible.
 * @property {number} [maxResolution] The maximum resolution (exclusive) below which this layer will
 * be visible.
 * @property {number} [minZoom] The minimum view zoom level (exclusive) above which this layer will be
 * visible.
 * @property {number} [maxZoom] The maximum view zoom level (inclusive) at which this layer will
 * be visible.
 * @property {number} [preload=0] Preload. Load low-resolution tiles up to `preload` levels. `0`
 * means no preloading.
 * @property {SourceType} [source] Source for this layer.
 * @property {import("../Map.js").default} [map] Sets the layer as overlay on a map. The map will not manage
 * this layer in its layers collection, and the layer will be rendered on top. This is useful for
 * temporary layers. The standard way to add a layer to a map and have it managed by the map is to
 * use {@link module:ol/Map~Map#addLayer}.
 * @property {boolean} [useInterimTilesOnError=true] Use interim tiles on error.
 * @property {number} [cacheSize=512] The internal texture cache size.  This needs to be large enough to render
 * two zoom levels worth of tiles.
 */

const tileVertexShader = `
 attribute vec2 a_textureCoord;
 uniform mat4 u_tileTransform;
 uniform float u_texturePixelWidth;
 uniform float u_texturePixelHeight;
 uniform float u_textureResolution;
 uniform float u_textureOriginX;
 uniform float u_textureOriginY;
 uniform float u_depth;

 varying vec2 v_textureCoord;
 varying vec2 v_mapCoord;

 void main() {
   v_textureCoord = a_textureCoord;
   v_mapCoord = vec2(
     u_textureOriginX + u_textureResolution * u_texturePixelWidth * v_textureCoord[0],
     u_textureOriginY - u_textureResolution * u_texturePixelHeight * v_textureCoord[1]
   );
   gl_Position = u_tileTransform * vec4(a_textureCoord, u_depth, 1.0);
 }
`;

const tileFragmentShader = `
 #ifdef GL_FRAGMENT_PRECISION_HIGH
 precision highp float;
 #else
 precision mediump float;
 #endif

 varying vec2 v_textureCoord;
 varying vec2 v_mapCoord;
 uniform vec4 u_renderExtent;
 uniform float u_transitionAlpha;
 uniform float u_texturePixelWidth;
 uniform float u_texturePixelHeight;
 uniform float u_resolution;
 uniform float u_zoom;

 uniform sampler2D u_tileTextures[1];

 void main() {
   if (
     v_mapCoord[0] < u_renderExtent[0] ||
     v_mapCoord[1] < u_renderExtent[1] ||
     v_mapCoord[0] > u_renderExtent[2] ||
     v_mapCoord[1] > u_renderExtent[3]
   ) {
     discard;
   }

   vec4 color = texture2D(u_tileTextures[0],  v_textureCoord);

   gl_FragColor = color;
   gl_FragColor.rgb *= gl_FragColor.a;
 }
`;

/**
 * @type {Array<SourceType>}
 */
const sources = [];

/**
 * @classdesc
 * Renders vector fields.
 *
 * @extends BaseTileLayer<SourceType, WebGLFieldLayerRenderer>
 * @fires import("../render/Event.js").RenderEvent
 * @api
 */
class FieldLayer extends BaseTileLayer {
  /**
   * @param {Options} options Tile layer options.
   */
  constructor(options) {
    options = options ? Object.assign({}, options) : {};

    const cacheSize = options.cacheSize;
    delete options.cacheSize;

    super(options);

    /**
     * @type {number}
     * @private
     */
    this.cacheSize_ = cacheSize;

    this.addChangeListener(LayerProperty.SOURCE, this.handleSourceUpdate_);
  }

  /**
   * @private
   */
  handleSourceUpdate_() {
    if (this.hasRenderer()) {
      this.getRenderer().clearCache();
    }
  }

  /**
   * Gets the sources for this layer, for a given extent and resolution.
   * @param {import("../extent.js").Extent} extent Extent.
   * @param {number} resolution Resolution.
   * @return {Array<SourceType>} Sources.
   */
  getSources(extent, resolution) {
    const source = this.getSource();
    sources[0] = source;
    return sources;
  }

  createRenderer() {
    return new WebGLFieldLayerRenderer(this, {
      tileFragmentShader,
      tileVertexShader,
      cacheSize: this.cacheSize_,
    });
  }
}

/**
 * Clean up underlying WebGL resources.
 * @function
 * @api
 */
FieldLayer.prototype.dispose;

export default FieldLayer;
