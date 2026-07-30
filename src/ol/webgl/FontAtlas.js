/**
 * @module ol/webgl/FontAtlas
 */
import {createCanvasContext2D} from '../dom.js';
import {registerFont} from '../render/canvas.js';

/**
 * @typedef {Object} GlyphMetrics
 * @property {number} u0 Atlas UV left
 * @property {number} v0 Atlas UV bottom (WebGL)
 * @property {number} u1 Atlas UV right
 * @property {number} v1 Atlas UV top (WebGL)
 * @property {number} width Glyph bitmap width in CSS pixels
 * @property {number} height Glyph bitmap height in CSS pixels
 * @property {number} bearingX Horizontal bearing (left of cell to glyph origin)
 * @property {number} bearingY Vertical bearing (top of cell to baseline)
 * @property {number} advance Horizontal advance in CSS pixels
 */

/**
 * @typedef {Object} GlyphStroke
 * @property {string} color Stroke color
 * @property {number} width Stroke width
 */

const PADDING = 2;
const DEFAULT_ATLAS_SIZE = 512;

/**
 * Growing shelf-packed font atlas for WebGL glyph billboards.
 * Glyphs are rasterized with canvas (alpha) and uploaded as an RGBA texture.
 */
class FontAtlas {
  /**
   * @param {number} [size] Initial atlas edge length in pixels
   */
  constructor(size) {
    /**
     * @private
     * @type {number}
     */
    this.size_ = size || DEFAULT_ATLAS_SIZE;

    /**
     * @private
     * @type {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D}
     */
    this.context_ = createCanvasContext2D(this.size_, this.size_);
    this.context_.clearRect(0, 0, this.size_, this.size_);

    /**
     * @type {HTMLCanvasElement|OffscreenCanvas}
     */
    this.canvas = this.context_.canvas;

    /**
     * @private
     * @type {Map<string, GlyphMetrics>}
     */
    this.glyphs_ = new Map();

    /**
     * @private
     * @type {number}
     */
    this.shelfX_ = PADDING;

    /**
     * @private
     * @type {number}
     */
    this.shelfY_ = PADDING;

    /**
     * @private
     * @type {number}
     */
    this.shelfHeight_ = 0;

    /**
     * @private
     * @type {boolean}
     */
    this.dirty_ = true;

    /**
     * Scratch canvas for measuring / rasterizing one glyph.
     * @private
     * @type {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D}
     */
    this.scratch_ = createCanvasContext2D(64, 64);
  }

  /**
   * @return {[number, number]} Atlas width and height
   */
  getSize() {
    return [this.size_, this.size_];
  }

  /**
   * @return {ImageData} Full atlas pixels for GPU upload
   */
  getImageData() {
    return this.context_.getImageData(0, 0, this.size_, this.size_);
  }

  /**
   * @return {boolean} Whether the atlas texture needs re-upload
   */
  isDirty() {
    return this.dirty_;
  }

  /**
   * Mark the atlas clean after GPU upload.
   */
  markClean() {
    this.dirty_ = false;
  }

  /**
   * @param {string} font CSS font
   * @param {string} ch Single grapheme / character
   * @param {GlyphStroke} [stroke] Optional stroke baked into the glyph
   * @return {GlyphMetrics} Glyph metrics and UVs
   */
  getGlyph(font, ch, stroke) {
    const key = glyphKey(font, ch, stroke);
    const existing = this.glyphs_.get(key);
    if (existing) {
      return existing;
    }
    return this.rasterize_(font, ch, stroke, key);
  }

  /**
   * @param {string} font CSS font
   * @param {string} text Text to measure
   * @param {Object<string, number>} [cache] Optional width cache
   * @return {number} Text width in CSS pixels
   */
  measureWidth(font, text, cache) {
    if (cache && text in cache) {
      return cache[text];
    }
    registerFont(font);
    const ctx = this.scratch_;
    ctx.font = font;
    const width = ctx.measureText(text).width;
    if (cache) {
      cache[text] = width;
    }
    return width;
  }

  /**
   * @param {string} font CSS font
   * @param {string} ch Character
   * @param {GlyphStroke|undefined} stroke Stroke
   * @param {string} key Cache key
   * @return {GlyphMetrics} Metrics
   * @private
   */
  rasterize_(font, ch, stroke, key) {
    registerFont(font);
    const scratch = this.scratch_;
    scratch.font = font;
    const metrics = scratch.measureText(ch);
    const ascent = Math.ceil(
      metrics.actualBoundingBoxAscent || metrics.fontBoundingBoxAscent || 12,
    );
    const descent = Math.ceil(
      metrics.actualBoundingBoxDescent || metrics.fontBoundingBoxDescent || 4,
    );
    const advance = metrics.width;
    const strokePad = stroke ? Math.ceil(stroke.width) : 0;
    const width = Math.max(1, Math.ceil(advance) + strokePad * 2 + PADDING * 2);
    const height = Math.max(1, ascent + descent + strokePad * 2 + PADDING * 2);

    if (scratch.canvas.width < width || scratch.canvas.height < height) {
      scratch.canvas.width = width;
      scratch.canvas.height = height;
    } else {
      scratch.clearRect(0, 0, scratch.canvas.width, scratch.canvas.height);
    }
    scratch.font = font;
    scratch.textBaseline = 'alphabetic';
    scratch.textAlign = 'left';
    const x = strokePad + PADDING;
    const y = ascent + strokePad + PADDING;
    if (stroke) {
      // White stroke into the alpha mask; tinting happens in the shader.
      scratch.strokeStyle = '#fff';
      scratch.lineWidth = stroke.width;
      scratch.lineJoin = 'round';
      scratch.miterLimit = 2;
      scratch.strokeText(ch, x, y);
    }
    scratch.fillStyle = '#fff';
    scratch.fillText(ch, x, y);

    const packed = this.pack_(scratch.canvas, width, height);
    const size = this.size_;
    /** @type {GlyphMetrics} */
    const glyph = {
      u0: packed.x / size,
      // With default UNPACK_FLIP_Y_WEBGL=false, canvas y=0 uploads to v=0.
      // Billboard local_y=-1 (screen top) samples v0; local_y=1 samples v1.
      v0: packed.y / size,
      u1: (packed.x + width) / size,
      v1: (packed.y + height) / size,
      width,
      height,
      bearingX: strokePad + PADDING,
      bearingY: ascent + strokePad + PADDING,
      advance,
    };
    this.glyphs_.set(key, glyph);
    this.dirty_ = true;
    return glyph;
  }

  /**
   * @param {CanvasImageSource} source Glyph image
   * @param {number} width Width
   * @param {number} height Height
   * @return {{x: number, y: number}} Top-left in atlas
   * @private
   */
  pack_(source, width, height) {
    if (this.shelfX_ + width + PADDING > this.size_) {
      this.shelfX_ = PADDING;
      this.shelfY_ += this.shelfHeight_ + PADDING;
      this.shelfHeight_ = 0;
    }
    if (this.shelfY_ + height + PADDING > this.size_) {
      this.grow_();
      return this.pack_(source, width, height);
    }
    const x = this.shelfX_;
    const y = this.shelfY_;
    this.context_.drawImage(source, 0, 0, width, height, x, y, width, height);
    this.shelfX_ += width + PADDING;
    this.shelfHeight_ = Math.max(this.shelfHeight_, height);
    return {x, y};
  }

  /**
   * Double atlas size and re-pack all glyphs.
   * @private
   */
  grow_() {
    const oldCanvas = this.canvas;
    const oldSize = this.size_;
    const glyphs = Array.from(this.glyphs_.entries());
    this.size_ *= 2;
    this.context_ = createCanvasContext2D(this.size_, this.size_);
    this.canvas = this.context_.canvas;
    this.glyphs_.clear();
    this.shelfX_ = PADDING;
    this.shelfY_ = PADDING;
    this.shelfHeight_ = 0;
    // Preserve previous pixels then re-key glyphs by re-rasterizing
    // (UVs change after grow; simplest is rebuild from keys).
    void oldCanvas;
    void oldSize;
    for (const [key] of glyphs) {
      const parts = parseGlyphKey(key);
      this.getGlyph(parts.font, parts.ch, parts.stroke);
    }
  }
}

/**
 * @param {string} font Font
 * @param {string} ch Character
 * @param {GlyphStroke} [stroke] Stroke
 * @return {string} Key
 */
function glyphKey(font, ch, stroke) {
  if (!stroke) {
    return `${font}\0${ch}`;
  }
  return `${font}\0${ch}\0${stroke.color}\0${stroke.width}`;
}

/**
 * @param {string} key Key
 * @return {{font: string, ch: string, stroke: GlyphStroke|undefined}} Parts
 */
function parseGlyphKey(key) {
  const parts = key.split('\0');
  if (parts.length >= 4) {
    return {
      font: parts[0],
      ch: parts[1],
      stroke: {color: parts[2], width: Number(parts[3])},
    };
  }
  return {font: parts[0], ch: parts[1], stroke: undefined};
}

export default FontAtlas;
