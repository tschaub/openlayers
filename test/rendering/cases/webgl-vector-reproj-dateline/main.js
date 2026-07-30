import Map from '../../../../src/ol/Map.js';
import View from '../../../../src/ol/View.js';
import GeoJSON from '../../../../src/ol/format/GeoJSON.js';
import WebGLVectorLayer from '../../../../src/ol/layer/WebGLVector.js';
import {fromLonLat, get as getProjection} from '../../../../src/ol/proj.js';
import VectorSource from '../../../../src/ol/source/Vector.js';

/**
 * Polygons on both sides of the antimeridian, Mercator view centered on 180°.
 * Regression: fills stay on their own side (no east↔west bridging streaks),
 * holes stay empty, translucent fill shows double-draw if triangles overlap.
 */
const geojson = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {name: 'west-of-dateline'},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [168, -18],
            [179, -18],
            [179, -6],
            [168, -6],
            [168, -18],
          ],
          [
            [172, -14],
            [176, -14],
            [176, -10],
            [172, -10],
            [172, -14],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {name: 'east-of-dateline'},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-179, -18],
            [-168, -18],
            [-168, -6],
            [-179, -6],
            [-179, -18],
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
  style: {
    'fill-color': [227, 26, 28, 0.45],
    'stroke-color': '#222',
    'stroke-width': 1,
  },
});

const projection = getProjection('EPSG:3857');

const map = new Map({
  pixelRatio: 1,
  target: 'map',
  layers: [vector],
  view: new View({
    projection,
    center: fromLonLat([180, -12], projection),
    resolution: (45 * 20037508.34) / 180 / 256,
  }),
});

map.on('rendercomplete', function onRenderComplete() {
  if (!vector.getRenderer()?.ready) {
    return;
  }
  map.un('rendercomplete', onRenderComplete);
  render({
    message:
      'Dateline WebGL vector: polygons on both sides of ±180 fill locally without bridging streaks; hole stays empty',
    tolerance: 0.02,
  });
});
