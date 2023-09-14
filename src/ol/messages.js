/**
 * @module ol/messages
 */

/**
 * @type {Object<string, string>} The message channels.
 */
export const channels = {
  /**
   * @type {string} The vector loader channel.
   */
  VECTOR_LOADER: 'vector-loader',
};

/**
 * @template {any} T
 * @typedef {Object} ClientRequest
 * @property {'request'} type The message type.
 * @property {string} channel The message channel.
 * @property {string} id The message id.
 * @property {T} message The message.
 */

/**
 * @template {any} T
 * @typedef {Object} ServerResponse
 * @property {'response'} type The message type.
 * @property {string} channel The message channel.
 * @property {string} id The message id.
 * @property {T} message The message.
 */

/**
 * @typedef {Object} ServerError
 * @property {'error'} type The message type.
 * @property {string} channel The message channel.
 * @property {string} id The message id.
 * @property {string} message The error message.
 * @property {string} stack The error stack.
 */

/**
 * @template {any} T
 * @typedef {Object} RelayRequest
 * @property {T} request The request data.
 * @property {Array<Transferable>} [transfer] The transferrables.
 */

/**
 * @template {any} T
 * @typedef {Object} RelayResponse
 * @property {T} response The response data.
 * @property {Array<Transferable>} [transfer] The transferrables.
 */

/**
 * @template {any} Request
 * @template {any} Response
 * @typedef {function(Request): Promise<RelayResponse<Response>>} RequestHandler
 */

/**
 * @template {any} Request
 * @template {any} Response
 * @typedef {Object} ServerOptions
 * @property {string} channel The message channel.
 * @property {Worker} worker The worker.
 * @property {RequestHandler<Request, Response>} handler The request handler.
 */

/**
 * @classdesc A server that responds to messages from a client using the
 * same channel.  A server runs in a worker and receives messages from a client
 * in the main thread.
 *
 * @template {any} Request
 * @template {any} Response
 */
export class MessageServer {
  /**
   * @param {ServerOptions<Request, Response>} options The options.
   */
  constructor({channel, worker, handler}) {
    /**
     * @private
     * @type {string}
     */
    this.channel_ = channel;

    /**
     * @private
     * @type {RequestHandler<Request, Response>}
     */
    this.requestHandler_ = handler;

    /**
     * @private
     * @type {Worker}
     */
    this.worker_ = worker;

    this.worker_.addEventListener('message', ({data}) =>
      this.handleRequest_(data)
    );
  }

  /**
   * @param {ClientRequest<Request>} requestData The message.
   */
  async handleRequest_(requestData) {
    if (requestData.channel !== this.channel_) {
      return;
    }

    if (requestData.type !== 'request') {
      throw new Error(`unexpected message type: ${requestData.type}`);
    }

    /**
     * @type {RelayResponse<Response>}
     */
    let relayResponse;

    /**
     * @type {Error}
     */
    let error;

    try {
      relayResponse = await this.requestHandler_(requestData.message);
    } catch (err) {
      error = err;
    }

    if (error) {
      /**
       * @type {ServerError}
       */
      const errorMessage = {
        channel: this.channel_,
        type: 'error',
        id: requestData.id,
        message: error.message,
        stack: error.stack,
      };
      this.worker_.postMessage(errorMessage);
      return;
    }

    /**
     * @type {ServerResponse<Response>}
     */
    const responseData = {
      channel: this.channel_,
      type: 'response',
      id: requestData.id,
      message: relayResponse.response,
    };

    try {
      this.worker_.postMessage(responseData, relayResponse.transfer);
    } catch (err) {
      /**
       * @type {ServerError}
       */
      const errorMessage = {
        channel: this.channel_,
        type: 'error',
        id: requestData.id,
        message: err.message,
        stack: err.stack,
      };
      this.worker_.postMessage(errorMessage);
      return;
    }
  }
}

/**
 * @typedef {Object} PendingRequest
 * @property {function(any): void} resolve The resolve function.
 * @property {function(any): void} reject The reject function.
 */

/**
 * @typedef {Object} MessageClientOptions
 * @property {string} channel The message channel.
 * @property {Worker} worker The worker to message.
 */

let clientCount = 0;

/**
 * @classdesc A client that sends messages to a server using the same channel.  A
 * client runs on the main thread and sends messages to a server in a worker.
 *
 * @template {any} Request
 * @template {any} Response
 */
export class MessageClient {
  /**
   * @param {MessageClientOptions} options The options.
   */
  constructor({channel, worker}) {
    /**
     * @private
     * @type {string}
     */
    this.channel_ = channel;

    /**
     * @private
     * @type {Worker}
     */
    this.worker_ = worker;

    /**
     * @private
     * @type {number}
     */
    this.id_ = clientCount;
    clientCount += 1;

    /**
     * @private
     * @type {number}
     */
    this.messageCount_ = 0;

    /**
     * @private
     * @type {Object<number, PendingRequest>}
     */
    this.pendingRequests_ = {};

    this.worker_.addEventListener('message', ({data}) =>
      this.handleResponse_(data)
    );
  }

  /**
   * @private
   * @param {ServerResponse<Response>|ServerError} data The message.
   */
  handleResponse_(data) {
    if (data.channel !== this.channel_) {
      return;
    }

    const pending = this.pendingRequests_[data.id];
    if (!pending) {
      throw new Error('received response without a request');
    }

    delete this.pendingRequests_[data.id];

    if (data.type === 'error') {
      const error = new Error(data.message);
      error.stack = data.stack;
      pending.reject(error);
      return;
    }

    if (data.type === 'response') {
      pending.resolve(data.message);
      return;
    }
  }

  /**
   * @param {RelayRequest<Request>} data The message and any transferrables.
   * @return {Promise<Response>} The response message.
   */
  send({request, transfer}) {
    this.messageCount_ += 1;
    const id = this.id_ + '.' + this.messageCount_;
    return new Promise((resolve, reject) => {
      /**
       * @type {ClientRequest<Request>}
       */
      const data = {
        channel: this.channel_,
        type: 'request',
        id,
        message: request,
      };

      this.worker_.postMessage(data, transfer);

      this.pendingRequests_[id] = {resolve, reject};
    });
  }
}
