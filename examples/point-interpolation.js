import Flow from '../src/ol/layer/Flow.js';
import GeoJSON from '../src/ol/format/GeoJSON.js';
import Interpolated from '../src/ol/source/Interpolated.js';
import Map from '../src/ol/Map.js';
import VectorLayer from '../src/ol/layer/Vector.js';
import VectorSource from '../src/ol/source/Vector.js';
import View from '../src/ol/View.js';
import colormap from 'colormap';

const valueCount = 4;
const values = new Array(valueCount).fill(0);

const wind = new Interpolated({
  config: {maxDistance: 100000},
  valueCount,
  values: (feature) => {
    values[0] = feature.get('u');
    values[1] = feature.get('v');
    values[3] = 1;
    return values;
  },
});

const maxSpeed = 10;
const colors = colormap({
  colormap: 'viridis',
  nshades: 10,
  format: 'rgba',
});
const colorStops = [];
for (let i = 0; i < colors.length; ++i) {
  colorStops.push((i * maxSpeed) / (colors.length - 1));
  colorStops.push(colors[i]);
}

const map = new Map({
  target: 'map',
  layers: [
    new Flow({
      source: wind,
      particles: 7000,
      maxSpeed,
      style: {
        color: ['interpolate', ['linear'], ['get', 'speed'], ...colorStops],
      },
    }),
    new VectorLayer(),
  ],
  view: new View({
    center: [-5831676, -6661136],
    zoom: 6.5,
    rotation: -1.329,
  }),
});

async function load(url) {
  const response = await fetch(url);
  const data = await response.json();
  const format = new GeoJSON({
    featureProjection: 'EPSG:3857',
  });
  const features = format.readFeatures(data);
  wind.setSource(new VectorSource({features}));
}

load('data/ascat_20200101_005400_metopb_37810_eps_o_250_3202_ovw.l2.json');
