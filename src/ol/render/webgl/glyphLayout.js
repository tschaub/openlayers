/**
 * @module ol/render/webgl/glyphLayout
 */
/**
 * Layout helpers that expand Text styles into GPU glyph billboard instances.
 * Anchors stay in the geometry CRS (source CRS under reprojection); the vertex
 * shader warps them with sourceToTarget.
 */
import {asArray} from '../../color.js';
import {getInteriorPointOfArray} from '../../geom/flat/interiorpoint.js';
import {lineStringLength} from '../../geom/flat/length.js';
import {drawTextOnPath} from '../../geom/flat/textpath.js';
import {TEXT_ALIGN} from '../canvas/TextBuilder.js';

/**
 * Floats per glyph instance:
 * position(2), offsetPx(2), sizePx(2), texCoord(4), color(4), angle(1)
 * @type {number}
 */
export const GLYPH_INSTANCE_STRIDE = 15;

/**
 * @typedef {Object} GlyphStrokeOptions
 * @property {string} color Stroke color CSS
 * @property {number} width Stroke width
 */

/**
 * @typedef {Object} LayoutContext
 * @property {import('../../webgl/FontAtlas.js').default} atlas Font atlas
 * @property {number} resolution View resolution (map units per pixel)
 * @property {number} [pixelRatio] Device pixel ratio (default 1)
 * @property {number} [viewRotation] View rotation in radians (for rotate-with-view)
 * @property {function(import('../../coordinate.js').Coordinate): (import('../../coordinate.js').Coordinate|null)|undefined} [projectToTarget]
 *     Optional exact forward projection for baking line label angles under reprojection
 */

/**
 * Append glyph instances for a point/polygon label at an anchor.
 *
 * @param {Array<number>} out Destination float array (appended)
 * @param {import('../../style/Text.js').default} textStyle Text style
 * @param {import('../../coordinate.js').Coordinate} anchor Anchor in geometry CRS
 * @param {LayoutContext} context Layout context
 */
export function layoutPointLabel(out, textStyle, anchor, context) {
  const text = normalizeText(textStyle.getText());
  if (!text) {
    return;
  }
  const font = textStyle.getFont() || '10px sans-serif';
  const scaleArr = textStyle.getScaleArray() || [1, 1];
  const scaleX = scaleArr[0];
  const scaleY = scaleArr[1];
  const offsetX = textStyle.getOffsetX() || 0;
  const offsetY = textStyle.getOffsetY() || 0;
  const rotation = textStyle.getRotation() || 0;
  const rotateWithView = textStyle.getRotateWithView();
  const viewRotation = rotateWithView ? context.viewRotation || 0 : 0;
  const angle = rotation + viewRotation;
  const textAlign = textStyle.getTextAlign() || 'center';
  const textBaseline = textStyle.getTextBaseline() || 'middle';
  const fillColor = colorFromTextStyle(textStyle);
  const strokeStyle = textStyle.getStroke();
  const stroke = strokeStyle ? strokeFromStyle(strokeStyle) : undefined;

  const lines = text.split('\n');
  const lineWidths = lines.map(
    (line) => context.atlas.measureWidth(font, line) * scaleX,
  );
  const sampleGlyph = context.atlas.getGlyph(font, 'M', stroke);
  const lineHeight = sampleGlyph.height * scaleY;
  const totalHeight = lineHeight * lines.length;

  const alignX =
    /** @type {Object<string, number>} */ (TEXT_ALIGN)[textAlign] ?? 0.5;
  const alignY =
    /** @type {Object<string, number>} */ (TEXT_ALIGN)[textBaseline] ?? 0.5;

  let yCursor = -totalHeight * alignY + lineHeight * 0.5;
  for (let li = 0; li < lines.length; ++li) {
    const line = lines[li];
    const lineWidth = lineWidths[li];
    let xCursor = -lineWidth * alignX;
    for (const ch of graphemes(line)) {
      const glyph = context.atlas.getGlyph(font, ch, stroke);
      const gw = glyph.width * scaleX;
      const gh = glyph.height * scaleY;
      const cx = xCursor + gw * 0.5 + offsetX;
      const cy = yCursor + offsetY;
      pushInstance(
        out,
        anchor[0],
        anchor[1],
        cx,
        cy,
        gw,
        gh,
        glyph,
        fillColor,
        angle,
      );
      xCursor += glyph.advance * scaleX;
    }
    yCursor += lineHeight;
  }
}

/**
 * Append glyph instances for line placement along a flat path.
 *
 * @param {Array<number>} out Destination
 * @param {import('../../style/Text.js').default} textStyle Text style
 * @param {Array<number>} flatCoords Flat path coordinates
 * @param {number} stride Coordinate stride
 * @param {LayoutContext} context Layout context
 */
export function layoutLineLabel(out, textStyle, flatCoords, stride, context) {
  const text = normalizeText(textStyle.getText());
  if (!text || flatCoords.length < stride * 2) {
    return;
  }
  const font = textStyle.getFont() || '10px sans-serif';
  const scaleArr = textStyle.getScaleArray() || [1, 1];
  const scale = scaleArr[0];
  const maxAngle = textStyle.getMaxAngle();
  const overflow = textStyle.getOverflow();
  const fillColor = colorFromTextStyle(textStyle);
  const lineStroke = textStyle.getStroke();
  const stroke = lineStroke ? strokeFromStyle(lineStroke) : undefined;
  const repeat = textStyle.getRepeat();
  const offsetY = textStyle.getOffsetY() || 0;
  const keepUpright = textStyle.getKeepUpright();
  const resolution = context.resolution || 1;

  // Work in pixel space so drawTextOnPath matches canvas semantics.
  /** @type {Array<number>} */
  const pixelCoords = new Array(flatCoords.length);
  for (let i = 0; i < flatCoords.length; i += stride) {
    pixelCoords[i] = flatCoords[i] / resolution;
    pixelCoords[i + 1] = flatCoords[i + 1] / resolution;
    for (let s = 2; s < stride; ++s) {
      pixelCoords[i + s] = flatCoords[i + s];
    }
  }

  /** @type {Object<string, number>} */
  const widthCache = {};
  /**
   * @param {string} f Font
   * @param {string} t Text
   * @param {Object<string, number>} cache Width cache
   * @return {number} Width
   */
  const measure = (f, t, cache) => context.atlas.measureWidth(f, t, cache);

  const pathLengthPx = lineStringLength(
    pixelCoords,
    0,
    pixelCoords.length,
    stride,
  );
  const textWidthPx = measure(font, text, widthCache) * scale;
  if (!overflow && textWidthPx > pathLengthPx) {
    return;
  }

  const starts = [];
  if (repeat && repeat > 0) {
    for (let m = repeat / 2; m < pathLengthPx; m += repeat) {
      starts.push(m - textWidthPx / 2);
    }
  } else {
    starts.push((pathLengthPx - textWidthPx) / 2);
  }

  for (let s = 0; s < starts.length; ++s) {
    const startM = Math.max(0, starts[s]);
    const chunks = drawTextOnPath(
      pixelCoords,
      0,
      pixelCoords.length,
      stride,
      text,
      startM,
      maxAngle,
      scale,
      measure,
      font,
      widthCache,
      0,
      keepUpright !== false,
    );
    if (!chunks) {
      continue;
    }
    for (let i = 0; i < chunks.length; ++i) {
      const [px, py, , angle, chunk] = chunks[i];
      const x = /** @type {number} */ (px) * resolution;
      const y = /** @type {number} */ (py) * resolution;
      let viewAngle = /** @type {number} */ (angle);
      if (context.projectToTarget) {
        const len = Math.max(resolution, 1e-6);
        const dx = Math.cos(viewAngle) * len;
        const dy = Math.sin(viewAngle) * len;
        const a = context.projectToTarget([x, y]);
        const b = context.projectToTarget([x + dx, y + dy]);
        if (a && b) {
          viewAngle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        }
      }
      let xCursor = -measure(font, chunk, widthCache) * scale * 0.5;
      for (const ch of graphemes(/** @type {string} */ (chunk))) {
        const glyph = context.atlas.getGlyph(font, ch, stroke);
        const gw = glyph.width * scale;
        const gh = glyph.height * scale;
        const localX = xCursor + gw * 0.5;
        const localY = offsetY;
        pushInstance(
          out,
          x,
          y,
          localX,
          localY,
          gw,
          gh,
          glyph,
          fillColor,
          viewAngle,
        );
        xCursor += glyph.advance * scale;
      }
    }
  }
}

/**
 * Compute a polygon interior point for labeling.
 *
 * @param {Array<number>} flatCoords Flat polygon rings
 * @param {Array<number>} ringEnds End offsets of each ring
 * @return {import('../../coordinate.js').Coordinate|null} Interior point
 */
export function polygonLabelAnchor(flatCoords, ringEnds) {
  if (!ringEnds.length || flatCoords.length < 6) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ringEnds[0]; i += 2) {
    const x = flatCoords[i];
    const y = flatCoords[i + 1];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const flatCenters = [(minX + maxX) / 2, (minY + maxY) / 2];
  const interior = getInteriorPointOfArray(
    flatCoords,
    0,
    ringEnds,
    2,
    flatCenters,
    0,
  );
  if (!interior) {
    return null;
  }
  return [interior[0], interior[1]];
}

/**
 * @param {Array<number>} out Out
 * @param {number} ax Anchor x
 * @param {number} ay Anchor y
 * @param {number} ox Offset x px
 * @param {number} oy Offset y px
 * @param {number} w Width px
 * @param {number} h Height px
 * @param {import('../../webgl/FontAtlas.js').GlyphMetrics} glyph Glyph
 * @param {Array<number>} color RGBA 0-1
 * @param {number} angle Radians
 */
function pushInstance(out, ax, ay, ox, oy, w, h, glyph, color, angle) {
  out.push(
    ax,
    ay,
    ox,
    oy,
    w,
    h,
    glyph.u0,
    glyph.v0,
    glyph.u1,
    glyph.v1,
    color[0],
    color[1],
    color[2],
    color[3],
    angle,
  );
}

/**
 * @param {string|Array<string>|undefined} text Text
 * @return {string} Normalized plain text
 */
function normalizeText(text) {
  if (!text) {
    return '';
  }
  if (Array.isArray(text)) {
    // Rich text tuples: take text parts only
    let s = '';
    for (let i = 0; i < text.length; i += 2) {
      s += text[i] || '';
    }
    return s;
  }
  return text;
}

/**
 * Prefer explicit fill color; fall back to stroke color when fill is absent.
 * @param {import('../../style/Text.js').default} textStyle Text style
 * @return {Array<number>} RGBA 0-1
 */
function colorFromTextStyle(textStyle) {
  const fill = textStyle.getFill();
  if (fill) {
    const color = fill.getColor();
    if (color) {
      const arr = asArray(/** @type {*} */ (color));
      return [arr[0] / 255, arr[1] / 255, arr[2] / 255, arr[3]];
    }
  }
  const stroke = textStyle.getStroke();
  if (stroke) {
    const color = stroke.getColor();
    if (color) {
      const arr = asArray(/** @type {*} */ (color));
      return [arr[0] / 255, arr[1] / 255, arr[2] / 255, arr[3]];
    }
  }
  return [0.2, 0.2, 0.2, 1];
}

/**
 * @param {import('../../style/Stroke.js').default|undefined} stroke Stroke
 * @return {GlyphStrokeOptions|undefined} Stroke options for atlas
 */
function strokeFromStyle(stroke) {
  if (!stroke) {
    return undefined;
  }
  const color = stroke.getColor();
  const width = stroke.getWidth() || 1;
  if (!color) {
    return undefined;
  }
  const arr = asArray(/** @type {*} */ (color));
  return {
    color: `rgba(${arr[0]},${arr[1]},${arr[2]},${arr[3]})`,
    width,
  };
}

/**
 * @param {string} text Text
 * @return {Iterable<string>} Graphemes
 */
function graphemes(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
    return Array.from(seg.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}
