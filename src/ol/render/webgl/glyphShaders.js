/**
 * @module ol/render/webgl/glyphShaders
 */
import {COMMON_HEADER} from './ShaderBuilder.js';

export const GlyphAttributes = {
  POSITION: 'a_position',
  LOCAL_POSITION: 'a_localPosition',
  OFFSET: 'a_glyphOffset',
  SIZE: 'a_glyphSize',
  TEX_COORD: 'a_glyphTexCoord',
  COLOR: 'a_glyphColor',
  ANGLE: 'a_glyphAngle',
};

export const GlyphUniforms = {
  ATLAS: 'u_glyphAtlas',
  ATLAS_SIZE: 'u_glyphAtlasSize',
};

/**
 * @return {string} Glyph billboard vertex shader
 */
export function getGlyphVertexShader() {
  return `${COMMON_HEADER}
uniform sampler2D ${GlyphUniforms.ATLAS};
uniform vec2 ${GlyphUniforms.ATLAS_SIZE};

attribute vec2 ${GlyphAttributes.LOCAL_POSITION};
attribute vec2 ${GlyphAttributes.POSITION};
attribute vec2 ${GlyphAttributes.OFFSET};
attribute vec2 ${GlyphAttributes.SIZE};
attribute vec4 ${GlyphAttributes.TEX_COORD};
attribute vec4 ${GlyphAttributes.COLOR};
attribute float ${GlyphAttributes.ANGLE};

varying vec2 v_texCoord;
varying vec4 v_color;

vec2 pxToScreen(vec2 coordPx) {
  return coordPx / u_viewportSizePx / 0.5;
}

void main(void) {
  vec2 halfSizePx = ${GlyphAttributes.SIZE} * 0.5;
  vec2 offsetPx = ${GlyphAttributes.OFFSET} + ${GlyphAttributes.LOCAL_POSITION} * halfSizePx * vec2(1., -1.);
  float angle = ${GlyphAttributes.ANGLE};
  float c = cos(-angle);
  float s = sin(-angle);
  offsetPx = vec2(c * offsetPx.x - s * offsetPx.y, s * offsetPx.x + c * offsetPx.y);
  vec4 center = u_projectionMatrix * vec4(sourceToTarget(${GlyphAttributes.POSITION}), 0.0, 1.0);
  gl_Position = center + vec4(pxToScreen(offsetPx), u_depth, 0.);
  vec4 texCoord = ${GlyphAttributes.TEX_COORD};
  float u = mix(texCoord.s, texCoord.p, ${GlyphAttributes.LOCAL_POSITION}.x * 0.5 + 0.5);
  float v = mix(texCoord.t, texCoord.q, ${GlyphAttributes.LOCAL_POSITION}.y * 0.5 + 0.5);
  v_texCoord = vec2(u, v);
  v_color = ${GlyphAttributes.COLOR};
}`;
}

/**
 * @return {string} Glyph billboard fragment shader
 */
export function getGlyphFragmentShader() {
  return `${COMMON_HEADER}
uniform sampler2D ${GlyphUniforms.ATLAS};
uniform vec2 ${GlyphUniforms.ATLAS_SIZE};

varying vec2 v_texCoord;
varying vec4 v_color;

void main(void) {
  float alpha = texture2D(${GlyphUniforms.ATLAS}, v_texCoord).a;
  if (alpha < 0.05) {
    discard;
  }
  gl_FragColor = vec4(v_color.rgb, v_color.a * alpha * u_globalAlpha);
  gl_FragColor.rgb *= gl_FragColor.a;
  if (u_hitDetection > 0) {
    discard;
  }
}`;
}
