/**
 * @module ol/render/webgpu/buffers
 */
import {asArray} from '../../color.js';
import {createEmpty, extend as extendExtent, isEmpty} from '../../extent.js';
import {inflateEnds} from '../../geom/flat/orient.js';
import RenderFeature from '../../render/Feature.js';
import {getUid} from '../../util.js';
import {countMetric, endMetric, startMetric} from '../../webgpu/metrics.js';
import {buildGeometryBuffers} from './geometryBuffers.js';
import {layoutLineLabel, layoutPointLabel} from './glyphLayout.js';

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
 * @typedef {import("./geometryBuffers.js").LocalGrid} LocalGrid
 */

/**
 * @typedef {Object} VectorBuffers
 * @property {Int16Array} fillPositions Fill positions in grid units.
 * @property {Uint32Array} fillStyles Style index per fill vertex.
 * @property {Uint32Array} fillIndices Fill indices.
 * @property {Int16Array} strokePositions Stroke positions in grid units.
 * @property {Float32Array} strokeAttributes Normal x, normal y, and width per stroke vertex.
 * @property {Uint32Array} strokeStyles Style index per stroke vertex.
 * @property {Uint32Array} strokeIndices Stroke indices.
 * @property {Float32Array} styles Color and hit color, eight floats per style.
 * @property {LocalGrid} grid Grid the positions are expressed in.
 * @property {Float32Array} symbolInstances Symbol instances.
 * @property {Array<import("./glyphLayout.js").GlyphInstance>} glyphs Glyphs.
 * @property {Array<import("./declutter.js").Label>} labels Declutter labels.
 * @property {Object<number, import("../../Feature.js").FeatureLike>} featuresByRef Hit refs.
 */

/**
 * @classdesc
 * Collects the distinct color and hit color pairs of a batch, so vertices only
 * carry an index instead of eight repeated floats.
 */
class StyleTable {
  constructor() {
    /**
     * @type {Array<number>}
     */
    this.values = [];

    /**
     * @private
     * @type {Map<string, number>}
     */
    this.indices_ = new Map();
  }

  /**
   * @param {Array<number>} color RGBA 0-1.
   * @param {Array<number>} hit Hit color RGBA 0-1.
   * @return {number} Style index.
   */
  add(color, hit) {
    const key = color.join(',') + '|' + hit.join(',');
    const existing = this.indices_.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const index = this.values.length / 8;
    this.values.push(
      color[0],
      color[1],
      color[2],
      color[3],
      hit[0],
      hit[1],
      hit[2],
      hit[3],
    );
    this.indices_.set(key, index);
    return index;
  }
}

/**
 * Fallback extent for the local grid when the caller has no clip extent.
 *
 * @param {Array<import("../../Feature.js").FeatureLike>} features Features.
 * @return {import("../../extent.js").Extent} Extent.
 */
function boundsOf(features) {
  const extent = createEmpty();
  for (const feature of features) {
    const geometry = feature.getGeometry();
    if (geometry) {
      extendExtent(extent, geometry.getExtent());
    }
  }
  return isEmpty(extent) ? [0, 0, 0, 0] : extent;
}

/**
 * Labels, symbols, and hit references. These stay on the main thread because
 * they need the font atlas and the feature objects.
 *
 * @typedef {Object} LabelData
 * @property {Float32Array} symbolInstances Symbol instances.
 * @property {Array<import("./glyphLayout.js").GlyphInstance>} glyphs Glyphs.
 * @property {Array<import("./declutter.js").Label>} labels Declutter labels.
 * @property {Object<number, import("../../Feature.js").FeatureLike>} featuresByRef Hit refs.
 */

/**
 * Style evaluation and geometry extraction, with the resulting tessellation
 * work described as plain data so it can run here or on a worker.
 *
 * @param {Array<import("../../Feature.js").FeatureLike>} features Features.
 * @param {import("../../style/Style.js").StyleFunction} styleFunction Style function.
 * @param {number} resolution Resolution.
 * @param {import("../../webgpu/FontAtlas.js").default} atlas Atlas.
 * @param {VectorReprojOptions} [reproj] Reprojection options.
 * @param {number} [pixelRatio] Device pixel ratio for glyph rasterization.
 * @return {{request: import("./geometryBuffers.js").GeometryRequest, labelData: LabelData}} Work and labels.
 */
export function buildVectorRequest(
  features,
  styleFunction,
  resolution,
  atlas,
  reproj,
  pixelRatio = 1,
) {
  const metricStart = startMetric();
  const styleTable = new StyleTable();
  /** @type {Array<import("./geometryBuffers.js").GeometryJob>} */
  const jobs = [];
  /** @type {Array<number>} */
  const coordinates = [];
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
    const featureId = feature.getId();

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
      const rawText = text?.getText();
      const textKey = Array.isArray(rawText)
        ? rawText.join('\n')
        : rawText || '';
      const featureKey =
        (featureId !== undefined ? String(featureId) : type) + '|' + textKey;

      if (fill && (type === 'Polygon' || type === 'MultiPolygon')) {
        appendFills(
          /** @type {any} */ (geom),
          fill,
          hit,
          jobs,
          coordinates,
          styleTable,
        );
      }
      if (stroke && type !== 'Point' && type !== 'MultiPoint') {
        appendStrokes(
          /** @type {any} */ (geom),
          stroke,
          hit,
          jobs,
          coordinates,
          styleTable,
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
            _identityKey: `${featureKey}|${s}|${a}|${pid ? 'pair' : 'image'}`,
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
              _identityKey: `${featureKey}|${s}|${a}|${pid ? 'pair' : 'text'}`,
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
          const count = glyphs.length - start;
          const middle = glyphs[start + Math.floor(count / 2)];
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
            glyphCount: count,
            text: textKey,
            _anchor: middle ? [middle.x, middle.y] : undefined,
            _identityKey: `${featureKey}|${s}|line`,
          });
        }
      }
    }
  }

  endMetric('buildVectorRequest', metricStart);
  countMetric('builtFeatures', sorted.length);

  return {
    request: {
      jobs,
      coordinates: new Float64Array(coordinates),
      styles: new Float32Array(styleTable.values),
      gridExtent: reproj?.clipExtent || boundsOf(features),
      clipExtent: reproj?.clipExtent,
      maxSegmentLength: reproj?.maxSegmentLength,
      maxSpanX: reproj?.maxSpanX,
      worldWidth: reproj?.worldWidth,
      warpGrid: reproj?.warpGrid,
      warpExtent: reproj?.warpExtent,
      maxTargetError: reproj?.maxTargetError,
      maxTargetEdge: reproj?.maxTargetEdge,
      projectToTarget: reproj?.projectToTarget,
    },
    labelData: {
      symbolInstances: new Float32Array(symbolInstances),
      glyphs,
      labels,
      featuresByRef,
    },
  };
}

/**
 * @param {import("./geometryBuffers.js").GeometryBuffers} geometry Geometry.
 * @param {LabelData} labelData Labels.
 * @return {VectorBuffers} Buffers.
 */
export function combineVectorBuffers(geometry, labelData) {
  countMetric('fillTriangles', geometry.fillIndices.length / 3);
  countMetric('strokeTriangles', geometry.strokeIndices.length / 3);
  return {
    fillPositions: geometry.fillPositions,
    fillStyles: geometry.fillStyles,
    fillIndices: geometry.fillIndices,
    strokePositions: geometry.strokePositions,
    strokeAttributes: geometry.strokeAttributes,
    strokeStyles: geometry.strokeStyles,
    strokeIndices: geometry.strokeIndices,
    styles: geometry.styles,
    grid: geometry.grid,
    symbolInstances: labelData.symbolInstances,
    glyphs: labelData.glyphs,
    labels: labelData.labels,
    featuresByRef: labelData.featuresByRef,
  };
}

/**
 * Build everything on the calling thread.
 *
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
  const {request, labelData} = buildVectorRequest(
    features,
    styleFunction,
    resolution,
    atlas,
    reproj,
    pixelRatio,
  );
  const metricStart = startMetric();
  const geometry = buildGeometryBuffers(request);
  endMetric('mainThreadGeometry', metricStart);
  return combineVectorBuffers(geometry, labelData);
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
  // Labels are drawn in view coordinates, so their anchors are projected here
  // even when the geometry is left in the source projection for a GPU warp.
  const projectToTarget =
    reproj?.projectAnchorsToTarget || reproj?.projectToTarget;
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
 * @param {Array<import("./geometryBuffers.js").GeometryJob>} jobs Jobs.
 * @param {Array<number>} coordinates Shared coordinates.
 * @param {StyleTable} styleTable Style table.
 */
function appendFills(geometry, fill, hit, jobs, coordinates, styleTable) {
  const color = toRgba(/** @type {string|Array<number>} */ (fill.getColor()));
  const styleIndex = styleTable.add(color, hit);
  const type = geometry.getType();
  if (type === 'Polygon') {
    appendPolygon(
      /** @type {import("../../geom/Polygon.js").default} */ (geometry),
      styleIndex,
      jobs,
      coordinates,
    );
  } else if (type === 'MultiPolygon') {
    const polygons =
      /** @type {import("../../geom/MultiPolygon.js").default} */ (
        geometry
      ).getPolygons();
    for (const polygon of polygons) {
      appendPolygon(polygon, styleIndex, jobs, coordinates);
    }
  }
}

/**
 * Split MVT Polygon rings by winding before earcut (same as the WebGL path).
 *
 * @param {import("../../geom/Polygon.js").default|import("../../render/Feature.js").default} polygon Polygon.
 * @param {number} styleIndex Style index.
 * @param {Array<import("./geometryBuffers.js").GeometryJob>} jobs Jobs.
 * @param {Array<number>} coordinates Shared coordinates.
 */
function appendPolygon(polygon, styleIndex, jobs, coordinates) {
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
    const start = coordinates.length / 2;
    /** @type {Array<number>} */
    const holes = [];
    let offset = startIndex;
    for (let r = 0; r < polyEnds.length; ++r) {
      const end = polyEnds[r];
      if (r > 0) {
        holes.push(coordinates.length / 2 - start);
      }
      for (let i = offset; i < end; i += stride) {
        coordinates.push(flat[i], flat[i + 1]);
      }
      offset = end;
    }
    const count = coordinates.length / 2 - start;
    if (count < 3) {
      coordinates.length = start * 2;
      continue;
    }
    jobs.push({kind: 'fill', start, count, holes, styleIndex});
  }
}

/**
 * @param {import("../../geom/Geometry.js").default} geometry Geometry.
 * @param {import("../../style/Stroke.js").default} stroke Stroke.
 * @param {Array<number>} hit Hit.
 * @param {Array<import("./geometryBuffers.js").GeometryJob>} jobs Jobs.
 * @param {Array<number>} coordinates Shared coordinates.
 * @param {StyleTable} styleTable Style table.
 */
function appendStrokes(geometry, stroke, hit, jobs, coordinates, styleTable) {
  const color = toRgba(
    /** @type {string|Array<number>} */ (stroke.getColor() || '#000'),
  );
  const styleIndex = styleTable.add(color, hit);
  const width = stroke.getWidth() || 1;
  const type = geometry.getType();
  if (type === 'LineString' || type === 'LinearRing') {
    addLineJob(
      /** @type {any} */ (geometry).getFlatCoordinates(),
      0,
      /** @type {any} */ (geometry).getFlatCoordinates().length,
      /** @type {any} */ (geometry).getStride(),
      styleIndex,
      width,
      false,
      jobs,
      coordinates,
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
      addLineJob(
        flat,
        offset,
        end,
        stride,
        styleIndex,
        width,
        false,
        jobs,
        coordinates,
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
        addLineJob(
          flat,
          offset,
          end,
          stride,
          styleIndex,
          width,
          true,
          jobs,
          coordinates,
        );
        offset = end;
      }
    }
  }
}

/**
 * @param {Array<number>} flat Flat coordinates.
 * @param {number} from Start index into `flat`.
 * @param {number} to End index into `flat`.
 * @param {number} stride Stride.
 * @param {number} styleIndex Style index.
 * @param {number} width Stroke width.
 * @param {boolean} skipClipEdges Drop segments lying on the clip extent.
 * @param {Array<import("./geometryBuffers.js").GeometryJob>} jobs Jobs.
 * @param {Array<number>} coordinates Shared coordinates.
 */
function addLineJob(
  flat,
  from,
  to,
  stride,
  styleIndex,
  width,
  skipClipEdges,
  jobs,
  coordinates,
) {
  const start = coordinates.length / 2;
  for (let i = from; i < to; i += stride) {
    coordinates.push(flat[i], flat[i + 1]);
  }
  const count = coordinates.length / 2 - start;
  if (count < 2) {
    coordinates.length = start * 2;
    return;
  }
  jobs.push({
    kind: 'stroke',
    start,
    count,
    styleIndex,
    width,
    skipClipEdges,
  });
}
