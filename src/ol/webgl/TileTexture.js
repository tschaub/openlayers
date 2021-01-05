/**
 * @module ol/webgl/TileTexture
 */

import DataTile from '../DataTile.js';
import EventTarget from '../events/Target.js';
import EventType from '../events/EventType.js';
import ImageTile from '../ImageTile.js';
import TileState from '../TileState.js';
import WebGLArrayBuffer from './Buffer.js';
import {ARRAY_BUFFER, STATIC_DRAW} from '../webgl.js';
import {toSize} from '../size.js';

function bindAndConfigure(gl, texture) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
}

/**
 * @param {WebGLRenderingContext} gl The WebGL context.
 * @param {WebGLTexture} texture The texture.
 * @param {HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} image The image.
 */
function uploadImageTexture(gl, texture, image) {
  bindAndConfigure(gl, texture);

  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
}

/**
 * @param {WebGLRenderingContext} gl The WebGL context.
 * @param {WebGLTexture} texture The texture.
 * @param {import("../size.js").Size} size The pixel size.
 * @param {import("../DataTile.js").Data} data The pixel data.
 */
function uploadDataTexture(gl, texture, size, data) {
  bindAndConfigure(gl, texture);

  let format;

  const bytesPerPixel = data.byteLength / (size[0] * size[1]);
  switch (bytesPerPixel) {
    case 1: {
      format = gl.LUMINANCE;
      break;
    }
    case 3: {
      format = gl.RGB;
      break;
    }
    case 4: {
      format = gl.RGBA;
      break;
    }
    default: {
      throw new Error(
        `Unsupported number of bytes per pixel: ${bytesPerPixel}`
      );
    }
  }

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    format,
    size[0],
    size[1],
    0,
    format,
    gl.UNSIGNED_BYTE,
    data
  );
}

const blank = new Uint8Array([0, 0, 0, 0]);

function uploadBlankTexture(gl, texture) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    blank
  );
}

class TileTexture extends EventTarget {
  constructor(tile, grid, helper) {
    super();

    this.tile = tile;
    this.size = toSize(grid.getTileSize(tile.tileCoord[0]));
    this.loaded = tile.getState() === TileState.LOADED;

    this.helper_ = helper;
    this.handleTileChange_ = this.handleTileChange_.bind(this);

    const coords = new WebGLArrayBuffer(ARRAY_BUFFER, STATIC_DRAW);
    coords.fromArray([
      0, // P0
      1,
      1, // P1
      1,
      1, // P2
      0,
      0, // P3
      0,
    ]);
    helper.flushBufferData(coords);
    this.coords = coords;

    const gl = helper.getGL();
    const texture = gl.createTexture();
    this.texture = texture;

    if (this.loaded) {
      this.uploadTile_();
    } else {
      uploadBlankTexture(gl, texture);
      tile.addEventListener(EventType.CHANGE, this.handleTileChange_);
    }
  }

  uploadTile_() {
    const gl = this.helper_.getGL();
    const texture = this.texture;
    const tile = this.tile;

    if (tile instanceof ImageTile) {
      uploadImageTexture(gl, texture, tile.getImage());
      return;
    }

    if (tile instanceof DataTile) {
      uploadDataTexture(gl, texture, this.size, tile.getData());
      return;
    }

    throw new Error('Unsupported tile type');
  }

  handleTileChange_() {
    if (this.tile.getState() === TileState.LOADED) {
      this.loaded = true;
      this.uploadTile_();
      this.dispatchEvent(EventType.CHANGE);
    }
  }

  disposeInternal() {
    const gl = this.helper_.getGL();
    this.helper_.deleteBuffer(this.coords);
    gl.deleteTexture(this.texture);
    this.tile.removeEventListener(EventType.CHANGE, this.handleTileChange_);
  }
}

export default TileTexture;
