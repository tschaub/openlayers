/**
 * @module ol/webgpu/FontAtlas
 */
import {createCanvasContext2D} from '../dom.js';
import {measureAndCacheTextWidth} from '../render/canvas.js';

/**
 * @typedef {Object} GlyphMetrics
 * @property {number} u0 Left tex coord.
 * @property {number} v0 Top tex coord.
 * @property {number} u1 Right tex coord.
 * @property {number} v1 Bottom tex coord.
 * @property {number} width Width in pixels.
 * @property {number} height Height in pixels.
 * @property {number} ascent Distance from the top of the packed cell to the alphabetic baseline.
 * @property {number} advance Advance width.
 */

/**
 * @param {string} font CSS font.
 * @param {number} pixelRatio Device pixel ratio.
 * @return {string} Font with px/pt sizes scaled for rasterization.
 */
function scaleFont(font, pixelRatio) {
  if (pixelRatio === 1) {
    return font;
  }
  return font.replace(
    /([\d.]+)(px|pt)/g,
    (_, value, unit) => `${Number(value) * pixelRatio}${unit}`,
  );
}

/**
 * @classdesc
 * Shelf-packed alpha font atlas rasterized with Canvas 2D.
 */
class FontAtlas {
  constructor() {
    /**
     * @private
     * @type {number}
     */
    this.size_ = 512;

    /**
     * @private
     * @type {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D}
     */
    this.context_ = createCanvasContext2D(this.size_, this.size_, undefined, {
      alpha: true,
    });
    this.context_.clearRect(0, 0, this.size_, this.size_);
    // White fill / black stroke: the glyph shader mixes by luminance.
    this.context_.fillStyle = '#fff';
    this.context_.strokeStyle = '#000';

    /**
     * @private
     * @type {number}
     */
    this.shelfY_ = 1;

    /**
     * @private
     * @type {number}
     */
    this.shelfX_ = 1;

    /**
     * @private
     * @type {number}
     */
    this.shelfHeight_ = 0;

    /**
     * @private
     * @type {Object<string, GlyphMetrics>}
     */
    this.glyphs_ = {};

    /**
     * @private
     * @type {Object<string, number>}
     */
    this.widthCache_ = {};

    /**
     * @private
     * @type {boolean}
     */
    this.dirty_ = true;

    /**
     * @type {GPUTexture|null}
     */
    this.texture = null;
  }

  /**
   * @param {string} font Font (CSS pixels).
   * @param {string} glyph Grapheme.
   * @param {number} [strokeWidth] Stroke width in CSS pixels.
   * @param {number} [pixelRatio] Device pixel ratio for rasterization.
   * @return {GlyphMetrics} Metrics in CSS pixels; UVs refer to the hi-res atlas.
   */
  getGlyph(font, glyph, strokeWidth = 0, pixelRatio = 1) {
    const dpr = pixelRatio > 0 ? pixelRatio : 1;
    const key = font + '\n' + glyph + '\n' + strokeWidth + '\n' + dpr;
    if (key in this.glyphs_) {
      return this.glyphs_[key];
    }
    const scaledFont = scaleFont(font, dpr);
    this.context_.font = scaledFont;
    const metrics = this.context_.measureText(glyph);
    const width = Math.ceil(metrics.width || 0);
    const ascent = Math.ceil(metrics.actualBoundingBoxAscent || 12 * dpr);
    const descent = Math.ceil(metrics.actualBoundingBoxDescent || 4 * dpr);
    const height = ascent + descent;
    const pad = Math.ceil(strokeWidth * dpr) + 1;
    const w = width + pad * 2;
    const h = height + pad * 2;

    if (this.shelfX_ + w + 1 > this.size_) {
      this.shelfY_ += this.shelfHeight_ + 1;
      this.shelfX_ = 1;
      this.shelfHeight_ = 0;
    }
    if (this.shelfY_ + h + 1 > this.size_) {
      this.grow_();
    }

    const x = this.shelfX_;
    const y = this.shelfY_;
    this.context_.save();
    this.context_.font = scaledFont;
    this.context_.fillStyle = '#fff';
    this.context_.strokeStyle = '#000';
    this.context_.textBaseline = 'alphabetic';
    this.context_.lineJoin = 'round';
    if (strokeWidth > 0) {
      this.context_.lineWidth = strokeWidth * dpr;
      this.context_.strokeText(glyph, x + pad, y + pad + ascent);
    }
    this.context_.fillText(glyph, x + pad, y + pad + ascent);
    this.context_.restore();

    this.shelfX_ += w + 1;
    this.shelfHeight_ = Math.max(this.shelfHeight_, h);
    this.dirty_ = true;

    const record = {
      u0: x / this.size_,
      v0: y / this.size_,
      u1: (x + w) / this.size_,
      v1: (y + h) / this.size_,
      width: w / dpr,
      height: h / dpr,
      ascent: (pad + ascent) / dpr,
      advance: measureAndCacheTextWidth(font, glyph, this.widthCache_),
    };
    this.glyphs_[key] = record;
    return record;
  }

  /**
   * @private
   */
  grow_() {
    const next = this.size_ * 2;
    const nextContext = createCanvasContext2D(next, next, undefined, {
      alpha: true,
    });
    nextContext.clearRect(0, 0, next, next);
    nextContext.drawImage(this.context_.canvas, 0, 0);
    nextContext.fillStyle = '#fff';
    nextContext.strokeStyle = '#000';
    this.context_ = nextContext;
    this.size_ = next;
    this.dirty_ = true;
    for (const key in this.glyphs_) {
      const glyph = this.glyphs_[key];
      glyph.u0 *= 0.5;
      glyph.v0 *= 0.5;
      glyph.u1 *= 0.5;
      glyph.v1 *= 0.5;
    }
  }

  /**
   * @param {import("./Helper.js").default} helper Helper.
   * @return {GPUTexture} Atlas texture.
   */
  upload(helper) {
    if (!this.texture || this.dirty_) {
      if (this.texture) {
        this.texture.destroy();
      }
      const canvas = this.context_.canvas;
      const imageData = this.context_.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      );
      this.texture = helper.createTextureFromRgba(
        imageData.data,
        canvas.width,
        canvas.height,
      );
      this.dirty_ = false;
    }
    return this.texture;
  }

  /**
   * @return {HTMLCanvasElement|OffscreenCanvas} Canvas.
   */
  getCanvas() {
    return this.context_.canvas;
  }
}

export default FontAtlas;
