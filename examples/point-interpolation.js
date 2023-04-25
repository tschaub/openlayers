import Flow from '../src/ol/layer/Flow.js';
import GeoJSON from '../src/ol/format/GeoJSON.js';
import Interpolated from '../src/ol/source/Interpolated.js';
import Map from '../src/ol/Map.js';
import Vector from '../src/ol/source/Vector.js';
import View from '../src/ol/View.js';

const data = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        u: 10,
        v: 10,
      },
      geometry: {
        type: 'Point',
        coordinates: [-40, 20],
      },
    },
    {
      type: 'Feature',
      properties: {
        u: 10,
        v: -10,
      },
      geometry: {
        type: 'Point',
        coordinates: [40, 20],
      },
    },
    {
      type: 'Feature',
      properties: {
        u: 12,
        v: -12,
      },
      geometry: {
        type: 'Point',
        coordinates: [40, -20],
      },
    },
    {
      type: 'Feature',
      properties: {
        u: 5,
        v: 20,
      },
      geometry: {
        type: 'Point',
        coordinates: [-40, -20],
      },
    },
  ],
};

const format = new GeoJSON({
  featureProjection: 'EPSG:3857',
});

const features = format.readFeatures(data);

const numValues = 4;
const values = new Array(numValues).fill(0);

const wind = new Interpolated({
  source: new Vector({features}),
  valueCount: 4,
  values: (feature) => {
    // values[0] = feature.get('u');
    // values[1] = feature.get('v');
    values[0] = 10;
    values[1] = -10;
    values[3] = 1;
    return values;
  },
});

const map = new Map({
  target: 'map',
  layers: [
    new Flow({
      source: wind,
      maxSpeed: 10,
      style: {
        color: [
          'interpolate',
          ['linear'],
          ['speed'],
          -10,
          '#34618d',
          -8,
          '#2c718e',
          -6,
          '#27818e',
          -4,
          '#21908d',
          -2,
          '#27ad81',
          0,
          '#42bb72',
          2,
          '#5cc863',
          4,
          '#83d24b',
          6,
          '#aadc32',
          8,
          '#d4e22c',
          10,
          '#fde725',
        ],
      },
    }),
  ],
  view: new View({
    center: [0, 0],
    zoom: 0,
  }),
});
