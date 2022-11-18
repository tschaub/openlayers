import WebGLArrayBuffer from '../../webgl/Buffer.js';
import WebGLTileLayerRenderer from './TileLayer.js';
import {ARRAY_BUFFER, STATIC_DRAW} from '../../webgl.js';

/**
 * @typedef {import("../../layer/Field.js").default} LayerType
 */

/**
 * @typedef {Object} Options
 * @property {string} tileVertexShader Vertex shader for rendering the data tiles.
 * @property {string} tileFragmentShader Fragment shader for rendering the data tiles.
 * @property {number} [cacheSize=512] The texture cache size.
 * @property {number} [particles=65536] The number of particles to render.
 */

const defaultRampColors = {
  0.0: '#034e7b',
  0.1: '#0570b0',
  0.2: '#3690c0',
  0.3: '#74a9cf',
  0.4: '#a6bddb',
  0.5: '#d0d1e6',
  0.6: '#ece7f2',
  1.0: '#fff7fb',
};

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

/**
 * @enum {string}
 */
const Uniforms = {
  TEXTURE: 'u_texture',
  VELOCITY_TEXTURE: 'u_velocityTexture',
  POSITION_TEXTURE: 'u_positionTexture',
  COLOR_RAMP_TEXTURE: 'u_colorRamp',
  PARTICLE_COUNT_SQRT: 'u_particleCountSqrt',
  VELOCITY_MIN: 'u_minVelocity',
  VELOCITY_MAX: 'u_maxVelocity',
  RANDOM_SEED: 'u_randomSeed',
  SPEED_FACTOR: 'u_speedFactor',
  DROP_RATE: 'u_dropRate',
  DROP_RATE_BUMP: 'u_dropRateBump',
  OPACITY: 'u_opacity',
};

/**
 * @enum {string}
 */
const Attributes = {
  POSITION: 'a_position',
  INDEX: 'a_index',
};

/**
 * @enum {string}
 */
const Varyings = {
  POSITION: 'v_position',
};

const quadVertexShader = `
  precision mediump float;

  attribute vec2 ${Attributes.POSITION};

  varying vec2 ${Varyings.POSITION};

  void main() {
    ${Varyings.POSITION} = ${Attributes.POSITION};
    gl_Position = vec4(1.0 - 2.0 * ${Attributes.POSITION}, 0, 1);
  }
`;

const textureAlphaFragmentShader = `
  precision mediump float;

  uniform sampler2D ${Uniforms.TEXTURE};
  uniform float ${Uniforms.OPACITY};

  varying vec2 ${Varyings.POSITION};

  void main() {
    vec4 color = texture2D(${Uniforms.TEXTURE}, 1.0 - ${Varyings.POSITION});
    gl_FragColor = vec4(floor(255.0 * color * ${Uniforms.OPACITY}) / 255.0);
  }
`;

const particlePositionFragmentShader = `
  precision highp float;

  uniform sampler2D ${Uniforms.POSITION_TEXTURE};
  uniform sampler2D ${Uniforms.VELOCITY_TEXTURE};
  uniform vec2 ${Uniforms.VELOCITY_MIN};
  uniform vec2 ${Uniforms.VELOCITY_MAX};
  uniform float ${Uniforms.RANDOM_SEED};
  uniform float ${Uniforms.SPEED_FACTOR};
  uniform float ${Uniforms.DROP_RATE};
  uniform float ${Uniforms.DROP_RATE_BUMP};

  varying vec2 ${Varyings.POSITION};

  // pseudo-random generator
  const vec3 rand_constants = vec3(12.9898, 78.233, 4375.85453);

  float rand(const vec2 co) {
    float t = dot(rand_constants.xy, co);
    return fract(sin(t) * (rand_constants.z + t));
  }

  void main() {
    vec4 color = texture2D(${Uniforms.POSITION_TEXTURE}, ${Varyings.POSITION});

    // decode particle position from pixel RGBA
    vec2 pos = vec2(
      color.r / 255.0 + color.b,
      color.g / 255.0 + color.a
    );

    vec2 unscaled = texture2D(${Uniforms.VELOCITY_TEXTURE}, pos).rg;
    vec2 velocity = mix(${Uniforms.VELOCITY_MIN}, ${Uniforms.VELOCITY_MAX}, unscaled);
    float speed_t = length(velocity) / length(${Uniforms.VELOCITY_MAX});

    vec2 offset = vec2(velocity.x, -velocity.y) * 0.0001 * ${Uniforms.SPEED_FACTOR};

    // update particle position, wrapping around the date line
    pos = fract(1.0 + pos + offset);

    // a random seed to use for the particle drop
    vec2 seed = (pos + ${Varyings.POSITION}) * ${Uniforms.RANDOM_SEED};

    // drop rate is a chance a particle will restart at random position, to avoid degeneration
    float drop_rate = ${Uniforms.DROP_RATE} + speed_t * ${Uniforms.DROP_RATE_BUMP};
    float drop = step(1.0 - drop_rate, rand(seed));

    vec2 random_pos = vec2(
      rand(seed + 1.3),
      rand(seed + 2.1)
    );
    pos = mix(pos, random_pos, drop);

    // encode the new particle position back into RGBA
    gl_FragColor = vec4(
      fract(pos * 255.0),
      floor(pos * 255.0) / 255.0
    );
  }
`;

const particleColorVertexShader = `
  precision mediump float;

  attribute float ${Attributes.INDEX};

  uniform sampler2D ${Uniforms.POSITION_TEXTURE};
  uniform float ${Uniforms.PARTICLE_COUNT_SQRT};

  varying vec2 ${Varyings.POSITION};

  void main() {
    vec4 color = texture2D(
      ${Uniforms.POSITION_TEXTURE},
      vec2(
        fract(${Attributes.INDEX} / ${Uniforms.PARTICLE_COUNT_SQRT}),
        floor(${Attributes.INDEX} / ${Uniforms.PARTICLE_COUNT_SQRT}) / ${Uniforms.PARTICLE_COUNT_SQRT}
      )
    );

    // decode current particle position from the pixel's RGBA value
    ${Varyings.POSITION} = vec2(
      color.r / 255.0 + color.b,
      color.g / 255.0 + color.a
    );

    gl_PointSize = 1.0;
    gl_Position = vec4(2.0 * ${Varyings.POSITION}.x - 1.0, 2.0 * ${Varyings.POSITION}.y - 1.0, 0, 1);
  }
`;

const particleColorFragmentShader = `
  precision mediump float;

  uniform sampler2D ${Uniforms.VELOCITY_TEXTURE};
  uniform vec2 ${Uniforms.VELOCITY_MIN};
  uniform vec2 ${Uniforms.VELOCITY_MAX};
  uniform sampler2D ${Uniforms.COLOR_RAMP_TEXTURE};

  varying vec2 ${Varyings.POSITION};

  void main() {
    vec2 velocity = mix(
      ${Uniforms.VELOCITY_MIN},
      ${Uniforms.VELOCITY_MAX},
      texture2D(${Uniforms.VELOCITY_TEXTURE}, ${Varyings.POSITION}).rg
    );

    float speed_t = length(velocity) / length(${Uniforms.VELOCITY_MAX});

    // color ramp is encoded in a 16x16 texture
    vec2 ramp_pos = vec2(
      fract(16.0 * speed_t),
      floor(16.0 * speed_t) / 16.0
    );

    gl_FragColor = texture2D(${Uniforms.COLOR_RAMP_TEXTURE}, ramp_pos);
  }
`;

/**
 * @classdesc
 * WebGL renderer for tile layers.
 * @extends {WebGLTileLayerRenderer<LayerType>}
 * @api
 */
class WebFieldLayerRenderer extends WebGLTileLayerRenderer {
  /**
   * @param {LayerType} layer The tiled field layer.
   * @param {Options} options The renderer options.
   */
  constructor(layer, options) {
    super(layer, {
      vertexShader: options.tileVertexShader,
      fragmentShader: options.tileFragmentShader,
      cacheSize: options.cacheSize,
      postProcesses: [{}],
    });

    /**
     * @type {WebGLTexture|null}
     * @private
     */
    this.velocityTexture_ = null;

    /**
     * @type {number}
     * @private
     */
    this.particleCountSqrt_ = options.particles
      ? Math.ceil(Math.sqrt(options.particles))
      : 200;

    /**
     * @type {WebGLArrayBuffer}
     * @private
     */
    this.particleIndexBuffer_;

    /**
     * @type {WebGLArrayBuffer}
     * @private
     */
    this.quadBuffer_;

    /**
     * @type {WebGLProgram}
     * @private
     */
    this.particlePositionProgram_;

    /**
     * @type {WebGLTexture}
     * @private
     */
    this.previousPositionTexture_;

    /**
     * @type {WebGLTexture}
     * @private
     */
    this.nextPositionTexture_;

    /**
     * @type {WebGLProgram}
     * @private
     */
    this.particleColorProgram_;

    /**
     * @type {WebGLProgram}
     * @private
     */
    this.textureAlphaProgram_;

    /**
     * @type {WebGLTexture}
     * @private
     */
    this.previousTrailsTexture_;

    /**
     * @type {WebGLTexture}
     * @private
     */
    this.nextTrailsTexture_;

    /**
     * @type {number}
     * @private
     */
    this.fadeOpacity_ = 0.996; // how fast the particle trails fade on each frame

    /**
     * @type {number}
     * @private
     */
    this.speedFactor_ = 0.25;

    /**
     * @type {number}
     * @private
     */
    this.dropRate_ = 0.003; // how often the particles move to a random place

    /**
     * @type {number}
     * @private
     */
    this.dropRateBump_ = 0.01; // drop rate increase relative to individual particle speed
  }

  afterHelperCreated() {
    super.afterHelperCreated();
    const helper = this.helper;

    const gl = helper.getGL();
    this.framebuffer_ = gl.createFramebuffer();

    const particleCount = this.particleCountSqrt_ * this.particleCountSqrt_;
    const particleIndices = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; ++i) {
      particleIndices[i] = i;
    }
    // TODO: helper.createBuffer(particleIndices)
    const particleIndexBuffer = new WebGLArrayBuffer(ARRAY_BUFFER, STATIC_DRAW);
    particleIndexBuffer.setArray(particleIndices);
    helper.flushBufferData(particleIndexBuffer);
    this.particleIndexBuffer_ = particleIndexBuffer;

    const quadIndices = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
    // TODO: helper.createBuffer(quadIndices)
    const quadBuffer = new WebGLArrayBuffer(ARRAY_BUFFER, STATIC_DRAW);
    quadBuffer.setArray(quadIndices);
    helper.flushBufferData(quadBuffer);
    this.quadBuffer_ = quadBuffer;

    const particlePositions = new Uint8Array(particleCount * 4);
    for (let i = 0; i < particlePositions.length; ++i) {
      particlePositions[i] = Math.floor(Math.random() * 256);
    }

    this.previousPositionTexture_ = helper.createTexture(
      [this.particleCountSqrt_, this.particleCountSqrt_],
      particlePositions,
      null,
      true
    );

    this.nextPositionTexture_ = helper.createTexture(
      [this.particleCountSqrt_, this.particleCountSqrt_],
      particlePositions,
      null,
      true
    );

    this.colorRampTexture_ = helper.createTexture(
      [16, 16],
      getColorRamp(defaultRampColors),
      null,
      false
    );

    this.particlePositionProgram_ = helper.getProgram(
      particlePositionFragmentShader,
      quadVertexShader
    );

    this.particleColorProgram_ = helper.getProgram(
      particleColorFragmentShader,
      particleColorVertexShader
    );

    this.textureAlphaProgram_ = helper.getProgram(
      textureAlphaFragmentShader,
      quadVertexShader
    );
  }

  createSizeDependentTextures_() {
    const helper = this.helper;
    const canvas = helper.getCanvas();
    const screenWidth = canvas.width;
    const screenHeight = canvas.height;

    const blank = new Uint8Array(screenWidth * screenHeight * 4);

    this.nextTrailsTexture_ = helper.createTexture(
      [screenWidth, screenHeight],
      blank,
      null,
      true
    );

    this.previousTrailsTexture_ = helper.createTexture(
      [screenWidth, screenHeight],
      blank,
      null,
      true
    );
  }

  beforeFinalize(frameState) {
    // TODO: compare to rendered size
    if (!this.nextTrailsTexture_) {
      this.createSizeDependentTextures_();
    }

    const helper = this.helper;
    const gl = helper.getGL();
    const canvas = helper.getCanvas();
    const screenWidth = canvas.width;
    const screenHeight = canvas.height;
    const size = [screenWidth, screenHeight];

    // copy current frame buffer to the velocity texture
    this.velocityTexture_ = helper.createTexture(
      size,
      null,
      this.velocityTexture_
    );
    gl.copyTexImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      0,
      0,
      screenWidth,
      screenHeight,
      0
    );

    this.drawParticleTrails_();
    this.updateParticlePositions_();

    frameState.animate = true;
  }

  drawParticleTrails_() {
    const helper = this.helper;
    const gl = helper.getGL();

    helper.bindFrameBuffer(this.framebuffer_, this.nextTrailsTexture_);

    this.drawTexture_(this.previousTrailsTexture_, this.fadeOpacity_);
    this.drawParticleColor_();

    helper.bindInitialFrameBuffer();
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // TODO: revisit blending
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.drawTexture_(this.nextTrailsTexture_, 1);
    gl.disable(gl.BLEND);

    const current = this.nextTrailsTexture_;
    this.nextTrailsTexture_ = this.previousTrailsTexture_;
    this.previousTrailsTexture_ = current;
  }

  /**
   * @param {WebGLTexture} texture The texture to draw.
   * @param {number} opacity The opacity.
   */
  drawTexture_(texture, opacity) {
    const helper = this.helper;
    const gl = helper.getGL();

    helper.useProgram(this.textureAlphaProgram_);
    helper.bindTexture(texture, 0, Uniforms.TEXTURE);
    helper.bindAttribute(this.quadBuffer_, Attributes.POSITION, 2);
    this.helper.setUniformFloatValue(Uniforms.OPACITY, opacity);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  drawParticleColor_() {
    const helper = this.helper;
    const gl = helper.getGL();

    helper.useProgram(this.particleColorProgram_);

    const particleCount = this.particleCountSqrt_ * this.particleCountSqrt_;

    helper.bindAttribute(this.particleIndexBuffer_, Attributes.INDEX, 1);

    helper.bindTexture(
      this.previousPositionTexture_,
      0,
      Uniforms.POSITION_TEXTURE
    );
    helper.bindTexture(this.velocityTexture_, 1, Uniforms.VELOCITY_TEXTURE);
    helper.bindTexture(this.colorRampTexture_, 2, Uniforms.COLOR_RAMP_TEXTURE);

    this.helper.setUniformFloatValue(
      Uniforms.PARTICLE_COUNT_SQRT,
      this.particleCountSqrt_
    );

    this.helper.setUniformFloatVec2(Uniforms.VELOCITY_MIN, [-20, -20]);
    this.helper.setUniformFloatVec2(Uniforms.VELOCITY_MAX, [20, 20]);

    gl.drawArrays(gl.POINTS, 0, particleCount);
  }

  updateParticlePositions_() {
    const helper = this.helper;
    const gl = helper.getGL();

    helper.useProgram(this.particlePositionProgram_);

    helper.bindFrameBuffer(this.framebuffer_, this.nextPositionTexture_);

    gl.viewport(0, 0, this.particleCountSqrt_, this.particleCountSqrt_);

    // TODO: remove this
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    helper.bindTexture(
      this.previousPositionTexture_,
      0,
      Uniforms.POSITION_TEXTURE
    );
    helper.bindTexture(this.velocityTexture_, 1, Uniforms.VELOCITY_TEXTURE);
    helper.bindAttribute(this.quadBuffer_, Attributes.POSITION, 2);

    helper.setUniformFloatValue(Uniforms.RANDOM_SEED, Math.random());
    helper.setUniformFloatVec2(Uniforms.VELOCITY_MIN, [-20, -20]);
    helper.setUniformFloatVec2(Uniforms.VELOCITY_MAX, [20, 20]);
    helper.setUniformFloatValue(Uniforms.SPEED_FACTOR, this.speedFactor_);
    helper.setUniformFloatValue(Uniforms.DROP_RATE, this.dropRate_);
    helper.setUniformFloatValue(Uniforms.DROP_RATE_BUMP, this.dropRateBump_);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const current = this.nextPositionTexture_;
    this.nextPositionTexture_ = this.previousPositionTexture_;
    this.previousPositionTexture_ = current;
  }
}

export default WebFieldLayerRenderer;
