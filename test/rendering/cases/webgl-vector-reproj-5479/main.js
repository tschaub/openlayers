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
  'EPSG:5479',
  '+proj=lcc +lat_1=-76.66666666666667 +lat_2=-79.33333333333333 ' +
    '+lat_0=-78 +lon_0=163 +x_0=7000000 +y_0=5000000 +ellps=GRS80 ' +
    '+towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
);
register(proj4);

const projection = getProjection('EPSG:5479');
const projectionExtent = [6825737.53, 4189159.8, 9633741.96, 5782472.71];
projection.setExtent(projectionExtent);

/**
 * Synthetic EPSG:4326 geometries for left-edge reprojection:
 * - Outer ring extends west of the CRS left edge (~154°E) so fill must meet
 *   the map's left edge after clipping / warping.
 * - Hole is fully inside the view (must stay empty — no bridging triangles).
 * - Separate island east of the main polygon.
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
            [140, -80],
            [178, -80],
            [178, -74],
            [140, -74],
            [140, -80],
          ],
          // Hole (clockwise), placed where the left-side view can see it
          [
            [158, -78],
            [168, -78],
            [168, -76],
            [158, -76],
            [158, -78],
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
            [182, -78],
            [186, -78],
            [186, -76],
            [182, -76],
            [182, -78],
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

// Left side of the CRS extent — where fill-to-edge and hole artifacts show up.
const viewExtent = [
  projectionExtent[0],
  4700000,
  projectionExtent[0] + (projectionExtent[2] - projectionExtent[0]) * 0.5,
  5400000,
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
  // Buffer rebuild is async; wait until the WebGL renderer has uploaded fills.
  if (!vector.getRenderer()?.ready) {
    return;
  }
  map.un('rendercomplete', onRenderComplete);
  render({
    message:
      'EPSG:5479 WebGL vector: translucent fill meets stroke (including left CRS edge), keeps holes empty, uniform opacity',
    tolerance: 0.02,
  });
});
