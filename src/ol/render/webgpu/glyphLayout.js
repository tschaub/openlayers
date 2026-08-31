/**
 * @module ol/render/webgpu/glyphLayout
 */
import {asArray} from '../../color.js';
import {lineStringLength} from '../../geom/flat/length.js';
import {drawTextOnPath} from '../../geom/flat/textpath.js';
import {measureAndCacheTextWidth} from '../canvas.js';
import {TEXT_ALIGN} from '../canvas/TextBuilder.js';

/**
 * Instance floats: position(2), offsetPx(2), sizePx(2), texCoord(4), fill(4),
 * stroke(4), hitColor(4), angle(1). Corner is a separate vertex buffer of 4 corners.
 * Per-instance stride without corner: 23 floats.
 * @type {number}
 */
export const GLYPH_INSTANCE_STRIDE = 23;

/** @type {Object<string, number>} */
const widthCache = {};

/**
 * @typedef {Object} GlyphInstance
 * @property {number} x Anchor x.
 * @property {number} y Anchor y.
 * @property {number} offsetX Pixel offset x.
 * @property {number} offsetY Pixel offset y.
 * @property {number} width Glyph width.
 * @property {number} height Glyph height.
 * @property {number} u0 Tex.
 * @property {number} v0 Tex.
 * @property {number} u1 Tex.
 * @property {number} v1 Tex.
 * @property {number} r Fill color.
 * @property {number} g Fill color.
 * @property {number} b Fill color.
 * @property {number} a Fill color.
 * @property {number} strokeR Stroke color.
 * @property {number} strokeG Stroke color.
 * @property {number} strokeB Stroke color.
 * @property {number} strokeA Stroke color.
 * @property {number} hitR Hit.
 * @property {number} hitG Hit.
 * @property {number} hitB Hit.
 * @property {number} hitA Hit.
 * @property {number} angle Angle.
 */

/**
 * @param {string|Array<string>} text Text.
 * @return {string} Normalized.
 */
function normalizeText(text) {
  if (Array.isArray(text)) {
    return text.join('\n');
  }
  return text || '';
}

/**
 * @param {string|Array<number>|undefined} color Color.
 * @param {Array<number>} fallback RGBA 0-1.
 * @return {Array<number>} RGBA 0-1.
 */
function toRgba(color, fallback) {
  if (!color || (typeof color === 'object' && !Array.isArray(color))) {
    return fallback;
  }
  const array = asArray(/** @type {string|Array<number>} */ (color));
  return [array[0] / 255, array[1] / 255, array[2] / 255, array[3] ?? 1];
}

/**
 * @param {import("../../style/Text.js").default} textStyle Style.
 * @return {Array<number>} RGBA 0-1.
 */
function fillColor(textStyle) {
  const fill = textStyle.getFill();
  const color = fill ? fill.getColor() : '#333';
  return toRgba(
    /** @type {string|Array<number>|undefined} */ (color),
    [0.2, 0.2, 0.2, 1],
  );
}

/**
 * @param {import("../../style/Text.js").default} textStyle Style.
 * @return {Array<number>} RGBA 0-1. Transparent if there is no stroke.
 */
function strokeColor(textStyle) {
  const stroke = textStyle.getStroke();
  if (!stroke) {
    return [0, 0, 0, 0];
  }
  return toRgba(
    /** @type {string|Array<number>|undefined} */ (stroke.getColor()),
    [0, 0, 0, 1],
  );
}

/**
 * Layout a point (or polygon-interior) label.
 *
 * @param {Array<GlyphInstance>} out Instances.
 * @param {import("../../style/Text.js").default} textStyle Style.
 * @param {import("../../coordinate.js").Coordinate} anchor Anchor.
 * @param {import("../../webgpu/FontAtlas.js").default} atlas Atlas.
 * @param {Array<number>} hitColor Hit color 0-1.
 * @param {number} [pixelRatio] Device pixel ratio for glyph rasterization.
 * @return {{minX: number, minY: number, maxX: number, maxY: number}|null} Pixel AABB around the anchor, or null.
 */
export function layoutPointLabel(
  out,
  textStyle,
  anchor,
  atlas,
  hitColor,
  pixelRatio = 1,
) {
  const text = normalizeText(textStyle.getText() || '');
  if (!text) {
    return null;
  }
  const font = textStyle.getFont() || '10px sans-serif';
  const lines = text.split('\n');
  const scale = textStyle.getScaleArray?.() || [1, 1];
  const scaleX = Array.isArray(scale) ? scale[0] : 1;
  const scaleY = Array.isArray(scale) ? scale[1] : 1;
  const alignKey = textStyle.getTextAlign() || 'center';
  const align = /** @type {number} */ (
    /** @type {any} */ (TEXT_ALIGN)[alignKey] ?? 0.5
  );
  const baselineKey = textStyle.getTextBaseline() || 'middle';
  const baseline = /** @type {number} */ (
    /** @type {any} */ (TEXT_ALIGN)[baselineKey] ?? 0.5
  );
  const offsetX = textStyle.getOffsetX() || 0;
  const offsetY = textStyle.getOffsetY() || 0;
  const rotation = textStyle.getRotation() || 0;
  const stroke = textStyle.getStroke();
  const strokeWidth = stroke ? stroke.getWidth() || 0 : 0;
  const color = fillColor(textStyle);
  const halo = strokeColor(textStyle);

  const lineHeights = [];
  const lineAscent = [];
  const lineWidths = [];
  let totalHeight = 0;
  const lineGlyphs = [];
  const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
  for (const line of lines) {
    /** @type {Array<import("../../webgpu/FontAtlas.js").GlyphMetrics>} */
    const glyphs = [];
    let maxAscent = 0;
    let maxHeight = 0;
    for (const {segment} of segmenter.segment(line)) {
      const glyph = atlas.getGlyph(font, segment, strokeWidth, pixelRatio);
      glyphs.push(glyph);
      maxAscent = Math.max(maxAscent, glyph.ascent * scaleY);
      maxHeight = Math.max(maxHeight, glyph.height * scaleY);
    }
    if (!glyphs.length) {
      const sample = atlas.getGlyph(font, 'M', strokeWidth, pixelRatio);
      maxAscent = sample.ascent * scaleY;
      maxHeight = sample.height * scaleY;
    }
    lineGlyphs.push(glyphs);
    lineAscent.push(maxAscent);
    lineHeights.push(maxHeight);
    const width = measureAndCacheTextWidth(font, line, widthCache) * scaleX;
    lineWidths.push(width);
    totalHeight += maxHeight;
  }

  let y = -totalHeight * baseline + offsetY;
  const start = out.length;
  for (let i = 0; i < lines.length; ++i) {
    let x = -lineWidths[i] * align + offsetX;
    const glyphs = lineGlyphs[i];
    const maxAscent = lineAscent[i];
    for (const glyph of glyphs) {
      const w = glyph.width * scaleX;
      const h = glyph.height * scaleY;
      out.push({
        x: anchor[0],
        y: anchor[1],
        offsetX: x,
        offsetY: y + maxAscent - glyph.ascent * scaleY,
        width: w,
        height: h,
        u0: glyph.u0,
        v0: glyph.v0,
        u1: glyph.u1,
        v1: glyph.v1,
        r: color[0],
        g: color[1],
        b: color[2],
        a: color[3],
        strokeR: halo[0],
        strokeG: halo[1],
        strokeB: halo[2],
        strokeA: halo[3],
        hitR: hitColor[0],
        hitG: hitColor[1],
        hitB: hitColor[2],
        hitA: hitColor[3],
        angle: rotation,
      });
      x += glyph.advance * scaleX;
    }
    y += lineHeights[i];
  }
  if (out.length === start) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = start; i < out.length; ++i) {
    const glyph = out[i];
    minX = Math.min(minX, glyph.offsetX);
    minY = Math.min(minY, glyph.offsetY);
    maxX = Math.max(maxX, glyph.offsetX + glyph.width);
    maxY = Math.max(maxY, glyph.offsetY + glyph.height);
  }
  const padding = textStyle.getPadding() || [0, 0, 0, 0];
  return {
    minX: minX - padding[3],
    minY: minY - padding[0],
    maxX: maxX + padding[1],
    maxY: maxY + padding[2],
  };
}

/**
 * Layout text along a linestring. Coordinates are already in pixels along the path helper.
 *
 * @param {Array<GlyphInstance>} out Instances.
 * @param {import("../../style/Text.js").default} textStyle Style.
 * @param {Array<number>} flatCoords Flat path in map units.
 * @param {number} resolution Resolution.
 * @param {import("../../webgpu/FontAtlas.js").default} atlas Atlas.
 * @param {Array<number>} hitColor Hit color.
 * @param {number} [pixelRatio] Device pixel ratio for glyph rasterization.
 * @return {{minX: number, minY: number, maxX: number, maxY: number}|null} Union AABB in pixels relative to...
 *     For line labels the AABB is in screen space after layout; we store it in pixel space around (0,0)
 *     by converting each glyph box. Callers should use glyph screen boxes.
 */
export function layoutLineLabel(
  out,
  textStyle,
  flatCoords,
  resolution,
  atlas,
  hitColor,
  pixelRatio = 1,
) {
  const text = normalizeText(textStyle.getText() || '');
  if (!text) {
    return null;
  }
  const font = textStyle.getFont() || '10px sans-serif';
  const pixelCoords = new Array(flatCoords.length);
  for (let i = 0; i < flatCoords.length; i += 2) {
    pixelCoords[i] = flatCoords[i] / resolution;
    pixelCoords[i + 1] = -flatCoords[i + 1] / resolution;
  }
  const length = lineStringLength(pixelCoords, 0, pixelCoords.length, 2);
  const width = measureAndCacheTextWidth(font, text, widthCache);
  const startM = (length - width) / 2;
  const maxAngle = textStyle.getMaxAngle
    ? textStyle.getMaxAngle()
    : Math.PI / 4;
  const overflow = textStyle.getOverflow ? textStyle.getOverflow() : false;
  if (!overflow && width > length) {
    return null;
  }
  const result = drawTextOnPath(
    pixelCoords,
    0,
    pixelCoords.length,
    2,
    text,
    startM,
    maxAngle,
    1,
    measureAndCacheTextWidth,
    font,
    widthCache,
    0,
    true,
  );
  if (!result) {
    return null;
  }
  const stroke = textStyle.getStroke();
  const strokeWidth = stroke ? stroke.getWidth() || 0 : 0;
  const color = fillColor(textStyle);
  const halo = strokeColor(textStyle);
  const startIndex = out.length;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const entry of result) {
    const gx = /** @type {number} */ (entry[0]);
    const gy = /** @type {number} */ (entry[1]);
    const angle = /** @type {number} */ (entry[3]);
    const chunk = /** @type {string} */ (entry[4]);
    const glyph = atlas.getGlyph(font, chunk, strokeWidth, pixelRatio);
    const mapX = gx * resolution;
    const mapY = -gy * resolution;
    out.push({
      x: mapX,
      y: mapY,
      offsetX: 0,
      offsetY: -glyph.ascent,
      width: glyph.width,
      height: glyph.height,
      u0: glyph.u0,
      v0: glyph.v0,
      u1: glyph.u1,
      v1: glyph.v1,
      r: color[0],
      g: color[1],
      b: color[2],
      a: color[3],
      strokeR: halo[0],
      strokeG: halo[1],
      strokeB: halo[2],
      strokeA: halo[3],
      hitR: hitColor[0],
      hitG: hitColor[1],
      hitB: hitColor[2],
      hitA: hitColor[3],
      angle,
    });
    minX = Math.min(minX, gx);
    minY = Math.min(minY, gy - glyph.ascent);
    maxX = Math.max(maxX, gx + glyph.width);
    maxY = Math.max(maxY, gy - glyph.ascent + glyph.height);
  }
  if (out.length === startIndex) {
    return null;
  }
  const padding = textStyle.getPadding() || [0, 0, 0, 0];
  return {
    minX: minX - padding[3],
    minY: minY - padding[0],
    maxX: maxX + padding[1],
    maxY: maxY + padding[2],
  };
}

/**
 * Pack glyph instances into a float array (without per-vertex corners).
 * @param {Array<GlyphInstance>} instances Instances.
 * @param {Array<number>} [opacities] Per-instance fade in `[0, 1]`.
 * @return {Float32Array} Packed instances.
 */
export function packGlyphInstances(instances, opacities) {
  const data = new Float32Array(instances.length * GLYPH_INSTANCE_STRIDE);
  let o = 0;
  for (let i = 0; i < instances.length; ++i) {
    const inst = instances[i];
    const fade = opacities ? opacities[i] : 1;
    data[o++] = inst.x;
    data[o++] = inst.y;
    data[o++] = inst.offsetX;
    data[o++] = inst.offsetY;
    data[o++] = inst.width;
    data[o++] = inst.height;
    data[o++] = inst.u0;
    data[o++] = inst.v0;
    data[o++] = inst.u1;
    data[o++] = inst.v1;
    data[o++] = inst.r;
    data[o++] = inst.g;
    data[o++] = inst.b;
    data[o++] = inst.a * fade;
    data[o++] = inst.strokeR;
    data[o++] = inst.strokeG;
    data[o++] = inst.strokeB;
    data[o++] = inst.strokeA * fade;
    data[o++] = inst.hitR;
    data[o++] = inst.hitG;
    data[o++] = inst.hitB;
    data[o++] = inst.hitA;
    data[o++] = inst.angle;
  }
  return data;
}
