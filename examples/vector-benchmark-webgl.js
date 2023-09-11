import GeoJSON from '../src/ol/format/GeoJSON.js';
import Layer from '../src/ol/layer/Layer.js';
import Link from '../src/ol/interaction/Link.js';
import Map from '../src/ol/Map.js';
import VectorLayer from '../src/ol/layer/Vector.js';
import VectorSource from '../src/ol/source/Vector.js';
import View from '../src/ol/View.js';
import WebGLVectorLayerRenderer from '../src/ol/renderer/webgl/VectorLayer.js';
import {useGeographic} from '../src/ol/proj.js';

useGeographic();

const map = new Map({
  layers: [],
  target: 'map',
  view: new View({
    center: [28.58737, -20.16127],
    zoom: 13,
  }),
});

const source = new VectorSource();

const style = {
  'fill-color': '#00AAFF',
  'stroke-color': '#028bd1',
  'stroke-width': 1.5,
};

class WebGLLayer extends Layer {
  createRenderer() {
    return new WebGLVectorLayerRenderer(this, {
      style,
    });
  }
}

function useWebGL() {
  map.getLayers().clear();
  map.addLayer(new WebGLLayer({source}));
}

function useCanvas() {
  map.getLayers().clear();
  map.addLayer(new VectorLayer({source, style}));
}

const link = new Link();

const webglToggle = document.getElementById('webgl');
webglToggle.addEventListener('change', function () {
  if (webglToggle.checked) {
    link.update('renderer', 'webgl');
    useWebGL();
  } else {
    link.update('renderer', 'canvas');
    useCanvas();
  }
});

const initialRenderer = link.track('renderer', (newRenderer) => {
  if (newRenderer === 'webgl') {
    useWebGL();
  } else {
    useCanvas();
  }
});
webglToggle.checked = initialRenderer === 'webgl';

const dataUrl = 'http://localhost:4000/bulawayo.json';

map.addInteraction(link);

const format = new GeoJSON();
function parseFeatures(data) {
  console.time('parse features');
  const features = format.readFeatures(data);
  console.timeEnd('parse features');
  return features;
}

async function addFeatures(features) {
  console.time('add features');
  source.addFeatures(features);
  console.timeEnd('add features');
}

async function main() {
  const response = await fetch(dataUrl);
  const data = await response.json();
  const features = parseFeatures(data);
  addFeatures(features);
  if (initialRenderer === 'webgl') {
    useWebGL();
  } else {
    useCanvas();
  }
}

main();
