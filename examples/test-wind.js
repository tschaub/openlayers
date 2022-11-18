import DataTileSource from '../src/ol/source/DataTile.js';
import Map from '../src/ol/Map.js';
import MapboxVectorLayer from '../src/ol/layer/MapboxVector.js';
import View from '../src/ol/View.js';
import WebGLTile from '../src/ol/layer/Field.js';
import {clamp} from '../src/ol/math.js';
import {createXYZ, wrapX} from '../src/ol/tilegrid.js';
import {get as getProjection, transform} from '../src/ol/proj.js';

const accessToken =
  'pk.eyJ1IjoicGxhbmV0IiwiYSI6ImNrOTF4eno1NTAwbmUzZm01bHc5djV4bnoifQ.oFybzMLDu9E9IrW2MZXZxw';
const baseStyleUrl = 'mapbox://styles/planet/ck8yzkkra05tv1ip9os6pmi1e';
const labelsStyleUrl = 'mapbox://styles/planet/cl47zd0xr000614n1al1l5kdx';

const windData = new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement('canvas');
    const width = image.width;
    const height = image.height;
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, width, height).data;
    resolve({data, width, height, bands: 4});
  };
  image.onerror = () => {
    reject(new Error('failed to load'));
  };
  image.src = './data/wind.png';
});

function bilinearInterpolation(xAlong, yAlong, v11, v21, v12, v22) {
  const q11 = (1 - xAlong) * (1 - yAlong) * v11;
  const q21 = xAlong * (1 - yAlong) * v21;
  const q12 = (1 - xAlong) * yAlong * v12;
  const q22 = xAlong * yAlong * v22;
  return q11 + q21 + q12 + q22;
}

const dataTileGrid = createXYZ();
const dataTileSize = 256;

const inputImageProjection = getProjection('EPSG:4326');
const dataTileProjection = getProjection('EPSG:3857');

const dataTiles = new DataTileSource({
  wrapX: true,
  async loader(z, x, y) {
    const {
      data: inputData,
      width: inputWidth,
      height: inputHeight,
      bands,
    } = await windData;

    const tileCoord = wrapX(dataTileGrid, [z, x, y], dataTileProjection);
    const extent = dataTileGrid.getTileCoordExtent(tileCoord);
    const resolution = dataTileGrid.getResolution(z);
    const data = new Uint8Array(dataTileSize * dataTileSize * bands);
    for (let row = 0; row < dataTileSize; ++row) {
      let offset = row * dataTileSize * bands;
      const mapY = extent[3] - row * resolution;
      for (let col = 0; col < dataTileSize; ++col) {
        const mapX = extent[0] + col * resolution;
        const [lon, lat] = transform(
          [mapX, mapY],
          dataTileProjection,
          inputImageProjection
        );
        const inputX = clamp(
          Math.round((inputWidth * (lon + 180)) / 360),
          0,
          inputWidth - 1
        );
        const inputY = clamp(
          Math.round((inputHeight * (90 - lat)) / 180),
          0,
          inputHeight - 1
        );
        const inputOffset = (inputY * 360 + inputX) * bands;
        data[offset] = inputData[inputOffset];
        data[offset + 1] = inputData[inputOffset + 1];
        data[offset + 2] = inputData[inputOffset + 2];
        data[offset + 3] = inputData[inputOffset + 3];
        offset += bands;
      }
    }
    return data;
  },
});

const map = new Map({
  target: 'map',
  layers: [
    new MapboxVectorLayer({
      accessToken,
      styleUrl: baseStyleUrl,
    }),
    new WebGLTile({source: dataTiles}),
    new MapboxVectorLayer({
      accessToken,
      styleUrl: labelsStyleUrl,
    }),
  ],
  view: new View({
    center: [0, 0],
    zoom: 0,
  }),
});
