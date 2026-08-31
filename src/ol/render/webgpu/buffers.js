/**
 * @module ol/render/webgpu/buffers
 */
import {asArray} from '../../color.js';
import {clipFlatLineStrings} from '../../geom/flat/clip.js';
import {inflateEnds} from '../../geom/flat/orient.js';
import RenderFeature from '../../render/Feature.js';
import {getUid} from '../../util.js';
import {layoutLineLabel, layoutPointLabel} from './glyphLayout.js';
import {projectFlatCoordinates, tessellatePolygon} from './tessellate.js';

/**
 * @typedef {import("./tessellate.js").TessellateOptions} VectorReprojOptions
 */

/**
 * @param {number} id Feature ref.
 * @return {Array<number>} RGBA 0-1.
 */
export function encodeHitColor(id) {
  return [
    (id & 255) / 255,
    ((id >> 8) & 255) / 255,
    ((id >> 16) & 255) / 255,
    1,
  ];
}

/**
 * @param {Array<number>} color RGBA 0-1 (or 0-255 from readPixels).
 * @return {number} Id.
 */
export function decodeHitColor(color) {
  const r = color[0] > 1 ? color[0] : color[0] * 255;
  const g = color[1] > 1 ? color[1] : color[1] * 255;
  const b = color[2] > 1 ? color[2] : color[2] * 255;
  return (Math.round(r) | (Math.round(g) << 8) | (Math.round(b) << 16)) >>> 0;
}

/**
 * @param {import("../../color.js").Color|string|undefined} color Color.
 * @return {Array<number>} RGBA 0-1.
 */
function toRgba(color) {
  if (!color) {
    return [0, 0, 0, 0];
  }
  const array = asArray(color);
  return [array[0] / 255, array[1] / 255, array[2] / 255, array[3] ?? 1];
}

/**
 * @typedef {Object} VectorBuffers
 * @property {Float32Array} fillVertices Fill vertices.
 * @property {Uint32Array} fillIndices Fill indices.
 * @property {Float32Array} strokeVertices Stroke vertices.
 * @property {Uint32Array} strokeIndices Stroke indices.
 * @property {Float32Array} symbolInstances Symbol instances.
 * @property {Array<import("./glyphLayout.js").GlyphInstance>} glyphs Glyphs.
 * @property {Array<import("./declutter.js").Label>} labels Declutter labels.
 * @property {Object<number, import("../../Feature.js").FeatureLike>} featuresByRef Hit refs.
 */

/**
 * @param {Array<import("../../Feature.js").FeatureLike>} features Features.
 * @param {import("../../style/Style.js").StyleFunction} styleFunction Style function.
 * @param {number} resolution Resolution.
 * @param {import("../../webgpu/FontAtlas.js").default} atlas Atlas.
 * @param {VectorReprojOptions} [reproj] Reprojection options.
 * @param {number} [pixelRatio] Device pixel ratio for glyph rasterization.
 * @return {VectorBuffers} Buffers.
 */
export function buildVectorBuffers(
  features,
  styleFunction,
  resolution,
  atlas,
  reproj,
  pixelRatio = 1,
) {
  /** @type {Array<number>} */
  const fillVertices = [];
  /** @type {Array<number>} */
  const fillIndices = [];
  /** @type {Array<number>} */
  const strokeVertices = [];
  /** @type {Array<number>} */
  const strokeIndices = [];
  /** @type {Array<number>} */
  const symbolInstances = [];
  /** @type {Array<import("./glyphLayout.js").GlyphInstance>} */
  const glyphs = [];
  /** @type {Array<import("./declutter.js").Label>} */
  const labels = [];
  /** @type {Object<number, import("../../Feature.js").FeatureLike>} */
  const featuresByRef = {};

  let pairId = 1;
  let featureIndex = 0;
  const sorted = features.slice().sort((a, b) => {
    const idA = Number(getUid(a));
    const idB = Number(getUid(b));
    return idA - idB;
  });

  for (const feature of sorted) {
    const geometry = feature.getGeometry();
    if (!geometry) {
      continue;
    }
    const styles = styleFunction(feature, resolution);
    if (!styles) {
      continue;
    }
    const styleArray = Array.isArray(styles) ? styles : [styles];
    const ref = ++featureIndex;
    featuresByRef[ref] = feature;
    const hit = encodeHitColor(ref);
    const labelId = Number(getUid(feature));

    for (let s = 0; s < styleArray.length; ++s) {
      const style = styleArray[s];
      const zIndex = style.getZIndex() || 0;
      const geom = style.getGeometryFunction()(feature) || geometry;
      if (!geom) {
        continue;
      }
      const type = geom.getType();
      const fill = style.getFill();
      const stroke = style.getStroke();
      const image = style.getImage();
      const text = style.getText();

      if (fill && (type === 'Polygon' || type === 'MultiPolygon')) {
        appendFills(
          /** @type {any} */ (geom),
          fill,
          hit,
          fillVertices,
          fillIndices,
          reproj,
        );
      }
      if (stroke && type !== 'Point' && type !== 'MultiPoint') {
        appendStrokes(
          /** @type {any} */ (geom),
          stroke,
          hit,
          strokeVertices,
          strokeIndices,
          reproj,
        );
      }

      const placement = text?.getPlacement ? text.getPlacement() : 'point';
      const linePlacement =
        text &&
        placement === 'line' &&
        (type === 'LineString' || type === 'MultiLineString');
      const imageAnchors =
        image && (type === 'Point' || type === 'MultiPoint')
          ? getAnchors(/** @type {any} */ (geom), reproj)
          : [];
      const textAnchors =
        text && !linePlacement
          ? getAnchors(/** @type {any} */ (geom), reproj)
          : [];
      const maxAnchors = Math.max(imageAnchors.length, textAnchors.length);
      for (let a = 0; a < maxAnchors; ++a) {
        const pid = imageAnchors[a] && textAnchors[a] ? pairId++ : undefined;
        if (image && imageAnchors[a]) {
          const anchor = imageAnchors[a];
          const size = image.getSize() || [16, 16];
          const color = toRgba(
            /** @type {any} */ (image).getFill?.()?.getColor?.() || [
              255, 153, 0, 1,
            ],
          );
          const declutterMode = image.getDeclutterMode?.() || 'declutter';
          const scale = image.getScaleArray?.() || [1, 1];
          const symbolIndex = symbolInstances.length / 14;
          symbolInstances.push(
            anchor[0],
            anchor[1],
            0,
            0,
            size[0] * (Array.isArray(scale) ? scale[0] : 1),
            size[1] * (Array.isArray(scale) ? scale[1] : 1),
            color[0],
            color[1],
            color[2],
            color[3],
            hit[0],
            hit[1],
            hit[2],
            hit[3],
          );
          labels.push({
            minX: -size[0] / 2,
            minY: -size[1] / 2,
            maxX: size[0] / 2,
            maxY: size[1] / 2,
            priority: -zIndex,
            id: labelId,
            mode: declutterMode,
            pairId: pid,
            glyphStart: 0,
            glyphCount: 0,
            symbolIndex,
            _anchor: anchor,
          });
        }
        if (text && textAnchors[a]) {
          const start = glyphs.length;
          const box = layoutPointLabel(
            glyphs,
            text,
            textAnchors[a],
            atlas,
            hit,
            pixelRatio,
          );
          if (box) {
            const rawText = text.getText();
            labels.push({
              minX: box.minX,
              minY: box.minY,
              maxX: box.maxX,
              maxY: box.maxY,
              priority: -zIndex,
              id: labelId,
              mode: text.getDeclutterMode?.() || 'declutter',
              pairId: pid,
              padding: text.getPadding() || [0, 0, 0, 0],
              glyphStart: start,
              glyphCount: glyphs.length - start,
              text: Array.isArray(rawText) ? rawText.join('\n') : rawText || '',
              _anchor: textAnchors[a],
            });
          }
        }
      }
      if (linePlacement) {
        const start = glyphs.length;
        const box = layoutLineLabel(
          glyphs,
          text,
          /** @type {any} */ (geom).getFlatCoordinates(),
          resolution,
          atlas,
          hit,
          pixelRatio,
        );
        if (box) {
          labels.push({
            minX: box.minX,
            minY: box.minY,
            maxX: box.maxX,
            maxY: box.maxY,
            priority: -zIndex,
            id: labelId,
            mode: text.getDeclutterMode?.() || 'declutter',
            padding: text.getPadding() || [0, 0, 0, 0],
            glyphStart: start,
            glyphCount: glyphs.length - start,
          });
        }
      }
    }
  }

  return {
    fillVertices: new Float32Array(fillVertices),
    fillIndices: new Uint32Array(fillIndices),
    strokeVertices: new Float32Array(strokeVertices),
    strokeIndices: new Uint32Array(strokeIndices),
    symbolInstances: new Float32Array(symbolInstances),
    glyphs,
    labels,
    featuresByRef,
  };
}

/**
 * Concatenate per-tile glyph/label records for map-level declutter.
 *
 * `pairId` is unique only within a single `buildVectorBuffers` call. Reusing
 * the same ids across tiles would merge unrelated image+text pairs into one
 * AABB that spans the map and hide every other label.
 *
 * @param {Array<VectorBuffers>} buffersList Per-tile buffers.
 * @return {VectorBuffers} Merged labels/glyphs/symbols (empty fill/stroke).
 */
export function mergeLabelBuffers(buffersList) {
  /** @type {Array<import("./glyphLayout.js").GlyphInstance>} */
  const glyphs = [];
  /** @type {Array<import("./declutter.js").Label>} */
  const labels = [];
  /** @type {Array<number>} */
  const symbolInstances = [];
  /** @type {Object<number, import("../../Feature.js").FeatureLike>} */
  const featuresByRef = {};
  let pairOffset = 0;
  for (const buffers of buffersList) {
    const glyphOffset = glyphs.length;
    const symbolCount = symbolInstances.length / 14;
    let maxPair = 0;
    glyphs.push(...buffers.glyphs);
    symbolInstances.push(...buffers.symbolInstances);
    Object.assign(featuresByRef, buffers.featuresByRef);
    for (const label of buffers.labels) {
      const extra = /** @type {any} */ (label);
      if (extra.pairId !== undefined) {
        maxPair = Math.max(maxPair, extra.pairId);
      }
      labels.push({
        ...label,
        glyphStart: (label.glyphStart || 0) + glyphOffset,
        symbolIndex:
          extra.symbolIndex !== undefined
            ? extra.symbolIndex + symbolCount
            : extra.symbolIndex,
        pairId:
          extra.pairId !== undefined ? extra.pairId + pairOffset : extra.pairId,
      });
    }
    pairOffset += maxPair + 1;
  }
  return {
    fillVertices: new Float32Array(0),
    fillIndices: new Uint32Array(0),
    strokeVertices: new Float32Array(0),
    strokeIndices: new Uint32Array(0),
    symbolInstances: new Float32Array(symbolInstances),
    glyphs,
    labels,
    featuresByRef,
  };
}

/**
 * Point / RenderFeature-compatible coordinate.
 *
 * @param {import("../../geom/Geometry.js").default|import("../../render/Feature.js").default} geometry Geometry.
 * @return {import("../../coordinate.js").Coordinate} Coordinate.
 */
function pointCoordinate(geometry) {
  const withCoords = /** @type {any} */ (geometry);
  if (typeof withCoords.getCoordinates === 'function') {
    const coordinates = withCoords.getCoordinates();
    if (coordinates) {
      return coordinates;
    }
  }
  const flat = withCoords.getFlatCoordinates();
  return [flat[0], flat[1]];
}

/**
 * MultiPoint / RenderFeature-compatible coordinates.
 *
 * @param {import("../../geom/Geometry.js").default|import("../../render/Feature.js").default} geometry Geometry.
 * @return {Array<import("../../coordinate.js").Coordinate>} Coordinates.
 */
function multiPointCoordinates(geometry) {
  const withCoords = /** @type {any} */ (geometry);
  if (typeof withCoords.getCoordinates === 'function') {
    const coordinates = withCoords.getCoordinates();
    if (coordinates) {
      return coordinates;
    }
  }
  const flat = withCoords.getFlatCoordinates();
  const stride = withCoords.getStride?.() || 2;
  /** @type {Array<import("../../coordinate.js").Coordinate>} */
  const anchors = [];
  for (let i = 0; i < flat.length; i += stride) {
    anchors.push([flat[i], flat[i + 1]]);
  }
  return anchors;
}

/**
 * Polygon label/symbol anchor. RenderFeature has no `getInteriorPoint()`.
 *
 * @param {import("../../geom/Geometry.js").default|import("../../render/Feature.js").default} geometry Geometry.
 * @return {import("../../coordinate.js").Coordinate} Anchor.
 */
function polygonAnchor(geometry) {
  const withInterior = /** @type {any} */ (geometry);
  if (typeof withInterior.getInteriorPoint === 'function') {
    return withInterior.getInteriorPoint().getCoordinates().slice(0, 2);
  }
  if (typeof withInterior.getFlatInteriorPoint === 'function') {
    const interior = withInterior.getFlatInteriorPoint();
    return [interior[0], interior[1]];
  }
  const extent = geometry.getExtent();
  return [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2];
}

/**
 * @param {import("../../geom/Geometry.js").default} geometry Geometry.
 * @param {VectorReprojOptions} [reproj] Reprojection.
 * @return {Array<import("../../coordinate.js").Coordinate>} Anchors.
 */
function getAnchors(geometry, reproj) {
  const type = geometry.getType();
  /** @type {Array<import("../../coordinate.js").Coordinate>} */
  let anchors;
  if (type === 'Point') {
    anchors = [pointCoordinate(geometry)];
  } else if (type === 'MultiPoint') {
    anchors = multiPointCoordinates(geometry);
  } else if (type === 'Polygon') {
    anchors = [polygonAnchor(geometry)];
  } else {
    const extent = geometry.getExtent();
    anchors = [[(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2]];
  }
  const projectToTarget = reproj?.projectToTarget;
  if (!projectToTarget) {
    return anchors;
  }
  /** @type {Array<import("../../coordinate.js").Coordinate>} */
  const projected = [];
  for (const anchor of anchors) {
    const p = projectToTarget(anchor);
    if (p && isFinite(p[0]) && isFinite(p[1])) {
      projected.push(p);
    }
  }
  return projected;
}

/**
 * @param {import("../../geom/Geometry.js").default} geometry Geometry.
 * @param {import("../../style/Fill.js").default} fill Fill.
 * @param {Array<number>} hit Hit color.
 * @param {Array<number>} vertices Vertices.
 * @param {Array<number>} indices Indices.
 * @param {VectorReprojOptions} [reproj] Reprojection.
 */
function appendFills(geometry, fill, hit, vertices, indices, reproj) {
  const color = toRgba(/** @type {string|Array<number>} */ (fill.getColor()));
  const type = geometry.getType();
  if (type === 'Polygon') {
    appendPolygon(
      /** @type {import("../../geom/Polygon.js").default} */ (geometry),
      color,
      hit,
      vertices,
      indices,
      reproj,
    );
  } else if (type === 'MultiPolygon') {
    const polygons =
      /** @type {import("../../geom/MultiPolygon.js").default} */ (
        geometry
      ).getPolygons();
    for (const polygon of polygons) {
      appendPolygon(polygon, color, hit, vertices, indices, reproj);
    }
  }
}

/**
 * Split MVT Polygon rings by winding before earcut (same as the WebGL path).
 *
 * @param {import("../../geom/Polygon.js").default|import("../../render/Feature.js").default} polygon Polygon.
 * @param {Array<number>} color Color.
 * @param {Array<number>} hit Hit.
 * @param {Array<number>} vertices Vertices.
 * @param {Array<number>} indices Indices.
 * @param {VectorReprojOptions} [reproj] Reprojection.
 */
function appendPolygon(polygon, color, hit, vertices, indices, reproj) {
  const stride = polygon.getStride();
  const flat = polygon.getOrientedFlatCoordinates();
  const ends = polygon.getEnds();
  if (!ends || ends.length === 0) {
    return;
  }
  const endss =
    polygon instanceof RenderFeature && ends.length > 1
      ? inflateEnds(flat, /** @type {Array<number>} */ (ends))
      : [/** @type {Array<number>} */ (ends)];
  const groups =
    endss.length > 0 ? endss : [/** @type {Array<number>} */ (ends)];
  for (let p = 0; p < groups.length; ++p) {
    const polyEnds = groups[p];
    const startIndex = p > 0 ? groups[p - 1][groups[p - 1].length - 1] : 0;
    appendPolygonRings(
      flat,
      startIndex,
      polyEnds,
      stride,
      color,
      hit,
      vertices,
      indices,
      reproj,
    );
  }
}

/**
 * @param {Array<number>} flat Flat coordinates.
 * @param {number} startIndex Offset into `flat` for the first ring.
 * @param {Array<number>} ends Absolute end indexes into `flat`.
 * @param {number} stride Stride.
 * @param {Array<number>} color Color.
 * @param {Array<number>} hit Hit.
 * @param {Array<number>} vertices Vertices.
 * @param {Array<number>} indices Indices.
 * @param {VectorReprojOptions} [reproj] Reprojection.
 */
function appendPolygonRings(
  flat,
  startIndex,
  ends,
  stride,
  color,
  hit,
  vertices,
  indices,
  reproj,
) {
  const xy = [];
  const holes = [];
  let offset = startIndex;
  for (let r = 0; r < ends.length; ++r) {
    const end = ends[r];
    if (r > 0) {
      holes.push(xy.length / 2);
    }
    for (let i = offset; i < end; i += stride) {
      xy.push(flat[i], flat[i + 1]);
    }
    offset = end;
  }
  if (xy.length < 6) {
    return;
  }
  const mesh = tessellatePolygon(xy, holes, reproj);
  const base = vertices.length / 10;
  for (let i = 0; i < mesh.vertices.length; i += 2) {
    vertices.push(
      mesh.vertices[i],
      mesh.vertices[i + 1],
      color[0],
      color[1],
      color[2],
      color[3],
      hit[0],
      hit[1],
      hit[2],
      hit[3],
    );
  }
  for (let i = 0; i < mesh.indices.length; ++i) {
    indices.push(mesh.indices[i] + base);
  }
}

/**
 * @param {import("../../geom/Geometry.js").default} geometry Geometry.
 * @param {import("../../style/Stroke.js").default} stroke Stroke.
 * @param {Array<number>} hit Hit.
 * @param {Array<number>} strokeVertices Vertices.
 * @param {Array<number>} strokeIndices Indices.
 * @param {VectorReprojOptions} [reproj] Reprojection.
 */
function appendStrokes(
  geometry,
  stroke,
  hit,
  strokeVertices,
  strokeIndices,
  reproj,
) {
  const color = toRgba(
    /** @type {string|Array<number>} */ (stroke.getColor() || '#000'),
  );
  const width = stroke.getWidth() || 1;
  const type = geometry.getType();
  if (type === 'LineString' || type === 'LinearRing') {
    appendLine(
      /** @type {any} */ (geometry).getFlatCoordinates(),
      /** @type {any} */ (geometry).getStride(),
      color,
      hit,
      width,
      strokeVertices,
      strokeIndices,
      reproj,
    );
  } else if (type === 'MultiLineString') {
    const ends =
      /** @type {import("../../geom/MultiLineString.js").default} */ (
        geometry
      ).getEnds();
    const flat = /** @type {any} */ (geometry).getFlatCoordinates();
    const stride = /** @type {any} */ (geometry).getStride();
    let offset = 0;
    for (const end of ends) {
      appendLine(
        flat.slice(offset, end),
        stride,
        color,
        hit,
        width,
        strokeVertices,
        strokeIndices,
        reproj,
      );
      offset = end;
    }
  } else if (type === 'Polygon' || type === 'MultiPolygon') {
    const rings =
      type === 'Polygon'
        ? [/** @type {import("../../geom/Polygon.js").default} */ (geometry)]
        : /** @type {import("../../geom/MultiPolygon.js").default} */ (
            geometry
          ).getPolygons();
    for (const polygon of rings) {
      const flat = polygon.getOrientedFlatCoordinates();
      const ends = polygon.getEnds();
      const stride = polygon.getStride();
      let offset = 0;
      for (const end of ends) {
        appendLine(
          flat.slice(offset, end),
          stride,
          color,
          hit,
          width,
          strokeVertices,
          strokeIndices,
          reproj,
          true,
        );
        offset = end;
      }
    }
  }
}

/**
 * @param {import("../../extent.js").Extent} extent Extent.
 * @return {number} Epsilon for clip-edge tests.
 */
function clipEdgeEpsilon(extent) {
  return Math.max(extent[2] - extent[0], extent[3] - extent[1]) * 1e-6;
}

/**
 * True when both endpoints lie on the same side of `extent` (an MVT clip edge).
 *
 * @param {number} x1 Start x.
 * @param {number} y1 Start y.
 * @param {number} x2 End x.
 * @param {number} y2 End y.
 * @param {import("../../extent.js").Extent} extent Clip extent.
 * @param {number} eps Distance tolerance.
 * @return {boolean} Segment is a clip edge.
 */
function segmentOnClipEdge(x1, y1, x2, y2, extent, eps) {
  return (
    (Math.abs(x1 - extent[0]) <= eps && Math.abs(x2 - extent[0]) <= eps) ||
    (Math.abs(x1 - extent[2]) <= eps && Math.abs(x2 - extent[2]) <= eps) ||
    (Math.abs(y1 - extent[1]) <= eps && Math.abs(y2 - extent[1]) <= eps) ||
    (Math.abs(y1 - extent[3]) <= eps && Math.abs(y2 - extent[3]) <= eps)
  );
}

/**
 * @param {Array<number>} flat Flat coords.
 * @param {number} stride Stride.
 * @param {Array<number>} color Color.
 * @param {Array<number>} hit Hit.
 * @param {number} width Width.
 * @param {Array<number>} vertices Vertices.
 * @param {Array<number>} indices Indices.
 * @param {VectorReprojOptions} [reproj] Reprojection.
 * @param {boolean} [skipClipEdges] Skip segments that lie on `clipExtent` (polygon rings).
 */
function appendLine(
  flat,
  stride,
  color,
  hit,
  width,
  vertices,
  indices,
  reproj,
  skipClipEdges,
) {
  const coords = [];
  for (let i = 0; i < flat.length; i += stride) {
    coords.push(flat[i], flat[i + 1]);
  }
  const projected = projectFlatCoordinates(
    coords,
    reproj?.projectToTarget,
    reproj?.maxSegmentLength,
    reproj?.maxSpanX,
  );
  if (!projected || projected.length < 4) {
    return;
  }
  const clipExtent = reproj?.clipExtent;
  let parts = projected;
  let ends = [projected.length];
  if (clipExtent) {
    const clipped = clipFlatLineStrings(
      projected,
      [projected.length],
      2,
      clipExtent,
    );
    parts = clipped.flatCoordinates;
    ends = clipped.ends;
    if (!parts.length) {
      return;
    }
  }
  const eps = clipExtent ? clipEdgeEpsilon(clipExtent) : 0;
  let offset = 0;
  for (const end of ends) {
    for (let i = offset; i < end - 2; i += 2) {
      const x1 = parts[i];
      const y1 = parts[i + 1];
      const x2 = parts[i + 2];
      const y2 = parts[i + 3];
      if (
        skipClipEdges &&
        clipExtent &&
        segmentOnClipEdge(x1, y1, x2, y2, clipExtent, eps)
      ) {
        continue;
      }
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const maxEdge = reproj?.maxTargetEdge || 0;
      if (maxEdge > 0 && len > maxEdge) {
        continue;
      }
      const nx = -dy / len;
      const ny = dx / len;
      const base = vertices.length / 13;
      vertices.push(
        x1,
        y1,
        nx,
        ny,
        color[0],
        color[1],
        color[2],
        color[3],
        hit[0],
        hit[1],
        hit[2],
        hit[3],
        width,
        x1,
        y1,
        -nx,
        -ny,
        color[0],
        color[1],
        color[2],
        color[3],
        hit[0],
        hit[1],
        hit[2],
        hit[3],
        width,
        x2,
        y2,
        nx,
        ny,
        color[0],
        color[1],
        color[2],
        color[3],
        hit[0],
        hit[1],
        hit[2],
        hit[3],
        width,
        x2,
        y2,
        -nx,
        -ny,
        color[0],
        color[1],
        color[2],
        color[3],
        hit[0],
        hit[1],
        hit[2],
        hit[3],
        width,
      );
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
    offset = end;
  }
}
