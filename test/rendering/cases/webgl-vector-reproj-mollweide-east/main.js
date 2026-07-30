import proj4 from 'proj4';
import Map from '../../../../src/ol/Map.js';
import View from '../../../../src/ol/View.js';
import {getCenter} from '../../../../src/ol/extent.js';
import GeoJSON from '../../../../src/ol/format/GeoJSON.js';
import WebGLVectorLayer from '../../../../src/ol/layer/WebGLVector.js';
import {
  get as getProjection,
  transformExtent,
} from '../../../../src/ol/proj.js';
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
            [112, -40],
            [154, -40],
            [154, -10],
            [112, -10],
            [112, -40],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {name: 'east-limb-island'},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [170, -20],
            [179, -20],
            [179, -12],
            [170, -12],
            [170, -20],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: {name: 'east-limb-islet'},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [172, -8],
            [177, -8],
            [177, -4],
            [172, -4],
            [172, -8],
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

// Northern Australia / western Pacific — matches the Mollweide streak repro.
const viewExtent4326 = [90, -45, 180, 10];
const viewExtent = transformExtent(viewExtent4326, 'EPSG:4326', 'ESRI:54009');

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
      'Mollweide east-limb WebGL vector: near-dateline islands fill locally without west-bound fill streaks',
    tolerance: 0.02,
  });
});
