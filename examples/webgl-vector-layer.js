import GeoJSON from '../src/ol/format/GeoJSON.js';
import Layer from '../src/ol/layer/Layer.js';
import Map from '../src/ol/Map.js';
import OSM from '../src/ol/source/OSM.js';
import TileLayer from '../src/ol/layer/WebGLTile.js';
import VectorSource from '../src/ol/source/Vector.js';
import View from '../src/ol/View.js';
import WebGLVectorLayerRenderer from '../src/ol/renderer/webgl/VectorLayer.js';
import {parseLiteralStyle} from '../src/ol/webgl/styleparser.js';

/** @type {import('../src/ol/style/literal.js').LiteralStyle} */
const style = {
  'fill-color': ['*', ['get', 'COLOR'], [255, 255, 255, 0.6]],
};

class WebGLLayer extends Layer {
  createRenderer() {
    const parseResult = parseLiteralStyle(style);
    return new WebGLVectorLayerRenderer(this, {
      fill: {
        vertexShader: parseResult.builder.getFillVertexShader(),
        fragmentShader: parseResult.builder.getFillFragmentShader(),
      },
      stroke: {
        vertexShader: parseResult.builder.getStrokeVertexShader(),
        fragmentShader: parseResult.builder.getStrokeFragmentShader(),
      },
      attributes: parseResult.attributes,
      uniforms: parseResult.uniforms,
    });
  }
}

const osm = new TileLayer({
  source: new OSM(),
});

const vectorLayer = new WebGLLayer({
  source: new VectorSource({
    url: 'https://openlayers.org/data/vector/ecoregions.json',
    format: new GeoJSON(),
  }),
});

const map = new Map({
  layers: [osm, vectorLayer],
  target: 'map',
  view: new View({
    center: [0, 0],
    zoom: 1,
  }),
});
