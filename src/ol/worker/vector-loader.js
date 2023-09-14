/**
 * @module ol/worker/vector-loader
 */

import {MessageServer, channels} from '../messages.js';

/**
 * @typedef {LoadFeaturesRequest} LoaderRequest
 */

/**
 * @typedef {LoadFeaturesResponse} LoaderResponse
 */

/**
 * @typedef {Object} LoadFeaturesRequest
 * @property {'loadFeatures'} type The message type.
 * @property {string} url The URL.
 */

/**
 * @typedef {import("geojson").FeatureCollection} LoadFeaturesResponse
 */

/**
 * @type {any}
 */
const worker = self;

/**
 * @param {string} url The URL.
 * @return {Promise<import("geojson").FeatureCollection>} A promise that resolves with the feature collection.
 */
async function loadFeatures(url) {
  const response = await fetch(url);
  return response.json();
}

/**
 * @param {LoaderRequest} request The request message.
 * @return {Promise<import("../messages.js").RelayResponse<LoaderResponse>>} The response message.
 */
async function handler(request) {
  switch (request.type) {
    case 'loadFeatures': {
      const collection = await loadFeatures(request.url);
      return {response: collection};
    }
    default: {
      throw new Error('Unknown message type: ' + request.type);
    }
  }
}

new MessageServer({
  channel: channels.VECTOR_LOADER,
  worker: worker,
  handler,
});

/**
 * @type {function(): Worker}
 */
export let create;
