import {assert} from 'chai';
import Feature from '../../../../../src/ol/Feature.js';
import LineString from '../../../../../src/ol/geom/LineString.js';
import Polygon from '../../../../../src/ol/geom/Polygon.js';
import RenderFeature from '../../../../../src/ol/render/Feature.js';
import {
  buildVectorBuffers,
  decodeHitColor,
  encodeHitColor,
  mergeLabelBuffers,
} from '../../../../../src/ol/render/webgpu/buffers.js';
import {resolveDeclutter} from '../../../../../src/ol/render/webgpu/declutter.js';
import CircleStyle from '../../../../../src/ol/style/Circle.js';
import Fill from '../../../../../src/ol/style/Fill.js';
import Stroke from '../../../../../src/ol/style/Stroke.js';
import Style from '../../../../../src/ol/style/Style.js';
import Text from '../../../../../src/ol/style/Text.js';

/**
 * @param {number} px X.
 * @param {number} py Y.
 * @param {number} ax Triangle A x.
 * @param {number} ay Triangle A y.
 * @param {number} bx Triangle B x.
 * @param {number} by Triangle B y.
 * @param {number} cx Triangle C x.
 * @param {number} cy Triangle C y.
 * @return {boolean} Point is inside the triangle.
 */
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const v0x = cx - ax;
  const v0y = cy - ay;
  const v1x = bx - ax;
  const v1y = by - ay;
  const v2x = px - ax;
  const v2y = py - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const denom = dot00 * dot11 - dot01 * dot01;
  if (denom === 0) {
    return false;
  }
  const u = (dot11 * dot02 - dot01 * dot12) / denom;
  const v = (dot00 * dot12 - dot01 * dot02) / denom;
  return u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9;
}

describe('ol/render/webgpu/buffers', () => {
  it('round-trips hit colors', () => {
    const encoded = encodeHitColor(42);
    assert.strictEqual(decodeHitColor(encoded), 42);
  });

  it('builds fill buffers with target-space tessellation', () => {
    const feature = new Feature(
      new Polygon([
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ]),
    );
    const style = new Style({
      fill: new Fill({color: [255, 0, 0, 1]}),
    });
    const buffers = buildVectorBuffers(
      [feature],
      () => style,
      1,
      /** @type {any} */ ({}),
      {
        projectToTarget: (coord) => [coord[0] * 2, coord[1] * 2],
      },
    );
    assert.isAbove(buffers.fillIndices.length, 0);
    let maxX = -Infinity;
    for (let i = 0; i < buffers.fillVertices.length; i += 10) {
      maxX = Math.max(maxX, buffers.fillVertices[i]);
    }
    assert.closeTo(maxX, 2, 1e-9);
  });

  it('builds symbol buffers from RenderFeature points used by MVT tiles', () => {
    const point = new RenderFeature('Point', [100, 200], [], 2, {}, undefined);
    const style = new Style({
      image: new CircleStyle({
        radius: 4,
        fill: new Fill({color: '#000'}),
      }),
    });
    const buffers = buildVectorBuffers(
      [point],
      () => style,
      1,
      /** @type {any} */ ({}),
    );
    assert.strictEqual(buffers.symbolInstances.length, 14);
    assert.closeTo(buffers.symbolInstances[0], 100, 1e-9);
    assert.closeTo(buffers.symbolInstances[1], 200, 1e-9);
  });

  it('does not throw when MVT-like tiles mix polygons and points', () => {
    const polygon = new RenderFeature(
      'Polygon',
      [0, 0, 10, 0, 10, 10, 0, 10, 0, 0],
      [10],
      2,
      {},
      undefined,
    );
    const point = new RenderFeature('Point', [5, 5], [], 2, {name_en: 'x'}, 1);
    const style = new Style({
      fill: new Fill({color: '#eee'}),
      stroke: new Stroke({color: '#888', width: 1}),
      image: new CircleStyle({
        radius: 2,
        fill: new Fill({color: '#000'}),
      }),
    });
    const buffers = buildVectorBuffers(
      [polygon, point],
      () => style,
      1,
      /** @type {any} */ ({}),
    );
    assert.isAbove(buffers.fillIndices.length, 0);
    assert.isAbove(buffers.strokeIndices.length, 0);
    assert.isAbove(buffers.symbolInstances.length, 0);
  });

  it('fills every MVT outer ring, not only the first', () => {
    // Two CCW outers in one Polygon, as Mapbox MVT encodes MultiPolygon.
    const polygon = new RenderFeature(
      'Polygon',
      [0, 0, 10, 0, 10, 10, 0, 10, 0, 0, 20, 0, 30, 0, 30, 10, 20, 10, 20, 0],
      [10, 20],
      2,
      {},
      undefined,
    );
    const style = new Style({
      fill: new Fill({color: '#eee'}),
    });
    const buffers = buildVectorBuffers(
      [polygon],
      () => style,
      1,
      /** @type {any} */ ({}),
    );
    let hasLeft = false;
    let hasRight = false;
    for (let i = 0; i < buffers.fillIndices.length; ++i) {
      const x = buffers.fillVertices[buffers.fillIndices[i] * 10];
      if (x < 12) {
        hasLeft = true;
      }
      if (x > 18) {
        hasRight = true;
      }
    }
    assert.isTrue(hasLeft);
    assert.isTrue(hasRight);
  });

  it('still treats opposite-winding rings as holes', () => {
    const withHole = new RenderFeature(
      'Polygon',
      [0, 0, 10, 0, 10, 10, 0, 10, 0, 0, 3, 3, 3, 7, 7, 7, 7, 3, 3, 3],
      [10, 20],
      2,
      {},
      undefined,
    );
    const style = new Style({
      fill: new Fill({color: '#eee'}),
    });
    const buffers = buildVectorBuffers(
      [withHole],
      () => style,
      1,
      /** @type {any} */ ({}),
    );
    assert.isAbove(buffers.fillIndices.length, 0);
    let holeFilled = false;
    let rimFilled = false;
    for (let i = 0; i < buffers.fillIndices.length; i += 3) {
      const i0 = buffers.fillIndices[i] * 10;
      const i1 = buffers.fillIndices[i + 1] * 10;
      const i2 = buffers.fillIndices[i + 2] * 10;
      const ax = buffers.fillVertices[i0];
      const ay = buffers.fillVertices[i0 + 1];
      const bx = buffers.fillVertices[i1];
      const by = buffers.fillVertices[i1 + 1];
      const cx = buffers.fillVertices[i2];
      const cy = buffers.fillVertices[i2 + 1];
      if (pointInTriangle(5, 5, ax, ay, bx, by, cx, cy)) {
        holeFilled = true;
      }
      if (pointInTriangle(1, 1, ax, ay, bx, by, cx, cy)) {
        rimFilled = true;
      }
    }
    assert.isTrue(rimFilled);
    assert.isFalse(holeFilled);
  });

  it('does not apply point symbolizers to polygons', () => {
    const polygon = new Feature(
      new Polygon([
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ]),
    );
    const style = new Style({
      fill: new Fill({color: '#eee'}),
      image: new CircleStyle({
        radius: 2,
        fill: new Fill({color: '#000'}),
      }),
    });
    const buffers = buildVectorBuffers(
      [polygon],
      () => style,
      1,
      /** @type {any} */ ({}),
    );
    assert.isAbove(buffers.fillIndices.length, 0);
    assert.strictEqual(buffers.symbolInstances.length, 0);
    assert.strictEqual(buffers.labels.length, 0);
  });

  it('namespaces image+text pair ids when merging tiles so distant labels stay independent', () => {
    const style = new Style({
      image: new CircleStyle({
        radius: 2,
        fill: new Fill({color: '#000'}),
      }),
      text: new Text({text: ''}),
    });
    const west = new RenderFeature('Point', [0, 0], [], 2, {}, 1);
    const east = new RenderFeature('Point', [1e6, 1e6], [], 2, {}, 2);
    const westBuffers = buildVectorBuffers(
      [west],
      () => style,
      1,
      /** @type {any} */ ({}),
    );
    const eastBuffers = buildVectorBuffers(
      [east],
      () => style,
      1,
      /** @type {any} */ ({}),
    );
    assert.strictEqual(
      westBuffers.labels[0].pairId,
      eastBuffers.labels[0].pairId,
    );

    const collided = resolveDeclutter([
      {
        minX: 0,
        minY: 0,
        maxX: 8,
        maxY: 8,
        priority: 0,
        pairId: westBuffers.labels[0].pairId,
      },
      {
        minX: 200,
        minY: 200,
        maxX: 208,
        maxY: 208,
        priority: 0,
        pairId: eastBuffers.labels[0].pairId,
      },
      {minX: 100, minY: 100, maxX: 108, maxY: 108, priority: 1},
    ]);
    assert.deepEqual(collided, [true, true, false]);

    const merged = mergeLabelBuffers([westBuffers, eastBuffers]);
    assert.notStrictEqual(merged.labels[0].pairId, merged.labels[1].pairId);
    const visible = resolveDeclutter([
      {
        minX: 0,
        minY: 0,
        maxX: 8,
        maxY: 8,
        priority: 0,
        pairId: merged.labels[0].pairId,
      },
      {
        minX: 200,
        minY: 200,
        maxX: 208,
        maxY: 208,
        priority: 0,
        pairId: merged.labels[1].pairId,
      },
      {minX: 100, minY: 100, maxX: 108, maxY: 108, priority: 1},
    ]);
    assert.deepEqual(visible, [true, true, true]);
  });

  it('does not stroke polygon edges that lie on the clip extent', () => {
    const feature = new Feature(
      new Polygon([
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ]),
    );
    const style = new Style({
      stroke: new Stroke({color: '#000', width: 1}),
    });
    const buffers = buildVectorBuffers(
      [feature],
      () => style,
      1,
      /** @type {any} */ ({}),
      {clipExtent: [0, 0, 10, 10]},
    );
    assert.strictEqual(buffers.strokeIndices.length, 0);
  });

  it('strokes interior polygon edges and skips only clip-extent sides', () => {
    const feature = new Feature(
      new Polygon([
        [
          [0, 0],
          [10, 0],
          [8, 5],
          [2, 5],
          [0, 0],
        ],
      ]),
    );
    const style = new Style({
      stroke: new Stroke({color: '#000', width: 1}),
    });
    const full = buildVectorBuffers(
      [feature],
      () => style,
      1,
      /** @type {any} */ ({}),
    );
    const clipped = buildVectorBuffers(
      [feature],
      () => style,
      1,
      /** @type {any} */ ({}),
      {clipExtent: [0, 0, 10, 10]},
    );
    assert.strictEqual(full.strokeIndices.length / 6, 4);
    assert.strictEqual(clipped.strokeIndices.length / 6, 3);
  });

  it('still strokes line strings that follow a tile edge', () => {
    const feature = new Feature(
      new LineString([
        [0, 0],
        [10, 0],
      ]),
    );
    const style = new Style({
      stroke: new Stroke({color: '#000', width: 1}),
    });
    const buffers = buildVectorBuffers(
      [feature],
      () => style,
      1,
      /** @type {any} */ ({}),
      {clipExtent: [0, 0, 10, 10]},
    );
    assert.strictEqual(buffers.strokeIndices.length / 6, 1);
  });

  it('clips stroke segments to the clip extent', () => {
    const feature = new Feature(
      new LineString([
        [-5, 5],
        [15, 5],
      ]),
    );
    const style = new Style({
      stroke: new Stroke({color: '#000', width: 1}),
    });
    const buffers = buildVectorBuffers(
      [feature],
      () => style,
      1,
      /** @type {any} */ ({}),
      {clipExtent: [0, 0, 10, 10]},
    );
    assert.isAbove(buffers.strokeVertices.length, 0);
    for (let i = 0; i < buffers.strokeVertices.length; i += 13) {
      assert.isAtLeast(buffers.strokeVertices[i], -1e-9);
      assert.isAtMost(buffers.strokeVertices[i], 10 + 1e-9);
    }
  });
});
