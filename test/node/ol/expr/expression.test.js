import expect from '../../expect.js';
import {
  BooleanType,
  CallExpression,
  ColorType,
  LiteralExpression,
  NumberArrayType,
  NumberType,
  SizeType,
  StringType,
  computeGeometryType,
  keyForAccessor,
  newParsingContext,
  parse,
} from '../../../../src/ol/expr/expression.js';
import {
  Circle,
  GeometryCollection,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
} from '../../../../src/ol/geom.js';

describe('ol/expr/expression.js', () => {
  describe('parse()', () => {
    it('parses a literal boolean', () => {
      const expression = parse(true, BooleanType, newParsingContext());
      expect(expression).to.be.a(LiteralExpression);
      expect(expression.type).to.be(BooleanType);
      expect(expression.value).to.be(true);
    });

    it('casts a number to boolean (42)', () => {
      const expression = parse(42, BooleanType, newParsingContext());
      expect(expression).to.be.a(LiteralExpression);
      expect(expression.type).to.be(BooleanType);
      expect(expression.value).to.be(true);
    });

    it('casts a number to boolean (0)', () => {
      const expression = parse(0, BooleanType, newParsingContext());
      expect(expression).to.be.a(LiteralExpression);
      expect(expression.type).to.be(BooleanType);
      expect(expression.value).to.be(false);
    });

    it('casts a string to boolean ("foo")', () => {
      const expression = parse('foo', BooleanType, newParsingContext());
      expect(expression).to.be.a(LiteralExpression);
      expect(expression.type).to.be(BooleanType);
      expect(expression.value).to.be(true);
    });

    it('casts a string to boolean ("")', () => {
      const expression = parse('', BooleanType, newParsingContext());
      expect(expression).to.be.a(LiteralExpression);
      expect(expression.type).to.be(BooleanType);
      expect(expression.value).to.be(false);
    });

    it('parses a literal string', () => {
      const expression = parse('foo', StringType, newParsingContext());
      expect(expression).to.be.a(LiteralExpression);
      expect(expression.type).to.be(StringType);
      expect(expression.value).to.be('foo');
    });

    it('casts a number to a string', () => {
      const expression = parse(42, StringType, newParsingContext());
      expect(expression).to.be.a(LiteralExpression);
      expect(expression.type).to.be(StringType);
      expect(expression.value).to.be('42');
    });

    it('casts a boolean to a string (true)', () => {
      const expression = parse(true, StringType, newParsingContext());
      expect(expression).to.be.a(LiteralExpression);
      expect(expression.type).to.be(StringType);
      expect(expression.value).to.be('true');
    });

    it('casts a boolean to a string (false)', () => {
      const expression = parse(false, StringType, newParsingContext());
      expect(expression).to.be.a(LiteralExpression);
      expect(expression.type).to.be(StringType);
      expect(expression.value).to.be('false');
    });

    it('parses a literal number', () => {
      const expression = parse(42, NumberType, newParsingContext());
      expect(expression).to.be.a(LiteralExpression);
      expect(expression.type).to.be(NumberType);
      expect(expression.value).to.be(42);
    });

    it('parses a literal color (array)', () => {
      const expression = parse([255, 0, 255], ColorType, newParsingContext());
      expect(expression).to.be.a(LiteralExpression);
      expect(expression.type).to.be(ColorType);
      expect(expression.value).to.eql([255, 0, 255, 1]);
    });

    it('parses a literal color (array w/ alpha)', () => {
      const expression = parse([0, 0, 0, 1], ColorType, newParsingContext());
      expect(expression).to.be.a(LiteralExpression);
      expect(expression.type).to.be(ColorType);
      expect(expression.value).to.eql([0, 0, 0, 1]);
    });

    it('parses a literal color (string)', () => {
      const expression = parse('fuchsia', ColorType, newParsingContext());
      expect(expression).to.be.a(LiteralExpression);
      expect(expression.type).to.be(ColorType);
      expect(expression.value).to.eql([255, 0, 255, 1]);
    });

    it('parses a literal number array', () => {
      const expression = parse([10, 20], NumberArrayType, newParsingContext());
      expect(expression).to.be.a(LiteralExpression);
      expect(expression.type).to.be(NumberArrayType);
      expect(expression.value).to.eql([10, 20]);
    });

    it('parses a get expression (string)', () => {
      const context = newParsingContext();
      const type = StringType;
      const path = ['foo'];
      const expression = parse(['get', ...path], type, context);
      expect(expression).to.be.a(CallExpression);
      expect(expression.operator).to.be('get');
      expect(expression.type).to.be(type);
      const key = keyForAccessor(path, type, {});
      expect(context.properties).to.have.property(key);
      const details = context.properties[key];
      expect(details.path).to.eql(path);
      expect(details.type).to.be(type);
      expect(details.slug).to.be('foo_0');
    });

    it('parses a get expression with default', () => {
      const context = newParsingContext();
      const type = NumberType;
      const path = ['foo'];
      const options = {default: 42};
      const expression = parse(['get', ...path, options], type, context);
      expect(expression).to.be.a(CallExpression);
      expect(expression.operator).to.be('get');
      expect(expression.type).to.be(type);
      const key = keyForAccessor(path, type, options);
      expect(context.properties).to.have.property(key);
      const details = context.properties[key];
      expect(details.path).to.eql(path);
      expect(details.type).to.be(type);
      expect(details.slug).to.be('foo_0');
      expect(details.default).to.be(42);
    });

    it('parses a deeply nested get expression', () => {
      const context = newParsingContext();
      const type = StringType;
      const path = ['chicken', 'soup'];
      const expression = parse(['get', ...path], type, context);
      expect(expression).to.be.a(CallExpression);
      expect(expression.operator).to.be('get');
      expect(expression.type).to.be(type);
      const key = keyForAccessor(path, type, {});
      expect(context.properties).to.have.property(key);
      const details = context.properties[key];
      expect(details.path).to.eql(path);
      expect(details.type).to.be(type);
      expect(details.slug).to.be('chicken_soup_0');
    });

    it('parses a deeply nested get expression with default', () => {
      const context = newParsingContext();
      const type = StringType;
      const path = ['chicken', 'soup'];
      const options = {default: 'yum'};
      const expression = parse(['get', ...path, options], type, context);
      expect(expression).to.be.a(CallExpression);
      expect(expression.operator).to.be('get');
      expect(expression.type).to.be(type);
      const key = keyForAccessor(path, type, options);
      expect(context.properties).to.have.property(key);
      const details = context.properties[key];
      expect(details.path).to.eql(path);
      expect(details.type).to.be(type);
      expect(details.slug).to.be('chicken_soup_0');
      expect(details.default).to.be('yum');
    });

    it('parses a var expression', () => {
      const context = newParsingContext();
      const path = ['foo'];
      const type = NumberType;
      const expression = parse(['var', ...path], type, context);
      expect(expression).to.be.a(CallExpression);
      expect(expression.operator).to.be('var');
      expect(expression.type).to.be(type);
      expect(context.variables).to.have.property(
        keyForAccessor(path, type, {}),
      );
    });

    it('parses a var expression with default', () => {
      const context = newParsingContext();
      const path = ['foo'];
      const type = NumberType;
      const options = {default: 100};
      const expression = parse(['var', ...path, options], type, context);
      expect(expression).to.be.a(CallExpression);
      expect(expression.operator).to.be('var');
      expect(expression.type).to.be(type);
      const key = keyForAccessor(path, type, options);
      expect(context.variables).to.have.property(key);
      const details = context.variables[key];
      expect(details.path).to.eql(path);
      expect(details.type).to.be(type);
      expect(details.slug).to.be('foo_0');
      expect(details.default).to.be(100);
    });

    it('parses a deeply nested var expression', () => {
      const context = newParsingContext();
      const path = ['foo', 'bar', 42, 'bam'];
      const type = ColorType;
      const expression = parse(['var', ...path], type, context);
      expect(expression).to.be.a(CallExpression);
      expect(expression.operator).to.be('var');
      expect(expression.type).to.be(type);
      const key = keyForAccessor(path, type, {});
      expect(context.variables).to.have.property(key);
    });

    it('parses a deeply nested var expression with default', () => {
      const context = newParsingContext();
      const path = ['foo', 'bar', 42, 'bam'];
      const type = ColorType;
      const options = {default: 'red'};
      const expression = parse(['var', ...path, options], type, context);
      expect(expression).to.be.a(CallExpression);
      expect(expression.operator).to.be('var');
      expect(expression.type).to.be(type);
      const key = keyForAccessor(path, type, options);
      expect(context.variables).to.have.property(key);
      const details = context.variables[key];
      expect(details.path).to.eql(path);
      expect(details.type).to.be(type);
      expect(details.slug).to.be('foo_bar_42_bam_0');
      expect(details.default).to.be('red');
    });

    it('parses a concat expression', () => {
      const context = newParsingContext();
      const type = StringType;
      const path = ['foo'];
      const expression = parse(
        ['concat', ['get', ...path], ' ', 'random'],
        type,
        context,
      );
      expect(expression).to.be.a(CallExpression);
      expect(expression.operator).to.be('concat');
      expect(expression.type).to.be(type);
      expect(context.properties).to.have.property(
        keyForAccessor(path, type, {}),
      );
    });

    it('is ok to have a concat expression with a string and number', () => {
      const context = newParsingContext();
      const expression = parse(
        ['concat', 'the answer is ', 42],
        StringType,
        context,
      );
      expect(expression).to.be.a(CallExpression);
      expect(expression.operator).to.be('concat');
      expect(expression.type).to.be(StringType);
      expect(expression.args).to.have.length(2);
      expect(expression.args[0].type).to.be(StringType);
      expect(expression.args[1].type).to.be(StringType);
    });

    it('parses id expression', () => {
      const context = newParsingContext();
      const expression = parse(['id'], StringType, context);
      expect(context.featureId).to.be(true);

      expect(expression).to.be.a(CallExpression);
      expect(expression.operator).to.be('id');
      expect(expression.type, StringType);
    });

    it('parses a == expression', () => {
      const context = newParsingContext();
      const type = NumberType;
      const path = ['foo'];
      const expression = parse(
        ['==', ['get', ...path], 42],
        BooleanType,
        context,
      );
      expect(expression).to.be.a(CallExpression);
      expect(expression.operator).to.be('==');
      expect(expression.type).to.be(BooleanType);
      expect(expression.args).to.have.length(2);
      expect(expression.args[0]).to.be.a(CallExpression);
      expect(expression.args[0].type).to.be(NumberType);
      expect(expression.args[1]).to.be.a(LiteralExpression);
      expect(expression.args[1].type).to.be(NumberType);
      expect(context.properties).to.have.property(
        keyForAccessor(path, type, {}),
      );
    });

    describe('case operation', () => {
      it('respects the return type (string or array color)', () => {
        const context = newParsingContext();
        const expression = parse(
          [
            'case',
            ['>', ['get', 'attr'], 3],
            'red',
            ['>', ['get', 'attr'], 1],
            'yellow',
            [255, 0, 0],
          ],
          ColorType,
          context,
        );
        expect(expression).to.be.a(CallExpression);
        expect(expression.operator).to.be('case');
        expect(expression.type).to.be(ColorType);
        expect(expression.args).to.have.length(5);
        expect(expression.args[0].type).to.be(BooleanType);
        expect(expression.args[1].type).to.be(ColorType);
        expect(expression.args[2].type).to.be(BooleanType);
        expect(expression.args[3].type).to.be(ColorType);
        expect(expression.args[4].type).to.be(ColorType);
      });

      it('respects the return type (string color)', () => {
        const expression = parse(
          ['case', true, 'red', false, 'yellow', 'white'],
          ColorType,
          newParsingContext(),
        );
        expect(expression.type).to.be(ColorType);
      });

      it('respects the return type (string)', () => {
        const expression = parse(
          ['case', true, 'red', false, 'yellow', '42'],
          StringType,
          newParsingContext(),
        );
        expect(expression.type).to.be(StringType);
      });

      it('respects the return type (number array)', () => {
        const expression = parse(
          [
            'case',
            true,
            [255, 0, 0],
            false,
            [255, 255, 0],
            false,
            [255, 255, 255],
            [255, 0, 255],
          ],
          NumberArrayType,
          newParsingContext(),
        );
        expect(expression.type).to.be(NumberArrayType);
        expect(expression.args[1].type).to.be(NumberArrayType);
        expect(expression.args[3].type).to.be(NumberArrayType);
        expect(expression.args[5].type).to.be(NumberArrayType);
        expect(expression.args[6].type).to.be(NumberArrayType);
      });

      it('respects the return type (size)', () => {
        const expression = parse(
          [
            'case',
            ['==', ['get', 'A'], 'true'],
            1,
            ['==', ['get', 'B'], 'true'],
            2,
            3,
          ],
          SizeType,
          newParsingContext(),
        );
        expect(expression.type).to.be(SizeType);
        expect(expression.args[1].type).to.be(SizeType);
        expect(expression.args[3].type).to.be(SizeType);
        expect(expression.args[4].type).to.be(SizeType);
      });
    });

    describe('match-number operation', () => {
      it('respects the return type (color)', () => {
        const context = newParsingContext();
        const expression = parse(
          [
            'match-number',
            ['get', 'attr'],
            0,
            'red',
            1,
            'yellow',
            [255, 0, 0, 1],
          ],
          ColorType,
          context,
        );
        expect(expression).to.be.a(CallExpression);
        expect(expression.operator).to.be('match');
        expect(expression.type).to.be(ColorType);
        expect(expression.args).to.have.length(6);
        expect(expression.args[0].type).to.be(NumberType);
        expect(expression.args[1].type).to.be(NumberType);
        expect(expression.args[2].type).to.be(ColorType);
        expect(expression.args[3].type).to.be(NumberType);
        expect(expression.args[4].type).to.be(ColorType);
        expect(expression.args[5].type).to.be(ColorType);
      });

      it('respects the return type (string)', () => {
        const expression = parse(
          ['match', ['get', 'attr'], 0, 'red', 1, 'yellow', 'not_a_color'],
          StringType,
          newParsingContext(),
        );
        expect(expression.type).to.be(StringType);
      });

      it('respects the return type (color array)', () => {
        const expression = parse(
          ['match', ['get', 'attr'], 0, [1, 1, 0], 1, [1, 0, 1], [0, 1, 1]],
          ColorType,
          newParsingContext(),
        );
        expect(expression.type).to.be(ColorType);
      });

      it('respects the return type (color string)', () => {
        const expression = parse(
          ['match', ['get', 'attr'], 0, 'red', 1, 'yellow', 'green'],
          ColorType,
          newParsingContext(),
        );
        expect(expression.type).to.be(ColorType);
      });

      it('respects the return type (size)', () => {
        const expression = parse(
          ['match', ['get', 'shape'], 'light', 0.5, 0.7],
          SizeType,
          newParsingContext(),
        );
        expect(expression.type).to.be(SizeType);
      });
    });

    describe('in operation', () => {
      it('respects the return type (number haystack)', () => {
        const context = newParsingContext();
        const expression = parse(
          ['in', ['get', 'attr'], [0, 50, 100]],
          BooleanType,
          context,
        );
        expect(expression).to.be.a(CallExpression);
        expect(expression.operator).to.be('in');
        expect(expression.type).to.be(BooleanType);
        expect(expression.args).to.have.length(4);
        expect(expression.args[0].type).to.be(NumberType);
        expect(expression.args[1].type).to.be(NumberType);
        expect(expression.args[2].type).to.be(NumberType);
        expect(expression.args[3].type).to.be(NumberType);
      });

      it('respects the return types (string haystack)', () => {
        const context = newParsingContext();
        const expression = parse(
          ['in', ['get', 'attr'], ['literal', ['ab', 'cd', 'ef', 'gh']]],
          BooleanType,
          context,
        );
        expect(expression).to.be.a(CallExpression);
        expect(expression.operator).to.be('in');
        expect(expression.type).to.be(BooleanType);
        expect(expression.args).to.have.length(5);
        expect(expression.args[0].type).to.be(StringType);
        expect(expression.args[1].type).to.be(StringType);
        expect(expression.args[2].type).to.be(StringType);
        expect(expression.args[3].type).to.be(StringType);
        expect(expression.args[4].type).to.be(StringType);
      });
    });

    describe('palette operator', () => {
      it('outputs color type and list of colors as args', () => {
        const expression = parse(
          ['palette', 1, ['red', 'rgba(255, 255, 0, 1)', [0, 255, 255]]],
          ColorType,
          newParsingContext(),
        );
        expect(expression.operator).to.be('palette');
        expect(expression.type).to.be(ColorType);
        expect(expression.args).to.have.length(4);
        expect(expression.args[0].type).to.be(NumberType);
        expect(expression.args[1].type).to.be(ColorType);
        expect(expression.args[2].type).to.be(ColorType);
        expect(expression.args[3].type).to.be(ColorType);
      });
    });

    describe('array operator', () => {
      it('respects the return type (number array)', () => {
        const expression = parse(
          ['array', 1, 2, ['get', 'third'], 4, 5],
          NumberArrayType,
          newParsingContext(),
        );
        expect(expression.operator).to.be('array');
        expect(expression.type).to.be(NumberArrayType);
        expect(expression.args).to.have.length(5);
        expect(expression.args[0].type).to.be(NumberType);
        expect(expression.args[1].type).to.be(NumberType);
        expect(expression.args[2].type).to.be(NumberType);
        expect(expression.args[3].type).to.be(NumberType);
        expect(expression.args[4].type).to.be(NumberType);
      });

      it('respects the return type (color)', () => {
        const expression = parse(
          ['array', 1, 2, ['get', 'blue']],
          ColorType,
          newParsingContext(),
        );
        expect(expression.type).to.be(ColorType);
        expect(expression.args).to.have.length(3);
        expect(expression.args[0].type).to.be(NumberType);
        expect(expression.args[1].type).to.be(NumberType);
        expect(expression.args[2].type).to.be(NumberType);
      });
    });
  });

  describe('parse() errors', () => {
    /**
     * @typedef {Object} Case
     * @property {string} name The case name.
     * @property {Array<*>} expression The expression to parse.
     * @property {import('../../../../src/ol/expr/expression.js').Type} type The expected type.
     * @property {import('../../../../src/ol/expr/expression.js').ParsingContext} [context] The parsing context.
     * @property {RegExp} error The expected error message.
     */

    /**
     * @type {Array<Case>}
     */
    const cases = [
      {
        name: 'interpolate with invalid method',
        expression: ['interpolate', ['invalid'], 0.5, 0, 0, 1, 1],
        type: NumberType,
        error: 'invalid interpolation type: ["invalid"]',
      },
      {
        name: 'interpolate with missing stop output',
        expression: ['interpolate', ['linear'], 0.5, 0, 0, 1, 1, 2, 2, 3],
        type: NumberType,
        error:
          'expected an even number of arguments for operation interpolate, got 9 instead',
      },
      {
        name: 'interpolate with string input',
        expression: ['interpolate', ['linear'], 'oops', 0, 0, 1, 1],
        type: NumberType,
        error:
          'failed to parse argument 1 in interpolate expression: got a string, but expected number',
      },
      {
        name: 'interpolate with string stop input',
        expression: ['interpolate', ['linear'], 0.5, 0, 0, 1, 1, 'x', 2, 3, 3],
        type: NumberType,
        error:
          'failed to parse argument 6 for interpolate expression: got a string, but expected number',
      },
      {
        name: 'interpolate with string base',
        expression: ['interpolate', ['exponential', 'x'], 0.5, 0, 0, 1, 1],
        type: NumberType,
        error:
          'expected a number base for exponential interpolation, got "x" instead',
      },
      {
        name: 'invalid expression',
        expression: null,
        type: NumberType,
        error: 'expression must be an array or a primitive value',
      },
      {
        name: 'invalid argument count (case)',
        expression: ['case', true, 0, false, 1],
        type: NumberType,
        error: 'expected an odd number of arguments for case, got 4 instead',
      },
      {
        name: 'no common output type could be found (case)',
        expression: ['case', true, 'red', false, '42', 123],
        type: NumberType,
        error:
          'failed to parse argument 1 of case expression: got a string, but expected number',
      },
      {
        name: 'mismatched types (match number and string)',
        expression: ['match', ['get', 'attr'], 0, 'red', 1, 123, 456],
        type: NumberType,
        error:
          'failed to parse argument 2 of match expression: got a string, but expected number',
      },
      {
        name: 'mismatched types in array (in)',
        expression: ['in', ['get', 'attr'], [0, 'abc', 50]],
        type: BooleanType,
        error:
          'failed to parse haystack item 1 for "in" expression: got a string, but expected number',
      },
      {
        name: 'invalid argument count (in)',
        expression: ['in', ['get', 'attr'], 'abcd', 'efgh'],
        type: BooleanType,
        error: 'expected 2 arguments for in, got 3',
      },
      {
        name: 'second argument is not an array (in)',
        expression: ['in', ['get', 'attr'], 'abcd'],
        type: BooleanType,
        error: 'the second argument for the "in" operator must be an array',
      },
      {
        name: 'second argument is a string array but not wrapped in a literal operator (in)',
        expression: ['in', ['get', 'attr'], ['abcd', 'efgh', 'ijkl']],
        type: BooleanType,
        error:
          'for the "in" operator, a string array should be wrapped in a "literal" operator to disambiguate from expressions',
      },
      {
        name: 'second argument is a literal value but not an array (in)',
        expression: ['in', ['get', 'attr'], ['literal', 123]],
        type: BooleanType,
        error:
          'failed to parse "in" expression: the literal operator must be followed by an array',
      },
      {
        name: 'first argument is not a number (palette)',
        expression: ['palette', 'abc', ['red', 'green', 'blue']],
        type: ColorType,
        error:
          'failed to parse first argument in palette expression: got a string, but expected number',
      },
      {
        name: 'second argument is not an array (palette)',
        expression: ['palette', ['band', 2], 'red'],
        type: ColorType,
        error: 'the second argument of palette must be an array',
      },
      {
        name: 'second argument is not an array of colors (palette)',
        expression: ['palette', ['band', 2], ['red', 'green', 'abcd']],
        type: ColorType,
        error:
          'failed to parse color at index 2 in palette expression: failed to parse "abcd" as color',
      },
    ];

    for (const {name, expression, type, error, context} of cases) {
      it(`throws for ${name}`, () => {
        const newContext = {...newParsingContext(), ...context};
        expect(() => parse(expression, type, newContext)).to.throwError((e) =>
          expect(e.message).to.eql(error),
        );
      });
    }
  });

  describe('computeGeometryType', () => {
    it('returns empty string for falsy geom', () => {
      expect(computeGeometryType(undefined)).to.eql('');
    });
    it('returns Point for Point geom', () => {
      expect(computeGeometryType(new Point([0, 1]))).to.eql('Point');
    });
    it('returns Polygon for MultiPolygon geom', () => {
      expect(computeGeometryType(new MultiPolygon([]))).to.eql('Polygon');
    });
    it('returns LineString for MultiLineString geom', () => {
      expect(computeGeometryType(new MultiLineString([]))).to.eql('LineString');
    });
    it('returns first geom type in geometry collection', () => {
      expect(
        computeGeometryType(new GeometryCollection([new Circle([0, 1])])),
      ).to.eql('Polygon');
      expect(
        computeGeometryType(new GeometryCollection([new MultiPoint([])])),
      ).to.eql('Point');
    });
    it('returns empty string for empty geom collection', () => {
      expect(computeGeometryType(new GeometryCollection([]))).to.eql('');
    });
  });
});
