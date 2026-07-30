/**
 * @module ol/webgl/reproj/shaders
 */

import {Uniforms as BaseUniforms} from '../../renderer/webgl/TileLayerBase.js';
import {Attributes, Uniforms as ReprojUniforms} from './common.js';

/**
 * Build a vertex shader that draws a warped triangulation mesh in target
 * (view) projection and samples a source tile texture.
 * @return {string} Vertex shader source.
 */
export function getReprojVertexShader() {
  return `
    attribute vec2 ${Attributes.TARGET_POS};
    attribute vec2 ${Attributes.SOURCE_POS};

    uniform mat4 ${ReprojUniforms.SCREEN_FROM_TARGET};
    uniform float ${BaseUniforms.DEPTH};
    uniform vec4 ${ReprojUniforms.SOURCE_EXTENT};
    uniform float ${ReprojUniforms.GUTTER};
    uniform vec2 ${ReprojUniforms.TEXTURE_PIXEL_SIZE};

    varying vec2 v_textureCoord;
    varying vec2 v_localMapCoord;

    void main() {
      v_localMapCoord = ${Attributes.TARGET_POS};

      float sourceWidth = ${ReprojUniforms.SOURCE_EXTENT}[2] - ${ReprojUniforms.SOURCE_EXTENT}[0];
      float sourceHeight = ${ReprojUniforms.SOURCE_EXTENT}[3] - ${ReprojUniforms.SOURCE_EXTENT}[1];
      float tilePixelWidth = ${ReprojUniforms.TEXTURE_PIXEL_SIZE}[0] - 2.0 * ${ReprojUniforms.GUTTER};
      float tilePixelHeight = ${ReprojUniforms.TEXTURE_PIXEL_SIZE}[1] - 2.0 * ${ReprojUniforms.GUTTER};

      float u = (${Attributes.SOURCE_POS}[0] - ${ReprojUniforms.SOURCE_EXTENT}[0]) / sourceWidth;
      float v = (${ReprojUniforms.SOURCE_EXTENT}[3] - ${Attributes.SOURCE_POS}[1]) / sourceHeight;
      v_textureCoord = vec2(
        (${ReprojUniforms.GUTTER} + u * tilePixelWidth) / ${ReprojUniforms.TEXTURE_PIXEL_SIZE}[0],
        (${ReprojUniforms.GUTTER} + v * tilePixelHeight) / ${ReprojUniforms.TEXTURE_PIXEL_SIZE}[1]
      );

      gl_Position = ${ReprojUniforms.SCREEN_FROM_TARGET} * vec4(
        ${Attributes.TARGET_POS},
        ${BaseUniforms.DEPTH},
        1.0
      );
    }
  `;
}
