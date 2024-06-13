import expect from '../../expect.js';
import {
  BooleanType,
  ColorType,
  NumberArrayType,
  NumberType,
  StringType,
  newParsingContext,
  processAccessorValues,
} from '../../../../src/ol/expr/expression.js';
import {
  buildExpression,
  newEvaluationContext,
} from '../../../../src/ol/expr/cpu.js';

describe('ol/expr/cpu.js', () => {
  describe('buildExpression()', () => {
    /**
     * @typedef {Object} Case
     * @property {string} name The case name.
     * @property {import('../../../../src/ol/expr/expression.js').EncodedExpression} expression The encoded expression.
     * @property {Object<string, any>} [featureProperties] The feature properties.
     * @property {Object<string, any>} [variables] Style variables.
     * @property {string|number} [featureId] The feature id.
     * @property {string} [geometryType] The geometry type.
     * @property {number} [resolution] The resolution.
     * @property {number} type The expression type.
     * @property {import('../../../../src/ol/expr/expression.js').LiteralValue} expected The expected value.
     * @property {number} [tolerance] Optional tolerance for numeric comparisons.
     */

    /**
     * @type {Array<Case>}
     */
    const cases = [
      {
        name: 'get (number)',
        expression: ['get', 'property'],
        featureProperties: {
          property: 42,
        },
        type: NumberType,
        expected: 42,
      },
      {
        name: 'get (number default)',
        expression: ['get', 'property', {default: 100}],
        featureProperties: {},
        type: NumberType,
        expected: 100,
      },
      {
        name: 'get (nested)',
        expression: ['get', 'deeply', 'nested', 'property'],
        featureProperties: {
          deeply: {
            nested: {
              property: 42,
            },
          },
        },
        type: NumberType,
        expected: 42,
      },
      {
        name: 'get (nested default)',
        expression: ['get', 'deeply', 'nested', 'property', {default: 100}],
        featureProperties: {
          deeply: {
            nested: {},
          },
        },
        type: NumberType,
        expected: 100,
      },
      {
        name: 'get number (excess key)',
        expression: ['get', 'property', 'nothing_here'],
        featureProperties: {
          property: 42,
        },
        type: NumberType,
        expected: undefined,
      },
      {
        name: 'get array item',
        expression: ['get', 'values', 1],
        featureProperties: {
          values: [17, 42],
        },
        type: NumberType,
        expected: 42,
      },
      {
        name: 'get array',
        expression: ['get', 'values'],
        featureProperties: {
          values: [17, 42],
        },
        type: NumberArrayType,
        expected: [17, 42],
      },
      {
        name: 'get color',
        expression: ['get', 'color'],
        featureProperties: {
          color: 'red',
        },
        type: ColorType,
        expected: [255, 0, 0, 1],
      },
      {
        name: 'get color default',
        expression: ['get', 'nope', {default: 'blue'}],
        featureProperties: {
          color: 'red',
        },
        type: ColorType,
        expected: [0, 0, 255, 1],
      },
      {
        name: 'var (number)',
        expression: ['var', 'property'],
        variables: {
          property: 42,
        },
        type: NumberType,
        expected: 42,
      },
      {
        name: 'var (number default)',
        expression: ['var', 'property', {default: 100}],
        variables: {},
        type: NumberType,
        expected: 100,
      },
      {
        name: 'var (deeply nested string)',
        expression: ['var', 'deeply', 'nested', 'property'],
        variables: {
          deeply: {
            nested: {
              property: 'foo',
            },
          },
        },
        type: StringType,
        expected: 'foo',
      },
      {
        name: 'var (deeply nested color)',
        expression: ['var', 'deeply', 'nested', 'property'],
        variables: {
          deeply: {
            nested: {
              property: 'fuchsia',
            },
          },
        },
        type: ColorType,
        expected: [255, 0, 255, 1],
      },
      {
        name: 'boolean literal (true)',
        expression: true,
        type: BooleanType,
        expected: true,
      },
      {
        name: 'boolean literal (false)',
        expression: false,
        type: BooleanType,
        expected: false,
      },
      {
        name: 'number assertion',
        expression: ['number', 'not', 'a', 'number', 42, false],
        type: NumberType,
        expected: 42,
      },
      {
        name: 'string assertion',
        expression: ['string', 42, 'chicken', false],
        type: StringType,
        expected: 'chicken',
      },
      {
        name: 'id (number)',
        type: NumberType,
        expression: ['id'],
        featureId: 42,
        expected: 42,
      },
      {
        name: 'id (string)',
        type: StringType,
        expression: ['id'],
        featureId: 'forty-two',
        expected: 'forty-two',
      },
      {
        name: 'geometry-type',
        type: StringType,
        expression: ['geometry-type'],
        geometryType: 'LineString',
        expected: 'LineString',
      },
      {
        name: 'geometry-type (empty)',
        type: StringType,
        expression: ['geometry-type'],
        geometryType: '',
        expected: '',
      },
      {
        name: 'resolution',
        expression: ['resolution'],
        resolution: 10,
        type: NumberType,
        expected: 10,
      },
      {
        name: 'resolution (comparison)',
        expression: ['>', ['resolution'], 10],
        resolution: 11,
        type: BooleanType,
        expected: true,
      },
      {
        name: 'concat (2 arguments)',
        expression: ['concat', ['get', 'val'], ' '],
        featureProperties: {
          val: 'test',
        },
        type: StringType,
        expected: 'test ',
      },
      {
        name: 'concat (3 arguments)',
        expression: ['concat', ['get', 'val'], ' ', ['get', 'val2']],
        featureProperties: {
          val: 'test',
          val2: 'another',
        },
        type: StringType,
        expected: 'test another',
      },
      {
        name: 'concat (with id)',
        expression: ['concat', 'Feature ', ['id']],
        featureId: 'foo',
        type: StringType,
        expected: 'Feature foo',
      },
      {
        name: 'concat (with string and number)',
        expression: ['concat', 'number ', 1],
        type: StringType,
        expected: 'number 1',
      },
      {
        name: 'coalesce (2 arguments, first has a value)',
        expression: ['coalesce', ['get', 'val'], 'default'],
        featureProperties: {
          val: 'test',
        },
        type: StringType,
        expected: 'test',
      },
      {
        name: 'coalesce (2 arguments, first has no value)',
        expression: ['coalesce', ['get', 'val'], 'default'],
        featureProperties: {},
        type: StringType,
        expected: 'default',
      },
      {
        name: 'coalesce (several arguments, first few have no value)',
        expression: [
          'coalesce',
          ['get', 'val'],
          ['get', 'beer'],
          ['get', 'present'],
          'last resort',
        ],
        featureProperties: {
          present: 'hello world',
        },
        type: StringType,
        expected: 'hello world',
      },
      {
        name: 'any (true)',
        expression: ['any', ['get', 'nope'], ['get', 'yep'], ['get', 'nope']],
        featureProperties: {nope: false, yep: true},
        type: BooleanType,
        expected: true,
      },
      {
        name: 'any (false)',
        expression: ['any', ['get', 'nope'], false, ['!', ['get', 'yep']]],
        featureProperties: {nope: false, yep: true},
        type: BooleanType,
        expected: false,
      },
      {
        name: 'all (true)',
        expression: ['all', ['get', 'yep'], true, ['!', ['get', 'nope']]],
        featureProperties: {yep: true, nope: false},
        type: BooleanType,
        expected: true,
      },
      {
        name: 'all (false)',
        expression: ['all', ['!', ['get', 'nope']], ['get', 'yep'], false],
        featureProperties: {nope: false, yep: true},
        type: BooleanType,
        expected: false,
      },
      {
        name: 'not (true)',
        expression: ['!', ['get', 'nope']],
        featureProperties: {nope: false, yep: true},
        type: BooleanType,
        expected: true,
      },
      {
        name: 'not (false)',
        expression: ['!', ['get', 'yep']],
        featureProperties: {nope: false, yep: true},
        type: BooleanType,
        expected: false,
      },
      {
        name: 'equal comparison (true)',
        expression: ['==', ['get', 'number'], 42],
        featureProperties: {number: 42},
        type: BooleanType,
        expected: true,
      },
      {
        name: 'equal comparison (false)',
        expression: ['==', ['get', 'number'], 1],
        featureProperties: {number: 42},
        type: BooleanType,
        expected: false,
      },
      {
        name: 'greater than comparison (true)',
        type: BooleanType,
        expression: ['>', ['get', 'number'], 40],
        featureProperties: {number: 42},
        expected: true,
      },
      {
        name: 'greater than comparison (false)',
        expression: ['>', ['get', 'number'], 44],
        featureProperties: {number: 42},
        type: BooleanType,
        expected: false,
      },
      {
        name: 'greater than or equal comparison (true)',
        expression: ['>=', ['get', 'number'], 42],
        featureProperties: {number: 42},
        type: BooleanType,
        expected: true,
      },
      {
        name: 'greater than or equal comparison (false)',
        expression: ['>=', ['get', 'number'], 43],
        featureProperties: {number: 42},
        type: BooleanType,
        expected: false,
      },
      {
        name: 'less than comparison (true)',
        expression: ['<', ['get', 'number'], 44],
        featureProperties: {number: 42},
        type: BooleanType,
        expected: true,
      },
      {
        name: 'less than comparison (false)',
        expression: ['<', ['get', 'number'], 1],
        featureProperties: {number: 42},
        type: BooleanType,
        expected: false,
      },
      {
        name: 'less than or equal comparison (true)',
        expression: ['<=', ['get', 'number'], 42],
        featureProperties: {number: 42},
        type: BooleanType,
        expected: true,
      },
      {
        name: 'less than or equal comparison (false)',
        expression: ['<=', ['get', 'number'], 41],
        featureProperties: {number: 42},
        type: BooleanType,
        expected: false,
      },
      {
        name: 'addition',
        expression: ['+', ['get', 'number'], 1],
        featureProperties: {number: 42},
        type: NumberType,
        expected: 43,
      },
      {
        name: 'addition (many values)',
        expression: ['+', 1, 2, 3, 4],
        type: NumberType,
        expected: 1 + 2 + 3 + 4,
      },
      {
        name: 'subtraction',
        expression: ['-', ['get', 'number'], 1],
        featureProperties: {number: 42},
        type: NumberType,
        expected: 41,
      },
      {
        name: 'subtraction',
        expression: ['-', ['get', 'number'], 1],
        featureProperties: {number: 42},
        type: NumberType,
        expected: 41,
      },
      {
        name: 'multiplication',
        expression: ['*', ['get', 'number'], 2],
        featureProperties: {number: 42},
        type: NumberType,
        expected: 84,
      },
      {
        name: 'multiplication (many values)',
        expression: ['*', 2, 4, 6, 8],
        type: NumberType,
        expected: 2 * 4 * 6 * 8,
      },
      {
        name: 'division',
        expression: ['/', ['get', 'number'], 2],
        featureProperties: {number: 42},
        type: NumberType,
        expected: 21,
      },
      {
        name: 'clamp (min)',
        expression: ['clamp', -10, 0, 50],
        type: NumberType,
        expected: 0,
      },
      {
        name: 'clamp (max)',
        expression: ['clamp', 100, 0, 50],
        type: NumberType,
        expected: 50,
      },
      {
        name: 'clamp (mid)',
        expression: ['clamp', 25, 0, 50],
        type: NumberType,
        expected: 25,
      },
      {
        name: 'clamp (mid)',
        expression: ['clamp', 25, 0, 50],
        type: NumberType,
        expected: 25,
      },
      {
        name: 'mod',
        expression: ['%', ['get', 'number'], 10],
        featureProperties: {number: 42},
        type: NumberType,
        expected: 2,
      },
      {
        name: 'pow',
        expression: ['^', ['get', 'number'], 2],
        featureProperties: {number: 42},
        type: NumberType,
        expected: 1764,
      },
      {
        name: 'abs',
        expression: ['abs', ['get', 'number']],
        featureProperties: {number: -42},
        type: NumberType,
        expected: 42,
      },
      {
        name: 'floor',
        expression: ['floor', ['get', 'number']],
        featureProperties: {number: 42.9},
        type: NumberType,
        expected: 42,
      },
      {
        name: 'ceil',
        expression: ['ceil', ['get', 'number']],
        featureProperties: {number: 42.1},
        type: NumberType,
        expected: 43,
      },
      {
        name: 'round',
        expression: ['round', ['get', 'number']],
        featureProperties: {number: 42.5},
        type: NumberType,
        expected: 43,
      },
      {
        name: 'sin',
        expression: ['sin', ['get', 'angle']],
        featureProperties: {angle: Math.PI / 2},
        type: NumberType,
        expected: 1,
      },
      {
        name: 'cos',
        expression: ['cos', ['get', 'angle']],
        featureProperties: {angle: Math.PI},
        type: NumberType,
        expected: -1,
      },
      {
        name: 'atan (1)',
        expression: ['atan', 1],
        type: NumberType,
        expected: Math.atan(1),
      },
      {
        name: 'atan (2)',
        expression: ['atan', 1, 2],
        type: NumberType,
        expected: Math.atan2(1, 2),
      },
      {
        name: 'sqrt',
        expression: ['sqrt', ['get', 'number']],
        featureProperties: {number: 42},
        type: NumberType,
        expected: Math.sqrt(42),
      },
      {
        name: 'case (first condition)',
        expression: [
          'case',
          ['<', ['get', 'value'], 42],
          'small',
          ['<', ['get', 'value'], 100],
          'big',
          'bigger',
        ],
        featureProperties: {value: 40},
        type: StringType,
        expected: 'small',
      },
      {
        name: 'case (second condition)',
        expression: [
          'case',
          ['<', ['get', 'value'], 42],
          'small',
          ['<', ['get', 'value'], 100],
          'big',
          'bigger',
        ],
        featureProperties: {value: 50},
        type: StringType,
        expected: 'big',
      },
      {
        name: 'case (fallback)',
        expression: [
          'case',
          ['<', ['get', 'value'], 42],
          'small',
          ['<', ['get', 'value'], 100],
          'big',
          'biggest',
        ],
        featureProperties: {value: 200},
        type: StringType,
        expected: 'biggest',
      },
      {
        name: 'match (string match)',
        expression: ['match', ['get', 'string'], 'foo', 'got foo', 'got other'],
        featureProperties: {string: 'foo'},
        type: StringType,
        expected: 'got foo',
      },
      {
        name: 'match (string fallback)',
        expression: ['match', ['get', 'string'], 'foo', 'got foo', 'got other'],
        featureProperties: {string: 'bar'},
        type: StringType,
        expected: 'got other',
      },
      {
        name: 'match (number match)',
        expression: ['match', ['get', 'number'], 42, 'got 42', 'got other'],
        featureProperties: {
          number: 42,
        },
        type: StringType,
        expected: 'got 42',
      },
      {
        name: 'match (number fallback)',
        expression: ['match', ['get', 'number'], 42, 'got 42', 'got other'],
        featureProperties: {number: 43},
        type: StringType,
        expected: 'got other',
      },
      {
        name: 'interpolate (linear number)',
        expression: [
          'interpolate',
          ['linear'],
          ['get', 'number'],
          0,
          0,
          1,
          100,
        ],
        featureProperties: {number: 0.5},
        type: NumberType,
        expected: 50,
      },
      {
        name: 'interpolate (exponential base 2 number)',
        expression: ['interpolate', ['exponential', 2], 0.5, 0, 0, 1, 100],
        type: NumberType,
        tolerance: 1e-6,
        expected: 41.42135623730952,
      },
      {
        name: 'interpolate (linear no delta)',
        expression: ['interpolate', ['linear'], 42, 42, 1, 42, 2],
        type: NumberType,
        expected: 1,
      },
      {
        name: 'interpolate (linear color)',
        expression: ['interpolate', ['linear'], 0.5, 0, 'red', 1, [0, 255, 0]],
        type: ColorType,
        expected: [219, 170, 0, 1],
      },
      {
        name: 'to-string (string)',
        expression: ['to-string', 'foo'],
        type: StringType,
        expected: 'foo',
      },
      {
        name: 'to-string (number)',
        expression: ['to-string', 42.9],
        type: StringType,
        expected: '42.9',
      },
      {
        name: 'to-string (boolean)',
        expression: ['to-string', 1 < 2],
        type: StringType,
        expected: 'true',
      },
      {
        name: 'to-string (array)',
        expression: ['to-string', ['get', 'fill']],
        featureProperties: {fill: [0, 255, 0]},
        type: StringType,
        expected: '0,255,0',
      },
      {
        name: 'in (true)',
        expression: ['in', 3, [1, 2, 3]],
        type: BooleanType,
        expected: true,
      },
      {
        name: 'in (false)',
        expression: ['in', 'yellow', ['literal', ['red', 'green', 'blue']]],
        type: BooleanType,
        expected: false,
      },
      {
        name: 'between (true)',
        expression: ['between', 3, 3, 5],
        type: BooleanType,
        expected: true,
      },
      {
        name: 'between (false)',
        expression: ['between', 3, 4, 5],
        type: BooleanType,
        expected: false,
      },
    ];

    for (const c of cases) {
      it(`works for ${c.name}`, () => {
        const parsingContext = newParsingContext();
        const evaluator = buildExpression(c.expression, c.type, parsingContext);
        const evaluationContext = newEvaluationContext();
        if (c.featureProperties) {
          evaluationContext.properties = processAccessorValues(
            c.featureProperties,
            parsingContext.properties,
          );
        }
        if (c.variables) {
          evaluationContext.variables = processAccessorValues(
            c.variables,
            parsingContext.variables,
          );
        }
        if ('featureId' in c) {
          evaluationContext.featureId = c.featureId;
        }
        if ('geometryType' in c) {
          evaluationContext.geometryType = c.geometryType;
        }
        if ('resolution' in c) {
          evaluationContext.resolution = c.resolution;
        }
        const value = evaluator(evaluationContext);
        if (c.tolerance !== undefined) {
          expect(value).to.roughlyEqual(c.expected, c.tolerance);
        } else {
          expect(value).to.eql(c.expected);
        }
      });
    }
  });

  describe('interpolate expressions', () => {
    /**
     * @typedef {Object} InterpolateTest
     * @property {Array} method The interpolation method.
     * @property {Array} stops The stops.
     * @property {Array<Array>} cases The test cases.
     */

    /**
     * @type {Array<InterpolateTest}
     */
    const tests = [
      {
        method: ['linear'],
        stops: [-1, -1, 0, 0, 1, 100, 2, 1000],
        cases: [
          [-2, -1],
          [-1, -1],
          [-0.5, -0.5],
          [0, 0],
          [0.25, 25],
          [0.5, 50],
          [0.9, 90],
          [1, 100],
          [1.5, 550],
          [2, 1000],
          [3, 1000],
        ],
      },
      {
        method: ['exponential', 2],
        stops: [0, 0, 1, 100],
        cases: [
          [-1, 0],
          [0, 0],
          [0.25, 18.920711500272102],
          [0.5, 41.42135623730952],
          [0.9, 86.60659830736148],
          [1, 100],
          [1.5, 100],
        ],
      },
      {
        method: ['exponential', 3],
        stops: [0, 0, 1, 100],
        cases: [
          [-1, 0],
          [0, 0],
          [0.25, 15.80370064762462],
          [0.5, 36.60254037844386],
          [0.9, 84.39376897611433],
          [1, 100],
          [1.5, 100],
        ],
      },
    ];

    for (const t of tests) {
      const expression = [
        'interpolate',
        t.method,
        ['var', 'input'],
        ...t.stops,
      ];
      const type = typeof t.stops[1] === 'number' ? NumberType : ColorType;
      describe(JSON.stringify(expression), () => {
        const parsingContext = newParsingContext();
        const evaluator = buildExpression(expression, type, parsingContext);
        const evaluationContext = newEvaluationContext();
        for (const [input, output] of t.cases) {
          it(`works for ${input}`, () => {
            evaluationContext.variables = processAccessorValues(
              {input},
              parsingContext.variables,
            );
            const got = evaluator(evaluationContext);
            expect(got).to.roughlyEqual(output, 1e-6);
          });
        }
      });
    }
  });
});
