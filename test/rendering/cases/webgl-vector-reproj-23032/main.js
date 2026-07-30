import proj4 from 'proj4';
import Map from '../../../../src/ol/Map.js';
import View from '../../../../src/ol/View.js';
import {getCenter} from '../../../../src/ol/extent.js';
import GeoJSON from '../../../../src/ol/format/GeoJSON.js';
import WebGLVectorLayer from '../../../../src/ol/layer/WebGLVector.js';
import {get as getProjection} from '../../../../src/ol/proj.js';
import {register} from '../../../../src/ol/proj/proj4.js';
import VectorSource from '../../../../src/ol/source/Vector.js';

proj4.defs(
  'EPSG:23032',
  '+proj=utm +zone=32 +ellps=intl ' +
    '+towgs84=-87,-98,-121,0,0,0,0 +units=m +no_defs',
);
register(proj4);

const projection = getProjection('EPSG:23032');
const projectionExtent = [-1206118.71, 4021309.92, 1295389.0, 8051813.28];
projection.setExtent(projectionExtent);

/**
 * Non-overlapping synthetic EPSG:4326 geometries for UTM fill stress:
 * - South: large polygon with a hole (earcut diagonals must not leave gaps).
 * - North: concave C-shape (long needles must not double-draw).
 */
const geojson = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {kind: 'hole'},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [2, 43.5],
            [12, 43.5],
            [12, 47.5],
            [2, 47.5],
            [2, 43.5],
          ],
          [
            [8.5, 45.5],
            [10.5, 45.5],
            [10.5, 46.8],
            [8.5, 46.8],
            [8.5, 45.5],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {kind: 'concave'},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [3, 48.2],
            [11, 48.2],
            [11, 49.2],
            [6.5, 49.2],
            [6.5, 50.8],
            [11, 50.8],
            [11, 51.6],
            [3, 51.6],
            [3, 48.2],
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
  // Translucent fill: double-draw shows as darker red; gaps show white.
  style: {
    'fill-color': [227, 26, 28, 0.45],
    'stroke-color': '#222',
    'stroke-width': 1,
  },
});

const viewExtent = [
  projectionExtent[0] + (projectionExtent[2] - projectionExtent[0]) * 0.35,
  projectionExtent[1] + (projectionExtent[3] - projectionExtent[1]) * 0.12,
  projectionExtent[0] + (projectionExtent[2] - projectionExtent[0]) * 0.8,
  projectionExtent[1] + (projectionExtent[3] - projectionExtent[1]) * 0.52,
];

const map = new Map({
  pixelRatio: 1,
  target: 'map',
  layers: [vector],
  view: new View({
    projection,
    extent: projectionExtent,
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
      'EPSG:23032 WebGL vector: hole and concave fills are uniform (no double-draw), meet their strokes, and leave holes empty',
    tolerance: 0.02,
  });
});
