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
  'ESRI:54009',
  '+proj=moll +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
);
register(proj4);

const projection = getProjection('ESRI:54009');
const projectionExtent = [-18e6, -9e6, 18e6, 9e6];
projection.setExtent(projectionExtent);

/**
 * Simple land-like polygons that must not produce continent-spanning
 * horizontal streaks when warped into Mollweide.
 */
const geojson = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-20, 40],
            [40, 40],
            [40, 60],
            [-20, 60],
            [-20, 40],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [100, -40],
            [150, -40],
            [150, -20],
            [100, -20],
            [100, -40],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-80, -20],
            [-40, -20],
            [-40, 10],
            [-80, 10],
            [-80, -20],
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
  // Translucent fill: double-draw shows as darker red; cut streaks show clearly.
  style: {
    'fill-color': [227, 26, 28, 0.45],
    'stroke-color': '#222',
    'stroke-width': 1,
  },
});

const map = new Map({
  pixelRatio: 1,
  target: 'map',
  layers: [vector],
  view: new View({
    projection,
    extent: projectionExtent,
    center: getCenter(projectionExtent),
    resolution:
      Math.max(
        projectionExtent[2] - projectionExtent[0],
        projectionExtent[3] - projectionExtent[1],
      ) / 256,
  }),
});

map.on('rendercomplete', function onRenderComplete() {
  if (!vector.getRenderer()?.ready) {
    return;
  }
  map.un('rendercomplete', onRenderComplete);
  render({
    message:
      'Mollweide WebGL vector: translucent fills stay local without cut streaks or double-draw',
    tolerance: 0.02,
  });
});
