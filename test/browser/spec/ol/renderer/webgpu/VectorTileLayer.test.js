import {assert} from 'chai';
import Feature from '../../../../../../src/ol/Feature.js';
import Point from '../../../../../../src/ol/geom/Point.js';
import WebGPUVectorTileLayer from '../../../../../../src/ol/layer/WebGPUVectorTile.js';
import {get as getProjection} from '../../../../../../src/ol/proj.js';
import VectorTileSource from '../../../../../../src/ol/source/VectorTile.js';
import {getCacheKey} from '../../../../../../src/ol/tilecoord.js';
import TileState from '../../../../../../src/ol/TileState.js';

/**
 * @param {number} z Z.
 * @param {number} x X.
 * @param {number} y Y.
 * @return {import('../../../../../../src/ol/VectorRenderTile.js').default} Idle tile.
 */
function idleTile(z, x, y) {
  return /** @type {any} */ ({
    tileCoord: [z, x, y],
    key: `${z}/${x}/${y}`,
    getState() {
      return TileState.IDLE;
    },
    getKey() {
      return `${z}/${x}/${y}`;
    },
    getSourceTiles() {
      return [];
    },
  });
}

/**
 * @param {number} z Z.
 * @param {number} x X.
 * @param {number} y Y.
 * @return {import('../../../../../../src/ol/VectorRenderTile.js').default} Loaded tile.
 */
function loadedTile(z, x, y) {
  return /** @type {any} */ ({
    tileCoord: [z, x, y],
    key: `${z}/${x}/${y}`,
    getState() {
      return TileState.LOADED;
    },
    getKey() {
      return `${z}/${x}/${y}`;
    },
    getSourceTiles() {
      return [
        {
          getState() {
            return TileState.LOADED;
          },
          getFeatures() {
            return [new Feature(new Point([0, 0]))];
          },
        },
      ];
    },
  });
}

describe('ol/renderer/webgpu/VectorTileLayer', () => {
  /** @type {import('../../../../../../src/ol/proj/Projection.js').default} */
  let projection;
  /** @type {VectorTileSource} */
  let source;
  /** @type {WebGPUVectorTileLayer} */
  let layer;
  /** @type {import('../../../../../../src/ol/renderer/webgpu/VectorTileLayer.js').default} */
  let renderer;

  beforeEach(() => {
    projection =
      /** @type {import('../../../../../../src/ol/proj/Projection.js').default} */ (
        getProjection('EPSG:3857')
      );
    source = new VectorTileSource({
      url: '{z}/{x}/{y}.pbf',
      projection,
    });
    layer = new WebGPUVectorTileLayer({
      source,
      style: {
        'circle-radius': 2,
        'circle-fill-color': '#000',
      },
    });
    renderer = layer.createRenderer();
  });

  afterEach(() => {
    layer.dispose();
  });

  /**
   * @param {number} z Zoom.
   * @return {import('../../../../../../src/ol/Map.js').FrameState} Frame.
   */
  function frameAtZ(z) {
    const tileGrid = source.getTileGridForProjection(projection);
    return /** @type {any} */ ({
      extent: tileGrid.getTileCoordExtent([0, 0, 0]),
      pixelRatio: 1,
      wantedTiles: {},
      tileQueue: {
        isKeyQueued: () => false,
        enqueue: () => {},
      },
      viewState: {
        projection,
        resolution: tileGrid.getResolution(z),
        center: [0, 0],
      },
    });
  }

  it('draws cached parent tiles while current zoom tiles are loading', () => {
    const requested = [];
    source.getTile = function (z, x, y) {
      requested.push([z, x, y]);
      return idleTile(z, x, y);
    };
    const sourceKey = source.getKey();
    renderer.renderTiles_.set(
      getCacheKey(source, sourceKey, 0, 0, 0),
      loadedTile(0, 0, 0),
    );

    const batches = renderer.collectBatches_(frameAtZ(1));

    assert.strictEqual(batches.length, 1);
    assert.match(batches[0].key, /^0\/0\/0\//);
    assert.isFalse(requested.some((coord) => coord[0] === 0));
    assert.isNotEmpty(requested);
  });

  it('draws cached child tiles when zooming out before parent tiles load', () => {
    source.getTile = function (z, x, y) {
      return idleTile(z, x, y);
    };
    const sourceKey = source.getKey();
    for (let x = 0; x <= 1; ++x) {
      for (let y = 0; y <= 1; ++y) {
        renderer.renderTiles_.set(
          getCacheKey(source, sourceKey, 1, x, y),
          loadedTile(1, x, y),
        );
      }
    }

    const batches = renderer.collectBatches_(frameAtZ(0));

    assert.strictEqual(batches.length, 4);
    const coords = batches
      .map((batch) => batch.key.split('/').slice(0, 3).join('/'))
      .sort();
    assert.deepEqual(coords, ['1/0/0', '1/0/1', '1/1/0', '1/1/1']);
  });
});
