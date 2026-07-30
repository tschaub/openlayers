/**
 * @module ol/render/webgl/glyphBuffers
 */
import {transform2D} from '../../geom/flat/transform.js';
import {
  GLYPH_INSTANCE_STRIDE,
  layoutLineLabel,
  layoutPointLabel,
  polygonLabelAnchor,
} from './glyphLayout.js';

/**
 * Build a glyph instance attribute buffer for all text styles on a geometry batch.
 *
 * @param {import('./MixedGeometryBatch.js').default} batch Geometry batch (source CRS; may be densified)
 * @param {import('../../style/Style.js').StyleFunction} styleFunction Style function (text-only styles ok)
 * @param {import('../../transform.js').Transform} transform Coordinate transform applied to anchors
 * @param {import('./glyphLayout.js').LayoutContext} layoutContext Atlas + resolution (+ optional projectToTarget)
 * @return {Float32Array} Instance attributes
 */
export function generateGlyphInstanceAttributes(
  batch,
  styleFunction,
  transform,
  layoutContext,
) {
  /** @type {Array<number>} */
  const floats = [];

  const pointBatch = batch.pointBatch;
  for (const uid in pointBatch.entries) {
    const entry = pointBatch.entries[uid];
    const styles = evaluateStyles(
      styleFunction,
      entry.feature,
      layoutContext.resolution,
    );
    for (let s = 0; s < styles.length; ++s) {
      const textStyle = styles[s]?.getText?.();
      if (!textStyle || textStyle.getPlacement() === 'line') {
        continue;
      }
      for (let i = 0; i < entry.flatCoordss.length; ++i) {
        const coords = entry.flatCoordss[i];
        const anchor = transformAnchor(coords[0], coords[1], transform);
        layoutPointLabel(floats, textStyle, anchor, layoutContext);
      }
    }
  }

  const lineBatch = batch.lineStringBatch;
  for (const uid in lineBatch.entries) {
    const entry = lineBatch.entries[uid];
    const styles = evaluateStyles(
      styleFunction,
      entry.feature,
      layoutContext.resolution,
    );
    for (let s = 0; s < styles.length; ++s) {
      const textStyle = styles[s]?.getText?.();
      if (!textStyle) {
        continue;
      }
      const placement = textStyle.getPlacement() || 'point';
      for (let i = 0; i < entry.flatCoordss.length; ++i) {
        const coords = entry.flatCoordss[i];
        if (placement === 'line') {
          const before = floats.length;
          layoutLineLabel(floats, textStyle, coords, 3, layoutContext);
          transformInstancePositions(floats, before, transform);
        } else {
          // Midpoint label on the line
          const mid = pathMidpoint(coords, 3);
          if (mid) {
            layoutPointLabel(
              floats,
              textStyle,
              transformAnchor(mid[0], mid[1], transform),
              layoutContext,
            );
          }
        }
      }
    }
  }

  const polygonBatch = batch.polygonBatch;
  for (const uid in polygonBatch.entries) {
    const entry = polygonBatch.entries[uid];
    const styles = evaluateStyles(
      styleFunction,
      entry.feature,
      layoutContext.resolution,
    );
    for (let s = 0; s < styles.length; ++s) {
      const textStyle = styles[s]?.getText?.();
      if (!textStyle) {
        continue;
      }
      const placement = textStyle.getPlacement() || 'point';
      for (let i = 0; i < entry.flatCoordss.length; ++i) {
        const flat = entry.flatCoordss[i];
        const ringCounts = entry.ringsVerticesCounts?.[i];
        if (!ringCounts) {
          continue;
        }
        /** @type {Array<number>} */
        const ends = [];
        let acc = 0;
        for (let r = 0; r < ringCounts.length; ++r) {
          acc += ringCounts[r] * 2;
          ends.push(acc);
        }
        if (placement === 'line') {
          // Outer ring as path (stride 2)
          const outerEnd = ringCounts[0] * 2;
          const ring = flat.slice(0, outerEnd);
          const before = floats.length;
          layoutLineLabel(floats, textStyle, ring, 2, layoutContext);
          transformInstancePositions(floats, before, transform);
        } else {
          const anchor = polygonLabelAnchor(flat, ends);
          if (anchor) {
            layoutPointLabel(
              floats,
              textStyle,
              transformAnchor(anchor[0], anchor[1], transform),
              layoutContext,
            );
          }
        }
      }
    }
  }

  return new Float32Array(floats);
}

/**
 * Shared local-position quad and indices for glyph billboards (same as symbols).
 * @return {{indices: Uint32Array, vertexAttributes: Float32Array}} Shared mesh
 */
export function createGlyphQuadMesh() {
  return {
    indices: Uint32Array.from([0, 1, 3, 1, 2, 3]),
    vertexAttributes: Float32Array.from([-1, -1, 1, -1, 1, 1, -1, 1]),
  };
}

export {GLYPH_INSTANCE_STRIDE};

/**
 * @param {import('../../style/Style.js').StyleFunction} styleFunction Style fn
 * @param {import('../../Feature.js').FeatureLike} feature Feature
 * @param {number} resolution Resolution
 * @return {Array<import('../../style/Style.js').default>} Style array
 */
function evaluateStyles(styleFunction, feature, resolution) {
  let styles;
  try {
    styles = styleFunction(feature, resolution);
  } catch {
    // Missing text-value / expression failures: skip this feature's labels.
    return [];
  }
  if (!styles) {
    return [];
  }
  return Array.isArray(styles) ? styles : [styles];
}

/**
 * @param {number} x X
 * @param {number} y Y
 * @param {import('../../transform.js').Transform} transform Transform
 * @return {import('../../coordinate.js').Coordinate} Transformed
 */
function transformAnchor(x, y, transform) {
  const out = [x, y];
  transform2D(out, 0, 2, 2, transform, out);
  return out;
}

/**
 * Apply the render transform to glyph anchor positions (layout runs in
 * geometry CRS / world space so path lengths stay in map units).
 * @param {Array<number>} floats Instance attribute buffer
 * @param {number} start Start index in floats
 * @param {import('../../transform.js').Transform} transform Transform
 */
function transformInstancePositions(floats, start, transform) {
  for (let i = start; i < floats.length; i += GLYPH_INSTANCE_STRIDE) {
    const p = [floats[i], floats[i + 1]];
    transform2D(p, 0, 2, 2, transform, p);
    floats[i] = p[0];
    floats[i + 1] = p[1];
  }
}

/**
 * @param {Array<number>} flat Flat coords
 * @param {number} stride Stride
 * @return {import('../../coordinate.js').Coordinate|null} Midpoint
 */
function pathMidpoint(flat, stride) {
  if (flat.length < stride * 2) {
    return null;
  }
  let length = 0;
  for (let i = stride; i < flat.length; i += stride) {
    const dx = flat[i] - flat[i - stride];
    const dy = flat[i + 1] - flat[i - stride + 1];
    length += Math.sqrt(dx * dx + dy * dy);
  }
  const half = length / 2;
  let walked = 0;
  for (let i = stride; i < flat.length; i += stride) {
    const x1 = flat[i - stride];
    const y1 = flat[i - stride + 1];
    const x2 = flat[i];
    const y2 = flat[i + 1];
    const seg = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
    if (walked + seg >= half) {
      const t = seg === 0 ? 0 : (half - walked) / seg;
      return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
    }
    walked += seg;
  }
  return [flat[flat.length - stride], flat[flat.length - stride + 1]];
}
