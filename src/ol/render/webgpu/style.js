/**
 * @module ol/render/webgpu/style
 */
import {newEvaluationContext} from '../../expr/cpu.js';
import {computeGeometryType, newParsingContext} from '../../expr/expression.js';
import {toFunction as toStyleFunction} from '../../style/Style.js';
import {buildRuleSet, buildStyle} from '../canvas/style.js';

/**
 * @param {import("../../style/flat.js").FlatStyleLike|import("../../style/Style.js").StyleLike} style Style.
 * @param {import("../../style/flat.js").StyleVariables} [variables] Live style variables.
 * @return {import("../../style/Style.js").StyleFunction} Style function.
 */
export function compileStyle(style, variables) {
  if (typeof style === 'function') {
    return style;
  }
  if (isClassicStyle(style)) {
    return toStyleFunction(
      /** @type {import("../../style/Style.js").StyleLike} */ (style),
    );
  }
  return flatStyleToStyleFunction(
    /** @type {import("../../style/flat.js").FlatStyleLike} */ (style),
    variables,
  );
}

/**
 * @param {import("../../style/flat.js").FlatStyleLike} flatStyleLike Style.
 * @param {import("../../style/flat.js").StyleVariables} [variables] Variables.
 * @return {import("../../style/Style.js").StyleFunction} Style function.
 */
function flatStyleToStyleFunction(flatStyleLike, variables) {
  const parsingContext = newParsingContext(variables);
  const evaluationContext = newEvaluationContext();
  if (variables) {
    evaluationContext.variables = variables;
  }

  /** @type {function(import("../../expr/cpu.js").EvaluationContext): Array<import("../../style/Style.js").default>} */
  let evaluate;
  if (!Array.isArray(flatStyleLike)) {
    const evaluator = buildStyle(flatStyleLike, parsingContext);
    evaluate = (context) => {
      const style = evaluator(context);
      return style ? [style] : [];
    };
  } else if (flatStyleLike.length && 'style' in flatStyleLike[0]) {
    evaluate = buildRuleSet(
      /** @type {Array<import("../../style/flat.js").Rule>} */ (flatStyleLike),
      parsingContext,
    );
  } else {
    const evaluators =
      /** @type {Array<import("../../style/flat.js").FlatStyle>} */ (
        flatStyleLike
      ).map((flatStyle) => buildStyle(flatStyle, parsingContext));
    evaluate = (context) => {
      /** @type {Array<import("../../style/Style.js").default>} */
      const styles = [];
      for (const evaluator of evaluators) {
        const style = evaluator(context);
        if (style) {
          styles.push(style);
        }
      }
      return styles;
    };
  }

  return function (feature, resolution) {
    evaluationContext.properties =
      /** @type {import("../../Feature.js").default} */ (
        feature
      ).getPropertiesInternal() ?? {};
    evaluationContext.resolution = resolution;
    const id = feature.getId();
    evaluationContext.featureId = id !== undefined ? id : null;
    const geometry = feature.getGeometry();
    evaluationContext.geometryType = geometry
      ? computeGeometryType(geometry)
      : '';
    const styles = evaluate(evaluationContext);
    if (!styles.length) {
      return undefined;
    }
    return styles.length === 1 ? styles[0] : styles;
  };
}

/**
 * @param {*} style Style.
 * @return {boolean} Classic Style / Style[] / StyleFunction.
 */
function isClassicStyle(style) {
  if (!style) {
    return true;
  }
  if (Array.isArray(style)) {
    if (!style.length) {
      return false;
    }
    return typeof style[0].getFill === 'function';
  }
  return typeof style.getFill === 'function';
}
