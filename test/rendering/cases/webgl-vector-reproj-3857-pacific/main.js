import Map from '../../../../src/ol/Map.js';
import View from '../../../../src/ol/View.js';
import {getCenter} from '../../../../src/ol/extent.js';
import GeoJSON from '../../../../src/ol/format/GeoJSON.js';
import WebGLVectorLayer from '../../../../src/ol/layer/WebGLVector.js';
import {
  get as getProjection,
  transformExtent,
} from '../../../../src/ol/proj.js';
import VectorSource from '../../../../src/ol/source/Vector.js';

/**
 * Australia + New Zealand boxes in EPSG:3857.
 * Regression: NZ vertices must not UV-clamp / unwrap to the far west and
 * produce continent-spanning horizontal fill/stroke triangles.
 */
const geojson = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {name: 'australia'},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [112, -44],
            [154, -44],
            [154, -10],
            [112, -10],
            [112, -44],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {name: 'new-zealand'},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [166, -47],
            [179, -47],
            [179, -34],
            [166, -34],
            [166, -47],
          ],
        ],
      },
    },
  ],
};

const source = new VectorSource({
  projection: 'EPSG:4326',
  features: new GeoJSON().readFeatures(geojson),
});

const vector = new WebGLVectorLayer({
  source,
  // Translucent fill: streaks and double-draw show as dark bands / white gaps.
  style: {
    'fill-color': [227, 26, 28, 0.45],
    'stroke-color': '#222',
    'stroke-width': 1,
  },
});

// Wide Pacific view (Africa-ish east through NZ) — previously triggered
// sticky unwrap + oversized cut threshold → NZ→west streaks.
const viewExtent4326 = [20, -50, 180, 5];
const viewExtent = transformExtent(viewExtent4326, 'EPSG:4326', 'EPSG:3857');

const map = new Map({
  pixelRatio: 1,
  target: 'map',
  layers: [vector],
  view: new View({
    projection: getProjection('EPSG:3857'),
    center: getCenter(viewExtent),
    resolution:
      Math.max(viewExtent[2] - viewExtent[0], viewExtent[3] - viewExtent[1]) /
      256,
  }),
});

map.on('rendercomplete', function onRenderComplete() {
  if (!vector.getRenderer()?.ready) {
    return;
  }
  map.un('rendercomplete', onRenderComplete);
  render({
    message:
      'EPSG:3857 Pacific WebGL vector: Australia and NZ fills stay local without west-bound horizontal streaks',
    tolerance: 0.02,
  });
});
