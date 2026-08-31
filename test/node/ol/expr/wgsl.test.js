import {assert} from 'chai';
import {
  ColorType,
  NumberType,
  newParsingContext,
} from '../../../../src/ol/expr/expression.js';
import {
  arrayToWgsl,
  compileTileColorPipeline,
  expressionToWgsl,
  newCompilationContext,
  numberToWgsl,
} from '../../../../src/ol/expr/wgsl.js';

describe('ol/expr/wgsl', () => {
  describe('numberToWgsl()', () => {
    it('adds a fraction when missing', () => {
      assert.strictEqual(numberToWgsl(1), '1.0');
      assert.strictEqual(numberToWgsl(1.5), '1.5');
    });
  });

  describe('arrayToWgsl()', () => {
    it('outputs typed vec constructors', () => {
      assert.strictEqual(arrayToWgsl([1, 0]), 'vec2<f32>(1.0, 0.0)');
    });
  });

  describe('expressionToWgsl()', () => {
    it('compiles arithmetic', () => {
      const context = newCompilationContext();
      const wgsl = expressionToWgsl(
        context,
        ['+', 1, ['*', 2, 3]],
        NumberType,
        newParsingContext(),
      );
      assert.strictEqual(wgsl, '(1.0 + (2.0 * 3.0))');
    });

    it('compiles a color literal', () => {
      const context = newCompilationContext();
      const wgsl = expressionToWgsl(
        context,
        [255, 0, 0, 1],
        ColorType,
        newParsingContext(),
      );
      assert.include(wgsl, 'vec4<f32>');
    });
  });

  describe('compileTileColorPipeline()', () => {
    it('emits a brightness adjustment', () => {
      const {fragmentBody} = compileTileColorPipeline({brightness: 0.2});
      assert.include(fragmentBody, '0.2');
    });
  });
});
