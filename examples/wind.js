import DataTileSource from '../src/ol/source/DataTile.js';
import Layer from '../src/ol/layer/Layer.js';
import Map from '../src/ol/Map.js';
import MapboxVectorLayer from '../src/ol/layer/MapboxVector.js';
import View from '../src/ol/View.js';
import WebGLTile from '../src/ol/layer/WebGLTile.js';
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

const dataTileGrid = createXYZ();
const dataTileSize = 256;
const dataTileBands = 3;

const inputImageProjection = getProjection('EPSG:4326');
const dataTileProjection = getProjection('EPSG:3857');

const dataTiles = new DataTileSource({
  wrapX: true,
  async loader(z, x, y) {
    const {
      data: inputData,
      width: inputWidth,
      height: inputHeight,
      bands: inputBands,
    } = await windData;

    const tileCoord = wrapX(dataTileGrid, [z, x, y], dataTileProjection);
    const extent = dataTileGrid.getTileCoordExtent(tileCoord);
    const resolution = dataTileGrid.getResolution(z);
    const data = new Uint8Array(dataTileSize * dataTileSize * dataTileBands);
    for (let row = 0; row < dataTileSize; ++row) {
      let offset = row * dataTileSize * dataTileBands;
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
        const inputOffset = (inputY * 360 + inputX) * inputBands;
        data[offset] = inputData[inputOffset];
        data[offset + 1] = inputData[inputOffset + 1];
        data[offset + 2] = inputData[inputOffset + 2];
        data[offset + 3] = inputData[inputOffset + 3];
        offset += dataTileBands;
      }
    }
    return data;
  },
});

const outputCanvas = document.createElement('canvas');

let draw;
const windLayer = new Layer({
  render: function (frameState) {
    if (!draw) {
      setTimeout(() => {
        init();
      }, 1);
    } else {
      setTimeout(draw, 1);
    }
    const canvas = outputCanvas;
    const [width, height] = frameState.size;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width * 2;
      canvas.height = height * 2;
      const style = canvas.style;
      style.position = 'absolute';
      style.left = '0px';
      style.width = `${width}px`;
      style.height = `${height}px`;
    }
    return canvas;
  },
});

const map = new Map({
  target: 'map',
  layers: [
    new WebGLTile({className: 'data-tiles', source: dataTiles}),
    new MapboxVectorLayer({
      accessToken,
      styleUrl: baseStyleUrl,
    }),
    windLayer,
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

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);

  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }

  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();

  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);

  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }

  const wrapper = {program: program};

  const numAttributes = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < numAttributes; i++) {
    const attribute = gl.getActiveAttrib(program, i);
    wrapper[attribute.name] = gl.getAttribLocation(program, attribute.name);
  }
  const numUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < numUniforms; i++) {
    const uniform = gl.getActiveUniform(program, i);
    wrapper[uniform.name] = gl.getUniformLocation(program, uniform.name);
  }

  return wrapper;
}

function createTexture(gl, filter, data, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  if (data instanceof Uint8Array) {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data
    );
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function bindTexture(gl, texture, unit) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}

function createBuffer(gl, data) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return buffer;
}

function bindAttribute(gl, buffer, attribute, numComponents) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, numComponents, gl.FLOAT, false, 0, 0);
}

function bindFramebuffer(gl, framebuffer, texture) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  if (texture) {
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0
    );
  }
}

const defaultRampColors = {
  0.0: '#3288bd',
  0.1: '#66c2a5',
  0.2: '#abdda4',
  0.3: '#e6f598',
  0.4: '#fee08b',
  0.5: '#fdae61',
  0.6: '#f46d43',
  1.0: '#d53e4f',
};

const drawVert = `
  precision mediump float;

  attribute float a_index;

  uniform sampler2D u_particles;
  uniform float u_particles_res;

  varying vec2 v_particle_pos;

  void main() {
      vec4 color = texture2D(u_particles, vec2(
          fract(a_index / u_particles_res),
          floor(a_index / u_particles_res) / u_particles_res));

      // decode current particle position from the pixel's RGBA value
      v_particle_pos = vec2(
          color.r / 255.0 + color.b,
          color.g / 255.0 + color.a);

      gl_PointSize = 1.0;
      gl_Position = vec4(2.0 * v_particle_pos.x - 1.0, 1.0 - 2.0 * v_particle_pos.y, 0, 1);
  }
`;

const drawFrag = `
  precision mediump float;

  uniform sampler2D u_wind;
  uniform vec2 u_wind_min;
  uniform vec2 u_wind_max;
  uniform sampler2D u_color_ramp;

  varying vec2 v_particle_pos;

  void main() {
      vec2 velocity = mix(u_wind_min, u_wind_max, texture2D(u_wind, v_particle_pos).rg);
      float speed_t = length(velocity) / length(u_wind_max);

      // color ramp is encoded in a 16x16 texture
      vec2 ramp_pos = vec2(
          fract(16.0 * speed_t),
          floor(16.0 * speed_t) / 16.0);

      gl_FragColor = texture2D(u_color_ramp, ramp_pos);
  }
`;

const quadVert = `
  precision mediump float;

  attribute vec2 a_pos;

  varying vec2 v_tex_pos;

  void main() {
      v_tex_pos = a_pos;
      gl_Position = vec4(1.0 - 2.0 * a_pos, 0, 1);
  }
`;

const screenFrag = `
  precision mediump float;

  uniform sampler2D u_screen;
  uniform float u_opacity;

  varying vec2 v_tex_pos;

  void main() {
      vec4 color = texture2D(u_screen, 1.0 - v_tex_pos);
      // a hack to guarantee opacity fade out even with a value close to 1.0
      gl_FragColor = vec4(floor(255.0 * color * u_opacity) / 255.0);
  }
`;

const updateFrag = `
  precision highp float;

  uniform sampler2D u_particles;
  uniform sampler2D u_wind;
  uniform vec2 u_wind_res;
  uniform vec2 u_wind_min;
  uniform vec2 u_wind_max;
  uniform float u_rand_seed;
  uniform float u_speed_factor;
  uniform float u_drop_rate;
  uniform float u_drop_rate_bump;

  varying vec2 v_tex_pos;

  // pseudo-random generator
  const vec3 rand_constants = vec3(12.9898, 78.233, 4375.85453);
  float rand(const vec2 co) {
      float t = dot(rand_constants.xy, co);
      return fract(sin(t) * (rand_constants.z + t));
  }

  // wind speed lookup; use manual bilinear filtering based on 4 adjacent pixels for smooth interpolation
  vec2 lookup_wind(const vec2 uv) {
      // return texture2D(u_wind, uv).rg; // lower-res hardware filtering
      vec2 px = 1.0 / u_wind_res;
      vec2 vc = (floor(uv * u_wind_res)) * px;
      vec2 f = fract(uv * u_wind_res);
      vec2 tl = texture2D(u_wind, vc).rg;
      vec2 tr = texture2D(u_wind, vc + vec2(px.x, 0)).rg;
      vec2 bl = texture2D(u_wind, vc + vec2(0, px.y)).rg;
      vec2 br = texture2D(u_wind, vc + px).rg;
      return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
  }

  void main() {
      vec4 color = texture2D(u_particles, v_tex_pos);
      vec2 pos = vec2(
          color.r / 255.0 + color.b,
          color.g / 255.0 + color.a); // decode particle position from pixel RGBA

      vec2 velocity = mix(u_wind_min, u_wind_max, lookup_wind(pos));
      float speed_t = length(velocity) / length(u_wind_max);

      // take EPSG:4236 distortion into account for calculating where the particle moved
      float distortion = 1.0; // TODO: revisit this cos(radians(pos.y * 180.0 - 90.0));
      vec2 offset = vec2(velocity.x / distortion, -velocity.y) * 0.0001 * u_speed_factor;

      // update particle position, wrapping around the date line
      pos = fract(1.0 + pos + offset);

      // a random seed to use for the particle drop
      vec2 seed = (pos + v_tex_pos) * u_rand_seed;

      // drop rate is a chance a particle will restart at random position, to avoid degeneration
      float drop_rate = u_drop_rate + speed_t * u_drop_rate_bump;
      float drop = step(1.0 - drop_rate, rand(seed));

      vec2 random_pos = vec2(
          rand(seed + 1.3),
          rand(seed + 2.1));
      pos = mix(pos, random_pos, drop);

      // encode the new particle position back into RGBA
      gl_FragColor = vec4(
          fract(pos * 255.0),
          floor(pos * 255.0) / 255.0);
  }
`;

class WindGL {
  constructor(gl) {
    this.gl = gl;

    this.fadeOpacity = 0.996; // how fast the particle trails fade on each frame
    this.speedFactor = 0.25; // how fast the particles move
    this.dropRate = 0.003; // how often the particles move to a random place
    this.dropRateBump = 0.01; // drop rate increase relative to individual particle speed

    this.drawProgram = createProgram(gl, drawVert, drawFrag);
    this.screenProgram = createProgram(gl, quadVert, screenFrag);
    this.updateProgram = createProgram(gl, quadVert, updateFrag);

    this.quadBuffer = createBuffer(
      gl,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1])
    );
    this.framebuffer = gl.createFramebuffer();

    this.setColorRamp(defaultRampColors);
    this.resize();
  }

  resize() {
    const gl = this.gl;
    const emptyPixels = new Uint8Array(gl.canvas.width * gl.canvas.height * 4);
    // screen textures to hold the drawn screen for the previous and the current frame
    this.backgroundTexture = createTexture(
      gl,
      gl.NEAREST,
      emptyPixels,
      gl.canvas.width,
      gl.canvas.height
    );
    this.screenTexture = createTexture(
      gl,
      gl.NEAREST,
      emptyPixels,
      gl.canvas.width,
      gl.canvas.height
    );
  }

  setColorRamp(colors) {
    // lookup texture for colorizing the particles according to their speed
    this.colorRampTexture = createTexture(
      this.gl,
      this.gl.LINEAR,
      getColorRamp(colors),
      16,
      16
    );
  }

  set numParticles(numParticles) {
    const gl = this.gl;

    // we create a square texture where each pixel will hold a particle position encoded as RGBA
    this.particleStateResolution = Math.ceil(Math.sqrt(numParticles));

    const particleRes = this.particleStateResolution;
    this._numParticles = particleRes * particleRes;

    const particleState = new Uint8Array(this._numParticles * 4);
    for (let i = 0; i < particleState.length; i++) {
      particleState[i] = Math.floor(Math.random() * 256); // randomize the initial particle positions
    }
    // textures to hold the particle state for the current and the next frame
    this.particleStateTexture0 = createTexture(
      gl,
      gl.NEAREST,
      particleState,
      particleRes,
      particleRes
    );
    this.particleStateTexture1 = createTexture(
      gl,
      gl.NEAREST,
      particleState,
      particleRes,
      particleRes
    );

    const particleIndices = new Float32Array(this._numParticles);
    for (let i = 0; i < this._numParticles; i++) {
      particleIndices[i] = i;
    }
    this.particleIndexBuffer = createBuffer(gl, particleIndices);
  }
  get numParticles() {
    return this._numParticles;
  }

  setWind(windData) {
    this.windData = windData;
    this.windTexture = createTexture(this.gl, this.gl.LINEAR, windData.image);
  }

  draw() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);

    bindTexture(gl, this.windTexture, 0);
    bindTexture(gl, this.particleStateTexture0, 1);

    this.drawScreen();
    this.updateParticles();
  }

  drawScreen() {
    const gl = this.gl;
    // draw the screen into a temporary framebuffer to retain it as the background on the next frame
    bindFramebuffer(gl, this.framebuffer, this.screenTexture);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

    this.drawTexture(this.backgroundTexture, this.fadeOpacity);
    this.drawParticles();

    bindFramebuffer(gl, null);
    // enable blending to support drawing on top of an existing background (e.g. a map)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.drawTexture(this.screenTexture, 1.0);
    gl.disable(gl.BLEND);

    // save the current screen as the background for the next frame
    const temp = this.backgroundTexture;
    this.backgroundTexture = this.screenTexture;
    this.screenTexture = temp;
  }

  drawTexture(texture, opacity) {
    const gl = this.gl;
    const program = this.screenProgram;
    gl.useProgram(program.program);

    bindAttribute(gl, this.quadBuffer, program.a_pos, 2);
    bindTexture(gl, texture, 2);
    gl.uniform1i(program.u_screen, 2);
    gl.uniform1f(program.u_opacity, opacity);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  drawParticles() {
    const gl = this.gl;
    const program = this.drawProgram;
    gl.useProgram(program.program);

    bindAttribute(gl, this.particleIndexBuffer, program.a_index, 1);
    bindTexture(gl, this.colorRampTexture, 2);

    gl.uniform1i(program.u_wind, 0);
    gl.uniform1i(program.u_particles, 1);
    gl.uniform1i(program.u_color_ramp, 2);

    gl.uniform1f(program.u_particles_res, this.particleStateResolution);
    gl.uniform2f(program.u_wind_min, this.windData.uMin, this.windData.vMin);
    gl.uniform2f(program.u_wind_max, this.windData.uMax, this.windData.vMax);

    gl.drawArrays(gl.POINTS, 0, this._numParticles);
  }

  updateParticles() {
    const gl = this.gl;
    bindFramebuffer(gl, this.framebuffer, this.particleStateTexture1);
    gl.viewport(
      0,
      0,
      this.particleStateResolution,
      this.particleStateResolution
    );

    const program = this.updateProgram;
    gl.useProgram(program.program);

    bindAttribute(gl, this.quadBuffer, program.a_pos, 2);

    gl.uniform1i(program.u_wind, 0);
    gl.uniform1i(program.u_particles, 1);

    gl.uniform1f(program.u_rand_seed, Math.random());
    gl.uniform2f(program.u_wind_res, this.windData.width, this.windData.height);
    gl.uniform2f(program.u_wind_min, this.windData.uMin, this.windData.vMin);
    gl.uniform2f(program.u_wind_max, this.windData.uMax, this.windData.vMax);
    gl.uniform1f(program.u_speed_factor, this.speedFactor);
    gl.uniform1f(program.u_drop_rate, this.dropRate);
    gl.uniform1f(program.u_drop_rate_bump, this.dropRateBump);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // swap the particle state textures so the new one becomes the current one
    const temp = this.particleStateTexture0;
    this.particleStateTexture0 = this.particleStateTexture1;
    this.particleStateTexture1 = temp;
  }
}

function getColorRamp(colors) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  canvas.width = 256;
  canvas.height = 1;

  const gradient = ctx.createLinearGradient(0, 0, 256, 0);
  for (const stop in colors) {
    gradient.addColorStop(+stop, colors[stop]);
  }

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 1);

  return new Uint8Array(ctx.getImageData(0, 0, 256, 1).data);
}

function init() {
  const canvas = outputCanvas;

  const pxRatio = Math.max(Math.floor(window.devicePixelRatio) || 1, 2);
  canvas.width = canvas.clientWidth * pxRatio;
  canvas.height = canvas.clientHeight * pxRatio;

  const gl = canvas.getContext('webgl', {antialiasing: false});

  const wind = new WindGL(gl);
  wind.numParticles = 128 * 128;

  function frame() {
    if (wind.windData) {
      wind.draw();
    }
    requestAnimationFrame(frame);
  }
  frame();

  function updateWind() {
    const windData = {
      source: 'http://nomads.ncep.noaa.gov',
      date: '2016-11-20T00:00Z',
      uMin: -20,
      uMax: 20,
      vMin: -20,
      vMax: 20,
    };

    const windImage = document.querySelector('.data-tiles');
    windData.image = windImage;
    windData.width = windImage.width;
    windData.height = windImage.height;
    wind.setWind(windData);
  }

  draw = updateWind;
}
