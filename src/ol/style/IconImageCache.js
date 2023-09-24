/**
 * @module ol/style/IconImageCache
 */
import ImageState from '../ImageState.js';
import RegularShape from './RegularShape.js';
import {getSharedCanvasContext2D} from '../dom.js';

/**
 * @classdesc
 * Singleton class. Available through {@link module:ol/style/IconImageCache.shared}.
 */
class IconImageCache {
  constructor() {
    /**
     * @type {!Object<string, import("./IconImage.js").default | import("./RegularShape.js").default>}
     * @private
     */
    this.cache_ = {};

    /**
     * @type {!Object<string, CanvasPattern>}
     * @private
     */
    this.patternCache_ = {};

    /**
     * @type {number}
     * @private
     */
    this.cacheSize_ = 0;

    /**
     * @type {number}
     * @private
     */
    this.maxCacheSize_ = 128;
  }

  /**
   * Remove all cached items
   */
  clear() {
    this.cache_ = {};
    this.patternCache_ = {};
    this.cacheSize_ = 0;
  }

  /**
   * @return {boolean} Can expire cache.
   */
  canExpireCache() {
    return this.cacheSize_ > this.maxCacheSize_;
  }

  /**
   * Evict some cached items
   */
  expire() {
    if (!this.canExpireCache()) {
      return;
    }
    let i = 0;
    for (const key in this.cache_) {
      const icon = this.cache_[key];
      if (
        (i++ & 3) === 0 &&
        (icon instanceof RegularShape || !icon.hasListener())
      ) {
        delete this.cache_[key];
        delete this.patternCache_[key];
        --this.cacheSize_;
      }
    }
  }

  /**
   * @param {string} key Key.
   * @return {import("./IconImage.js").default | RegularShape} Icon image.
   */
  get(key) {
    return key in this.cache_ ? this.cache_[key] : null;
  }

  /**
   * @param {string} src Src.
   * @param {?string} crossOrigin Cross origin.
   * @param {string|null} color Color.
   * @return {CanvasPattern} Icon image.
   */
  getPattern(src, crossOrigin, color) {
    const key = getIconKey(src, crossOrigin, color);
    return key in this.patternCache_ ? this.patternCache_[key] : null;
  }

  /**
   * @param {string} src Src.
   * @param {?string} crossOrigin Cross origin.
   * @param {string|null} color Color.
   * @param {import("./IconImage.js").default|null} iconImage Icon image.
   * @param {boolean} [pattern] Also cache a `'repeat'` pattern with this `iconImage`.
   */
  set(src, crossOrigin, color, iconImage, pattern) {
    const key = getIconKey(src, crossOrigin, color);
    const update = key in this.cache_;
    this.cache_[key] = iconImage;
    if (pattern) {
      if (iconImage.getImageState() === ImageState.IDLE) {
        iconImage.load();
      }
      if (iconImage.getImageState() === ImageState.LOADING) {
        iconImage.ready().then(() => {
          this.patternCache_[key] = getSharedCanvasContext2D().createPattern(
            iconImage.getImage(1),
            'repeat',
          );
        });
      } else {
        this.patternCache_[key] = getSharedCanvasContext2D().createPattern(
          iconImage.getImage(1),
          'repeat',
        );
      }
    }
    if (!update) {
      ++this.cacheSize_;
    }
  }

  /**
   * Set the cache size of the icon cache. Default is `128`.Change this value when
   * your map uses more than the default number of icons images or RegularShapes
   * and you are not caching these on the application level.
   * @param {number} maxCacheSize Cache max size.
   * @api
   */
  setSize(maxCacheSize) {
    this.maxCacheSize_ = maxCacheSize;
    this.expire();
  }
}

/**
 * @param {string} src Src.
 * @param {string|null} crossOrigin Cross origin.
 * @param {string|null} color Color.
 * @return {string} Cache key.
 */
export function getIconKey(src, crossOrigin, color) {
  return src + ':' + crossOrigin + ':' + color;
}

export default IconImageCache;

/**
 * The {@link module:ol/style/IconImageCache~IconImageCache} for
 * {@link module:ol/style/Icon~Icon} images.
 * @api
 */
export const shared = new IconImageCache();
