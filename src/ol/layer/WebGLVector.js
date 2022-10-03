/**
 * @module ol/layer/WebGLVector
 */
import Layer from './Layer.js';
import Renderer from '../renderer/webgl/VectorLayer.js';
import {packColor} from '../renderer/webgl/shaders.js';

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
 * @property {import("../source/BinaryVector.js").default} [source] The data source.
 */

/**
 * @extends {Layer<import("../source/BinaryVector.js").default, Renderer>}
 * @fires import("../render/Event.js").RenderEvent
 */
class WebGLVectorLayer extends Layer {
  /**
   * @param {Options} options Options.
   */
  constructor(options) {
    const baseOptions = Object.assign({}, options);

    super(baseOptions);
  }

  createRenderer() {
    return new Renderer(this, {
      point: {
        attributes: {
          color: () => packColor([255, 0, 0, 1]),
        },
      },
    });
  }
}

export default WebGLVectorLayer;
