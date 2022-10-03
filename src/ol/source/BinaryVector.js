/**
 * @module ol/source/BinaryVector
 */

import Source from './Source.js';

/**
 * @typedef {Object} Points
 * @property {Float32Array} coordinates The coordinate values.
 * @property {number} [stride=2] The number of values between each geometry.
 * @property {number} [offset=0] The start index for the first geometry.
 */

/**
 * @typedef {Object} Attributes
 * @property {Float32Array} values The attribute values.
 * @property {number} [stride=1] The number of values between each attribute.
 * @property {number} [offset=0] The start index for the first attribute.
 * @property {Object<number, any>} [lookup] Optional lookup mapping numeric attribute keys to values.
 */

/**
 * @typedef {Object} PointFeatures
 * @property {Points} geometries The point geometry data.
 * @property {Object<string, Attributes>} attributes The point feature attributes.
 */

/**
 * @typedef {Object} Data
 * @property {PointFeatures} [points] The point features.
 */

/**
 * @typedef {Object} Options
 * @property {Data} [data] The source data.
 */

/**
 * @classdesc
 * Provides a source of features for binary vector layers.
 */
class BinaryVectorSource extends Source {
  /**
   * @param {Options} [options] Source options.
   */
  constructor(options) {
    super({});

    options = options || {};

    /**
     * @type {Data}
     */
    const data = options.data || {};

    /**
     * @type {PointFeatures|null}
     */
    this.points_ = data.points || null;
  }

  /**
   * @return {PointFeatures|null} Point feature data.
   */
  getPoints() {
    return this.points_;
  }
}

export default BinaryVectorSource;
