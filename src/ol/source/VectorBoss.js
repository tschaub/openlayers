/**
 * @module ol/source/VectorBoss
 */

import GeoJSON from '../format/GeoJSON.js';
import Source from './Source.js';
import {MessageClient, channels} from '../messages.js';
import {create as createVectorLoader} from '../worker/vector-loader.js';

/**
 * @typedef {Object} Options
 * @property {string} url The URL.
 */

/**
 * @typedef {import("../worker/vector-loader.js").LoaderRequest} LoaderRequest
 */

/**
 * @typedef {import("../worker/vector-loader.js").LoaderResponse} LoaderResponse
 */

class VectorBoss extends Source {
  /**
   * @param {Options} options Source options.
   */
  constructor(options) {
    super({});

    /**
     * @private
     * @type {MessageClient<LoaderRequest, LoaderResponse>}
     */
    this.messageClient_ = new MessageClient({
      channel: channels.VECTOR_LOADER,
      worker: createVectorLoader(),
    });

    /**
     * @private
     * @type {string}
     */
    this.url_ = options.url;

    this.format_ = new GeoJSON();

    /**
     * @private
     * @type {Array<import('../Feature.js').default>}
     */
    this.features_ = [];

    /**
     * @private
     * @type {boolean}
     */
    this.loadFeaturesCalled_ = false;
  }

  /**
   * @param {import("../extent.js").Extent} extent Extent.
   * @param {number} resolution Resolution.
   * @param {import("../proj/Projection.js").default} projection Projection.
   */
  async loadFeatures(extent, resolution, projection) {
    if (this.loadFeaturesCalled_) {
      return;
    }
    this.loadFeaturesCalled_ = true;

    const collection = await this.messageClient_.send({
      request: {
        type: 'loadFeatures',
        url: this.url_,
      },
    });
    this.features_ = this.format_.readFeatures(collection, {
      featureProjection: projection,
    });

    this.changed();
  }

  /**
   * @param {import("../extent.js").Extent} extent Extent.
   * @param {import("../proj/Projection.js").default} [projection] Include features
   * where `extent` exceeds the x-axis bounds of `projection` and wraps around the world.
   * @return {Array<import("../Feature.js").default>} Features.
   */
  getFeaturesInExtent(extent, projection) {
    return this.features_;
  }

  /**
   * @return {boolean} The source can have overlapping geometries.
   */
  getOverlaps() {
    return true;
  }
}

export default VectorBoss;
