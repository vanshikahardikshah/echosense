"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "node_modules/ws/lib/constants.js"(exports2, module2) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module2.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
      kListener: /* @__PURE__ */ Symbol("kListener"),
      kStatusCode: /* @__PURE__ */ Symbol("status-code"),
      kWebSocket: /* @__PURE__ */ Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "node_modules/ws/lib/buffer-util.js"(exports2, module2) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask2, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask2[i & 3];
      }
    }
    function _unmask(buffer, mask2) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask2[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module2.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require("bufferutil");
        module2.exports.mask = function(source, mask2, output, offset, length) {
          if (length < 48) _mask(source, mask2, output, offset, length);
          else bufferUtil.mask(source, mask2, output, offset, length);
        };
        module2.exports.unmask = function(buffer, mask2) {
          if (buffer.length < 32) _unmask(buffer, mask2);
          else bufferUtil.unmask(buffer, mask2);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "node_modules/ws/lib/limiter.js"(exports2, module2) {
    "use strict";
    var kDone = /* @__PURE__ */ Symbol("kDone");
    var kRun = /* @__PURE__ */ Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module2.exports = Limiter;
  }
});

// node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "node_modules/ws/lib/permessage-deflate.js"(exports2, module2) {
    "use strict";
    var zlib = require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = /* @__PURE__ */ Symbol("permessage-deflate");
    var kTotalLength = /* @__PURE__ */ Symbol("total-length");
    var kCallback = /* @__PURE__ */ Symbol("callback");
    var kBuffers = /* @__PURE__ */ Symbol("buffers");
    var kError = /* @__PURE__ */ Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && (typeof params.client_max_window_bits === "number" ? opts.clientMaxWindowBits > params.client_max_window_bits : !params.client_max_window_bits)) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module2.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "node_modules/ws/lib/validation.js"(exports2, module2) {
    "use strict";
    var { isUtf8 } = require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module2.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module2.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = require("utf-8-validate");
        module2.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "node_modules/ws/lib/receiver.js"(exports2, module2) {
    "use strict";
    var { Writable } = require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._numFragments = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
          const error = this.createError(
            RangeError,
            "Too many message fragments",
            false,
            1008,
            "WS_ERR_TOO_MANY_BUFFERED_PARTS"
          );
          cb(error);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._numFragments = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module2.exports = Receiver2;
  }
});

// node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "node_modules/ws/lib/sender.js"(exports2, module2) {
    "use strict";
    var { Duplex } = require("stream");
    var { randomFillSync } = require("crypto");
    var {
      types: { isUint8Array }
    } = require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = /* @__PURE__ */ Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask2;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask2 = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask2);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask2[0] = randomPool[randomPoolPointer++];
            mask2[1] = randomPool[randomPoolPointer++];
            mask2[2] = randomPool[randomPoolPointer++];
            mask2[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask2[0] | mask2[1] | mask2[2] | mask2[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask2[0];
        target[offset - 3] = mask2[1];
        target[offset - 2] = mask2[2];
        target[offset - 1] = mask2[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask2, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask2, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask2, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask: mask2,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask2, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask: mask2,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask2, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask: mask2,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module2.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "node_modules/ws/lib/event-target.js"(exports2, module2) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = /* @__PURE__ */ Symbol("kCode");
    var kData = /* @__PURE__ */ Symbol("kData");
    var kError = /* @__PURE__ */ Symbol("kError");
    var kMessage = /* @__PURE__ */ Symbol("kMessage");
    var kReason = /* @__PURE__ */ Symbol("kReason");
    var kTarget = /* @__PURE__ */ Symbol("kTarget");
    var kType = /* @__PURE__ */ Symbol("kType");
    var kWasClean = /* @__PURE__ */ Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module2.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "node_modules/ws/lib/extension.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module2.exports = { format, parse };
  }
});

// node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "node_modules/ws/lib/websocket.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var https2 = require("https");
    var http2 = require("http");
    var net = require("net");
    var tls = require("tls");
    var { randomBytes: randomBytes3, createHash: createHash2 } = require("crypto");
    var { Duplex, Readable } = require("stream");
    var { URL: URL3 } = require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = /* @__PURE__ */ Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            if (!options || options.protocols === void 0) {
              protocols = [];
            } else if (Array.isArray(options.protocols)) {
              protocols = options.protocols;
            } else {
              protocols = [options.protocols];
            }
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              if (options.protocols === void 0) {
                protocols = [];
              } else if (Array.isArray(options.protocols)) {
                protocols = options.protocols;
              } else {
                protocols = [options.protocols];
              }
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        this._readyState = _WebSocket.CLOSING;
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask2, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask2 = void 0;
        } else if (typeof mask2 === "function") {
          cb = mask2;
          mask2 = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask2 === void 0) mask2 = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask2, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask2, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask2 = void 0;
        } else if (typeof mask2 === "function") {
          cb = mask2;
          mask2 = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask2 === void 0) mask2 = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask2, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module2.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 256 * 1024,
        maxFragments: 16 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        protocols: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL3) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL3(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes3(16).toString("base64");
      const request = isSecure ? https2.request : http2.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL3(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash2("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "node_modules/ws/lib/stream.js"(exports2, module2) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module2.exports = createWebSocketStream2;
  }
});

// node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "node_modules/ws/lib/subprotocol.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module2.exports = { parse };
  }
});

// node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "node_modules/ws/lib/websocket-server.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var http2 = require("http");
    var { Duplex } = require("stream");
    var { createHash: createHash2 } = require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=262144] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=16384] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 256 * 1024,
          maxFragments: 16 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http2.createServer((req, res) => {
            const body = http2.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server2 = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server2.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash2("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module2.exports = WebSocketServer2;
    function addListeners(server2, map) {
      for (const event of Object.keys(map)) server2.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server2.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server2) {
      server2._state = CLOSED;
      server2.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http2.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http2.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server2, req, socket, code, message, headers) {
      if (server2.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server2.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// src/server/server.ts
var import_node_crypto4 = require("node:crypto");
var import_node_child_process2 = require("node:child_process");
var import_node_crypto5 = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_node_http = __toESM(require("node:http"));
var import_node_https = __toESM(require("node:https"));
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));

// node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);

// src/agents/a2a.ts
var import_node_crypto = require("node:crypto");
function contextOf(m) {
  switch (m.type) {
    case "incident":
    case "evidence_closed":
    case "investigate":
    case "negotiate":
      return m.incident.id;
    case "move":
      return m.move.incidentId;
    case "look_request":
    case "look_reply":
      return m.incidentId;
    case "report":
      return m.report.incidentId;
    case "position":
      return m.position.incidentId;
    case "trace":
      return m.trace.incidentId;
    case "context":
      return m.context.incidentId;
    case "outcome":
      return m.outcome.incidentId;
    case "action":
      return m.action.incidentId;
    case "human":
      return m.incidentId;
    default:
      return "witness";
  }
}
function toA2A(m, sender) {
  return {
    kind: "message",
    role: "agent",
    messageId: (0, import_node_crypto.randomUUID)(),
    contextId: contextOf(m),
    parts: [{ kind: "data", data: m }],
    metadata: { "witness/type": m.type, ...sender ? { "witness/sender": sender } : {} }
  };
}
function fromA2A(x) {
  const o = x;
  if (o?.kind === "message" && Array.isArray(o.parts)) {
    const part = o.parts.find((p) => p?.kind === "data");
    return part?.data ?? null;
  }
  return typeof o?.type === "string" ? o : null;
}

// src/agents/bus.ts
function memberId(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 48) || "agent";
}
var LocalMember = class {
  constructor(id, address, bus) {
    this.id = id;
    this.address = address;
    this.bus = bus;
    this.handlers = [];
  }
  async publish(msg) {
    this.bus.deliver(this, msg);
  }
  onMessage(h) {
    this.handlers.push(h);
  }
};
var LocalBus = class {
  constructor(home = "home", note = "in memory channel") {
    this.home = home;
    this.note = note;
    this.kind = "local";
    this.members = /* @__PURE__ */ new Map();
    this.removed = /* @__PURE__ */ new Set();
    this.moderator = new LocalMember("moderator", `witness/${home}/moderator`, this);
    this.members.set("moderator", this.moderator);
  }
  deliver(from, msg) {
    if (!this.members.has(from.id)) return;
    const copy = fromA2A(JSON.parse(JSON.stringify(toA2A(msg, from.address))));
    for (const m of this.members.values()) {
      if (m === from) continue;
      queueMicrotask(() => {
        for (const h of m.handlers) h(from.id, copy);
      });
    }
  }
  async join(raw) {
    const id = memberId(raw);
    let m = this.members.get(id);
    if (!m) {
      m = new LocalMember(id, `witness/${this.home}/${id}`, this);
      this.members.set(id, m);
    }
    this.removed.delete(id);
    return m;
  }
  async remove(raw) {
    const id = memberId(raw);
    const had = this.members.delete(id);
    if (had) this.removed.add(id);
    return had;
  }
  isMember(raw) {
    return this.members.has(memberId(raw));
  }
  info() {
    return {
      kind: "local",
      channel: `witness/${this.home}/board`,
      encrypted: false,
      endpoint: "in process",
      members: [...this.members.keys()],
      removed: [...this.removed],
      note: this.note
    };
  }
};
var importEsm = new Function("s", "return import(s)");
var SlimMember = class {
  constructor(id, address, name, app, run) {
    this.id = id;
    this.address = address;
    this.name = name;
    this.app = app;
    this.run = run;
    this.handlers = [];
    this.session = null;
    this.alive = true;
  }
  async publish(msg) {
    if (!this.session || !this.alive) return;
    const data = Buffer.from(JSON.stringify(toA2A(msg)));
    await this.run(() => this.alive ? this.session.publishAndWaitAsync(data, "application/json", void 0) : Promise.resolve());
  }
  onMessage(h) {
    this.handlers.push(h);
  }
  async loop(onEnd) {
    while (this.alive && this.session) {
      let rec;
      try {
        rec = await this.session.getMessageAsync(6e4);
      } catch (e) {
        const why = String(e?.inner?.message ?? e?.message ?? e);
        if (/timeout|timed out/i.test(why)) continue;
        this.alive = false;
        onEnd();
        return;
      }
      try {
        const msg = fromA2A(JSON.parse(Buffer.from(rec.payload).toString("utf8")));
        if (!msg) continue;
        const from = String(rec.context.sourceName).split("/").pop() ?? "?";
        for (const h of this.handlers) h(from, msg);
      } catch {
      }
    }
  }
};
var SlimBus = class _SlimBus {
  constructor(o) {
    this.o = o;
    this.kind = "slim";
    this.connId = 0n;
    this.members = /* @__PURE__ */ new Map();
    this.removed = /* @__PURE__ */ new Set();
    this.queue = Promise.resolve();
    this.endpoint = "";
    this.mls = false;
    this.run = (f) => this.serial(f);
  }
  static async start(o) {
    const bus = new _SlimBus(o);
    await bus.init();
    return bus;
  }
  async init() {
    const slim = this.slim = await importEsm("@agntcy/slim-bindings");
    if (!slim.isInitialized?.()) {
      slim.initializeWithConfigs(slim.newRuntimeConfig(), slim.newTracingConfigWith("error", false, false, []), [slim.newServiceConfig()]);
    }
    this.service = slim.getGlobalService();
    if (!this.o.endpoint) {
      this.service.runServer(slim.newInsecureServerConfig(this.o.listen));
      await new Promise((r) => setTimeout(r, 300));
      this.endpoint = `http://${this.o.listen.replace("0.0.0.0", "127.0.0.1")}`;
    } else this.endpoint = this.o.endpoint;
    this.connId = BigInt(await this.service.connectAsync(slim.newInsecureClientConfig(this.endpoint)));
    const mod = await this.makeApp("moderator");
    this.moderator = mod;
    this.session = await mod.app.createSessionAndWaitAsync(
      {
        sessionType: slim.SessionType.Group,
        maxRetries: 5,
        interval: 1e3,
        metadata: /* @__PURE__ */ new Map([["purpose", "witness deliberation board"]]),
        mlsSettings: { headerIntegrityValidationPercent: 100 }
      },
      new slim.Name("witness", this.o.home, "board")
    );
    mod.session = this.session;
    this.mls = !!this.session.config?.()?.mlsSettings;
    this.members.set("moderator", mod);
    void mod.loop(() => this.o.log("moderator session ended"));
  }
  async makeApp(id) {
    const name = new this.slim.Name("witness", this.o.home, id);
    const app = this.service.createAppWithSecret(name, this.o.secret);
    await app.subscribeAsync(name, this.connId);
    return new SlimMember(id, `witness/${this.o.home}/${id}`, name, app, this.run);
  }
  /** Invites, removals and publishes run one at a time (each invite is an MLS commit). */
  serial(f) {
    const next = this.queue.then(f, f);
    this.queue = next.catch(() => void 0);
    return next;
  }
  join(raw) {
    const id = memberId(raw);
    const have = this.members.get(id);
    if (have && have.alive) return Promise.resolve(have);
    return this.serial(async () => {
      const again = this.members.get(id);
      if (again && again.alive) return again;
      const m = again && !again.alive ? new SlimMember(id, again.address, again.name, again.app, this.run) : await this.makeApp(id);
      if (again) m.handlers = again.handlers;
      let lastErr = null;
      for (let attempt = 0; attempt < 3 && !m.session; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 700));
        const listening = m.app.listenForSessionAsync(6e3);
        listening.catch(() => void 0);
        try {
          await this.moderator.app.setRouteAsync(m.name, this.connId);
          await this.session.inviteAndWaitAsync(m.name);
          m.session = await listening;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!m.session) throw new Error(`could not invite ${m.address}: ${String(lastErr?.inner?.message ?? lastErr)}`);
      m.alive = true;
      this.members.set(id, m);
      this.removed.delete(id);
      void m.loop(() => this.o.log(`${m.address} left the channel`));
      return m;
    });
  }
  remove(raw) {
    const id = memberId(raw);
    return this.serial(async () => {
      const m = this.members.get(id);
      if (!m || !m.alive) return false;
      await this.session.removeAndWaitAsync(m.name);
      m.alive = false;
      this.removed.add(id);
      return true;
    });
  }
  isMember(raw) {
    return !!this.members.get(memberId(raw))?.alive;
  }
  info() {
    return {
      kind: "slim",
      channel: `witness/${this.o.home}/board`,
      encrypted: this.mls,
      endpoint: this.o.endpoint ? this.endpoint : `${this.endpoint} (SLIM node inside the hub)`,
      members: [...this.members.values()].filter((m) => m.alive).map((m) => m.id),
      removed: [...this.removed],
      note: "AGNTCY SLIM group session"
    };
  }
};
async function startBus(o) {
  if (!o.enabled) return new LocalBus(o.home, "SLIM turned off (ECHOSENSE_SLIM=0)");
  try {
    const bus = await SlimBus.start(o);
    o.log(`AGNTCY SLIM channel ${bus.info().channel} ready (${bus.info().encrypted ? "MLS encrypted" : "not encrypted"}) at ${bus.info().endpoint}`);
    return bus;
  } catch (e) {
    const why = e.message ?? String(e);
    o.log(`SLIM unavailable (${why.slice(0, 160)}). Run "npm install" in the echosense folder to enable it. Using the in memory channel.`);
    return new LocalBus(o.home, "SLIM not installed: run npm install");
  }
}

// src/agents/phoneAgent.ts
var WINDOW = {
  before: [-4500, -400],
  around: [-2e3, 1500],
  after: [1500, 11500],
  sound: [-2500, 2500],
  media: [-12e3, -500]
};
var GATHER_MS = WINDOW.after[1] + 300;
var SAME_EVENT_MS = 3e3;
var BURST_DB = 20;
var MOVING_DB = 12;
var seq = 0;
function uid(prefix) {
  seq = (seq + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36)}`;
}
function screamConfirmed(e) {
  if (e.ai) return e.ai.group === "distress" && e.ai.score >= 0.5;
  return e.confidence >= 0.8 && e.aboveFloorDb >= 28;
}
function isDistressSound(e) {
  if (e.ai) return e.ai.group === "distress" && e.ai.score >= 0.5;
  return e.cls === "scream" && screamConfirmed(e);
}
function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}
var PhoneAgent = class {
  constructor(nodeId, name, onTrigger = () => {
  }) {
    this.nodeId = nodeId;
    this.name = name;
    this.onTrigger = onTrigger;
    this.samples = [];
    this.sounds = [];
    this.alerts = [];
    this.imu = [];
    this.lastBurstTrigger = -1e12;
    this.lastSeen = 0;
    this.stillCand = null;
  }
  trim(now) {
    const keep = now - 4e4;
    while (this.samples.length && this.samples[0].t < keep) this.samples.shift();
    while (this.sounds.length && this.sounds[0].t < keep) this.sounds.shift();
    while (this.alerts.length && this.alerts[0].t < keep) this.alerts.shift();
    while (this.imu.length && this.imu[0].t < keep) this.imu.shift();
  }
  onSample(s) {
    this.samples.push(s);
    this.lastSeen = s.t;
    this.trim(s.t);
    if (s.sonarOk && s.fastMotionDb >= BURST_DB + 4 && s.t - this.lastBurstTrigger > 1e4) {
      this.lastBurstTrigger = s.t;
      this.stillCand = null;
      this.onTrigger("burst", `sudden body motion, ${s.fastMotionDb.toFixed(0)} dB`, s.t);
      return;
    }
    const present = s.presence === "moving" || s.presence === "still";
    if (s.sonarOk && present && s.fastMotionDb >= 16) {
      this.stillCand = { t: s.t, db: s.fastMotionDb };
    } else if (this.stillCand && s.t - this.stillCand.t >= 6e3) {
      const c = this.stillCand;
      this.stillCand = null;
      const after = this.samples.filter((x) => x.t > c.t + 1500);
      const ok = after.length >= 10 && after.every((x) => x.sonarOk);
      const still = ok && after.filter((x) => x.fastMotionDb < MOVING_DB).length / after.length >= 0.85;
      const stayed = ok && after.filter((x) => x.presence === "moving" || x.presence === "still").length / after.length >= 0.5;
      if (still && stayed && c.t - this.lastBurstTrigger > 2e4) {
        this.lastBurstTrigger = c.t;
        this.onTrigger("burst", `sudden movement (${c.db.toFixed(0)} dB), then no movement`, c.t);
      }
    }
  }
  onSound(e) {
    this.sounds.push(e);
    this.lastSeen = Math.max(this.lastSeen, e.t);
    this.trim(e.t);
    const bodyMoved = this.samples.some((x) => x.sonarOk && Math.abs(x.t - e.t) <= 1500 && x.fastMotionDb >= 16);
    if (e.benign && e.aboveFloorDb < 30 && !bodyMoved) return;
    if (e.cls === "impact" && (e.confidence >= 0.55 && e.aboveFloorDb >= 15 || bodyMoved && e.aboveFloorDb >= 10)) {
      this.onTrigger("impact", `impact ${e.aboveFloorDb.toFixed(0)} dB above the room`, e.t);
    } else if (e.cls === "scream" && e.confidence >= 0.6 && screamConfirmed(e)) {
      this.onTrigger("scream", `scream ${e.aboveFloorDb.toFixed(0)} dB above the room (${e.ai?.top?.[0]?.name ?? "loud"})`, e.t);
    } else if (e.cls === "scream" && e.aboveFloorDb >= 30 && e.ai && e.ai.group !== "media" && (e.ai.top ?? []).some((x) => /Shout|Yell|Screaming/.test(x.name) && x.score >= 0.4)) {
      this.onTrigger("scream", `a loud shout, ${e.aboveFloorDb.toFixed(0)} dB above the room`, e.t);
    }
  }
  onAlert(a) {
    this.alerts.push(a);
    this.lastSeen = Math.max(this.lastSeen, a.t);
    if (a.kind === "fall") {
      const recent = [
        ...this.sounds.filter((e) => e.cls === "impact" || e.cls === "knock").map((e) => e.t),
        ...this.samples.filter((x) => x.sonarOk && x.fastMotionDb >= BURST_DB).map((x) => x.t)
      ].filter((t) => t <= a.t && t >= a.t - 9e3);
      this.onTrigger("fall_alert", a.title, recent.length ? Math.min(...recent.filter((t) => t >= Math.max(...recent) - 2500)) : a.t - 6e3);
    } else if (a.kind === "escalation" && /help/i.test(a.title)) this.onTrigger("help_pressed", a.title, a.t);
    else if (a.kind === "phone_drop") {
      this.imu.push({ t: a.t, type: "drop" });
      this.onTrigger("phone_drop", a.title, a.t);
    } else if (a.kind === "phone_moved") this.imu.push({ t: a.t, type: "moved" });
  }
  /** Whether this phone saw someone move (not just breathe) between t and now. */
  movedSince(t) {
    return this.samples.filter((s) => s.t >= t && s.sonarOk && s.fastMotionDb >= 14 && s.motionDb >= 14).length >= 6;
  }
  /** Whether this phone sees someone right now. */
  seesSomeone(now) {
    const xs = this.samples.filter((s) => s.t >= now - 3e3 && s.sonarOk);
    return xs.length > 5 && xs.filter((s) => s.presence === "moving" || s.presence === "still").length / xs.length >= 0.5;
  }
  /**
   * A fresh look, on request from a role agent: what this phone measures right
   * now and since the incident (the report only covers the first 11 seconds).
   */
  lookNow(t0, now) {
    const last = this.samples[this.samples.length - 1];
    if (!last || now - last.t > 5e3) return { streaming: false, note: "this phone is not streaming right now (locked, closed, or a recording that has ended)" };
    const recent = this.samples.filter((s) => s.t >= now - 4e3 && s.sonarOk);
    const since = this.samples.filter((s) => s.t >= t0 + 11500 && s.sonarOk);
    const moving = recent.filter((s) => s.fastMotionDb >= 14 && s.motionDb >= 14).length;
    let breathing = null;
    for (const s of recent) if (s.breathing && s.breathing.quality >= 0.3) breathing = Math.round(s.breathing.rateBpm);
    const sounds = this.sounds.filter((e) => e.t >= t0 + 2500 && e.t <= now);
    const heard = [...new Set(sounds.map((e) => e.ai && e.ai.score >= 0.3 ? e.ai.words ?? e.ai.group : e.cls))].slice(0, 6);
    return {
      streaming: true,
      seconds_since_incident: Math.round((now - t0) / 1e3),
      sonar_running: recent.length >= 5,
      sees_someone_now: this.seesSomeone(now),
      moving_now: recent.length ? moving / recent.length >= 0.25 : null,
      distance_now_m: this.recentRange(4e3, now)?.toFixed(2) ?? null,
      breathing_bpm_now: breathing,
      moved_since_report: since.length ? this.movedSince(t0 + 11500) : null,
      sounds_since_incident: heard,
      voice_since_incident: sounds.some((e) => e.cls === "voice" || e.ai?.group === "speech"),
      distress_since_incident: sounds.some(isDistressSound)
    };
  }
  /** Median distance of a confirmed target over the last span ms (null if none seen). */
  recentRange(span, now) {
    const xs = this.samples.filter((s) => s.t >= now - span && s.sonarOk).map((s) => s.range !== null && (s.confirmed || s.snrDb >= 10) ? s.range : s.breathing ? s.breathing.range : null).filter((r) => r !== null);
    if (xs.length < 3) return null;
    return median(xs);
  }
  /** Build this phone's evidence report for an incident at t0 (ms). */
  report(incidentId, t0, now) {
    const inWin = (xs, w2) => xs.filter((x) => x.t >= t0 + w2[0] && x.t <= t0 + w2[1]);
    const all = inWin(this.samples, [WINDOW.before[0], WINDOW.after[1]]);
    const before = inWin(this.samples, WINDOW.before);
    const around = inWin(this.samples, WINDOW.around);
    const after = inWin(this.samples, WINDOW.after);
    const sonarAll = all.filter((s) => s.sonarOk);
    const medianLinkDb = median(sonarAll.map((s) => s.linkSnrDb));
    const online = sonarAll.length >= Math.max(8, 0.6 * all.length) && medianLinkDb >= 10;
    const present = (s) => (s.presence === "moving" || s.presence === "still") && (s.confirmed || s.breathing !== null || s.motionDb >= 14);
    const sawPersonBefore = online && before.length > 3 && before.filter(present).length / before.length >= 0.4;
    const lastRange = (xs) => {
      for (let i = xs.length - 1; i >= 0; i--) if (xs[i].range !== null && xs[i].confirmed) return xs[i].range;
      return null;
    };
    const burstDb = around.filter((s) => s.sonarOk).reduce((m, s) => Math.max(m, s.fastMotionDb), 0);
    const afterOk = after.filter((s) => s.sonarOk);
    const stillAfter = afterOk.length ? afterOk.filter((s) => s.fastMotionDb < MOVING_DB).length / afterOk.length : 0;
    const motionResumed = afterOk.length > 5 && afterOk.filter((s) => s.fastMotionDb >= 14 && s.motionDb >= 14).length / afterOk.length >= 0.25;
    const presentAfter = afterOk.length > 5 && afterOk.filter(present).length / afterOk.length >= 0.5;
    const firstMove = afterOk.find((s) => s.t >= t0 + 2500 && s.fastMotionDb >= 13.5 && present(s));
    let breathingAfter = null;
    for (const s of afterOk) if (s.breathing) breathingAfter = s.breathing.rateBpm;
    const roomChangeDb = around.concat(after).reduce((m, s) => Math.max(m, s.staticChangeDb), 0);
    const snd = inWin(this.sounds, WINDOW.sound);
    const impacts = snd.filter((e) => (e.cls === "impact" || e.cls === "knock") && e.confidence >= 0.45);
    const aiImpact = impacts.filter((e) => e.ai).sort((a, b) => b.aboveFloorDb - a.aboveFloorDb)[0]?.ai ?? null;
    const distress = inWin(this.sounds, [-3e3, 9e3]).some(isDistressSound);
    const mediaSamples = inWin(this.samples, [-12e3, 0]).filter((x) => x.media !== void 0);
    const media = mediaSamples.length ? mediaSamples.reduce((a, x) => a + (x.media ?? 0), 0) / mediaSamples.length : null;
    const seenBefore = this.samples.filter((x) => x.t <= t0 && x.t >= t0 - 4e4 && x.sonarOk && (x.presence === "moving" || x.presence === "still") && (x.confirmed || x.motionDb >= 14));
    const loudest = impacts.reduce((m, e) => !m || e.aboveFloorDb > m.aboveFloorDb ? e : m, null);
    const screams = inWin(this.sounds, [-3e3, 7500]).filter((e) => e.cls === "scream" && screamConfirmed(e));
    const mediaEv = inWin(this.sounds, WINDOW.media).filter((e) => e.cls === "voice" || e.cls === "sustained" || e.repetitive);
    const voiceAfter = inWin(this.sounds, WINDOW.after).some((e) => e.cls === "voice");
    const imu = inWin(this.imu, [-3e3, 3e3]);
    const alerts = inWin(this.alerts, [-1e3, GATHER_MS + 2e3]).filter((a) => a.kind === "fall");
    const localVerdict = alerts.some((a) => a.severity === "critical") ? "fall" : alerts.length ? "possible_fall" : "none";
    const lastBefore = this.samples.filter((s) => s.t <= t0).pop();
    return {
      id: uid("report"),
      incidentId,
      nodeId: this.nodeId,
      name: this.name,
      postedAt: now,
      samples: all.length,
      silenceMs: lastBefore ? t0 - lastBefore.t : 1e9,
      sound: {
        impactDb: loudest ? loudest.aboveFloorDb : null,
        impactRepetitive: loudest ? loudest.repetitive : false,
        screamDb: screams.length ? Math.max(...screams.map((e) => e.aboveFloorDb)) : null,
        mediaEventsBefore: mediaEv.length,
        voiceAfter,
        impactAi: aiImpact ? { group: aiImpact.group, score: aiImpact.score, label: aiImpact.top?.[0]?.name ?? aiImpact.group } : null,
        media,
        distress
      },
      sonar: {
        online,
        medianLinkDb,
        sawPersonBefore,
        rangeBefore: online ? lastRange(before) : null,
        rangeAfter: online ? lastRange(after) : null,
        burstDb: online ? burstDb : 0,
        stillAfter: online ? stillAfter : 0,
        motionResumed: online && motionResumed,
        presentAfter: online && presentAfter,
        lastSeenAgo: online && seenBefore.length ? (t0 - seenBefore[seenBefore.length - 1].t) / 1e3 : null,
        firstMoveAfter: online && firstMove ? (firstMove.t - t0) / 1e3 : null,
        breathingAfter: online ? breathingAfter : null,
        roomChangeDb
      },
      imu: { moved: imu.some((e) => e.type === "moved"), dropped: imu.some((e) => e.type === "drop") },
      localVerdict
    };
  }
};

// src/agents/cartographer.ts
var PLACE_KINDS = [
  { kind: "tv", label: "TV", rest: false, source: true },
  { kind: "speaker", label: "Speaker or radio", rest: false, source: true },
  { kind: "sofa", label: "Sofa", rest: true, source: false },
  { kind: "chair", label: "Chair", rest: true, source: false },
  { kind: "bed", label: "Bed", rest: true, source: false },
  { kind: "desk", label: "Desk", rest: true, source: false },
  { kind: "kitchen", label: "Kitchen", rest: false, source: false },
  { kind: "bathroom", label: "Bathroom", rest: false, source: false },
  { kind: "door", label: "Door", rest: false, source: false },
  { kind: "stairs", label: "Stairs", rest: false, source: false },
  { kind: "other", label: "Other", rest: false, source: false }
];
function emptyMap() {
  return { phones: {}, places: [], resting: {} };
}
var BIN = 0.1;
var BINS = 40;
function learnRest(map, phone, range) {
  const h = map.resting[phone] ??= new Array(BINS).fill(0);
  const b = Math.min(BINS - 1, Math.max(0, Math.round(range / BIN)));
  h[b]++;
}
function isUsualRest(map, phone, range) {
  const h = map.resting[phone];
  if (!h) return 0;
  const b = Math.round(range / BIN);
  let n = 0;
  for (let k = b - 2; k <= b + 2; k++) if (k >= 0 && k < BINS) n += h[k];
  return n;
}
function fit(levels, dist, name, kind) {
  const pts = levels.filter((l) => dist[l.id] !== void 0).map((l) => ({ db: l.db, att: 20 * Math.log10(Math.max(dist[l.id], 0.25)) }));
  if (pts.length < 3) return null;
  const l0 = pts.reduce((a, p) => a + p.db + p.att, 0) / pts.length;
  const err = Math.sqrt(pts.reduce((a, p) => a + (p.db + p.att - l0) ** 2, 0) / pts.length);
  return { name, kind, errDb: err, phones: pts.length };
}
function cartograph(map, reports) {
  const notes = [];
  const heard = reports.filter((r) => r.sound.impactDb !== null);
  const levels = reports.filter((r) => r.samples >= 10).map((r) => ({ id: r.nodeId, db: r.sound.impactDb ?? 4 }));
  const fits = [];
  for (const p of map.places) {
    const f = fit(levels, p.ranges, p.name, p.kind);
    if (f) fits.push(f);
  }
  const person = {};
  for (const r of reports) {
    const d = r.sonar.rangeAfter ?? r.sonar.rangeBefore;
    if (d !== null && r.sonar.online) person[r.nodeId] = d;
  }
  const personFit = fit(levels, person, "where the person is", "person");
  if (personFit) fits.push(personFit);
  for (const r of heard) {
    const others = levels.filter((l) => l.id !== r.nodeId);
    if (!others.length) continue;
    const margin = (r.sound.impactDb ?? 0) - Math.max(...others.map((o) => o.db));
    if (margin >= 12) fits.push({ name: `right at ${r.name}`, kind: "phone", errDb: Math.max(0, 6 - margin / 4), phones: levels.length });
  }
  const loudestPhone = [...heard].sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0))[0];
  if (loudestPhone && !fits.some((f) => f.kind !== "phone")) {
    const others = levels.filter((l) => l.id !== loudestPhone.nodeId);
    const margin = (loudestPhone.sound.impactDb ?? 0) - Math.max(-99, ...others.map((o) => o.db));
    const nearest = map.places.map((p) => ({ p, d: p.ranges[loudestPhone.nodeId] })).filter((x) => x.d !== void 0 && x.d <= 1.5).sort((a, b) => a.d - b.d)[0];
    const personHere = person[loudestPhone.nodeId];
    if (nearest && margin >= 4 && (personHere === void 0 || personHere > nearest.d + 0.8)) {
      fits.push({ name: nearest.p.name, kind: nearest.p.kind, errDb: 1, phones: levels.length });
      notes.push(`the bang was loudest on ${loudestPhone.name}, ${nearest.d.toFixed(1)} m from the ${nearest.p.name}${personHere !== void 0 ? ` and ${personHere.toFixed(1)} m from the person` : ""}`);
    }
  }
  fits.sort((a, b) => a.errDb - b.errDb);
  const source = heard.length && fits.length ? fits[0] : null;
  if (source && personFit && source !== personFit) {
    notes.push(`the loudness pattern fits ${source.name} (off by ${source.errDb.toFixed(1)} dB) better than where the person is (off by ${personFit.errDb.toFixed(1)} dB)`);
  } else if (source && source === personFit) {
    notes.push(`the loudness pattern fits where the person is (off by ${source.errDb.toFixed(1)} dB)`);
  }
  let loudestNear = null;
  const loudest = heard.sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0))[0];
  const lab = loudest ? map.phones[loudest.nodeId] : void 0;
  if (loudest && lab?.near && (lab.near === "tv" || lab.near === "speaker")) {
    loudestNear = { phone: loudest.name, near: lab.near, label: lab.label };
    if (!notes.some((n) => n.startsWith(`the bang was loudest on ${loudest.name}`))) notes.push(`the bang was loudest on ${loudest.name}, which sits ${lab.label || `by the ${lab.near}`}`);
  }
  let endedAt = null;
  for (const p of map.places) {
    const common = Object.keys(person).filter((id) => p.ranges[id] !== void 0);
    if (!common.length) continue;
    const off = Math.max(...common.map((id) => Math.abs(person[id] - p.ranges[id])));
    if (off <= 0.4 && (!endedAt || off < endedAt.offBy || common.length > endedAt.phones)) endedAt = { place: p, offBy: off, phones: common.length };
  }
  if (endedAt) notes.push(`they ended up at the ${endedAt.place.name} (within ${(endedAt.offBy * 100).toFixed(0)} cm on ${endedAt.phones} phone${endedAt.phones > 1 ? "s" : ""})`);
  else if (Object.keys(person).length && map.places.length) notes.push("they ended up away from every marked place");
  const usualRest = Object.entries(person).some(([id, d]) => isUsualRest(map, id, d) >= 5);
  if (usualRest && !endedAt) notes.push("they stopped at a spot where someone often rests");
  if (!notes.length) notes.push(map.places.length ? "nothing in the room map bears on this" : "no room map yet: mark the TV and the sofa on the console");
  return { notes, source, personFit, endedAt, usualRest, loudestNear };
}
function kindInfo(k) {
  return PLACE_KINDS.find((p) => p.kind === k) ?? PLACE_KINDS[PLACE_KINDS.length - 1];
}

// src/agents/memory.ts
function emptyMemory() {
  return { incidents: [], phones: {} };
}
function remember(mem, incident, reports, outcome, place) {
  const heard = reports.filter((r) => r.sound.impactDb !== null).sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0));
  const loud = heard[0];
  const rec = {
    id: incident.id,
    t: incident.t0,
    hour: new Date(incident.t0).getHours(),
    trigger: incident.trigger.kind,
    outcome: outcome.kind,
    human: null,
    source: "",
    sound: loud?.sound.impactAi ? loud.sound.impactAi.label : null,
    loudest: loud ? loud.nodeId : null,
    alarmed: reports.filter((r) => r.localVerdict !== "none").map((r) => r.nodeId),
    place,
    simulated: incident.simulated
  };
  mem.incidents.push(rec);
  if (mem.incidents.length > 300) mem.incidents.splice(0, mem.incidents.length - 300);
  for (const id of rec.alarmed) (mem.phones[id] ??= { alarms: 0, falseAlarms: 0, confirmed: 0 }).alarms++;
  return rec;
}
function learn(mem, incidentId, answer, source) {
  const rec = mem.incidents.find((r) => r.id === incidentId);
  if (!rec || rec.human) return;
  rec.human = answer;
  rec.source = source;
  for (const id of rec.alarmed) {
    const p = mem.phones[id] ??= { alarms: 0, falseAlarms: 0, confirmed: 0 };
    if (answer === "ok") p.falseAlarms++;
    else p.confirmed++;
  }
}
function learnedTrust(mem, nodeId) {
  const p = mem?.phones[nodeId];
  if (!p || p.falseAlarms < 3) return null;
  const ratio = p.falseAlarms / Math.max(1, p.falseAlarms + p.confirmed);
  if (ratio < 0.75) return null;
  return { factor: 0.8, reason: `${p.falseAlarms} of its last ${p.falseAlarms + p.confirmed} alarms turned out to be nothing` };
}
function knownHarmless(mem, reports, t0) {
  if (!mem) return [];
  const heard = reports.filter((r) => r.sound.impactDb !== null).sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0));
  const loud = heard[0];
  if (!loud) return [];
  const hour = new Date(t0).getHours();
  const label = loud.sound.impactAi?.label ?? null;
  return mem.incidents.filter(
    (r) => !r.simulated && r.human === "ok" && r.loudest === loud.nodeId && Math.min(Math.abs(r.hour - hour), 24 - Math.abs(r.hour - hour)) <= 1 && (label === null || r.sound === label)
  );
}
function summarize(mem, names, reports, t0) {
  if (!mem || !mem.incidents.some((r) => !r.simulated)) return { note: "No history yet in this home." };
  const real = mem.incidents.filter((r) => !r.simulated);
  const recent = real.slice(-8).map((r) => ({
    when: new Date(r.t).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }),
    trigger: r.trigger,
    sound: r.sound,
    decided: r.outcome,
    person_said: r.human ?? "nobody was asked",
    place: r.place
  }));
  const phones = Object.fromEntries(Object.entries(mem.phones).map(([id, p]) => [names[id] ?? id, p]));
  const similar = knownHarmless(mem, reports, t0);
  return {
    incidents_remembered: real.length,
    recent,
    phone_alarm_record: phones,
    similar_past_incidents_that_were_fine: similar.length,
    pattern: similar.length >= 2 ? `${similar.length} earlier incidents like this (same sound, same phone, same time of day) were fine` : null
  };
}

// src/agents/roles.ts
var BURST = 20;
function phoneMovedItself(r) {
  return r.imu.moved || r.imu.dropped || r.sonar.roomChangeDb >= 15;
}
function heardImpact(r, min = 10) {
  return r.sound.impactDb !== null && r.sound.impactDb >= min && !r.sound.impactRepetitive;
}
var HARMLESS = ["tap", "speech", "media", "footsteps"];
function harmlessSound(r) {
  const a = r.sound.impactAi;
  const bodyMoved = r.sonar.online && r.sonar.burstDb >= 16 && !phoneMovedItself(r);
  return !!a && a.score >= 0.3 && (HARMLESS.includes(a.group) || a.group === "object") && !bodyMoved;
}
function thudSound(r) {
  return !!r.sound.impactAi && r.sound.impactAi.group === "thud" && r.sound.impactAi.score >= 0.3;
}
function dangerImpact(r, min = 10) {
  return heardImpact(r, min) && !harmlessSound(r);
}
function claimsBody(r) {
  return sonarBurst(r) || r.localVerdict !== "none";
}
function aiWords(r) {
  const a = r.sound.impactAi;
  return a ? `${a.label} ${Math.round(a.score * 100)}%` : "";
}
function watched(r) {
  return r.sonar.online && r.sonar.sawPersonBefore && !phoneMovedItself(r);
}
function sonarBurst(r) {
  return r.sonar.online && r.sonar.burstDb >= BURST && !phoneMovedItself(r);
}
function rangeShift(r) {
  return r.sonar.rangeBefore !== null && r.sonar.rangeAfter !== null ? Math.abs(r.sonar.rangeAfter - r.sonar.rangeBefore) : null;
}
function fullSignature(r) {
  return watched(r) && sonarBurst(r) && dangerImpact(r) && r.sonar.stillAfter >= 0.8 && !r.sonar.motionResumed;
}
function colocated(rs) {
  const heard = rs.filter((r) => r.sound.impactDb !== null);
  const watchers = rs.filter(watched);
  if (heard.length < 2 || !watchers.length) return true;
  const loudest = heard.reduce((m, r) => r.sound.impactDb > m.sound.impactDb ? r : m);
  if (watchers.includes(loudest)) return true;
  return !watchers.every((r) => (r.sound.impactDb ?? -99) <= loudest.sound.impactDb - 6);
}
function cap(x) {
  return x ? x[0].toUpperCase() + x.slice(1) : x;
}
function db(x) {
  return x === null ? "nothing" : `${x.toFixed(0)} dB`;
}
function trustOf(ctx) {
  return ctx.prior.find((p) => p.agent === "auditor")?.trust ?? null;
}
function w(trust, r) {
  return trust?.[r.nodeId]?.score ?? 1;
}
function fingerprint(r) {
  const s = r.sonar;
  return [r.nodeId, r.sound.impactDb?.toFixed(2), s.burstDb.toFixed(2), s.stillAfter.toFixed(3), s.rangeBefore?.toFixed(3), s.rangeAfter?.toFixed(3), r.samples].join("|");
}
function position(ctx, agent, stance, confidence, argument, points, trust) {
  return {
    id: uid(agent),
    incidentId: ctx.incident.id,
    agent,
    round: ctx.round,
    stance,
    confidence: Math.max(0.05, Math.min(0.97, confidence)),
    argument,
    points,
    trust,
    llm: false,
    postedAt: ctx.now
  };
}
function auditor(ctx) {
  const rs = ctx.reports;
  const trust = {};
  const quarantine = [];
  const healthy = (r) => r.samples >= 10 && r.silenceMs <= 3e3;
  const acoustic = /* @__PURE__ */ new Map();
  for (const r of rs) {
    const others = rs.filter((o) => o !== r && healthy(o));
    let a = 1;
    const loud = r.sound.impactDb !== null && r.sound.impactDb >= 20;
    if (loud && others.length >= 2 && !others.some((o) => heardImpact(o, 5)) && !phoneMovedItself(r) && claimsBody(r)) a = 0.25;
    if (r.sound.impactDb === null && healthy(r) && others.filter((o) => heardImpact(o, 15)).length >= 2) a = 0.25;
    acoustic.set(r.nodeId, a);
  }
  for (const r of rs) {
    let score = 1;
    const reasons = [];
    const others = rs.filter((o) => o !== r && healthy(o));
    if (!healthy(r)) {
      score *= 0.5;
      reasons.push(r.samples < 10 ? `streamed only ${r.samples} samples around the incident` : `was silent for ${(r.silenceMs / 1e3).toFixed(0)} s before it`);
    }
    if (ctx.seenFingerprints.has(fingerprint(r))) {
      score *= 0.1;
      reasons.push("sent a report identical to an earlier incident (replayed)");
    }
    const moved = phoneMovedItself(r);
    if (moved) {
      reasons.push(
        r.imu.dropped || r.imu.moved ? "its own motion sensor says the phone moved, so its sonar describes the phone, not the room" : `its room echo changed ${r.sonar.roomChangeDb.toFixed(0)} dB at once, so the phone itself moved`
      );
    }
    const loud = r.sound.impactDb !== null && r.sound.impactDb >= 20;
    const othersHeard = others.filter((o) => heardImpact(o, 5));
    if (loud && others.length >= 1 && othersHeard.length === 0 && !moved && !claimsBody(r)) {
      reasons.push(`heard a ${db(r.sound.impactDb)} sound right next to it that the others did not: something near this phone, not a fall`);
    } else if (loud && others.length >= 2 && othersHeard.length === 0 && !moved) {
      score *= 0.25;
      reasons.push(`claims a ${db(r.sound.impactDb)} impact and a fall that ${others.map((o) => o.name).join(" and ")} did not hear at all`);
    } else if (loud && others.length === 1 && othersHeard.length === 0 && !moved) {
      score *= 0.6;
      reasons.push(`claims a ${db(r.sound.impactDb)} impact nobody else confirms`);
    }
    const loudOthers = others.filter((o) => heardImpact(o, 15));
    if (r.sound.impactDb === null && healthy(r) && loudOthers.length >= 2) {
      const claimsFine = watched(r) && (r.sonar.motionResumed || r.sonar.presentAfter && r.sonar.burstDb < 16);
      if (claimsFine) {
        score *= 0.25;
        reasons.push(`heard nothing and claims the person carried on normally, while ${loudOthers.map((o) => `${o.name} (${db(o.sound.impactDb)})`).join(" and ")} heard an impact`);
      } else {
        score *= 0.65;
        reasons.push(`did not hear the impact ${loudOthers.map((o) => o.name).join(" and ")} heard: low observability for this event (distance, obstruction or orientation), not evidence either way`);
      }
    } else if (r.sound.impactDb === null && healthy(r) && loudOthers.length === 1 && others.length === 1) {
      score *= 0.7;
      reasons.push(`heard nothing while ${loudOthers[0].name} heard ${db(loudOthers[0].sound.impactDb)}`);
    }
    if (sonarBurst(r)) {
      const calm = others.filter(
        (o) => (acoustic.get(o.nodeId) ?? 1) >= 0.5 && watched(o) && o.sonar.burstDb < 16 && (o.sonar.motionResumed || o.sonar.presentAfter)
      );
      if (calm.length) {
        score *= 0.5;
        reasons.push(`its burst is contradicted by ${calm.map((o) => o.name).join(" and ")}, which watched the person move normally`);
      }
    }
    if (r.localVerdict === "fall" && !(sonarBurst(r) || moved) && !heardImpact(r)) {
      score *= 0.3;
      reasons.push("its fall verdict does not follow from its own measurements");
    }
    const learned = learnedTrust(ctx.memory, r.nodeId);
    if (learned && r.localVerdict !== "none") {
      score *= learned.factor;
      reasons.push(`learned from earlier answers: ${learned.reason}`);
    }
    if (!reasons.length) reasons.push("consistent with the other phones");
    trust[r.nodeId] = { score: Math.max(0.02, score), reasons };
    if (score < 0.3 && !moved) quarantine.push(r.name);
  }
  let conflict;
  const healthyRs = rs.filter(healthy);
  for (const a of healthyRs) {
    for (const b of healthyRs) {
      if (a === b) continue;
      const deafB = (a.sound.impactDb ?? 0) >= 20 && b.sound.impactDb === null && !phoneMovedItself(a) && !harmlessSound(a);
      const calmB = sonarBurst(a) && watched(b) && b.sonar.burstDb < 16 && (b.sonar.motionResumed || b.sonar.presentAfter);
      if (!deafB && !calmB) continue;
      const third = healthyRs.filter((c) => c !== a && c !== b);
      const tieBreak = third.some((c) => deafB && c.sound.impactDb !== null !== (b.sound.impactDb !== null) || calmB && watched(c));
      const sideWithB = third.some((c) => deafB && c.sound.impactDb === null);
      if (!tieBreak && !sideWithB && (claimsBody(a) || claimsBody(b))) {
        conflict = `${a.name} and ${b.name} tell opposite stories (${deafB ? `${a.name} heard ${db(a.sound.impactDb)}, ${b.name} heard nothing` : `${a.name} saw a sudden movement, ${b.name} saw them moving normally`}) and no other phone can break the tie`;
      }
    }
  }
  const good = rs.filter((r) => trust[r.nodeId].score >= 0.5);
  const bad = rs.filter((r) => trust[r.nodeId].score < 0.5);
  const mapSays = ctx.context?.source;
  const together = colocated(good) && !(mapSays && mapSays.kind !== "person" && ctx.context?.personFit && ctx.context.personFit.errDb - mapSays.errDb >= 3);
  const sonarCh = good.filter(
    (r) => watched(r) && sonarBurst(r) && r.sonar.stillAfter >= 0.8 && !r.sonar.motionResumed && (heardImpact(r, 10) && together || (rangeShift(r) ?? 0) >= 0.35)
  );
  const restSpot = ctx.context?.endedAt && kindInfo(ctx.context.endedAt.place.kind).rest && (ctx.context.endedAt.phones >= 2 || ctx.context.endedAt.offBy <= 0.2);
  const motionless = !(restSpot && !good.some((r) => dangerImpact(r, 12))) && good.some((r) => watched(r) && r.sonar.burstDb >= 16 && r.sonar.presentAfter && r.sonar.firstMoveAfter === null && !r.sonar.motionResumed);
  const audioCh = together ? good.filter((r) => dangerImpact(r, 12)) : [];
  const scream = good.some((r) => r.sound.screamDb !== null || r.sound.distress);
  const vanished = good.some((r) => r.sonar.lastSeenAgo !== null && r.sonar.lastSeenAgo <= 10) && !good.some((r) => r.sonar.presentAfter || r.sonar.motionResumed) && good.some((r) => dangerImpact(r, 15));
  const danger = (r) => r.localVerdict !== "none" || sonarBurst(r) || dangerImpact(r, 20) || r.sound.distress;
  const points = [];
  for (const r of rs) {
    const t = trust[r.nodeId];
    points.push(`${r.name}: trust ${(t.score * 100).toFixed(0)}%, ${t.reasons.join("; ")}`);
  }
  if (ctx.incident.trigger.kind === "help_pressed") {
    return position(ctx, "auditor", "escalate", 0.95, "The person asked for help on the phone. That is first hand and needs no corroboration.", points, trust);
  }
  if (conflict) {
    const p = position(ctx, "auditor", "uncertain", 0.6, `${conflict[0].toUpperCase()}${conflict.slice(1)}. One of them is wrong, and only the person can settle it.`, points, trust);
    p.conflict = conflict;
    return p;
  }
  if (bad.some(danger) && !good.some(danger)) {
    const names = bad.filter(danger).map((r) => r.name).join(" and ");
    return position(
      ctx,
      "auditor",
      "stand_down",
      0.85,
      `The alarm rests on ${names} alone, and ${names} contradicts the other phones. I would not act on it${quarantine.length ? `, and I am flagging ${quarantine.join(", ")} as untrustworthy` : ""}.`,
      points,
      trust
    );
  }
  if (!together) points.push("the impact was loudest far from the person, so the sound and the movement are separate events");
  if (restSpot) points.push(`the room map puts them at the ${ctx.context.endedAt.place.name}`);
  const harmless = rs.filter((r) => heardImpact(r, 5) && harmlessSound(r));
  if (harmless.length) points.push(`sound model on ${harmless.map((r) => `${r.name}: ${aiWords(r)}`).join(", ")}`);
  const channels = (sonarCh.length ? 1 : motionless ? 1 : 0) + (sonarCh.length >= 2 ? 1 : 0) + (audioCh.length ? 1 : 0) + (scream ? 1 : 0) + (vanished ? 1 : 0);
  const thudHeard = audioCh.some(thudSound);
  if (channels === 1 && audioCh.length && !sonarCh.length && !motionless && !scream && !vanished && thudHeard) {
    return position(ctx, "auditor", "uncertain", 0.5, `Only sound so far, but the sound model calls it ${aiWords(audioCh.find(thudSound))}. Worth asking.`, points, trust);
  }
  if (channels === 1 && audioCh.length && !sonarCh.length && !motionless && !scream && !vanished) {
    return position(
      ctx,
      "auditor",
      "stand_down",
      0.55,
      "A sound on its own, with no sign of anyone moving or falling, is not enough to bother anyone.",
      points,
      trust
    );
  }
  if (channels === 0 && (good.some(danger) || !together)) {
    return position(
      ctx,
      "auditor",
      "stand_down",
      0.65,
      together ? "The measurements are real, but none of them is a fall pattern: no impact where the person is, no move to the floor, and they moved again afterwards." : "The phones are honest, but the bang came from where nobody is, and the movement near the person ended where it started.",
      points,
      trust
    );
  }
  if (channels >= 2 && !sonarCh.length && !scream && !vanished) {
    return position(ctx, "auditor", "uncertain", 0.5, "Two weak signs line up (a bang and stillness at the same spot), but nothing shows a fall for certain. Ask them.", points, trust);
  }
  if (channels >= 2) {
    const parts = [
      sonarCh.length ? `sonar on ${sonarCh.map((r) => r.name).join(" and ")}` : "",
      audioCh.length ? `the impact heard by ${audioCh.length} phone${audioCh.length > 1 ? "s" : ""}` : "",
      scream ? "someone in distress" : "",
      vanished ? (() => {
        const seer = good.filter((r) => r.sonar.lastSeenAgo !== null).sort((a, b) => a.sonar.lastSeenAgo - b.sonar.lastSeenAgo)[0];
        const blind = good.filter((r) => !r.sonar.online).map((r) => r.name);
        return `${seer.name} last saw the person ${seer.sonar.lastSeenAgo.toFixed(0)} s before the bang and nobody since${blind.length ? ` (${blind.join(" and ")} had no working sonar)` : ""}`;
      })() : ""
    ].filter(Boolean);
    return position(ctx, "auditor", "escalate", 0.7, `The evidence checks out: ${parts.join(" and ")} line up in time, from phones that agree with each other.`, points, trust);
  }
  if (!good.some(danger)) {
    return position(ctx, "auditor", "stand_down", 0.6, "No trusted phone measured anything dangerous.", points, trust);
  }
  return position(ctx, "auditor", "uncertain", 0.5, "The reports are honest but thin: only one kind of evidence, so I cannot confirm it either way.", points, trust);
}
function responder(ctx) {
  const trust = trustOf(ctx);
  const rs = ctx.reports.filter((r) => w(trust, r) >= 0.5);
  const ignored = ctx.reports.filter((r) => w(trust, r) < 0.5);
  const points = [];
  let s = 0;
  if (ctx.incident.trigger.kind === "help_pressed") {
    return position(ctx, "responder", "escalate", 0.97, "They pressed Get help. Call now.", ["help requested on the phone"]);
  }
  const full = rs.filter(fullSignature);
  if (full.length) {
    const r = full[0];
    s += 0.6;
    points.push(
      `${r.name} watched the person: ${r.sonar.burstDb.toFixed(0)} dB burst, impact ${db(r.sound.impactDb)}, then ${(r.sonar.stillAfter * 100).toFixed(0)}% still afterwards`
    );
  } else {
    const soft = rs.filter((r) => watched(r) && r.sonar.burstDb >= 16 && r.sonar.stillAfter >= 0.85 && !r.sonar.motionResumed);
    if (soft.length) {
      const r = soft[0];
      const shift = rangeShift(r);
      s += sonarBurst(r) ? 0.35 : 0.2;
      points.push(`${r.name}: sudden motion (${r.sonar.burstDb.toFixed(0)} dB) and then no movement`);
      if (r.sonar.presentAfter && r.sonar.firstMoveAfter === null) {
        s += 0.25;
        points.push(`${r.name} has seen no movement at all for 10 s since; people sitting down shift around, this person has not`);
      }
      if (shift !== null && shift >= 0.35) {
        s += 0.2;
        points.push(`${r.name} saw the body move from ${r.sonar.rangeBefore.toFixed(1)} m to ${r.sonar.rangeAfter.toFixed(1)} m and stay there`);
      }
    }
  }
  const heard = rs.filter((r) => dangerImpact(r, 12));
  const thud = rs.find(thudSound);
  if (thud) {
    s += 0.15;
    points.push(`the sound model on ${thud.name} heard ${aiWords(thud)}, like a body hitting the floor`);
  }
  const distress = rs.find((r) => r.sound.distress);
  if (distress) {
    s += 0.3;
    points.push(`${distress.name} heard someone in distress`);
  }
  const harmless = rs.filter((r) => heardImpact(r, 5) && harmlessSound(r));
  if (harmless.length && !heard.length) {
    s -= 0.3;
    points.push(`the sound model called it ${harmless.map(aiWords).join(", ")}`);
  }
  if (heard.length && !full.length) {
    s += 0.15;
    points.push(`impact heard by ${heard.map((r) => `${r.name} (${db(r.sound.impactDb)})`).join(", ")}`);
  }
  if (heard.length >= 2 && rs.some((r) => sonarBurst(r) && watched(r))) {
    s += 0.1;
    points.push("the impact and the body motion happened together");
  }
  const scream = rs.filter((r) => r.sound.screamDb !== null);
  if (scream.length) {
    s += 0.25;
    points.push(`scream heard by ${scream.map((r) => r.name).join(", ")}`);
  }
  const anyWatching = rs.some((r) => watched(r) || r.sonar.online && r.sonar.presentAfter);
  const recently = rs.filter((r) => r.sonar.lastSeenAgo !== null && r.sonar.lastSeenAgo <= 10).sort((a, b) => a.sonar.lastSeenAgo - b.sonar.lastSeenAgo)[0];
  if (!anyWatching && recently && heard.some((r) => (r.sound.impactDb ?? 0) >= 15)) {
    s += 0.3;
    points.push(`${recently.name} saw them moving ${recently.sonar.lastSeenAgo.toFixed(0)} s before a heavy bang, and now no phone can see them`);
  }
  const resumed = rs.filter((r) => r.sonar.online && !phoneMovedItself(r) && r.sonar.motionResumed);
  if (resumed.length) {
    s -= 0.45;
    points.push(`${resumed.map((r) => r.name).join(" and ")} saw normal movement afterwards`);
  }
  if (ignored.length) points.push(`not counting ${ignored.map((r) => r.name).join(", ")} (the Auditor does not trust ${ignored.length > 1 ? "them" : "it"})`);
  if (ctx.round === 2) {
    const sk2 = ctx.prior.find((p) => p.agent === "skeptic");
    const au = ctx.prior.find((p) => p.agent === "auditor");
    if (au?.stance === "stand_down") s -= 0.3;
    if (au?.stance === "escalate") s += 0.1;
    if (sk2?.stance === "stand_down") {
      s -= 0.3 * sk2.confidence;
      if (sk2.confidence >= 0.7) points.push(`the Skeptic's explanation fits the data: ${sk2.points[0] ?? sk2.argument}`);
    }
  }
  const m = ctx.context;
  if (m?.endedAt && !kindInfo(m.endedAt.place.kind).rest && rs.some((r) => watched(r) && r.sonar.burstDb >= 16)) {
    s += 0.1;
    points.push(`they ended up at the ${m.endedAt.place.name}, not somewhere people sit or lie down`);
  }
  if (m?.source?.kind === "person" && heard.length >= 2) {
    s += 0.1;
    points.push("the room map puts the bang right where the person is");
  }
  const awake = rs.filter((r) => watched(r) && r.sonar.firstMoveAfter !== null && !r.sonar.motionResumed);
  const talking = rs.some((r) => r.sound.voiceAfter && r.sound.mediaEventsBefore < 3);
  if (s >= 0.55 && (awake.length || talking) && !scream.length) {
    points.push(awake.length ? `${awake[0].name} saw them move ${awake[0].sonar.firstMoveAfter.toFixed(0)} s later, so they are awake` : "someone is talking");
    return position(ctx, "responder", "uncertain", 0.6, `This could be a fall, but they are awake and moving. Ask them first and call if they do not answer.`, points);
  }
  const shifted = rs.some((r) => watched(r) && r.sonar.burstDb >= 16 && (rangeShift(r) ?? 0) >= 0.35 && !r.sonar.motionResumed);
  const vanishedNow = !anyWatching && !!recently && heard.some((r) => (r.sound.impactDb ?? 0) >= 15);
  const clear = full.length > 0 || shifted || !!distress || scream.length > 0 || vanishedNow || rs.some((r) => thudSound(r) && sonarBurst(r) && watched(r));
  if (s >= 0.55 && !clear) {
    return position(ctx, "responder", "uncertain", 0.6, `This might be a fall, but nothing is certain yet. ${points[0] ?? ""}. Ask them now, and call if they do not answer.`, points);
  }
  if (s >= 0.55) {
    return position(ctx, "responder", "escalate", s, `This looks like a real fall. ${points[0] ?? ""}. I want someone called now.`, points);
  }
  if (s >= 0.25) {
    return position(ctx, "responder", "uncertain", 0.5, `Something happened and I cannot rule out that they are hurt. ${points[0] ?? ""}. Ask them.`, points);
  }
  const sk = ctx.prior.find((p) => p.agent === "skeptic");
  const convinced = ctx.round === 2 && sk?.stance === "stand_down" && sk.confidence >= 0.7;
  const because = convinced ? `I accept the Skeptic's explanation: ${(sk.points[0] ?? sk.argument).split(":")[0]}.` : resumed.length ? `${resumed.map((r) => r.name).join(" and ")} saw them moving normally afterwards.` : ignored.length && !rs.some((r) => r.localVerdict !== "none" || sonarBurst(r)) ? `The only alarm comes from ${ignored.map((r) => r.name).join(", ")}, and I do not trust it.` : points.length ? "What the phones measured does not add up to someone hurt." : "No sign that anyone is hurt.";
  return position(ctx, "responder", "stand_down", Math.min(0.9, 0.6 - s), `Nothing here needs a caregiver. ${because}`, points);
}
function skeptic(ctx) {
  const trust = trustOf(ctx);
  const rs = ctx.reports.filter((r) => w(trust, r) >= 0.5);
  const hyps = [];
  const heard = rs.filter((r) => r.sound.impactDb !== null);
  const loudest = heard.reduce((m2, r) => !m2 || r.sound.impactDb > m2.sound.impactDb ? r : m2, null);
  const watchers = rs.filter(watched);
  if (loudest && heard.length >= 2 && watchers.length && !watchers.includes(loudest)) {
    const quieter = watchers.filter((r) => (r.sound.impactDb ?? -99) <= loudest.sound.impactDb - 6);
    if (quieter.length === watchers.length) {
      let st = 0.45;
      const why = [`the impact was loudest on ${loudest.name} (${db(loudest.sound.impactDb)}), which could not see the person; ${quieter.map((r) => `${r.name} next to them heard ${db(r.sound.impactDb)}`).join(", ")}`];
      const media = rs.filter((r) => r.sound.mediaEventsBefore >= 3);
      if (media.length) {
        st += 0.15;
        why.push(`continuous voice or music before it (${media[0].sound.mediaEventsBefore} events on ${media[0].name})`);
      }
      const inPlace = watchers.filter((r) => r.sonar.presentAfter && (rangeShift(r) ?? 9) < 0.3);
      if (inPlace.length) {
        st += 0.25;
        why.push(`${inPlace[0].name} shows them at the same distance afterwards (${inPlace[0].sonar.rangeAfter.toFixed(1)} m), not on the floor`);
      }
      if (!watchers.some((r) => r.sonar.burstDb >= 24)) st += 0.1;
      hyps.push({ name: "sound from elsewhere", strength: st, because: why.join("; ") });
    }
  }
  for (const r of ctx.reports) {
    if (!phoneMovedItself(r) || r.sound.impactDb === null) continue;
    const others = ctx.reports.filter((o) => o !== r);
    const otherMax = others.reduce((m2, o) => Math.max(m2, o.sound.impactDb ?? -99), -99);
    if (r.sound.impactDb - otherMax >= 10) {
      let st = 0.7;
      const why = [`${r.name} heard the bang ${otherMax < -50 ? "and nobody else did" : `${(r.sound.impactDb - otherMax).toFixed(0)} dB louder than anyone`}`];
      why.push(r.imu.moved || r.imu.dropped ? `its accelerometer says it moved` : `its whole room echo changed ${r.sonar.roomChangeDb.toFixed(0)} dB`);
      if (rs.some((o) => o !== r && watched(o) && (o.sonar.motionResumed || o.sonar.burstDb < BURST))) {
        st += 0.15;
        why.push("the phones watching the person saw nothing unusual");
      }
      hyps.push({ name: "phone knocked over", strength: st, because: why.join("; ") });
    }
  }
  const benign = ctx.reports.filter((r) => heardImpact(r, 5) && harmlessSound(r));
  const anyThud = ctx.reports.some(thudSound);
  const bodyDown = rs.some((r) => watched(r) && r.sonar.burstDb >= 16 && r.sonar.stillAfter >= 0.8 && r.sonar.firstMoveAfter === null && !r.sonar.motionResumed);
  if (benign.length && !anyThud) {
    const r = benign.sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0))[0];
    hyps.push({
      name: "an everyday sound",
      strength: bodyDown ? 0.3 : 0.75,
      because: `the sound model on ${r.name} heard ${aiWords(r)}, not a body hitting the floor${bodyDown ? ", though that does not explain why they stopped moving" : ""}`
    });
  }
  const loudOne = ctx.reports.filter((r) => (r.sound.impactDb ?? -99) >= 15);
  if (loudOne.length === 1 && ctx.reports.length >= 2 && !ctx.reports.some(claimsBody)) {
    const r = loudOne[0];
    const quiet = ctx.reports.filter((o) => o !== r && o.sound.impactDb === null);
    if (quiet.length === ctx.reports.length - 1) {
      hyps.push({ name: "a sound right next to one phone", strength: 0.7, because: `${r.name} heard ${db(r.sound.impactDb)} and ${quiet.map((o) => o.name).join(" and ")} heard nothing, so it happened right at ${r.name}` });
    }
  }
  const mediaR = rs.filter((r) => (r.sound.media ?? 0) >= 0.4);
  if (mediaR.length && !watchers.some((r) => r.sonar.burstDb >= 24)) {
    hyps.push({
      name: "the TV",
      strength: 0.5 + (rs.some((r) => r.sound.impactAi?.group === "media") ? 0.2 : 0),
      because: `${mediaR[0].name}'s sound model says TV or music has been playing (${Math.round((mediaR[0].sound.media ?? 0) * 100)}% of the last 12 s), and no phone watching the person saw a fall`
    });
  }
  const m = ctx.context;
  const modelRunning = ctx.reports.some((r) => r.sound.media !== null);
  const tvOn = !modelRunning || ctx.reports.some((r) => (r.sound.media ?? 0) >= 0.3 || r.sound.impactAi?.group === "media");
  if (tvOn && m?.source && (m.source.kind === "tv" || m.source.kind === "speaker") && (!m.personFit || m.personFit.errDb - m.source.errDb >= 3)) {
    hyps.push({ name: `the ${m.source.name}`, strength: 0.8, because: `the room map says the bang came from the ${m.source.name}: ${m.notes.find((n) => n.includes("loud")) ?? m.notes[0]}` });
  } else if (tvOn && m?.loudestNear && !watchers.some((r) => r.sonar.burstDb >= 24)) {
    hyps.push({ name: "the TV", strength: 0.65, because: m.notes.find((n) => n.includes("sits")) ?? "the loudest phone sits by the TV" });
  }
  if (m?.source?.kind === "phone" && !ctx.reports.some(claimsBody)) {
    hyps.push({ name: "a sound right next to one phone", strength: 0.7, because: `the loudness pattern puts the sound ${m.source.name}` });
  }
  if (m?.endedAt && kindInfo(m.endedAt.place.kind).rest && !ctx.reports.some(thudSound) && !ctx.reports.some((r) => r.sound.distress)) {
    const awake = watchers.some((r) => r.sonar.firstMoveAfter !== null);
    const sure = m.endedAt.phones >= 2 || m.endedAt.offBy <= 0.2;
    const quiet = !ctx.reports.some((r) => dangerImpact(r, 12));
    hyps.push({
      name: `resting on the ${m.endedAt.place.name}`,
      strength: (awake ? 0.7 : quiet ? 0.62 : 0.4) + (m.usualRest ? 0.1 : 0) - (sure ? 0 : 0.15),
      because: `the room map puts them at the ${m.endedAt.place.name} afterwards, a place people sit or lie down${awake ? ", and they shifted around after" : ""}`
    });
  }
  const resumed = rs.filter((r) => r.sonar.online && !phoneMovedItself(r) && r.sonar.motionResumed);
  if (resumed.length) {
    hyps.push({ name: "moving normally", strength: 0.7, because: `${resumed.map((r) => r.name).join(" and ")} saw them moving normally a few seconds later` });
  }
  const anyImpact = rs.some((r) => heardImpact(r, 10));
  const sat = watchers.filter((r) => r.sonar.burstDb >= 16 && r.sonar.presentAfter && !anyImpact);
  if (sat.length) {
    const r = sat[0];
    const shift = rangeShift(r);
    const shifted = r.sonar.firstMoveAfter !== null;
    hyps.push({
      name: "sat down quickly",
      strength: (shift !== null && shift < 0.35 ? 0.45 : 0.25) + (shifted ? 0.2 : -0.15),
      because: `fast motion with no impact sound, then resting ${shift !== null && shift < 0.35 ? "at the same distance" : "nearby"} on ${r.name}${shifted ? `, and shifting position ${r.sonar.firstMoveAfter.toFixed(0)} s later` : ""}`
    });
  }
  const settled = watchers.filter((r) => r.sonar.presentAfter && r.sonar.firstMoveAfter !== null && !r.sonar.motionResumed);
  if (settled.length && !sat.length) {
    const same = (rangeShift(settled[0]) ?? 9) < 0.25;
    hyps.push({
      name: same ? "fine, still standing where they were" : "conscious and moving",
      strength: same ? 0.62 : 0.5,
      because: `${settled[0].name} saw them shift position ${settled[0].sonar.firstMoveAfter.toFixed(0)} s later, which an unconscious person does not do`
    });
  }
  const measured = watchers.filter((r) => r.sonar.presentAfter && rangeShift(r) !== null);
  if (measured.length && measured.every((r) => rangeShift(r) < 0.25) && !resumed.length) {
    hyps.push({
      name: "still in the same spot",
      strength: measured.length >= 2 ? 0.45 : 0.35,
      because: `${measured.map((r) => `${r.name} shows them at ${r.sonar.rangeAfter.toFixed(1)} m, same as before`).join("; ")}; a fall usually moves the body`
    });
  }
  if (trust) {
    const bad = ctx.reports.filter((r) => w(trust, r) < 0.5 && (r.localVerdict !== "none" || sonarBurst(r) || heardImpact(r, 20)));
    const goodDanger = rs.some((r) => r.localVerdict !== "none" || sonarBurst(r) || heardImpact(r, 20));
    if (bad.length && !goodDanger) {
      hyps.push({ name: "bad data", strength: 0.85, because: `the only alarming report comes from ${bad.map((r) => r.name).join(", ")}, which the Auditor showed contradicts the others` });
    }
  }
  const before = knownHarmless(ctx.memory, ctx.reports, ctx.incident.t0);
  if (before.length >= 2 && !bodyDown && !rs.some((r) => r.sound.screamDb !== null || r.sound.distress)) {
    hyps.push({
      name: "a known everyday sound in this home",
      strength: Math.min(0.66, 0.42 + 0.06 * before.length),
      because: `${before.length} earlier incidents like this (same sound, loudest on the same phone, same time of day) turned out fine when someone answered`
    });
  }
  if (!hyps.length && heard.length && !rs.some(sonarBurst) && !rs.some((r) => r.sound.screamDb !== null || r.sound.distress) && !rs.some(thudSound)) {
    hyps.push({ name: "dropped object", strength: 0.4, because: "a bang with no body motion on any sonar" });
  }
  hyps.sort((a, b) => b.strength - a.strength);
  let best = hyps[0];
  if (ctx.round === 2 && best) {
    const au = ctx.prior.find((p) => p.agent === "auditor");
    if (au?.stance === "escalate" && best.strength < 0.7) best = { ...best, strength: best.strength - 0.15 };
  }
  const points = hyps.map((h) => `${h.name}: ${h.because}`);
  if (ctx.incident.trigger.kind === "help_pressed") {
    return position(ctx, "skeptic", "escalate", 0.9, "A person asking for help is not something I argue with.", points);
  }
  const brief = (h) => h.because.split("; ").slice(0, 2).join(", and ");
  if (best && best.strength >= 0.55) {
    return position(ctx, "skeptic", "stand_down", best.strength, `I think it was ${best.name}. ${cap(brief(best))}.`, points);
  }
  const strong = rs.some(fullSignature) || rs.some((r) => r.sound.screamDb !== null || r.sound.distress);
  const conflict = ctx.prior.find((p) => p.conflict)?.conflict;
  if (conflict && (!best || best.strength < 0.55)) {
    return position(ctx, "skeptic", "uncertain", 0.5, "I cannot explain this, but the phones disagree with each other, so I would not trust either story without asking.", points);
  }
  if (!best && strong) {
    return position(ctx, "skeptic", "escalate", 0.6, "I tried to explain this away and could not. Every phone tells the same story.", ["no harmless explanation fits"]);
  }
  if (best && best.strength >= 0.35) {
    return position(ctx, "skeptic", "uncertain", 0.5, `Maybe ${best.name}, but I am not sure. ${cap(brief(best))}.`, points);
  }
  return position(ctx, "skeptic", strong ? "escalate" : "uncertain", 0.45, strong ? "Nothing harmless fits well enough." : "There is too little here to explain either way.", points);
}
var ROLES = { responder, skeptic, auditor };
var ROLE_INFO = {
  investigator: { title: "Investigator", goal: "Called in only when the others cannot agree. Goes and looks: asks phones to look again, checks the room map and the home history, then casts the deciding vote." },
  responder: { title: "Responder", goal: "Never let a real fall go unanswered. Argues for getting help." },
  skeptic: { title: "Skeptic", goal: "Prevent false alarms. Looks for a harmless explanation that fits every measurement." },
  auditor: { title: "Auditor", goal: "Trust no phone by default. Checks every report against physics and the other phones." }
};

// src/agents/otel.ts
var import_node_crypto2 = require("node:crypto");
var hex = (n) => (0, import_node_crypto2.randomBytes)(n).toString("hex");
var ns = (ms) => String(Math.round(ms * 1e6));
var attr = (k, v) => ({
  key: k,
  value: typeof v === "number" ? { doubleValue: v } : typeof v === "boolean" ? { boolValue: v } : { stringValue: String(v).slice(0, 500) }
});
function incidentSpans(r) {
  const traceId = hex(16);
  const root = hex(8);
  const end = r.outcome.decidedAt;
  const spans = [
    {
      traceId,
      spanId: root,
      name: `incident ${r.incident.trigger.kind}`,
      kind: 1,
      startTimeUnixNano: ns(r.incident.t0),
      endTimeUnixNano: ns(end),
      attributes: [attr("witness.incident", r.incident.id), attr("witness.trigger", r.incident.trigger.detail), attr("witness.outcome", r.outcome.kind), attr("witness.headline", r.outcome.headline), attr("witness.simulated", r.incident.simulated)]
    }
  ];
  const child = (name, t0, t1, attrs) => spans.push({ traceId, spanId: hex(8), parentSpanId: root, name, kind: 1, startTimeUnixNano: ns(t0), endTimeUnixNano: ns(Math.max(t1, t0 + 1)), attributes: attrs });
  for (const rep of r.reports) child(`report ${rep.name}`, rep.postedAt - 50, rep.postedAt, [attr("agent", `phone ${rep.name}`), attr("verdict", rep.localVerdict), attr("impact_db", rep.sound.impactDb ?? -1), attr("burst_db", rep.sonar.burstDb)]);
  for (const p of r.positions) child(`${p.agent} round ${p.round}`, p.postedAt - 100, p.postedAt, [attr("agent", p.agent), attr("stance", p.stance), attr("confidence", p.confidence), attr("argument", p.argument), attr("llm", p.llm)]);
  for (const t of r.traces) child(`${t.agent} ${t.tool ?? t.kind}`, t.t - 50, t.t, [attr("agent", t.agent), attr("step", t.step), attr("summary", t.summary)]);
  child("outcome", end - 1, end, [attr("kind", r.outcome.kind), attr("summary", r.outcome.summary)]);
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr("service.name", "echosense-witness"), attr("witness.channel", "AGNTCY SLIM")] },
        scopeSpans: [{ scope: { name: "witness", version: "1.0.0" }, spans }]
      }
    ]
  };
}
async function exportIncident(endpoint, r) {
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(incidentSpans(r)) });
    return res.ok;
  } catch {
    return false;
  }
}

// src/sim/random.ts
var Rng = class {
  constructor(seed = 1) {
    this.spare = null;
    this.s = seed >>> 0 || 1;
  }
  next() {
    this.s = this.s + 1831565813 >>> 0;
    let t = this.s;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  uniform(a, b) {
    return a + (b - a) * this.next();
  }
  gauss() {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
};

// src/agents/llm.ts
function llmFromEnv(env = process.env) {
  const apiKey = env.ANTHROPIC_API_KEY ?? "";
  const mode = env.ECHOSENSE_LLM ?? (apiKey ? "agent" : "off");
  return {
    apiKey,
    model: env.ECHOSENSE_LLM_MODEL ?? "claude-haiku-4-5-20251001",
    // Older settings (narrate, reason) cost a Claude call per agent per incident: map them to the Investigator.
    mode: apiKey && ["off", "narrate", "reason", "agent"].includes(mode) ? mode === "off" ? "off" : "agent" : "off",
    timeoutMs: Number(env.ECHOSENSE_LLM_TIMEOUT ?? 12e3),
    baseUrl: env.ANTHROPIC_BASE_URL || void 0,
    workspaceId: env.ANTHROPIC_WORKSPACE_ID || void 0
  };
}
function compactReport(r, trust) {
  const s = r.sonar;
  const ai = r.sound.impactAi;
  return {
    phone: r.name,
    trust: trust === void 0 ? void 0 : Math.round(trust * 100) / 100,
    streamed_samples: r.samples,
    silent_before_s: r.silenceMs > 1e8 ? "never streamed" : +(r.silenceMs / 1e3).toFixed(1),
    heard_impact_db: r.sound.impactDb === null ? null : Math.round(r.sound.impactDb),
    impact_repeating: r.sound.impactRepetitive || void 0,
    sound_model_says: ai ? `${ai.label} (${ai.group}, ${Math.round(ai.score * 100)}%)` : r.sound.impactDb === null ? void 0 : "not recognised",
    tv_or_music_share_before: r.sound.media === null ? void 0 : +r.sound.media.toFixed(2),
    voice_or_music_events_before: r.sound.mediaEventsBefore,
    scream: r.sound.screamDb !== null,
    distress_sound: r.sound.distress,
    voice_after: r.sound.voiceAfter,
    sonar_online: s.online,
    // Sonar that was not running knows nothing: every sonar reading is "unknown", never "nobody".
    ...s.online ? {
      was_watching_person: s.sawPersonBefore,
      last_saw_person_s_before: s.lastSeenAgo === null ? null : +s.lastSeenAgo.toFixed(1),
      range_before_m: s.rangeBefore === null ? null : +s.rangeBefore.toFixed(2),
      range_after_m: s.rangeAfter === null ? null : +s.rangeAfter.toFixed(2),
      body_burst_db: Math.round(s.burstDb),
      still_after_fraction: +s.stillAfter.toFixed(2),
      first_movement_after_s: s.firstMoveAfter === null ? null : +s.firstMoveAfter.toFixed(1),
      moved_normally_after: s.motionResumed,
      person_present_after: s.presentAfter,
      breathing_after_bpm: s.breathingAfter
    } : { sonar_readings: "unknown: this phone had no working sonar for this event" },
    phone_itself_moved: r.imu.moved || r.imu.dropped || s.roomChangeDb >= 15,
    phone_own_verdict: r.localVerdict
  };
}
var SYSTEM = (role) => `You are the ${ROLE_INFO[role].title} agent in Witness, a home safety system where phones sense a room with sonar and sound. Your goal: ${ROLE_INFO[role].goal} Several agents with different goals argue over the same evidence and no single agent decides. Speak like a calm, sharp person in one or two short sentences. Cite phones by name and numbers from the evidence. No jargon, no hedging filler, no dashes. Reply with JSON only.`;
function makeVoice(cfg, onError = () => {
}) {
  if (cfg.mode === "off" || cfg.mode === "agent" || !cfg.apiKey) return void 0;
  const timeoutMs = Math.min(cfg.timeoutMs, 6e3);
  return async (draft, ctx) => {
    const trust = ctx.prior.find((p) => p.agent === "auditor")?.trust ?? draft.trust;
    const evidence = ctx.reports.map((r) => compactReport(r, trust?.[r.nodeId]?.score));
    const others = ctx.prior.filter((p) => p.agent !== draft.agent).map((p) => ({ agent: p.agent, stance: p.stance, argument: p.argument }));
    const task = cfg.mode === "reason" ? 'Decide your stance: "escalate" (get a caregiver now), "stand_down" (no emergency) or "uncertain" (ask the person). The rule engine drafted the position below; you may disagree with it if the evidence supports you.' : "Rewrite the argument below in your own voice. Keep the same stance and the same facts.";
    const user = JSON.stringify({
      round: ctx.round,
      trigger: ctx.incident.trigger,
      evidence,
      other_agents_round_1: ctx.round === 2 ? others : void 0,
      draft: { stance: draft.stance, confidence: +draft.confidence.toFixed(2), argument: draft.argument, points: draft.points },
      task,
      reply_format: { stance: "escalate | stand_down | uncertain", confidence: "0..1", argument: "one or two sentences" }
    });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", ...cfg.workspaceId ? { "anthropic-workspace-id": cfg.workspaceId } : {} },
        body: JSON.stringify({ model: cfg.model, max_tokens: 300, system: SYSTEM(draft.agent), messages: [{ role: "user", content: user }] })
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 400)}`);
      const body = await res.json();
      const text = body.content.map((c) => c.text ?? "").join("");
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("model reply had no JSON");
      const out = JSON.parse(m[0]);
      const stance = cfg.mode === "reason" && (out.stance === "escalate" || out.stance === "stand_down" || out.stance === "uncertain") ? out.stance : draft.stance;
      const argument = typeof out.argument === "string" && out.argument.trim() ? out.argument.trim().replace(/\s*[—–]\s*/g, ", ") : draft.argument;
      const confidence = cfg.mode === "reason" && typeof out.confidence === "number" ? Math.max(0.05, Math.min(0.97, out.confidence)) : draft.confidence;
      return { ...draft, stance, confidence, argument, llm: true };
    } catch (e) {
      onError(e);
      return draft;
    } finally {
      clearTimeout(timer);
    }
  };
}
async function checkKey(cfg) {
  if (!cfg.apiKey) return "no ANTHROPIC_API_KEY in .env";
  try {
    const res = await fetch(`${cfg.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", ...cfg.workspaceId ? { "anthropic-workspace-id": cfg.workspaceId } : {} },
      body: JSON.stringify({ model: cfg.model, max_tokens: 5, messages: [{ role: "user", content: "Say OK" }] })
    });
    if (res.ok) return "OK";
    const t = await res.text();
    if (t.includes("workspace")) return `the key needs a workspace id: add ANTHROPIC_WORKSPACE_ID=wrkspc_... to .env (${t.slice(0, 300)})`;
    return `Anthropic API ${res.status}: ${t.slice(0, 300)}`;
  } catch (e) {
    return `cannot reach the Anthropic API (${e.message})`;
  }
}
async function caregiverBrief(cfg, facts, fallback, onUsage) {
  if (!cfg?.apiKey || cfg.mode === "off") return fallback;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4e3);
  try {
    const res = await fetch(`${cfg.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", ...cfg.workspaceId ? { "anthropic-workspace-id": cfg.workspaceId } : {} },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 160,
        system: 'You write the alert a family member receives from a home safety system for an older relative. At most three short plain sentences: what happened and where, what the person said (quote it) or that they did not answer, and the one most telling measurement. Calm, factual, no jargon, no dashes, no greeting, no advice beyond "please check on them".',
        messages: [{ role: "user", content: JSON.stringify(facts) }]
      })
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    if (body.usage) onUsage?.(body.usage);
    const text = body.content.map((c) => c.text ?? "").join("").trim().replace(/\s*[—–]\s*/g, ", ");
    return text && text.length < 600 ? text : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

// src/agents/brain.ts
var TOOLS = [
  {
    name: "physics_check",
    description: "Check every phone's report against physics and against the other phones: did a bang that loud reach the other phones, does each phone's verdict follow from its own numbers, did a phone itself get moved, was the report replayed, do two phones tell opposite stories. Returns a trust score per phone with reasons.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "ask_cartographer",
    description: "Ask the Cartographer agent what the room map says: which marked place (TV, sofa, a phone itself, the person) the loudness pattern fits best, where the person ended up, and whether that is a spot where someone usually rests.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "ask_all_phones",
    description: "Broadcast one request to every phone in the room to look again right now (one message on the shared channel; each phone answers with whether it sees someone, whether they move, distance, breathing and sounds since). Optionally every phone waits up to 10 seconds first. Use this before asking single phones.",
    input_schema: {
      type: "object",
      properties: { wait_seconds: { type: "number", description: "0 to 10" } },
      additionalProperties: false
    }
  },
  {
    name: "ask_phone",
    description: "Ask one phone to look again right now. The reports only cover the first 11 seconds after the incident; this returns what the phone measures now: whether it sees someone, whether they are moving, their distance, breathing, and any sounds since. You may ask it to wait up to 10 seconds first to see if anything changes.",
    input_schema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Phone name exactly as in the evidence" },
        wait_seconds: { type: "number", description: "0 to 10" }
      },
      required: ["phone"],
      additionalProperties: false
    }
  },
  {
    name: "home_history",
    description: "Read this home's memory: earlier incidents, what was decided, and what the person or caregiver said afterwards. Shows phones whose alarms keep turning out false and patterns like the same harmless sound at the same time of day.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "role_checklist",
    description: "Run your role's standard checklist over the evidence (the fixed rules every agent of your role follows). Returns the stance the checklist reaches and the facts it found. You may disagree with it.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "post_position",
    description: "Post your position to the other agents. Call this exactly once, when you have decided.",
    input_schema: {
      type: "object",
      properties: {
        stance: { type: "string", enum: ["escalate", "stand_down", "uncertain"], description: "escalate: call a caregiver now. stand_down: no emergency. uncertain: ask the person out loud (no answer means a caregiver is called)." },
        confidence: { type: "number", description: "0 to 1" },
        argument: { type: "string", description: "One or two plain sentences to the other agents, citing phones by name and numbers." },
        cited: { type: "array", items: { type: "string" }, description: "The specific facts you relied on, short." }
      },
      required: ["stance", "confidence", "argument"],
      additionalProperties: false
    }
  }
];
var INVESTIGATOR_SYSTEM = [
  "You are the Investigator in Witness, the safety system in an older person's home. Phones sense the room with sonar (distance and body movement) and on-phone sound recognition.",
  "Three local agents (Responder: never miss a fall; Skeptic: avoid false alarms; Auditor: check every phone against physics) already argued and could not agree. You are called in only now, to break the tie, and you are the only part of the system that costs money, so be quick.",
  "Go and look: ask_all_phones broadcasts one request to every phone to look again right now (add a few seconds of wait if someone may be down), ask_phone asks one phone directly, ask_cartographer reads the room map, home_history reads what this home learned, physics_check checks the phones against each other. Call the tools you need in one turn; they run in parallel. Two turns of looking is usually enough.",
  'Then post_position. "stand_down" only if what you found explains the event and shows the person is fine (moving normally, sitting where they usually sit, the bang came from the TV). "escalate" if what you found points to a fall: the phones then say "It looks like you may have fallen" and call the family in 25 s unless the person says they are OK. "uncertain" keeps the gentle "Are you OK?" question.',
  "Readings: impact dB is above that phone's quiet level (20+ is a real bang). sound_model_says is the on-phone sound recognition. body_burst_db 20+ is a sudden body movement. still_after_fraction near 1 means nobody moved; first_movement_after_s is when they first shifted.",
  "Argument: one or two plain sentences citing what you found, phones by name, numbers. No jargon, no dashes."
].join("\n");
var SYSTEM2 = (role) => role === "investigator" ? INVESTIGATOR_SYSTEM : [
  `You are the ${ROLE_INFO[role].title} agent in Witness, the safety system in an older person's home. Phones around the room sense with sonar (distance and body movement) and a sound recognition model.`,
  `Your goal: ${ROLE_INFO[role].goal}`,
  "Three agents with different goals (Responder, Skeptic, Auditor) argue over the same evidence. A Cartographer agent knows the room map but does not vote. Nobody decides alone. The public rule: get help if no agent says stand down and at least two say escalate; no emergency if no agent says escalate and at least two say stand down; anything else asks the person out loud, and no answer calls a caregiver.",
  'What happens next: "escalate" makes the phones say "It looks like you may have fallen" and call the family in 25 seconds unless the person says they are OK (at once if they cry out or ask for help). "uncertain" asks "Are you OK?" gently and calls if nobody answers. "stand_down" does nothing, except asking anyway if nobody moves for a minute. So a wrong "stand_down" is the costly mistake; a wrong "escalate" costs a scary sentence and a call they must cancel. The person may not be able to use a screen; their spoken answer is understood by speech recognition.',
  "You decide what to look at. Use the tools when they could change your mind, not by habit: the evidence you were handed may already be enough. If someone may be down and not moving, a fresh look from a phone (ask_phone, with a short wait) is often the most useful thing you can do. In round 2 you already investigated in round 1: do not repeat the same tools. Read the other agents and answer their strongest point; call a tool only if someone raised something you never checked.",
  "Before a tool call you may think out loud in ONE short plain sentence (under 25 words, no lists, no markdown). Do not restate the evidence.",
  "If you want several tools, call them all in the same turn; they run in parallel and time matters.",
  "Readings: impact dB is above that phone's quiet level (20+ is a real bang, under 10 is faint). sound_model_says is the on-phone sound recognition of that bang: a snap, tap, knock, speech, TV or music, footsteps or a door are everyday sounds; a thump or thud can be a fall; it is a model and can be wrong. tv_or_music_share_before near 1 means a TV or music was playing. body_burst_db 20+ is a sudden body movement, under 16 is ordinary. still_after_fraction near 1 means nobody moved afterwards; first_movement_after_s is when they first shifted (an unconscious person does not). phone_itself_moved means its sonar described the phone, not the room. A phone with few streamed_samples or a long silence was asleep and knows little.",
  "Finish by calling post_position once. Speak like a calm, sharp person: one or two short sentences, cite phones by name and numbers. No jargon, no filler, no dashes."
].join("\n");
async function agentThink(cfg, ctx, role, tools, opts) {
  const isInv = role === "investigator";
  const draft = isInv ? {
    id: uid("position"),
    incidentId: ctx.incident.id,
    agent: "investigator",
    round: 3,
    stance: "uncertain",
    confidence: 0.5,
    argument: "I could not look into it, so the person is asked.",
    points: [],
    llm: false,
    postedAt: Date.now()
  } : ROLES[role]({ ...ctx, memory: ctx.memory ?? tools.memory?.() });
  const deadline = Date.now() + opts.budgetMs;
  let step = 0;
  const trace = (kind, summary, tool, input) => opts.onTrace?.({ incidentId: ctx.incident.id, agent: role, round: ctx.round, step: ++step, kind, tool, input, summary: summary.slice(0, 400), t: Date.now() });
  const used = [];
  const findings = [];
  if (ctx.incident.trigger.kind === "help_pressed") return draft;
  const fullCtx = { ...ctx, context: ctx.context ?? tools.context?.(), memory: ctx.memory ?? tools.memory?.() };
  const auditTrust = ctx.prior.find((p) => p.agent === "auditor")?.trust;
  const evidence = ctx.reports.map((r) => compactReport(r, auditTrust?.[r.nodeId]?.score));
  const mine = ctx.prior.find((p) => p.agent === role);
  const brief = {
    round: ctx.round,
    what_happened: { trigger: ctx.incident.trigger.kind, phone: ctx.incident.trigger.name, detail: ctx.incident.trigger.detail },
    local_time: new Date(ctx.incident.t0).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }),
    evidence
  };
  if (isInv) {
    brief.the_three_agents = ctx.prior.map((p) => ({ agent: p.agent, stance: p.stance, confidence: +p.confidence.toFixed(2), argument: p.argument, facts: p.points.slice(0, 5), conflict: p.conflict }));
  } else if (ctx.round === 2) {
    brief.your_round_1 = mine ? { stance: mine.stance, argument: mine.argument, what_you_found: mine.findings } : null;
    brief.other_agents_round_1 = ctx.prior.filter((p) => p.agent !== role).map((p) => ({ agent: p.agent, stance: p.stance, confidence: +p.confidence.toFixed(2), argument: p.argument, what_they_found: p.findings, conflict: p.conflict }));
  }
  const messages = [{ role: "user", content: JSON.stringify(brief) }];
  const runTool = async (name, input) => {
    if (name === "physics_check") {
      const a = role === "auditor" ? draft : auditor({ ...fullCtx, round: 1, prior: [] });
      const trust = Object.fromEntries(ctx.reports.map((r) => [r.name, { trust: Math.round((a.trust?.[r.nodeId]?.score ?? 1) * 100) / 100, reasons: a.trust?.[r.nodeId]?.reasons ?? [] }]));
      const low = ctx.reports.filter((r) => (a.trust?.[r.nodeId]?.score ?? 1) < 0.5).map((r) => r.name);
      return {
        result: { trust, conflict: a.conflict ?? null },
        summary: a.conflict ? `conflict: ${a.conflict}` : low.length ? `low trust: ${low.join(", ")}` : "every phone checks out"
      };
    }
    if (name === "ask_cartographer") {
      const c = fullCtx.context;
      if (!c) return { result: { note: "The Cartographer has nothing: no room map for this home yet." }, summary: "no room map yet" };
      return {
        result: {
          notes: c.notes,
          bang_fits_best: c.source ? { place: c.source.name, kind: c.source.kind, misfit_db: +c.source.errDb.toFixed(1) } : null,
          bang_fits_person: c.personFit ? +c.personFit.errDb.toFixed(1) : null,
          person_ended_at: c.endedAt ? c.endedAt.place.name : null,
          usual_rest_spot: c.usualRest,
          loudest_phone_sits_by: c.loudestNear
        },
        summary: c.notes.slice(0, 2).join("; ")
      };
    }
    if (name === "ask_all_phones") {
      const waitS = Math.max(0, Math.min(10, Number(input.wait_seconds ?? 0) || 0, (deadline - Date.now() - 6e3) / 1e3));
      if (!tools.lookNow) return { result: { note: "Phones cannot be asked again in this replay." }, summary: "not available in this replay" };
      const r = await tools.lookNow(ctx.incident.id, "all", waitS);
      const parts = (r.replies ?? []).map((x) => `${x.phone}: ${lookWords(x.look)}`);
      if (r.no_reply?.length) parts.push(`no reply from ${r.no_reply.join(", ")}`);
      return { result: r, summary: `broadcast to every phone${waitS >= 1 ? ` (after ${Math.round(waitS)} s)` : ""}: ${parts.join("; ") || "no replies"}` };
    }
    if (name === "ask_phone") {
      const phone = String(input.phone ?? "");
      const waitS = Math.max(0, Math.min(10, Number(input.wait_seconds ?? 0) || 0, (deadline - Date.now() - 6e3) / 1e3));
      if (!tools.lookNow) return { result: { note: "Phones cannot be asked again in this replay." }, summary: "not available in this replay" };
      const r = await tools.lookNow(ctx.incident.id, phone, waitS);
      const s = lookWords(r);
      return { result: r, summary: `${phone}${waitS >= 1 ? ` after ${Math.round(waitS)} s` : ""}: ${s}` };
    }
    if (name === "home_history") {
      const h = summarize(fullCtx.memory, tools.names?.() ?? {}, ctx.reports, ctx.incident.t0);
      return { result: h, summary: h.note ? String(h.note) : `${h.incidents_remembered} past incidents${h.pattern ? `; ${h.pattern}` : ""}` };
    }
    if (name === "role_checklist") {
      return {
        result: { stance: draft.stance, confidence: +draft.confidence.toFixed(2), finding: draft.argument, facts: draft.points.slice(0, 10) },
        summary: `checklist says ${draft.stance.replace("_", " ")}: ${draft.argument}`
      };
    }
    return { result: { error: `unknown tool ${name}` }, summary: `unknown tool ${name}` };
  };
  try {
    const maxTurns = isInv ? 4 : 7;
    for (let turn = 0; turn < maxTurns; turn++) {
      const left = deadline - Date.now();
      if (left < 2500) throw new Error("out of time");
      if (opts.canSpend && !opts.canSpend()) throw new Error("today's Claude budget is used up");
      const last = turn === maxTurns - 1 || left < 9e3;
      const body = await call(cfg, {
        system: SYSTEM2(role),
        messages,
        tools: isInv ? TOOLS.filter((t) => t.name !== "role_checklist") : TOOLS,
        tool_choice: last ? { type: "tool", name: "post_position" } : { type: "auto" },
        max_tokens: isInv ? 400 : 600
      }, Math.min(left - 500, cfg.timeoutMs), deadline);
      opts.onUsage?.(body.usage);
      messages.push({ role: "assistant", content: body.content });
      const text = body.content.filter((b) => b.type === "text" && b.text?.trim()).map((b) => b.text.trim()).join(" ");
      if (text) trace("thought", text);
      const calls = body.content.filter((b) => b.type === "tool_use");
      if (!calls.length) {
        messages.push({ role: "user", content: "Use a tool if you need more, otherwise call post_position now." });
        continue;
      }
      const post = calls.find((c) => c.name === "post_position");
      if (post) return finalize(post.input ?? {});
      for (const c of calls) used.push(c.name);
      const results = await Promise.all(
        calls.map(async (c) => {
          const { result, summary } = await runTool(c.name, c.input ?? {});
          if (c.name !== "role_checklist") findings.push(`${c.name}: ${summary}`.slice(0, 240));
          trace("tool", summary, c.name, c.input);
          return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(result).slice(0, isInv ? 2500 : 6e3) };
        })
      );
      messages.push({ role: "user", content: results });
    }
    throw new Error(`no decision after ${maxTurns} turns`);
  } catch (e) {
    opts.onError?.(e);
    trace("fallback", isInv ? `Claude could not investigate (${e.message.slice(0, 120)}), so the person is asked` : `Claude did not finish (${e.message.slice(0, 120)}), using the ${ROLE_INFO[role].title} checklist`);
    return { ...draft, tools: used, findings };
  }
  function finalize(out) {
    const stance = out.stance === "escalate" || out.stance === "stand_down" || out.stance === "uncertain" ? out.stance : draft.stance;
    let confidence = typeof out.confidence === "number" ? Math.max(0.05, Math.min(0.97, out.confidence)) : draft.confidence;
    let argument = typeof out.argument === "string" && out.argument.trim() ? out.argument.trim().replace(/\s*[—–]\s*/g, ", ") : draft.argument;
    const cited = Array.isArray(out.cited) ? out.cited.filter((x) => typeof x === "string").slice(0, 8) : [];
    let final = stance;
    let floor;
    const strongCase = isInv ? ctx.prior.some((p) => p.stance === "escalate" && p.confidence >= 0.8 || p.conflict) : draft.stance === "escalate" && draft.confidence >= 0.6;
    if (stance === "stand_down" && strongCase) {
      final = "uncertain";
      confidence = 0.5;
      floor = isInv ? "wanted to stand down, but one of the agents has a strong case for help or the phones contradict each other, so the person gets asked instead" : `wanted to stand down, but the ${ROLE_INFO[role].title} checklist found a strong case for help (${draft.argument}), so the person gets asked instead`;
      argument = `${argument} (Safety rule: not standing down against this evidence, so we ask.)`;
      trace("floor", floor);
    }
    return {
      ...draft,
      stance: final,
      confidence,
      argument,
      points: cited.length ? cited : draft.points,
      llm: true,
      tools: used,
      findings,
      floor,
      postedAt: Date.now()
    };
  }
}
async function call(cfg, req, timeoutMs, deadline = Date.now() + timeoutMs) {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(1e3, Math.min(timeoutMs, deadline - Date.now())));
    try {
      const res = await fetch(`${cfg.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", ...cfg.workspaceId ? { "anthropic-workspace-id": cfg.workspaceId } : {} },
        body: JSON.stringify({ model: cfg.model, ...req })
      });
      if (res.ok) return await res.json();
      const text = (await res.text()).slice(0, 400);
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      const wait = Math.min(8e3, (Number(res.headers.get("retry-after")) || 0) * 1e3 || 1200 * (attempt + 1));
      if (!retryable || attempt >= 3 || Date.now() + wait > deadline - 4e3) throw new Error(`Anthropic API ${res.status}: ${text}`);
      await new Promise((r) => setTimeout(r, wait));
    } catch (e) {
      if (e.name === "AbortError") throw new Error("Claude took too long");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
function lookWords(r) {
  if (r.streaming === false) return String(r.note ?? "not streaming");
  if (r.error) return String(r.error);
  const sounds = r.sounds_since_incident;
  return `${r.sees_someone_now ? `sees someone${r.distance_now_m ? ` at ${r.distance_now_m} m` : ""}` : "sees nobody"}${r.moving_now ? ", moving" : r.moving_now === false ? ", not moving" : ""}${r.breathing_bpm_now ? `, breathing ${r.breathing_bpm_now}/min` : ""}${r.moved_since_report ? ", moved since the report" : ""}${sounds?.length ? `, heard ${sounds.join(", ")}` : ""}`;
}

// src/agents/negotiation.ts
var LADDER = ["none", "watch", "ask", "urgent", "call"];
var ACTION_WORDS = {
  none: "do nothing",
  watch: "keep watching",
  ask: 'ask "Are you OK?"',
  urgent: 'say "you may have fallen" and count down',
  call: "call the family now"
};
function describePlan(p) {
  return `${ACTION_WORDS[p.action]}${p.callIfNoMovementS && p.action !== "call" ? `, and call at once if nobody moves within ${p.callIfNoMovementS} s` : ""}`;
}
function rank(a) {
  return LADDER.indexOf(a);
}
function openingPlan(p) {
  const s = p.stance;
  if (s === "escalate") return { action: p.agent === "responder" ? "call" : "urgent" };
  if (s === "uncertain") return { action: "ask" };
  return { action: p.agent === "skeptic" ? "none" : "watch" };
}
function samePlan(a, b) {
  return a.action === b.action;
}
function agreed(plans) {
  if (plans.length < 3 || !plans.every((p) => p.action === plans[0].action)) return null;
  const conds = plans.map((p) => p.callIfNoMovementS).filter((x) => !!x);
  return { action: plans[0].action, callIfNoMovementS: conds.length ? Math.min(...conds) : null };
}
function nearAgreement(plans) {
  const ranks = plans.map((p) => rank(p.action));
  if (plans.length < 3 || Math.min(...ranks) < rank("ask") || Math.max(...ranks) > rank("urgent")) return null;
  const conds = plans.map((p) => p.callIfNoMovementS).filter((x) => !!x);
  return { action: Math.max(...ranks) === rank("urgent") ? "urgent" : "ask", callIfNoMovementS: conds.length ? Math.min(...conds) : null };
}
function noDeal(plans) {
  const top = Math.max(...plans.map((p) => rank(p.action)));
  const action = top >= rank("urgent") ? "urgent" : top >= rank("ask") ? "ask" : "watch";
  const conds = plans.map((p) => p.callIfNoMovementS).filter((x) => !!x);
  return { action, callIfNoMovementS: conds.length ? Math.min(...conds) : null };
}
function normalisePlan(x, fallback) {
  const o = x ?? {};
  const action = LADDER.includes(o.action ?? "") ? o.action : fallback.action;
  const raw = o.call_if_no_movement_s ?? o.callIfNoMovementS ?? null;
  const cond = typeof raw === "number" && raw > 0 && action !== "call" ? Math.round(Math.min(120, Math.max(10, raw))) : null;
  return { action, callIfNoMovementS: cond };
}
var TITLES = { responder: "Responder", skeptic: "Skeptic", auditor: "Auditor" };
var ROLES3 = ["auditor", "responder", "skeptic"];
function negotiatedOutcome(rule, transcript, plan, deal, rounds) {
  const last = (r) => [...transcript].reverse().find((m) => m.agent === r);
  const stanceOf = (p) => p.action === "call" || p.action === "urgent" ? "escalate" : p.action === "ask" ? "uncertain" : "stand_down";
  return {
    ...rule,
    kind: plan.action === "call" || plan.action === "urgent" ? "escalate" : plan.action === "ask" ? "ask_human" : "stand_down",
    unanimous: deal,
    headline: deal ? `Agents negotiated a plan: ${describePlan(plan)}` : `No agreement after ${rounds} rounds: the disagreement is kept and the person is asked`,
    summary: ROLES3.map((r) => `${TITLES[r]}: ${last(r).argument}`).join(" "),
    dissent: deal ? [] : ROLES3.filter((r) => !samePlan(last(r).plan, plan)).map((r) => ({ agent: r, stance: stanceOf(last(r).plan), argument: last(r).argument })),
    plan,
    negotiation: { rounds, agreed: deal },
    decidedAt: Date.now()
  };
}

// src/agents/negotiator.ts
var GOALS = {
  responder: "You speak for the person. Your goal is that a real fall is never left unanswered. Push for the strongest response the evidence supports, but you lose credibility if you ignore evidence that they are fine.",
  skeptic: "You speak for the household against false alarms: every needless call scares the family and makes them switch the system off. Push for the lightest response the evidence allows, but never argue someone is fine when the evidence says they may be on the floor.",
  auditor: "You trust no phone by default. Your goal is that the decision rests only on evidence that checks out across phones. Side with whoever the trustworthy evidence supports, call out claims built on a phone that was moved, replayed, or contradicted, and propose conditions that test the disputed fact."
};
var TOOLS2 = [
  {
    name: "ask_all_phones",
    description: "Broadcast one request on the channel: every phone looks again right now (optionally after waiting up to 10 s) and replies with whether it sees someone, movement, distance, breathing, sounds since. Use it to settle a disputed fact.",
    input_schema: { type: "object", properties: { wait_seconds: { type: "number" } }, additionalProperties: false }
  },
  {
    name: "ask_cartographer",
    description: "Ask the Cartographer what the room map says: where the bang came from, where the person ended up, whether that is a usual resting spot.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "physics_check",
    description: "Check each phone's report against physics and the other phones (moved, replayed, contradicted). Returns trust per phone.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "home_history",
    description: "What this home learned from people's answers before: phones that cry wolf, harmless sounds at this time of day.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "make_move",
    description: "Make your one move for this round. Call it exactly once.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["offer", "challenge", "concede", "counter", "accept"], description: "offer: first proposal. challenge: dispute a specific claim of another agent with evidence. concede: admit another agent is right about a claim. counter: propose a different plan, usually meeting them part way. accept: agree to another agent's current plan exactly." },
        to: { type: "string", enum: ["responder", "skeptic", "auditor"], description: "Whose claim or plan this answers (not for offer)." },
        claim: { type: "string", description: "The claim you challenge or concede, in a few words." },
        action: { type: "string", enum: [...LADDER], description: "The plan you now stand behind: none, watch, ask, urgent, call." },
        call_if_no_movement_s: { type: "number", description: "Optional condition: call at once if no phone sees movement within this many seconds (10 to 120)." },
        argument: { type: "string", description: "One or two plain sentences to the other agents, citing phones by name and numbers." }
      },
      required: ["kind", "action", "argument"],
      additionalProperties: false
    }
  }
];
var SYSTEM3 = (role) => [
  `You are the ${ROLE_INFO[role].title} agent in Witness, the safety system in an older person's home. Phones sense the room with sonar (distance, body movement) and on-phone sound recognition.`,
  `Your goal: ${GOALS[role]}`,
  "The three agents (Responder, Skeptic, Auditor) disagree about this incident, so you are negotiating what to do. Nobody can overrule the others: you must reach one plan all three accept. If there is no deal after the last round, nobody wins: the disagreement is kept on the record and the person is asked out loud (no answer calls for help). It is fine not to agree when the evidence really is not enough; do not give in just to reach a deal.",
  'The actions, lightest to strongest: none (nothing; they are still asked if nobody moves for a minute), watch (keep watching, ask if nobody moves), ask (gentle "Are you OK?", call if no answer in 40 s), urgent ("It looks like you may have fallen", call in 25 s unless they say they are OK), call (call the family now). A plan may add: call at once if no phone sees movement within N seconds.',
  "Negotiate like a sharp, fair colleague: challenge the specific claim you think is wrong and say why with evidence; concede a point when the evidence is against you; move toward the others when they are right; accept a plan you can live with. Do not repeat yourself. If a fact is disputed, check it with a tool instead of arguing (in one turn; tools run in parallel), but only if it would change a mind.",
  "Readings: impact dB is above that phone's quiet level (20+ is a real bang). sound_model_says is the on-phone recognition. body_burst_db 20+ is a sudden body movement. still_after_fraction near 1 means nobody moved; first_movement_after_s is when they first shifted. phone_itself_moved means its sonar described the phone, not the room.",
  'Say only what the readings show: someone "disappeared" only if a phone has last_saw_person_s_before set and nobody is present after; if nobody was seen before either, say "no phone can see anyone". The countdown is 25 s and the gentle question waits 40 s: use those numbers, do not invent others.',
  "Evidence rules: never infer missing evidence (no working sonar means unknown, not nobody there); a phone that did not hear or see something is not lying unless it could clearly have observed it; name the phone behind every claim.",
  "Speak in one or two plain sentences, phones by name, numbers. No jargon, no dashes."
].join("\n");
async function negotiateThink(cfg, ctx, role, round, lastRound, transcript, tools, opts) {
  const deadline = Date.now() + opts.budgetMs;
  let step = 0;
  const trace = (kind, summary, tool) => opts.onTrace?.({ incidentId: ctx.incident.id, agent: role, round: round + 2, step: ++step, kind, tool, summary: summary.slice(0, 400), t: Date.now() });
  const mine = [...transcript].reverse().find((m) => m.agent === role);
  const fallbackPlan = mine?.plan ?? { action: "ask" };
  const findings = [];
  const brief = {
    round,
    last_round: lastRound,
    what_happened: { trigger: ctx.incident.trigger.kind, phone: ctx.incident.trigger.name, detail: ctx.incident.trigger.detail },
    evidence: ctx.reports.map((r) => compactReport(r)),
    room_map: ctx.context?.notes ?? null,
    said_so_far: transcript.map((m) => ({ round: m.round, agent: m.agent, move: m.kind, to: m.to ?? void 0, claim: m.claim ?? void 0, plan: describePlan(m.plan), argument: m.argument, checked: m.findings?.length ? m.findings : void 0 })),
    your_current_plan: mine ? describePlan(mine.plan) : null,
    task: lastRound ? "Last round: accept a plan you can live with, or state your final plan." : "Make your move."
  };
  const messages = [{ role: "user", content: JSON.stringify(brief) }];
  const run = async (name, input) => {
    if (name === "ask_all_phones") {
      if (!tools.lookNow) return { result: { note: "not available in this replay" }, summary: "not available in this replay" };
      const waitS = Math.max(0, Math.min(10, Number(input.wait_seconds ?? 0) || 0, (deadline - Date.now() - 6e3) / 1e3));
      const r = await tools.lookNow(ctx.incident.id, "all", waitS);
      const parts = (r.replies ?? []).map((x) => `${x.phone}: ${lookWords(x.look)}`);
      if (r.no_reply?.length) parts.push(`no reply from ${r.no_reply.join(", ")}`);
      return { result: r, summary: `broadcast to every phone${waitS >= 1 ? ` (after ${Math.round(waitS)} s)` : ""}: ${parts.join("; ") || "no replies"}` };
    }
    if (name === "ask_cartographer") {
      const c = ctx.context;
      return c ? { result: { notes: c.notes, ended_at: c.endedAt?.place.name ?? null, bang_from: c.source?.name ?? null }, summary: c.notes.slice(0, 2).join("; ") } : { result: { note: "no room map yet" }, summary: "no room map yet" };
    }
    if (name === "physics_check") {
      const a = auditor({ ...ctx, round: 1, prior: [], seenFingerprints: /* @__PURE__ */ new Set() });
      const low = ctx.reports.filter((r) => (a.trust?.[r.nodeId]?.score ?? 1) < 0.5);
      return {
        result: { trust: Object.fromEntries(ctx.reports.map((r) => [r.name, { trust: +(a.trust?.[r.nodeId]?.score ?? 1).toFixed(2), reasons: a.trust?.[r.nodeId]?.reasons ?? [] }])), conflict: a.conflict ?? null },
        summary: a.conflict ? `conflict: ${a.conflict}` : low.length ? `low trust: ${low.map((r) => r.name).join(", ")}` : "every phone checks out"
      };
    }
    if (name === "home_history") {
      const h = summarize(ctx.memory ?? tools.memory?.(), tools.names?.() ?? {}, ctx.reports, ctx.incident.t0);
      return { result: h, summary: h.note ? String(h.note) : `${h.incidents_remembered} past incidents${h.pattern ? `; ${h.pattern}` : ""}` };
    }
    return { result: { error: "unknown tool" }, summary: "unknown tool" };
  };
  try {
    for (let turn = 0; turn < 3; turn++) {
      const left = deadline - Date.now();
      if (left < 2500) throw new Error("out of time");
      if (opts.canSpend && !opts.canSpend()) throw new Error("today's Claude budget is used up");
      const final = turn === 2 || left < 8e3;
      const body = await call(cfg, { system: SYSTEM3(role), messages, tools: TOOLS2, tool_choice: final ? { type: "tool", name: "make_move" } : { type: "auto" }, max_tokens: 350 }, Math.min(left - 500, cfg.timeoutMs), deadline);
      opts.onUsage?.(body.usage);
      messages.push({ role: "assistant", content: body.content });
      const text = body.content.filter((b) => b.type === "text" && b.text?.trim()).map((b) => b.text.trim()).join(" ");
      if (text) trace("thought", text);
      const calls = body.content.filter((b) => b.type === "tool_use");
      const move = calls.find((c) => c.name === "make_move");
      if (move) return toMove(move.input ?? {});
      if (!calls.length) {
        messages.push({ role: "user", content: "Make your move now with make_move." });
        continue;
      }
      const results = await Promise.all(
        calls.map(async (c) => {
          const { result, summary } = await run(c.name, c.input ?? {});
          findings.push(`${c.name}: ${summary}`.slice(0, 240));
          trace("tool", summary, c.name);
          return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(result).slice(0, 2500) };
        })
      );
      messages.push({ role: "user", content: results });
    }
    throw new Error("no move");
  } catch (e) {
    opts.onError?.(e);
    trace("fallback", `could not make a move (${e.message.slice(0, 100)}); keeps its plan`);
    return null;
  }
  function toMove(o) {
    const kind = ["offer", "challenge", "concede", "counter", "accept"].includes(String(o.kind)) ? o.kind : "counter";
    let plan = normalisePlan({ action: o.action, call_if_no_movement_s: o.call_if_no_movement_s }, fallbackPlan);
    const to = ["responder", "skeptic", "auditor"].includes(String(o.to)) && o.to !== role ? o.to : null;
    if (kind === "accept" && to) {
      const theirs = [...transcript].reverse().find((m) => m.agent === to);
      if (theirs) plan = { ...theirs.plan };
    }
    return {
      id: uid("move"),
      incidentId: ctx.incident.id,
      agent: role,
      round,
      kind,
      to,
      claim: typeof o.claim === "string" ? o.claim.slice(0, 160) : null,
      plan,
      argument: (typeof o.argument === "string" && o.argument.trim() ? o.argument.trim() : describePlan(plan)).replace(/\s*[—–]\s*/g, ", ").slice(0, 500),
      findings,
      llm: true,
      postedAt: Date.now()
    };
  }
}

// src/agents/protocol.ts
var ORDER = ["auditor", "responder", "skeptic"];
async function deliberate(incident, reports, opts = {}) {
  const now = opts.now ?? Date.now;
  const seen = opts.seenFingerprints ?? /* @__PURE__ */ new Set();
  const voice = opts.voice;
  const context = opts.map ? cartograph(opts.map, reports) : void 0;
  const base = { incident, reports, seenFingerprints: seen, context };
  const r1Ctx = { ...base, round: 1, prior: [], now: now() };
  const round1 = await Promise.all(
    ORDER.map(async (role) => {
      const draft = ROLES[role]({ ...r1Ctx, now: now() });
      return voice ? await voice(draft, r1Ctx) : draft;
    })
  );
  for (const p of round1) opts.onPosition?.(p);
  if (opts.pause) await opts.pause(1200);
  const r2Ctx = { ...base, round: 2, prior: round1, now: now() };
  const round2 = await Promise.all(
    ORDER.map(async (role) => {
      const draft = ROLES[role]({ ...r2Ctx, now: now() });
      return voice ? await voice(draft, r2Ctx) : draft;
    })
  );
  for (const p of round2) opts.onPosition?.(p);
  const outcome = resolve(incident, round2, reports, now());
  const brain = opts.brain;
  const contested = outcome.kind === "ask_human";
  if (brain && contested && incident.trigger.kind !== "help_pressed") {
    const transcript = round2.map((p) => ({ id: `${p.agent}-0`, incidentId: incident.id, agent: p.agent, round: 0, kind: "offer", plan: openingPlan(p), argument: p.argument, llm: false, postedAt: now() }));
    if (!agreed(transcript.map((m) => m.plan))) {
      const ctx = { ...base, round: 3, prior: round2, now: now() };
      let deal = null;
      let round = 0;
      while (!deal && round < 3) {
        round++;
        const moves = await Promise.all(ORDER.map((role) => negotiateThink(brain.cfg, ctx, role, round, round === 3, transcript, {}, { budgetMs: brain.budgetMs ?? 3e4, onTrace: brain.onTrace })));
        for (const m of moves) if (m) transcript.push(m);
        const now3 = ORDER.map((r) => [...transcript].reverse().find((m) => m.agent === r).plan);
        deal = agreed(now3) ?? (round >= 3 ? nearAgreement(now3) : null);
      }
      const plan = deal ?? noDeal(ORDER.map((r) => [...transcript].reverse().find((m) => m.agent === r).plan));
      return { positions: [...round1, ...round2], outcome: negotiatedOutcome(outcome, transcript, plan, !!deal, round), moves: transcript };
    }
  }
  return { positions: [...round1, ...round2], outcome };
}
function withInvestigator(o, inv) {
  if (!inv.llm) return { ...o, summary: `${o.summary} The Investigator could not look into it.` };
  const keep = o.dissent;
  if (inv.stance === "stand_down" && inv.confidence >= 0.7 && !inv.floor) {
    return { ...o, kind: "stand_down", unanimous: false, headline: "Investigator settled it: no emergency", summary: `Investigator: ${inv.argument}`, dissent: keep };
  }
  if (inv.stance === "escalate") {
    return { ...o, kind: "escalate", unanimous: false, headline: "Investigator settled it: get help", summary: `Investigator: ${inv.argument}`, dissent: keep };
  }
  return { ...o, headline: "Still not sure: asking the person", summary: `Investigator: ${inv.argument} ${o.summary}` };
}
function resolve(incident, finals, reports, t) {
  const esc = finals.filter((p) => p.stance === "escalate");
  const down = finals.filter((p) => p.stance === "stand_down");
  let kind;
  const conflict = finals.find((p) => p.conflict)?.conflict;
  if (incident.trigger?.kind === "help_pressed") kind = "escalate";
  else if (conflict) kind = "ask_human";
  else if (!down.length && esc.length >= 2) kind = "escalate";
  else if (!esc.length && down.length >= 2) kind = "stand_down";
  else kind = "ask_human";
  const unanimous = kind === "escalate" && esc.length === finals.length || kind === "stand_down" && down.length === finals.length;
  const dissent = finals.filter((p) => kind === "escalate" ? p.stance !== "escalate" : kind === "stand_down" ? p.stance !== "stand_down" : true).map((p) => ({ agent: p.agent, stance: p.stance, argument: p.argument }));
  const trust = finals.find((p) => p.agent === "auditor")?.trust ?? {};
  const quarantined = reports.filter((r) => (trust[r.nodeId]?.score ?? 1) < 0.3 && !trust[r.nodeId]?.reasons.some((x) => x.includes("phone moved") || x.includes("phone itself"))).map((r) => r.name);
  const lead = (role) => finals.find((p) => p.agent === role);
  let headline;
  let summary;
  if (kind === "escalate") {
    headline = unanimous ? "All three agents agree: get help" : "Agents agree: get help";
    summary = `Responder: ${lead("responder").argument}`;
  } else if (kind === "stand_down") {
    headline = unanimous ? "All three agents agree: no emergency" : "Agents agree: no emergency";
    const why = lead("skeptic").stance === "stand_down" ? lead("skeptic") : lead("auditor");
    summary = `${why === lead("skeptic") ? "Skeptic" : "Auditor"}: ${why.argument}`;
  } else {
    headline = conflict ? "Phones contradict each other: asking the person" : "Agents disagree: asking the person";
    summary = `${finals.map((p) => `${cap2(p.agent)} says ${stanceWord(p.stance)}`).join(", ")}. The disagreement is kept and the person is asked directly; no answer means help is called.`;
  }
  if (quarantined.length) summary += ` ${quarantined.join(" and ")} flagged as untrustworthy.`;
  return { incidentId: incident.id, kind, unanimous, headline, summary, dissent, quarantined, decidedAt: t };
}
function cap2(s) {
  return s[0].toUpperCase() + s.slice(1);
}
function stanceWord(s) {
  return s === "escalate" ? "get help" : s === "stand_down" ? "stand down" : "not sure";
}

// src/agents/roleAgent.ts
var ROLE_ORDER = ["auditor", "responder", "skeptic"];
var RoleAgent = class {
  constructor(role, member, voice, opts) {
    this.role = role;
    this.member = member;
    this.voice = voice;
    this.opts = opts;
    this.work = /* @__PURE__ */ new Map();
    /** The Auditor's memory of earlier reports (replay detection). */
    this.seen = /* @__PURE__ */ new Set();
    this.asker = new PhoneAsker(member, (id) => [...new Set([...this.work.get(id)?.reports.values() ?? []].map((r) => r.name))]);
    member.onMessage((from, msg) => this.on(from, msg));
  }
  /** One move in a negotiation round the moderator opened. */
  async negotiate(msg) {
    const b = this.opts.negotiator?.();
    const w2 = this.work.get(msg.incident.id);
    if (!b || !w2) return;
    const move = await negotiateThink(
      b.cfg,
      { incident: msg.incident, reports: [...w2.reports.values()], round: 3, prior: [...w2.round1.values()], seenFingerprints: this.seen, now: Date.now(), context: w2.context, memory: this.opts.memory?.() },
      this.role,
      msg.round,
      msg.lastRound,
      msg.transcript,
      { ...b.tools, lookNow: (id, phone, waitS) => this.asker.ask(id, phone, waitS) },
      { budgetMs: b.budgetMs, onUsage: b.onUsage, canSpend: b.canSpend, onError: b.onError, onTrace: (trace) => void this.member.publish({ type: "trace", trace }).catch(() => {
      }) }
    );
    if (move) await this.member.publish({ type: "move", move });
  }
  get(incident) {
    let w2 = this.work.get(incident.id);
    if (!w2) {
      w2 = { incident, reports: /* @__PURE__ */ new Map(), wanted: null, round1: /* @__PURE__ */ new Map(), posted1: false, posted2: false };
      this.work.set(incident.id, w2);
      if (this.work.size > 50) this.work.delete(this.work.keys().next().value);
    }
    return w2;
  }
  on(_from, msg) {
    if (msg.type === "negotiate") {
      void this.negotiate(msg);
      return;
    }
    if (msg.type === "incident") this.get(msg.incident).incident = msg.incident;
    else if (msg.type === "report") {
      const w2 = this.work.get(msg.report.incidentId);
      if (w2) {
        w2.reports.set(msg.report.id, msg.report);
        this.maybeRound1(w2);
      }
    } else if (msg.type === "evidence_closed") {
      const w2 = this.get(msg.incident);
      w2.incident = msg.incident;
      w2.wanted = msg.reportIds;
      this.maybeRound1(w2);
      setTimeout(() => this.round1(w2), this.opts.waitReportsMs);
    } else if (msg.type === "context") {
      const w2 = this.work.get(msg.context.incidentId);
      const full = msg.full;
      if (w2 && full) {
        w2.context = full;
        this.maybeRound1(w2);
      }
    } else if (msg.type === "position" && msg.position.round === 1 && msg.position.agent !== "investigator") {
      const w2 = this.work.get(msg.position.incidentId);
      if (w2) {
        w2.round1.set(msg.position.agent, msg.position);
        this.maybeRound2(w2);
      }
    }
  }
  maybeRound1(w2) {
    if (!w2.wanted || !w2.wanted.every((id) => w2.reports.has(id))) return;
    if (!w2.context && this.opts.waitContextMs && !w2.contextWait) {
      w2.contextWait = true;
      setTimeout(() => void this.round1(w2), this.opts.waitContextMs);
      return;
    }
    if (w2.context || !this.opts.waitContextMs) void this.round1(w2);
  }
  async round1(w2) {
    if (w2.posted1 || !w2.wanted) return;
    w2.posted1 = true;
    const p = await this.think(w2, 1, []);
    w2.round1.set(this.role, p);
    await this.member.publish({ type: "position", position: p });
    this.maybeRound2(w2);
    setTimeout(() => void this.round2(w2), this.opts.waitPeersMs());
  }
  maybeRound2(w2) {
    if (w2.posted1 && ROLE_ORDER.every((r) => w2.round1.has(r))) setTimeout(() => void this.round2(w2), this.opts.roundPauseMs);
  }
  async round2(w2) {
    if (w2.posted2 || !w2.posted1) return;
    w2.posted2 = true;
    const prior = [...w2.round1.values()];
    const mine = w2.round1.get(this.role);
    const firm = prior.length === ROLE_ORDER.length && prior.every((p2) => p2.stance === prior[0].stance && p2.confidence >= 0.7 && !p2.conflict);
    if (firm && mine && this.opts.brain?.()) {
      void this.member.publish({ type: "trace", trace: { incidentId: w2.incident.id, agent: this.role, round: 2, step: 1, kind: "thought", summary: "All three of us already agree, so there is nothing to argue about.", t: Date.now() } }).catch(() => {
      });
      await this.member.publish({ type: "position", position: { ...mine, id: uid("position"), round: 2, postedAt: Date.now() } });
      if (this.role === "auditor") for (const r of w2.reports.values()) this.seen.add(fingerprint(r));
      return;
    }
    const p = await this.think(w2, 2, prior);
    await this.member.publish({ type: "position", position: p });
    if (this.role === "auditor") for (const r of w2.reports.values()) this.seen.add(fingerprint(r));
  }
  async think(w2, round, prior) {
    const ctx = { incident: w2.incident, reports: [...w2.reports.values()], round, prior, seenFingerprints: this.seen, now: Date.now(), context: w2.context, memory: this.opts.memory?.() };
    const b = this.opts.brain?.();
    if (b) {
      return agentThink(b.cfg, ctx, this.role, { ...b.tools, context: () => w2.context }, {
        budgetMs: b.budgetMs(round),
        onError: b.onError,
        onUsage: b.onUsage,
        onTrace: (trace) => void this.member.publish({ type: "trace", trace }).catch(() => {
        })
      });
    }
    const draft = ROLES[this.role](ctx);
    const v = this.voice();
    return v ? v(draft, ctx) : draft;
  }
};
var CartographerAgent = class {
  constructor(member, mapFor) {
    this.member = member;
    this.mapFor = mapFor;
    this.reports = /* @__PURE__ */ new Map();
    member.onMessage((_from, msg) => {
      if (msg.type === "report") {
        const list = this.reports.get(msg.report.incidentId) ?? [];
        list.push(msg.report);
        this.reports.set(msg.report.incidentId, list);
        if (this.reports.size > 50) this.reports.delete(this.reports.keys().next().value);
      } else if (msg.type === "evidence_closed") {
        const go = () => {
          const have = this.reports.get(msg.incident.id) ?? [];
          const ctx = cartograph(this.mapFor(msg.incident), have);
          const note = {
            incidentId: msg.incident.id,
            notes: ctx.notes,
            source: ctx.source ? { name: ctx.source.name, kind: ctx.source.kind, errDb: ctx.source.errDb } : null,
            endedAt: ctx.endedAt ? { name: ctx.endedAt.place.name, kind: ctx.endedAt.place.kind } : null,
            postedAt: Date.now()
          };
          void this.member.publish({ type: "context", context: note, full: ctx });
        };
        const ready = () => msg.reportIds.every((id) => (this.reports.get(msg.incident.id) ?? []).some((r) => r.id === id));
        if (ready()) go();
        else setTimeout(go, 600);
      }
    });
  }
};
var PhoneAsker = class {
  constructor(member, phones) {
    this.member = member;
    this.phones = phones;
    this.waiting = /* @__PURE__ */ new Map();
    member.onMessage((_f, msg) => {
      if (msg.type !== "look_reply") return;
      const w2 = this.waiting.get(msg.requestId);
      if (!w2) return;
      w2.replies.push({ phone: msg.phone, look: msg.look });
      if (w2.replies.length >= w2.expected) w2.done();
    });
  }
  async ask(incidentId, phone, waitS) {
    const all = phone === "all";
    const names = this.phones(incidentId);
    const requestId = uid("look");
    const replies = [];
    await new Promise((resolve2) => {
      const timer = setTimeout(resolve2, (waitS + 3) * 1e3);
      this.waiting.set(requestId, {
        replies,
        expected: all ? Math.max(1, names.length) : 1,
        done: () => {
          clearTimeout(timer);
          resolve2();
        }
      });
      void this.member.publish({ type: "look_request", requestId, incidentId, target: all ? null : phone, waitS }).catch(() => resolve2());
    });
    this.waiting.delete(requestId);
    if (all) return { asked: "every phone, one broadcast on the SLIM channel", replies, no_reply: names.filter((n) => !replies.some((r) => r.phone === n)) };
    return replies[0] ? { phone: replies[0].phone, ...replies[0].look } : { error: `no reply from ${phone} (off, asleep or quarantined)`, phones: names };
  }
};

// src/agents/sim.ts
var ROOM = { w: 5, d: 4 };
var LAYOUT = [
  { nodeId: "sim-1", name: "Phone 1", x: 0.4, y: 0.4, imu: true },
  { nodeId: "sim-2", name: "Phone 2", x: 4.6, y: 0.4, imu: true },
  { nodeId: "sim-3", name: "Phone 3", x: 2.5, y: 3.6, imu: true }
];
var T0 = 1e5;
var START = T0 - 14e3;
var END = T0 + 16e3;
var DT = 125;
var SEE_M = 3;
var SCENARIOS = [
  {
    key: "fall_center",
    title: "Fall in the middle of the room",
    description: "Walking, trips and falls; every phone can see.",
    emergency: true,
    person: { from: [1.6, 1.2], to: [2.4, 1.9], at: [2.7, 2.4], before: "walk", after: "floor", event: "fall" },
    sounds: [{ at: 250, from: "person", level: 38, cls: "impact", ai: { group: "thud", p: 0.75 } }],
    screamProb: 0.2
  },
  {
    key: "fall_corner",
    title: "Fall seen by one phone",
    description: "Falls in a corner; only Phone 1 has a view, the others only hear it.",
    emergency: true,
    person: { from: [1.4, 0.9], to: [1, 1], at: [0.9, 1.5], before: "walk", after: "floor", event: "fall" },
    sounds: [{ at: 250, from: "person", level: 38, cls: "impact", ai: { group: "thud", p: 0.75 } }],
    occluded: [2]
  },
  {
    key: "tv_thud",
    title: "Action movie on TV",
    description: "Seated on the couch; the TV plays a loud crash and they flinch.",
    emergency: false,
    person: { from: [1.3, 2.6], to: [1.3, 2.6], at: [1.3, 2.6], before: "sit", after: "sit", event: "flinch", eventProb: 0.7 },
    sounds: [{ at: 0, from: "media", level: 41, cls: "impact", ai: { group: "media", p: 0.6 } }],
    media: [4.7, 0.9]
  },
  {
    key: "phone_knocked",
    title: "Phone knocked off the table",
    description: "Walking past, they knock Phone 1 to the floor and keep going.",
    emergency: false,
    person: { from: [0.6, 1.8], to: [1, 1.2], at: [1.2, 1.4], before: "walk", after: "walk", event: "none" },
    sounds: [{ at: 120, from: { phone: 0 }, level: 33, cls: "impact", ai: { group: "object", p: 0.6 } }],
    knock: 0
  },
  {
    key: "dropped_pan",
    title: "Dropped a pan",
    description: "Drops something heavy, bends to pick it up, usually walks on.",
    emergency: false,
    person: { from: [1.4, 1.2], to: [2, 1.6], at: [2.05, 1.6], before: "walk", after: "still", event: "bend", resumeProb: 0.6 },
    sounds: [{ at: 0, from: "person", level: 36, cls: "impact", ai: { group: "object", p: 0.75 } }]
  },
  {
    key: "sat_down",
    title: "Flopped onto the couch",
    description: "Walks over and drops onto the couch. No bang.",
    emergency: false,
    person: { from: [2.6, 1], to: [1.6, 2.2], at: [1.5, 2.4], before: "walk", after: "sit", event: "sit" },
    sounds: []
  },
  {
    key: "soft_collapse",
    title: "Quiet collapse",
    description: "Slumps to the floor slowly. No loud impact at all.",
    emergency: true,
    person: { from: [1.6, 1], to: [2.2, 1.6], at: [2.4, 2.2], before: "walk", after: "floor", event: "collapse" },
    sounds: [{ at: 600, from: "person", level: 16, cls: "impact", ai: { group: "thud", p: 0.5 }, prob: 0.3 }]
  },
  {
    key: "fake_fall",
    title: "Hacked phone fakes a fall",
    description: "Phone 2 is compromised and reports a fall while they walk around.",
    emergency: false,
    person: { from: [1, 1.4], to: [2.2, 2.2], at: [2.4, 2.3], before: "walk", after: "walk", event: "none" },
    sounds: [],
    compromised: { phone: 1, kind: "fake_fall" }
  },
  {
    key: "hidden_fall",
    title: "Hacked phone hides a fall",
    description: "A real fall seen by Phone 1; compromised Phone 2 says all is well; Phone 3 is blocked.",
    emergency: true,
    person: { from: [1.6, 1], to: [1.1, 1.4], at: [1, 1.9], before: "walk", after: "floor", event: "fall" },
    sounds: [{ at: 250, from: "person", level: 38, cls: "impact", ai: { group: "thud", p: 0.75 } }],
    occluded: [2],
    compromised: { phone: 1, kind: "hide" }
  },
  {
    key: "fall_tv_on",
    title: "Real fall while the TV is on",
    description: "Gets up from the couch during a loud movie and falls.",
    emergency: true,
    person: { from: [1.3, 2.6], to: [1.6, 2.3], at: [2.1, 1.9], before: "sit", after: "floor", event: "fall" },
    sounds: [{ at: 250, from: "person", level: 36, cls: "impact", ai: { group: "thud", p: 0.7 } }],
    media: [4.7, 0.9],
    heldOut: true
  },
  {
    key: "fall_hallway",
    title: "Fall out of every phone's view",
    description: "Falls in the hallway; no sonar can see, every phone hears it.",
    emergency: true,
    person: { from: [2.6, 1.6], to: [4.5, 3.5], at: [4.75, 3.75], before: "walk", after: "floor", event: "fall" },
    sounds: [{ at: 250, from: "person", level: 38, cls: "impact", ai: { group: "thud", p: 0.75 } }],
    outOfView: [4.1, 3.1, 5, 4],
    heldOut: true
  },
  {
    key: "door_slam",
    title: "Door slams while walking",
    description: "A door slams in the next room while they walk around.",
    emergency: false,
    person: { from: [1, 1.2], to: [2.2, 2], at: [2.4, 2.2], before: "walk", after: "walk", event: "none" },
    sounds: [{ at: 0, from: [4.9, 3.9], level: 40, cls: "impact", ai: { group: "object", p: 0.75 } }],
    heldOut: true
  },
  {
    key: "snap_near_phone",
    title: "Finger snap next to a phone",
    description: "Sitting quietly; snaps their fingers right next to Phone 1.",
    emergency: false,
    person: { from: [1.3, 2.6], to: [1.3, 2.6], at: [1.3, 2.6], before: "sit", after: "sit", event: "none" },
    sounds: [{ at: 0, from: { phone: 0 }, level: 18, cls: "impact", ai: { group: "tap", p: 0.85 } }]
  },
  {
    key: "tap_unseen",
    title: "Tap on the desk, nobody in view",
    description: "At a desk out of every sonar view (like the laptop test), taps the desk, then sits silently.",
    emergency: false,
    person: { from: [4.6, 3.6], to: [4.6, 3.6], at: [4.6, 3.6], before: "sit", after: "sit", event: "none" },
    sounds: [{ at: 0, from: "person", level: 30, cls: "impact", ai: { group: "tap", p: 0.8 } }],
    outOfView: [4.1, 3.1, 5, 4]
  }
];
var lerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
var clampRoom = (p) => [Math.max(0.2, Math.min(ROOM.w - 0.2, p[0])), Math.max(0.2, Math.min(ROOM.d - 0.2, p[1]))];
function generate(spec, seed, layout = LAYOUT) {
  const rng = new Rng(seed * 7919 + spec.key.length * 104729);
  const j = (v, s) => v + rng.uniform(-s, s);
  const phones = layout.map((p, i) => ({
    ...p,
    x: j(p.x, 0.2),
    y: j(p.y, 0.2),
    imu: i === spec.knock ? rng.next() < 0.5 : p.imu,
    occluded: spec.occluded?.includes(i) ?? false,
    compromised: spec.compromised?.phone === i ? spec.compromised.kind : void 0
  }));
  const P = spec.person;
  const from = clampRoom([j(P.from[0], 0.3), j(P.from[1], 0.3)]);
  const to = clampRoom([j(P.to[0], 0.3), j(P.to[1], 0.3)]);
  const at = clampRoom([to[0] + (P.at[0] - P.to[0]) * rng.uniform(0.7, 1.3), to[1] + (P.at[1] - P.to[1]) * rng.uniform(0.7, 1.3)]);
  const eventHappens = rng.next() < (P.eventProb ?? 1);
  const resumes = rng.next() < (P.resumeProb ?? (P.after === "walk" ? 1 : 0));
  const resumeAt = T0 + rng.uniform(2500, 4500);
  const walkDir = [rng.uniform(-1, 1), rng.uniform(-1, 1)];
  const media = spec.media ? [j(spec.media[0], 0.2), j(spec.media[1], 0.2)] : null;
  const aiOn = rng.next() < 0.85;
  const hidden = (p) => !!spec.outOfView && p[0] >= spec.outOfView[0] && p[1] >= spec.outOfView[1] && p[0] <= spec.outOfView[2] && p[1] <= spec.outOfView[3];
  const personAt = (t) => {
    if (t < T0 - 300) {
      if (P.before === "walk") return { pos: lerp(from, to, (t - START) / (T0 - 300 - START)), state: "walk" };
      return { pos: to, state: P.before };
    }
    if (t < T0 + 1200) {
      const ev = eventHappens ? P.event : "none";
      if (ev === "none" || ev === "flinch" && t > T0 + 500) {
        const st = P.before;
        return { pos: st === "walk" ? lerp(to, clampRoom([to[0] + walkDir[0], to[1] + walkDir[1]]), (t - T0 + 300) / 6e3) : to, state: st };
      }
      return { pos: lerp(to, at, Math.max(0, Math.min(1, (t - T0 + 300) / 1300))), state: "event" };
    }
    const settled = eventHappens ? P.after : P.before;
    if (resumes && t >= resumeAt) {
      const base = P.event === "none" && P.before === "walk" ? to : at;
      return { pos: lerp(base, clampRoom([base[0] + walkDir[0] * 2, base[1] + walkDir[1] * 2]), (t - resumeAt) / 8e3), state: "walk" };
    }
    if (P.event === "none" && P.before === "walk") {
      return { pos: lerp(to, clampRoom([to[0] + walkDir[0], to[1] + walkDir[1]]), (t - T0 + 300) / 6e3), state: "walk" };
    }
    return { pos: eventHappens ? at : to, state: settled };
  };
  const fidgets = [];
  for (let t = START + rng.uniform(0, 6e3); t < END; t += rng.uniform(4e3, 13e3)) fidgets.push([t, t + rng.uniform(400, 800)]);
  const fidgeting = (t) => fidgets.some(([a, b]) => t >= a && t <= b);
  const height = (s) => s === "floor" ? 0.25 : s === "sit" ? 1 : s === "event" ? 0.7 : 1.25;
  const streams = phones.map((ph, idx) => {
    const samples = [];
    const sonarMiss = rng.next() < 0.08;
    const breathes = rng.next() < 0.6;
    let stillSince = -1;
    const knocked = spec.knock === idx;
    const link = rng.uniform(18, 28);
    for (let t = START; t <= END; t += DT) {
      const { pos, state } = personAt(t);
      const d = Math.hypot(pos[0] - ph.x, pos[1] - ph.y);
      const sees = !ph.occluded && !sonarMiss && d <= SEE_M && !hidden(pos);
      let fast;
      let motion;
      let presence = "empty";
      let range = null;
      let confirmed = false;
      let breathing = null;
      let sonarOk = true;
      let staticChangeDb = rng.uniform(0, 4);
      let linkSnrDb = link + rng.uniform(-1.5, 1.5);
      if (sees) {
        const ev = eventHappens ? P.event : "none";
        if (state === "walk") [fast, motion, presence] = [rng.uniform(13, 19), rng.uniform(18, 26), "moving"];
        else if (state === "event") {
          const burst = ev === "fall" ? [24, 32] : ev === "collapse" ? [16, 22] : ev === "flinch" ? [19, 24] : ev === "sit" ? [20, 25] : [17, 22];
          [fast, motion, presence] = [rng.uniform(burst[0], burst[1]), rng.uniform(20, 30), "moving"];
        } else if (state !== "floor" && fidgeting(t)) [fast, motion, presence] = [rng.uniform(14, 18), rng.uniform(15, 20), "moving"];
        else [fast, motion, presence] = [rng.uniform(1, state === "floor" ? 6 : 9), rng.uniform(8, 13), "still"];
        range = Math.hypot(d, height(state) - 0.75) + rng.gauss() * 0.04;
        confirmed = rng.next() < (state === "walk" || state === "event" ? 0.95 : state === "floor" ? 0.65 : 0.8);
        if (state === "still" || state === "sit" || state === "floor") {
          if (stillSince < 0) stillSince = t;
          if (breathes && t - stillSince > 1e4 && rng.next() < 0.9) breathing = { rateBpm: 14 + rng.gauss(), quality: rng.uniform(0.5, 0.8), range };
        } else stillSince = -1;
      } else {
        [fast, motion] = [rng.uniform(0, 4), rng.uniform(2, 7)];
        stillSince = -1;
      }
      if (knocked && t >= T0) {
        if (ph.imu) {
          sonarOk = false;
          presence = "unknown";
          range = null;
          confirmed = false;
          fast = 0;
          breathing = null;
        } else {
          fast = t < T0 + 500 ? rng.uniform(32, 38) : rng.uniform(0, 5);
          staticChangeDb = rng.uniform(18, 26);
          linkSnrDb = rng.uniform(12, 20);
          presence = t < T0 + 500 ? "moving" : "empty";
          range = null;
          confirmed = false;
          breathing = null;
        }
      }
      const mediaShare = aiOn ? media ? rng.uniform(0.45, 0.95) : rng.uniform(0, 0.1) : void 0;
      samples.push({ t, presence, range, confirmed, snrDb: confirmed ? rng.uniform(16, 26) : 0, fastMotionDb: fast, motionDb: motion, staticChangeDb, linkSnrDb, breathing, sonarOk, media: mediaShare });
    }
    const sounds = [];
    const hear = (sx, sy, level, at2, cls, repetitive = false, ai) => {
      const d = Math.hypot(sx - ph.x, sy - ph.y);
      const lvl = level + rng.gauss() * 2 - 20 * Math.log10(Math.max(d, 0.3));
      if (lvl < 6) return;
      let c = cls;
      if (cls === "impact" && rng.next() < 0.12) c = "knock";
      const ev = { t: at2 + rng.uniform(150, 600), cls: c, confidence: rng.uniform(0.55, 0.9), aboveFloorDb: lvl, repetitive };
      if (aiOn && ai) {
        const right = rng.next() < ai.p;
        const wrong = ["thud", "object", "tap"].filter((g) => g !== ai.group);
        const group = right ? ai.group : wrong[Math.floor(rng.next() * wrong.length)];
        const score = right ? rng.uniform(0.35, 0.85) : rng.uniform(0.15, 0.4);
        ev.ai = { group, score, top: [{ name: group, score }] };
        ev.benign = c !== "scream" && score >= 0.35 && lvl < 30 && ["tap", "speech", "media", "footsteps", "object"].includes(group);
      }
      sounds.push(ev);
    };
    if (media) {
      for (let t = START; t < END; t += rng.uniform(800, 1400)) hear(media[0], media[1], 26, t, rng.next() < 0.6 ? "voice" : "sustained", rng.next() < 0.2, { group: "media", p: 0.8 });
    }
    for (const s of spec.sounds) {
      if (s.prob !== void 0 && rng.next() >= s.prob) continue;
      let src;
      if (s.from === "person") src = personAt(T0 + s.at).pos;
      else if (s.from === "media") src = media ?? [0, 0];
      else if (Array.isArray(s.from)) src = s.from;
      else src = [phones[s.from.phone].x, phones[s.from.phone].y + 0.15];
      hear(src[0], src[1], s.level + rng.uniform(-3, 3), T0 + s.at, s.cls, s.repetitive, s.ai);
    }
    if (spec.screamProb && eventHappens && seededChance(seed, spec.screamProb)) {
      const p = personAt(T0 + 400).pos;
      hear(p[0], p[1], 40, T0 + 400, "scream", false, { group: "distress", p: 0.85 });
    }
    sounds.sort((a, b) => a.t - b.t);
    const alerts = [];
    if (knocked && ph.imu) alerts.push({ t: T0 + 250, kind: "phone_drop", severity: "warning", title: "Phone dropped" });
    return { phone: ph, samples, sounds, alerts };
  });
  for (const s of streams) {
    if (s.phone.compromised === "fake_fall") fabricateFall(s, rng);
    else if (s.phone.compromised === "hide") fabricateCalm(s, rng);
  }
  for (const s of streams) s.alerts.push(...localVerdicts(s), ...[]);
  for (const s of streams) s.alerts.sort((a, b) => a.t - b.t);
  return { spec, phones, streams };
}
function seededChance(seed, p) {
  return new Rng(seed * 31 + 7).next() < p;
}
function fabricateFall(s, rng, t0 = T0) {
  const r0 = rng.uniform(1.2, 1.8);
  for (const x of s.samples) {
    const t = x.t;
    x.sonarOk = true;
    x.staticChangeDb = rng.uniform(0, 4);
    if (t < t0 - 300) Object.assign(x, { presence: "moving", range: r0 + rng.gauss() * 0.05, confirmed: true, fastMotionDb: rng.uniform(13, 18), motionDb: rng.uniform(18, 24), breathing: null });
    else if (t < t0 + 1200) Object.assign(x, { presence: "moving", range: r0 + 0.4, confirmed: true, fastMotionDb: rng.uniform(26, 31), motionDb: 28 });
    else Object.assign(x, { presence: "still", range: r0 + 0.6, confirmed: true, fastMotionDb: rng.uniform(1, 5), motionDb: rng.uniform(8, 12) });
  }
  s.sounds = s.sounds.filter((e) => e.t < t0 - 3e3 || e.t > t0 + 3e3);
  s.sounds.push({ t: t0 + 300, cls: "impact", confidence: 0.85, aboveFloorDb: rng.uniform(28, 34), repetitive: false });
  s.sounds.sort((a, b) => a.t - b.t);
}
function fabricateCalm(s, rng) {
  const r0 = rng.uniform(1.5, 2.2);
  for (const x of s.samples) {
    Object.assign(x, { sonarOk: true, presence: "moving", range: r0 + rng.gauss() * 0.1, confirmed: true, fastMotionDb: rng.uniform(13, 17), motionDb: rng.uniform(18, 24), breathing: null });
  }
  s.sounds = [];
  s.alerts = [];
}
function localVerdicts(s) {
  const out = [];
  const impacts = s.sounds.filter((e) => e.cls === "impact" && !e.repetitive && !e.benign && e.confidence >= 0.55);
  let lastFall = -1e12;
  let lastSeen = -1e12;
  const seen = s.samples.filter((x) => x.sonarOk && (x.confirmed && x.snrDb >= 15 || x.motionDb >= 16 || x.breathing));
  const bursts = s.samples.filter((x) => x.sonarOk && x.fastMotionDb >= 20).map((x) => x.t);
  const anchors = [...impacts.map((e) => e.t), ...bursts].sort((a, b) => a - b);
  let lastAnchor = -1e12;
  for (const t0 of anchors) {
    if (t0 - lastAnchor < 3e3) continue;
    lastAnchor = t0;
    const sound = impacts.find((e) => Math.abs(e.t - t0) <= 2e3);
    const around = s.samples.filter((x) => x.t >= t0 - 2e3 && x.t <= t0 + 1500 && x.sonarOk);
    const after = s.samples.filter((x) => x.t > t0 + 1500 && x.t <= t0 + 6e3 && x.sonarOk);
    const sonarOk = around.length > 10;
    const burst = around.reduce((m, x) => Math.max(m, x.fastMotionDb), 0);
    const still = sonarOk && after.length > 10 && after.filter((x) => x.fastMotionDb < 12).length / after.length >= 0.85;
    const presentBefore = around.filter((x) => x.t < t0 - 200 && (x.confirmed && x.snrDb >= 15 || x.motionDb >= 16)).length > 5;
    for (const x of seen) if (x.t < t0) lastSeen = Math.max(lastSeen, x.t);
    const decideAt = t0 + 6e3;
    if (decideAt - lastFall < 3e4) continue;
    if (sonarOk && burst >= 20 && sound && still) {
      lastFall = decideAt;
      out.push({ t: decideAt, kind: "fall", severity: "critical", title: "Possible fall" });
    } else if (sound && still && sound.confidence >= 0.7 && !(sonarOk && presentBefore) && t0 - lastSeen < 9e4 && (sound.ai ? sound.ai.group === "thud" || sound.ai.group === "distress" : sound.confidence >= 0.85 && sound.aboveFloorDb >= 28)) {
      lastFall = decideAt;
      out.push({ t: decideAt, kind: "fall", severity: "warning", title: "Loud impact, then no movement" });
    }
  }
  return out;
}
var SIM_PLACES = [
  { name: "TV", kind: "tv", at: [4.7, 0.9], h: 1.25 },
  { name: "sofa", kind: "sofa", at: [1.3, 2.6], h: 1 },
  { name: "kitchen counter", kind: "kitchen", at: [0.7, 1.4], h: 1.25 }
];
function simHomeMap(trial) {
  const rng = new Rng(trial.phones.length * 977 + 13);
  const map = { phones: {}, places: [], resting: {} };
  for (const p of SIM_PLACES) {
    const ranges = {};
    for (const ph of trial.phones) {
      const d = Math.hypot(p.at[0] - ph.x, p.at[1] - ph.y);
      if (d <= SEE_M) ranges[ph.nodeId] = Math.hypot(d, p.h - 0.75) + rng.gauss() * 0.05;
    }
    map.places.push({ id: p.name, name: p.name, kind: p.kind, ranges, createdAt: 0 });
  }
  if (trial.phones[1]) map.phones[trial.phones[1].nodeId] = { label: "by the TV", near: "tv" };
  return map;
}

// src/agents/council.ts
var Council = class {
  constructor(o) {
    this.o = o;
    this.agents = /* @__PURE__ */ new Map();
    this.board = [];
    this.live = /* @__PURE__ */ new Map();
    this.compromised = /* @__PURE__ */ new Set();
    this.quarantined = /* @__PURE__ */ new Map();
    this.joining = /* @__PURE__ */ new Set();
    this.roles = [];
    this.realCallsForSims = false;
    this.simRunning = false;
    this.simAgents = [];
    this.map = emptyMap();
    this.simMap = emptyMap();
    this.still = /* @__PURE__ */ new Map();
    this.saveTimer = null;
    this.memory = emptyMemory();
    this.lastBrainError = 0;
    /** When someone last said they were OK (new bumps right after are them getting up). */
    this.lastOkAt = 0;
    /** Result of the startup key check (set by the hub). */
    this.llmHealth = "not checked";
    /** A phone agent joins the channel under its own identity and answers "look again" requests on it. */
    this.answering = /* @__PURE__ */ new WeakSet();
    this.voice = this.makeVoice();
  }
  makeVoice() {
    let last = 0;
    return makeVoice(this.o.llm, (e) => {
      if (Date.now() - last > 6e4) this.log(`Claude unavailable, using rule text (${e.message.slice(0, 160)})`);
      last = Date.now();
    });
  }
  /** Switch Claude between off, narrate and reason while running (needs ANTHROPIC_API_KEY). */
  setLlmMode(mode) {
    if (mode !== "off" && !this.o.llm.apiKey) return false;
    this.o.llm.mode = mode;
    this.voice = this.makeVoice();
    this.log(`Claude mode: ${mode}`);
    return true;
  }
  log(s) {
    this.o.log?.(`[witness] ${s}`);
  }
  /** Every role agent joins the channel under its own identity. */
  async start() {
    const bus = this.o.bus;
    bus.moderator.onMessage((from, msg) => this.onWire(from, msg));
    this.map = this.o.loadMap?.() ?? emptyMap();
    this.memory = this.o.loadMemory?.() ?? emptyMemory();
    for (const role of ROLE_ORDER) {
      const member = await bus.join(role);
      this.roles.push(
        new RoleAgent(role, member, () => this.voice, {
          roundPauseMs: 1200,
          waitReportsMs: 3e3,
          waitPeersMs: () => this.o.llm.mode === "narrate" || this.o.llm.mode === "reason" ? 9e3 : 4e3,
          waitContextMs: 900,
          memory: () => this.memory,
          negotiator: () => this.o.llm.mode === "agent" && this.o.llm.apiKey ? {
            cfg: this.o.llm,
            budgetMs: 24e3,
            tools: { memory: () => this.memory, names: () => Object.fromEntries([...this.agents.values()].map((a) => [a.nodeId, a.name])) },
            canSpend: () => this.o.budget?.canSpend() ?? true,
            onUsage: (u) => this.o.budget?.add(u),
            onError: (e) => {
              if (Date.now() - this.lastBrainError > 3e4) this.log(`a negotiator could not move: ${e.message.slice(0, 300)}`);
              this.lastBrainError = Date.now();
            }
          } : null
        })
      );
    }
    new CartographerAgent(await bus.join("cartographer"), (inc) => inc.simulated ? this.simMap : this.map);
    this.log(`agents on ${bus.info().channel}: ${bus.info().members.join(", ")}`);
  }
  record(m, from) {
    this.board.push(m);
    if (this.board.length > 600) this.board.splice(0, this.board.length - 600);
    this.o.publish(m, from);
  }
  /** The moderator's own posts: shown on the console and sent to every agent. */
  post(m) {
    this.record(m, this.o.bus.moderator.address);
    void this.o.bus.moderator.publish(m).catch((e) => this.log(`channel publish failed: ${e.message}`));
  }
  /** Everything the moderator hears from the other agents on the channel. */
  onWire(from, msg) {
    const address = `${this.o.bus.info().channel.replace(/\/board$/, "")}/${from}`;
    if (msg.type === "context") {
      const l = this.live.get(msg.context.incidentId);
      if (l && !l.done) {
        l.place = msg.context.endedAt?.name ?? null;
        this.record({ type: "context", context: msg.context }, address);
      }
      return;
    }
    if (msg.type === "trace") {
      const l = this.live.get(msg.trace.incidentId);
      if (l && (!l.done || l.investigating || l.negotiation)) {
        (l.traces ??= []).push(msg.trace);
        this.record(msg, address);
      }
      return;
    }
    if (msg.type === "report") {
      const l = this.live.get(msg.report.incidentId);
      if (!l || l.done || l.reports.some((r) => r.id === msg.report.id)) return;
      l.reports = l.reports.filter((r) => r.nodeId !== msg.report.nodeId).concat(msg.report);
      this.record(msg, address);
    } else if (msg.type === "move") {
      const l = this.live.get(msg.move.incidentId);
      if (l) this.onMove(l, msg.move, address);
    } else if (msg.type === "position" && msg.position.agent === "investigator") {
      const l = this.live.get(msg.position.incidentId);
      if (!l || !l.investigating) return;
      l.positions.push(msg.position);
      this.record(msg, address);
      void this.conclude(l, l.investigating.outcome, msg.position);
    } else if (msg.type === "position") {
      const l = this.live.get(msg.position.incidentId);
      if (!l || l.done) return;
      l.positions.push(msg.position);
      this.record(msg, address);
      const finals = ROLE_ORDER.filter((r) => l.positions.some((p) => p.agent === r && p.round === 2));
      if (finals.length === ROLE_ORDER.length) void this.finish(l);
    }
  }
  phoneMember(nodeId) {
    return `phone-${nodeId}`;
  }
  ensureJoined(nodeId) {
    const id = this.phoneMember(nodeId);
    if (this.joining.has(id) || this.o.bus.isMember(id)) return;
    if ((this.quarantined.get(nodeId) ?? 0) > Date.now()) return;
    const a = this.agents.get(nodeId);
    if (!a) return;
    this.joining.add(id);
    this.joinPhone(a).catch((e) => this.log(`${id} could not join the channel: ${e.message}`)).finally(() => this.joining.delete(id));
  }
  async joinPhone(a) {
    const m = await this.o.bus.join(this.phoneMember(a.nodeId));
    if (!this.answering.has(m)) {
      this.answering.add(m);
      m.onMessage((_from, msg) => {
        if (msg.type === "look_request") this.answerLook(a, m, msg);
      });
    }
    return m;
  }
  /** A phone agent's own reply to the Investigator: what it measures right now (broadcast or addressed to it). */
  answerLook(a, m, req) {
    const l = this.live.get(req.incidentId);
    if (!l || !(l.pool ?? []).some((p) => p.nodeId === a.nodeId)) return;
    if (req.target && req.target.toLowerCase() !== a.name.toLowerCase() && !a.name.toLowerCase().includes(req.target.toLowerCase())) return;
    if ((this.quarantined.get(a.nodeId) ?? 0) > Date.now()) return;
    setTimeout(() => {
      const look = l.incident.simulated ? { streaming: false, note: "simulated phone: this is a recording, there is nothing newer to see" } : a.lookNow(l.incident.t0, Date.now());
      void m.publish({ type: "look_reply", requestId: req.requestId, incidentId: req.incidentId, phone: a.name, look }).catch(() => {
      });
    }, Math.max(0, Math.min(10, req.waitS)) * 1e3);
  }
  status() {
    return {
      llmMode: this.o.llm.mode,
      llmKey: !!this.o.llm.apiKey,
      llm: this.o.llm.mode === "off" ? this.o.llm.apiKey ? "rules only (Claude off)" : "rules only (add ANTHROPIC_API_KEY for Claude)" : this.o.llm.mode === "agent" ? `the three agents decide locally when they agree; when they disagree, each becomes its own Claude (${this.o.llm.model}) and they negotiate a plan${this.llmHealth === "OK" ? "" : `. Key check: ${this.llmHealth}`}` : `rules plus ${this.o.llm.model} (${this.o.llm.mode === "reason" ? "Claude picks stances" : "Claude writes the arguments"})`,
      llmHealth: this.llmHealth,
      speech: this.o.speechStatus?.() ?? "off",
      claude: this.o.budget?.summary() ?? null,
      memory: {
        incidents: this.memory.incidents.length,
        answered: this.memory.incidents.filter((r) => r.human).length,
        falseAlarms: this.memory.incidents.filter((r) => r.human === "ok").length
      },
      notify: this.o.notifier.describe(),
      webhook: !!this.o.notifier.cfg.webhook,
      compromised: [...this.compromised],
      realCallsForSims: this.realCallsForSims,
      bus: this.o.bus.info(),
      map: {
        places: this.map.places.map((p) => ({ id: p.id, name: p.name, kind: p.kind, ranges: p.ranges })),
        phones: this.map.phones,
        restingSpots: Object.fromEntries(Object.entries(this.map.resting).map(([k, h]) => [k, h.reduce((a, b) => a + b, 0)]))
      },
      quarantined: [...this.quarantined.entries()].filter(([, until]) => until > Date.now()).map(([id]) => this.agents.get(id)?.name ?? id),
      phones: [...this.agents.values()].filter((a) => !a.nodeId.startsWith("sim-")).map((a) => ({ nodeId: a.nodeId, name: a.name }))
    };
  }
  // ---------------------------------------------------------------- inputs from phones
  agent(nodeId, name) {
    let a = this.agents.get(nodeId);
    if (!a) {
      a = new PhoneAgent(nodeId, name, (kind, detail, t) => this.trigger(nodeId, kind, detail, t));
      this.agents.set(nodeId, a);
    }
    a.name = name;
    if (!nodeId.startsWith("sim-")) this.ensureJoined(nodeId);
    return a;
  }
  onTelemetry(nodeId, name, tel, now = Date.now()) {
    const st = this.still.get(nodeId);
    if (tel.presence === "still" && tel.confirmed && tel.range !== null) {
      if (!st || Math.abs(st.range - tel.range) > 0.3) this.still.set(nodeId, { since: now, range: tel.range, learnedAt: 0 });
      else if (now - st.since > 2e4 && now - st.learnedAt > 2e4) {
        st.learnedAt = now;
        learnRest(this.map, nodeId, st.range);
        this.saveSoon();
      }
    } else this.still.delete(nodeId);
    this.agent(nodeId, name).onSample({
      t: now,
      presence: tel.presence,
      range: tel.range,
      confirmed: tel.confirmed,
      snrDb: tel.snrDb,
      fastMotionDb: tel.fastMotionDb,
      motionDb: tel.motionDb,
      staticChangeDb: tel.staticChangeDb ?? 0,
      linkSnrDb: tel.linkSnrDb,
      breathing: tel.breathing,
      sonarOk: tel.sonarOk ?? (tel.status !== "calibrating" && tel.status !== "degraded"),
      media: tel.scene?.media
    });
  }
  onSound(nodeId, name, s, now = Date.now()) {
    this.agent(nodeId, name).onSound({ ...s, t: now - (s.lateMs ?? 0) });
  }
  onAlert(nodeId, name, a, now = Date.now()) {
    const agent = this.agent(nodeId, name);
    const how = a.evidence?.[0] ?? "";
    if (a.kind === "resolved") {
      const inc = this.latestOpen();
      if (inc) this.human(inc.incident.id, "ok", `${name}: ${how || "tapped I'm OK"}`);
      return;
    }
    if (a.kind === "escalation") {
      const inc = this.latestOpen();
      if (/help/i.test(a.title)) {
        if (inc) this.human(inc.incident.id, "help", `${name}: ${how || "tapped Get help"}`);
        else this.trigger(nodeId, "help_pressed", `${a.title}${how ? ` (${how})` : ""}`, now);
      } else if (inc) this.human(inc.incident.id, "no_answer", `${name}: nobody answered the phone's "Are you OK?"`);
      return;
    }
    if (a.kind === "agent_check" || a.kind === "sound") return;
    agent.onAlert({ t: now, kind: a.kind, severity: a.severity, title: a.title });
  }
  latestOpen() {
    const list = [...this.live.values()].filter((l) => !l.incident.simulated && Date.now() - l.incident.t0 < 18e4 && !["stood_down", "resolved_ok", "resolved_help"].includes(l.incident.status));
    return list.sort((a, b) => b.incident.t0 - a.incident.t0)[0] ?? null;
  }
  // ---------------------------------------------------------------- incidents
  trigger(nodeId, kind, detail, t, opts = {}) {
    for (const l2 of this.live.values()) {
      if (Math.abs(l2.incident.t0 - t) <= SAME_EVENT_MS && l2.incident.simulated === !!opts.simulated) return;
    }
    const urgentKind = kind === "help_pressed" || kind === "scream";
    if (!opts.simulated && !urgentKind) {
      const calmMs = Number(process.env.ECHOSENSE_CALM_SECONDS ?? 20) * 1e3;
      if (kind !== "fall_alert" && Date.now() - this.lastOkAt < calmMs) {
        this.log(`ignored ${kind} on ${nodeId}: they said they were OK ${Math.round((Date.now() - this.lastOkAt) / 1e3)} s ago`);
        return;
      }
      const busy = [...this.live.values()].find(
        (l2) => !l2.incident.simulated && Date.now() - l2.incident.t0 < 18e4 && ["gathering", "deliberating", "asking", "urgent", "escalated"].includes(l2.incident.status)
      );
      if (busy) {
        this.log(`folded ${kind} on ${nodeId} into ${busy.incident.id} (${busy.incident.status})`);
        return;
      }
    }
    const pool = opts.agents ?? [...this.agents.values()].filter((a) => !a.nodeId.startsWith("sim-") && Date.now() - a.lastSeen < 1e4);
    const who = pool.find((a) => a.nodeId === nodeId) ?? this.agents.get(nodeId);
    const incident = {
      id: uid("incident"),
      t0: t,
      trigger: { nodeId, name: who?.name ?? nodeId, kind, detail },
      status: "gathering",
      expected: pool.map((a) => a.nodeId),
      simulated: !!opts.simulated,
      scenario: opts.scenario
    };
    const l = { incident, reports: [], positions: [], outcome: null, askTimer: null, escalated: false, done: false, finishTimer: null, pool };
    this.live.set(incident.id, l);
    if (this.live.size > 60) this.live.delete(this.live.keys().next().value);
    this.post({ type: "incident", incident: { ...incident } });
    this.log(`incident ${incident.id}: ${incident.trigger.name} ${kind} (${detail})`);
    const wait = opts.gatherMs ?? Math.max(0, t + GATHER_MS - Date.now());
    if (kind === "scream" && !opts.simulated) {
      this.o.askPhones(incident.id, "I heard someone cry out. Are you OK? Do you need help?", false, Math.round((this.o.askTimeoutMs ?? 4e4) / 1e3));
      this.action(l, "ask_phone", true, `${who?.name ?? nodeId} heard someone cry out: asking "Are you OK?" right away while the other phones check`);
    }
    setTimeout(() => void this.run(l, pool), kind === "help_pressed" ? 300 : wait);
  }
  async run(l, pool) {
    const now = Date.now();
    const at = l.incident.simulated ? l.incident.t0 + GATHER_MS : now;
    const bus = this.o.bus;
    const ids = [];
    const skipped = [];
    const stale = [];
    await Promise.all(
      pool.map(async (a) => {
        if ((this.quarantined.get(a.nodeId) ?? 0) > Date.now()) {
          skipped.push(a.name);
          return;
        }
        const age = Date.now() - a.lastSeen;
        if (!l.incident.simulated && age > 5e3) {
          stale.push(`${a.name} (${Math.round(age / 1e3)} s old)`);
          return;
        }
        let r = { ...a.report(l.incident.id, l.incident.t0, at), ageMs: l.incident.simulated ? 0 : age };
        if (this.compromised.has(a.nodeId)) r = forge(r, l.incident.t0);
        try {
          const m = await this.joinPhone(a);
          ids.push(r.id);
          l.reports.push(r);
          this.record({ type: "report", report: r }, m.address);
          await m.publish({ type: "report", report: r });
        } catch (e) {
          this.log(`${a.name} could not post its report: ${e.message}`);
        }
      })
    );
    if (!l.incident.simulated) for (const a of pool) this.compromised.delete(a.nodeId);
    if (skipped.length) this.action(l, "quarantine", true, `${skipped.join(", ")} is quarantined and was not asked to testify`);
    if (stale.length) this.action(l, "ask_phone", false, `report rejected, not live: ${stale.join(", ")}. Keep Safari open and the screen on.`);
    l.incident.status = "deliberating";
    this.post({ type: "incident", incident: { ...l.incident } });
    await bus.moderator.publish({ type: "evidence_closed", incident: { ...l.incident }, reportIds: ids });
    l.finishTimer = setTimeout(() => void this.finish(l), this.o.llm.mode === "narrate" || this.o.llm.mode === "reason" ? 3e4 : 15e3);
  }
  async finish(l) {
    if (l.done) return;
    l.done = true;
    if (l.finishTimer) clearTimeout(l.finishTimer);
    const finals = ROLE_ORDER.map(
      (r) => l.positions.find((p) => p.agent === r && p.round === 2) ?? l.positions.find((p) => p.agent === r && p.round === 1)
    ).filter((p) => !!p);
    const outcome = resolve(l.incident, finals, l.reports, Date.now());
    const missing = ROLE_ORDER.filter((r) => !finals.some((p) => p.agent === r));
    if (missing.length) outcome.summary += ` ${missing.map((m) => ROLE_INFO[m].title).join(" and ")} did not answer in time.`;
    const contested = outcome.kind === "ask_human" && finals.length === 3 && l.incident.trigger.kind !== "help_pressed" && l.incident.trigger.kind !== "scream" && !l.answer;
    if (contested) {
      const opening = finals.map((p) => ({
        id: uid("move"),
        incidentId: l.incident.id,
        agent: p.agent,
        round: 0,
        kind: "offer",
        to: null,
        claim: null,
        plan: openingPlan(p),
        argument: p.argument,
        llm: p.llm,
        postedAt: Date.now()
      }));
      const same = agreed(opening.map((m) => m.plan));
      const claude = this.o.llm.mode === "agent" && !!this.o.llm.apiKey && (this.o.budget?.canSpend() ?? true);
      if (!same && claude) {
        l.negotiation = { round: 0, transcript: opening, ruleOutcome: outcome, timer: null };
        this.action(l, "ask_phone", true, "the agents disagree: they negotiate what to do (each agent is its own Claude, talking over the SLIM channel)");
        for (const m of opening) this.record({ type: "move", move: m }, `${this.o.bus.info().channel.replace(/\/board$/, "")}/${m.agent}`);
        void this.nextRound(l);
        return;
      }
      if (!same && this.o.llm.mode === "agent" && this.o.llm.apiKey) this.action(l, "ask_phone", true, "the agents disagree, but today's Claude budget is used up, so the person is asked");
    }
    await this.conclude(l, outcome);
  }
  /** Open the next negotiation round: every role agent makes one move on the channel. */
  async nextRound(l) {
    const n = l.negotiation;
    if (!n) return;
    n.round++;
    const lastRound = n.round >= 3;
    n.timer = setTimeout(() => void this.closeRound(l), 28e3);
    await this.o.bus.moderator.publish({ type: "negotiate", incident: { ...l.incident }, round: n.round, lastRound, transcript: n.transcript });
  }
  onMove(l, m, address) {
    const n = l.negotiation;
    if (!n || m.round !== n.round || n.transcript.some((x) => x.round === n.round && x.agent === m.agent)) return;
    n.transcript.push(m);
    this.record({ type: "move", move: m }, address);
    if (ROLE_ORDER.every((r) => n.transcript.some((x) => x.round === n.round && x.agent === r))) void this.closeRound(l);
  }
  /** After each round: a deal if all three now stand behind the same plan; otherwise another round; with no deal after the last, the disagreement is kept and the person is asked. */
  async closeRound(l) {
    const n = l.negotiation;
    if (!n) return;
    if (n.timer) clearTimeout(n.timer);
    n.timer = null;
    const plans = ROLE_ORDER.map((r) => [...n.transcript].reverse().find((m) => m.agent === r).plan);
    const deal = agreed(plans) ?? (n.round >= 3 ? nearAgreement(plans) : null);
    if (!deal && n.round < 3 && !l.answer) {
      await this.nextRound(l);
      return;
    }
    const plan = deal ?? noDeal(plans);
    l.negotiation = void 0;
    const outcome = negotiatedOutcome(n.ruleOutcome, n.transcript, plan, !!deal, n.round);
    await this.conclude(l, outcome);
  }
  /** The final outcome: post it, act on it, and remember it. */
  async conclude(l, outcome, inv) {
    if (l.outcome) return;
    if (l.investigating) clearTimeout(l.investigating.timer);
    l.investigating = void 0;
    if (inv) outcome = withInvestigator(outcome, inv);
    l.outcome = outcome;
    if (!l.incident.simulated) {
      remember(this.memory, l.incident, l.reports, outcome, l.place ?? null);
      this.o.saveMemory?.(this.memory);
    }
    this.post({ type: "outcome", outcome });
    this.log(`outcome ${outcome.kind}: ${outcome.headline}`);
    if (this.o.otlpEndpoint)
      void exportIncident(this.o.otlpEndpoint, { incident: l.incident, reports: l.reports, positions: l.positions, traces: l.traces ?? [], outcome }).then((ok) => {
        if (!ok) this.log(`could not send the trace to ${this.o.otlpEndpoint}`);
      });
    for (const q of outcome.quarantined) await this.quarantine(l, q);
    if (l.answer?.answer === "ok") {
      this.action(l, "ask_phone", true, `no call: they already said they are OK (${l.answer.source})`);
      return;
    }
    if (l.answer?.answer === "help") return;
    await this.act(l, outcome);
  }
  /** Removes a phone from the encrypted channel for two minutes. */
  async quarantine(l, name) {
    const pool = l.incident.simulated ? [...this.simAgents] : [...this.agents.values()];
    const a = pool.find((x) => x.name === name);
    if (!a) return;
    const id = this.phoneMember(a.nodeId);
    const ms = 12e4;
    this.quarantined.set(a.nodeId, Date.now() + ms);
    let removed = false;
    try {
      removed = await this.o.bus.remove(id);
    } catch (e) {
      this.log(`could not remove ${id}: ${e.message}`);
    }
    const where = this.o.bus.kind === "slim" ? "the encrypted SLIM channel" : "the channel";
    this.action(l, "quarantine", removed, `${name} removed from ${where} for 2 minutes: its reports contradict the other phones${removed ? ", so it can no longer read or post" : ""}`);
    setTimeout(() => {
      this.quarantined.delete(a.nodeId);
      if (!a.nodeId.startsWith("sim-")) this.ensureJoined(a.nodeId);
    }, ms);
  }
  action(l, action, ok, detail) {
    this.post({ type: "action", action: { incidentId: l.incident.id, action, ok, detail, t: Date.now() } });
    this.log(`${action}: ${detail}`);
  }
  setStatus(l, s) {
    l.incident.status = s;
    this.post({ type: "incident", incident: { ...l.incident } });
  }
  async act(l, o) {
    if (o.plan) {
      await this.actOnPlan(l, o, o.plan);
      return;
    }
    const sim = l.incident.simulated;
    if (o.kind === "escalate") {
      if (l.incident.trigger.kind === "help_pressed") await this.escalate(l, o.summary);
      else if (l.noAnswer && !this.audioOnly(l)) await this.escalate(l, `${o.summary} They did not answer the phone's question either.`);
      else this.urgentCheck(l);
      return;
    }
    if (o.kind === "stand_down") {
      if (l.noAnswer && !sim) {
        const pool = (l.pool ?? []).filter((a) => !a.nodeId.startsWith("sim-"));
        if (pool.some((a) => a.seesSomeone(Date.now()))) {
          this.ask(l, "Sorry to bother you again. Are you OK?");
          return;
        }
        this.action(l, "ask_phone", true, "nobody answered, but no phone sees anyone in the room now: they probably walked away");
      }
      this.setStatus(l, "stood_down");
      this.watchAfter(l);
      return;
    }
    if (l.noAnswer) {
      if (this.audioOnly(l)) this.urgentCheck(l);
      else await this.escalate(l, `The agents were not sure, and they did not answer the phone's question. ${o.summary}`);
      return;
    }
    this.ask(l, "Your sensors noticed something and are not sure you are OK.");
  }
  /**
   * The only evidence is one phone's sound classifier hearing distress: no
   * second phone heard it and no phone measured a bang or a body movement.
   * That could be a film or a child; it earns the countdown, never a call by itself.
   */
  audioOnly(l) {
    const distress = l.reports.filter((r) => r.sound.distress || r.sound.screamDb !== null).length;
    const physical = l.reports.some((r) => r.sonar.online && r.sonar.burstDb >= 16 && !phoneMovedItself(r) || (r.sound.impactDb ?? 0) >= 15);
    return (l.incident.trigger.kind === "scream" || distress > 0) && distress < 2 && !physical;
  }
  /** Carry out the plan the agents negotiated, including its condition. */
  async actOnPlan(l, o, plan) {
    const sim = l.incident.simulated;
    if (plan.action === "call") return this.escalate(l, o.headline);
    if (plan.action === "urgent") {
      if (l.noAnswer && !this.audioOnly(l)) return this.escalate(l, `${o.headline}. They did not answer the phone either.`);
      this.urgentCheck(l);
    } else if (plan.action === "ask") {
      if (l.noAnswer) return this.escalate(l, `${o.headline}. They did not answer the phone's question either.`);
      this.ask(l, "Your sensors noticed something and want to make sure you are OK.");
    } else {
      this.setStatus(l, "stood_down");
      this.watchAfter(l, plan.action === "watch" ? plan.callIfNoMovementS ?? 60 : void 0);
      return;
    }
    const s = plan.callIfNoMovementS;
    if (s && !sim) {
      const from = Date.now();
      this.action(l, "ask_phone", true, `agreed condition: if no phone sees movement within ${s} s, call at once`);
      setTimeout(() => {
        if (l.incident.status !== "asking" && l.incident.status !== "urgent") return;
        const pool = (l.pool ?? []).filter((a) => !a.nodeId.startsWith("sim-"));
        if (pool.some((a) => a.movedSince(from))) return;
        this.human(l.incident.id, "no_answer", `nobody moved within ${s} s (the condition the agents agreed on)`);
      }, s * 1e3);
    } else if (s && sim) this.action(l, "ask_phone", true, `agreed condition: call at once if nobody moves within ${s} s (simulation: not checked)`);
  }
  /** Gentle check-in: "Are you OK?" No answer in time means help is called. */
  ask(l, reason) {
    const sim = l.incident.simulated;
    this.setStatus(l, "asking");
    if (!sim) this.o.askPhones(l.incident.id, reason, false, Math.round((this.o.askTimeoutMs ?? 4e4) / 1e3));
    this.action(l, "ask_phone", true, sim ? `simulation (demo timer 8 s, real use ${Math.round((this.o.askTimeoutMs ?? 4e4) / 1e3)} s): the phones would ask "Are you OK?"` : 'asking "Are you OK?" out loud on every phone');
    const ms = sim ? 8e3 : this.o.askTimeoutMs ?? 4e4;
    if (l.askTimer) clearTimeout(l.askTimer);
    l.askTimer = setTimeout(() => this.human(l.incident.id, "no_answer", `no answer within ${Math.round(ms / 1e3)} s`), ms);
  }
  /**
   * The agents want help called. Like a fall detecting watch, say so out loud
   * first and count down: "I'm OK" cancels, "help" or silence calls at once.
   */
  urgentCheck(l) {
    const sim = l.incident.simulated;
    const ms = sim ? 6e3 : this.o.urgentMs ?? 25e3;
    this.setStatus(l, "urgent");
    if (!sim) this.o.askPhones(l.incident.id, "It looks like you may have fallen.", true, Math.round(ms / 1e3));
    this.action(
      l,
      "ask_phone",
      true,
      sim ? `simulation (demo timer ${Math.round(ms / 1e3)} s, real use ${Math.round((this.o.urgentMs ?? 25e3) / 1e3)} s): the phones would say "It looks like you may have fallen" and call unless they say they are OK` : `the agents want help: told them out loud, calling in ${Math.round(ms / 1e3)} s unless they say they are OK`
    );
    if (l.askTimer) clearTimeout(l.askTimer);
    l.askTimer = setTimeout(() => this.human(l.incident.id, "no_answer", `no answer within ${Math.round(ms / 1e3)} s of "It looks like you may have fallen"`), ms);
  }
  /**
   * Watchful waiting. If the agents stood down because the person seemed to sit
   * or lie down, that explanation predicts they will move again. If no phone
   * sees them move for a minute, ask them after all.
   */
  watchAfter(l, agreedS) {
    if (l.incident.simulated) return;
    const bodyDown = l.reports.some((r) => r.sonar.sawPersonBefore && r.sonar.burstDb >= 16 && r.sonar.firstMoveAfter === null && !r.sonar.motionResumed);
    if (!bodyDown && agreedS === void 0) return;
    const from = agreedS !== void 0 ? Date.now() : l.incident.t0 + 12e3;
    const ms = (agreedS ?? Number(process.env.ECHOSENSE_WATCH_SECONDS ?? 60)) * 1e3;
    this.action(l, "ask_phone", true, `watching: if nobody moves in the next ${Math.round(ms / 1e3)} s, they will be asked`);
    setTimeout(() => {
      if (l.incident.status !== "stood_down") return;
      const pool = [...this.agents.values()].filter((a) => !a.nodeId.startsWith("sim-") && l.incident.expected.includes(a.nodeId));
      const moved = pool.some((a) => a.movedSince(from));
      const someone = pool.some((a) => a.seesSomeone(Date.now()));
      if (moved || !someone) {
        this.action(l, "ask_phone", true, moved ? "they moved again: nothing to do" : "nobody in view any more: they got up and left");
        return;
      }
      this.setStatus(l, "asking");
      const reason = "You have not moved for a while. Are you OK?";
      this.o.askPhones(l.incident.id, reason);
      this.action(l, "ask_phone", true, `no movement for ${Math.round((Date.now() - from) / 1e3)} s since: asking "Are you OK?" on every phone`);
      l.askTimer = setTimeout(() => this.human(l.incident.id, "no_answer", "no answer to the follow up check-in"), this.o.askTimeoutMs ?? 4e4);
    }, ms);
  }
  async escalate(l, why) {
    if (l.escalated) return;
    l.escalated = true;
    this.setStatus(l, "escalated");
    const sim = l.incident.simulated;
    if (!sim) {
      this.o.clearPhones?.();
      this.o.tellPhones("Help has been called.");
    }
    const place = l.incident.trigger.name;
    const said = l.answer?.transcript;
    const when = new Date(l.incident.t0).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const spoken = `This is EchoSense. ${sim ? "This is a simulation. " : ""}A possible fall was detected near ${place}.${said ? ` They said: ${said}.` : l.answer?.answer === "no_answer" ? " They did not answer when asked if they were OK." : ""} Please check on them.`;
    const finals = ["responder", "skeptic", "auditor"].map((r) => [...l.positions].reverse().find((p) => p.agent === r)).filter((p) => !!p);
    const fallback = `${sim ? "(Simulation) " : ""}Possible fall near ${place} at ${when}. ${why}`.slice(0, 600);
    const useClaude = this.o.llm.mode !== "off" && (this.o.budget?.canSpend() ?? true);
    const brief = await caregiverBrief(
      useClaude ? this.o.llm : null,
      {
        place,
        time: when,
        simulation: sim,
        trigger: l.incident.trigger.detail,
        person_said: said ?? null,
        injury: l.answer?.injury ?? null,
        answered: l.answer?.answer ?? null,
        why_help_is_called: why,
        agents: finals.map((p) => ({ agent: p.agent, stance: p.stance, argument: p.argument }))
      },
      fallback,
      (u) => this.o.budget?.add(u)
    );
    const text = `EchoSense${sim ? " (simulation)" : ""}: ${brief}`.slice(0, 600);
    const real = !sim || this.realCallsForSims;
    const facts = [
      { title: "Where", value: `${place}, ${when}` },
      ...said ? [{ title: "They said", value: `"${said}"` }] : [],
      ...l.outcome?.plan ? [{ title: l.outcome.negotiation?.agreed ? "Agents agreed" : "Agents disagreed", value: l.outcome.negotiation?.agreed ? describePlan(l.outcome.plan) : "the evidence was not enough to agree, so the person was asked" }] : [],
      ...finals.map((p) => ({ title: ROLE_INFO[p.agent].title, value: `${stanceWord(p.stance)}: ${p.argument}`.slice(0, 300) }))
    ];
    const n = this.o.notifier;
    const [c, s, w2, x] = await Promise.all([
      real ? n.call(l.incident.id, spoken) : Promise.resolve({ ok: true, detail: `simulation: would call the caregiver and say "${spoken}"` }),
      real ? n.sms(text) : Promise.resolve({ ok: true, detail: "simulation: would text the caregiver" }),
      real ? n.webhook(text) : Promise.resolve({ ok: true, detail: "simulation: would post to the chat webhook" }),
      n.webex(l.incident.id, `${sim ? "Simulation: " : ""}possible fall near ${place}`, brief, facts, true)
    ]);
    this.action(l, "call", c.ok, c.detail);
    this.action(l, "sms", s.ok, s.detail);
    this.action(l, "webhook", w2.ok, w2.detail);
    this.action(l, "webex", x.ok, x.detail);
  }
  /** A human answered: the person on the phone, the caregiver on the call, or someone at the console. */
  human(incidentId, answer, source, extra = {}) {
    const l = this.live.get(incidentId);
    if (!l) return;
    const prev = l.answer?.answer;
    if (prev === answer && answer !== "no_answer") return;
    if (prev === "help" && answer !== "ok") return;
    if (prev === "ok" && answer === "no_answer") return;
    if (answer === "no_answer" && !l.outcome) {
      l.noAnswer = true;
      this.action(l, "ask_phone", true, `${source}; the agents will take that into account`);
      return;
    }
    if (answer === "no_answer" && l.outcome?.kind === "stand_down" && l.incident.status === "stood_down") return;
    if (answer === "no_answer" && l.incident.status === "asking" && this.audioOnly(l) && !l.askedTwice) {
      l.askedTwice = true;
      this.action(l, "ask_phone", true, `${source}; only one phone heard a cry and nothing physical backs it up, so the countdown comes before any call`);
      this.urgentCheck(l);
      return;
    }
    if (l.askTimer) clearTimeout(l.askTimer);
    l.askTimer = null;
    l.answer = { answer, source, t: Date.now(), ...extra };
    this.post({ type: "human", incidentId, answer, source, t: Date.now(), ...extra });
    this.learnFrom(incidentId, answer, source);
    const said = extra.transcript ? ` They said: "${extra.transcript}".` : "";
    if (answer === "ok") {
      const was = l.escalated;
      const asked = l.incident.status === "asking" || l.incident.status === "urgent";
      if (!l.incident.simulated) this.lastOkAt = Date.now();
      this.setStatus(l, "resolved_ok");
      if (!l.incident.simulated) {
        this.o.clearPhones?.();
        this.o.tellPhones(was ? "Okay. I've told your family you're OK." : "Okay, glad you're OK.");
      }
      if (was && !l.incident.simulated) void this.o.notifier.sms(`EchoSense: update, they say they are OK (${source}).${said}`);
      if (was) void this.o.notifier.webexText(`**EchoSense update: they are OK.** ${source}.${said}`);
      else if (asked && !l.incident.simulated)
        void this.o.notifier.webexText(`EchoSense checked in after ${describeTrigger(l.incident)} near ${l.incident.trigger.name}: they said they are OK (${source}).${said} No action needed.`);
      return;
    }
    const why = answer === "help" ? `They asked for help (${source}).${said}${extra.injury ? ` Injury: ${extra.injury}.` : ""}` : `Asked if they were OK and got no answer (${source}).`;
    void this.escalate(l, why).then(() => {
      if (answer === "help") this.setStatus(l, "resolved_help");
    });
  }
  /**
   * The person spoke and the hub understood it (speech to text, then Claude or
   * the keyword rules). Applies to the open incident, or opens one if they
   * asked for help out of the blue.
   */
  personSaid(nodeId, name, transcript, answer, injury) {
    const inc = this.latestOpen();
    if (inc) {
      this.human(inc.incident.id, answer, `${name}: said "${transcript}"`, { transcript, injury });
      return true;
    }
    if (answer === "help") {
      this.trigger(nodeId, "help_pressed", `said "${transcript}"`, Date.now());
      return true;
    }
    this.lastOkAt = Date.now();
    return false;
  }
  /** A line on the console under the open incident (or on its own). */
  note(detail) {
    const inc = this.latestOpen();
    this.post({ type: "action", action: { incidentId: inc?.incident.id ?? "-", action: "ask_phone", ok: true, detail, t: Date.now() } });
  }
  /** A person's answer is the label the agents learn from. */
  /** Everything the phones and agents produced for one incident, for a labelled training record. */
  incidentRecord(id) {
    const l = this.live.get(id);
    if (!l) return null;
    return { incident: l.incident, reports: l.reports, positions: l.positions, outcome: l.outcome, answer: l.answer ?? null, moves: l.negotiation?.transcript ?? [], escalated: l.escalated };
  }
  learnFrom(incidentId, answer, source) {
    const l = this.live.get(incidentId);
    if (!l || l.incident.simulated) return;
    learn(this.memory, incidentId, answer, source);
    this.o.saveMemory?.(this.memory);
  }
  /** Caregiver pressed a key on the call. */
  caregiver(incidentId, digit, by) {
    const l = this.live.get(incidentId);
    if (!l) return;
    if (digit === "1") {
      if (l.askTimer) clearTimeout(l.askTimer);
      l.askTimer = null;
      l.answer = { answer: "help", source: by ? `${by} is on the way` : "caregiver pressed 1: on the way", t: Date.now() };
      this.post({ type: "human", incidentId, answer: "help", source: l.answer.source, t: Date.now() });
      this.learnFrom(incidentId, "help", by ?? "caregiver");
      void this.o.notifier.webexText(`EchoSense: ${by ?? "a caregiver"} is on the way. Told the phones.`);
      this.setStatus(l, "resolved_help");
      if (!l.incident.simulated) this.o.tellPhones("Help is on the way.");
    } else if (digit === "2") this.human(incidentId, "ok", by ? `${by} says they are OK` : "caregiver pressed 2: false alarm");
  }
  // ---------------------------------------------------------------- room map
  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.o.saveMap?.(this.map);
    }, 2e3);
  }
  /** "I'm standing at the sofa": every phone that can see you records how far away you are. */
  async markPlace(name, kind) {
    await new Promise((r) => setTimeout(r, 5e3));
    const now = Date.now();
    const ranges = {};
    const parts = [];
    const missed = [];
    const live = [...this.agents.values()].filter((a) => !a.nodeId.startsWith("sim-") && now - a.lastSeen <= 5e3);
    for (const a of live) {
      const r = a.recentRange(5500, now);
      if (r !== null) {
        ranges[a.nodeId] = r;
        parts.push(`${a.name} ${r.toFixed(1)} m`);
      } else missed.push(a.name);
    }
    if (!live.length) return { ok: false, detail: "No phone is connected and sensing. Open the link on the phones first." };
    if (!parts.length)
      return {
        ok: false,
        detail: `No phone could see you (${missed.join(", ")}). Stand within about 3 m of a phone, in front of its bottom edge, sway gently, and try again.`
      };
    const clean = name.trim().slice(0, 40) || PLACE_KINDS.find((k) => k.kind === kind)?.label || "place";
    this.map.places = this.map.places.filter((p) => p.name.toLowerCase() !== clean.toLowerCase());
    this.map.places.push({ id: uid("place"), name: clean, kind, ranges, createdAt: now });
    this.o.saveMap?.(this.map);
    return { ok: true, detail: `Saved "${clean}": ${parts.join(", ")}${missed.length ? ` (${missed.join(", ")} could not see you, which is fine)` : ""}` };
  }
  removePlace(id) {
    this.map.places = this.map.places.filter((p) => p.id !== id);
    this.o.saveMap?.(this.map);
  }
  labelPhone(nodeId, label, near) {
    if (!label && !near) delete this.map.phones[nodeId];
    else this.map.phones[nodeId] = { label: label.slice(0, 40), near };
    this.o.saveMap?.(this.map);
  }
  // ---------------------------------------------------------------- demo controls
  setCompromised(nodeId, on) {
    if (on) this.compromised.add(nodeId);
    else this.compromised.delete(nodeId);
  }
  /** A compromised phone injects a fake fall right now. */
  injectFake(nodeId) {
    const a = this.agents.get(nodeId);
    if (!a) return;
    this.compromised.add(nodeId);
    this.trigger(nodeId, "fall_alert", "Possible fall (reported by this phone)", Date.now() - 6e3);
  }
  /** Plays a simulated scenario through virtual phone agents and the same protocol. */
  runScenario(key, seed = Math.floor(Math.random() * 1e3) + 1) {
    const spec = SCENARIOS.find((s) => s.key === key);
    if (!spec || this.simRunning) return false;
    this.simRunning = true;
    setTimeout(() => this.simRunning = false, 3e3);
    const trial = generate(spec, seed);
    this.simMap = simHomeMap(trial);
    const shift = Date.now() - GATHER_MS - T0;
    const triggers = [];
    const agents = trial.streams.map((s) => new PhoneAgent(s.phone.nodeId, `Sim ${s.phone.name}`, (kind, detail, t) => triggers.push({ t, nodeId: s.phone.nodeId, kind, detail })));
    this.simAgents = agents;
    for (const a of agents) this.quarantined.delete(a.nodeId);
    const evs = [];
    trial.streams.forEach((s, i) => {
      for (const x of s.samples) evs.push({ t: x.t + shift, run: () => agents[i].onSample({ ...x, t: x.t + shift }) });
      for (const x of s.sounds) evs.push({ t: x.t + shift, run: () => agents[i].onSound({ ...x, t: x.t + shift }) });
      for (const x of s.alerts) evs.push({ t: x.t + shift, run: () => agents[i].onAlert({ ...x, t: x.t + shift }) });
    });
    evs.sort((a, b) => a.t - b.t);
    for (const e of evs) e.run();
    const t0 = T0 + shift;
    const main = triggers.filter((tr) => tr.t >= t0 - SAME_EVENT_MS && tr.t <= t0 + 9e3).sort((a, b) => a.t - b.t)[0];
    if (main) this.trigger(main.nodeId, main.kind, main.detail, main.t, { simulated: true, scenario: spec.key, agents, gatherMs: 2500 });
    if (!main) {
      this.post({
        type: "action",
        action: { incidentId: "-", action: "ask_phone", ok: true, detail: `${spec.title}: no phone raised anything, nothing to deliberate`, t: Date.now() }
      });
    }
    this.log(`scenario ${spec.key} seed ${seed}: ${triggers.length} triggers`);
    return true;
  }
};
function describeTrigger(i) {
  return { impact: "a loud bang", burst: "a sudden movement", fall_alert: "a possible fall", scream: "a scream", help_pressed: "a call for help", phone_drop: "a dropped phone" }[i.trigger.kind];
}
function forge(r, t0) {
  const rng = new Rng(t0 % 1e5);
  const r0 = rng.uniform(1.3, 1.8);
  return {
    ...r,
    samples: Math.max(r.samples, 80),
    silenceMs: 100,
    sound: {
      impactDb: rng.uniform(28, 33),
      impactRepetitive: false,
      screamDb: null,
      mediaEventsBefore: 0,
      voiceAfter: false,
      impactAi: { group: "thud", score: 0.6, label: "Thump, thud" },
      media: 0,
      distress: false
    },
    sonar: {
      online: true,
      medianLinkDb: 24,
      sawPersonBefore: true,
      rangeBefore: r0,
      rangeAfter: r0 + 0.55,
      burstDb: rng.uniform(26, 30),
      stillAfter: 1,
      motionResumed: false,
      presentAfter: true,
      lastSeenAgo: 0.5,
      firstMoveAfter: null,
      breathingAfter: null,
      roomChangeDb: 2
    },
    imu: { moved: false, dropped: false },
    localVerdict: "fall"
  };
}

// src/agents/eval.ts
var METHODS = ["single", "any", "majority", "agents", "agentsMap"];
async function runAgents(trial, seen = /* @__PURE__ */ new Set(), map, brain) {
  const triggers = [];
  const agents = trial.streams.map((s) => new PhoneAgent(s.phone.nodeId, s.phone.name, (kind, detail, t) => triggers.push({ t, nodeId: s.phone.nodeId, name: s.phone.name, kind, detail })));
  const evs = [];
  trial.streams.forEach((s, i) => {
    for (const x of s.samples) evs.push({ t: x.t, i, run: () => agents[i].onSample(x) });
    for (const x of s.sounds) evs.push({ t: x.t, i, run: () => agents[i].onSound(x) });
    for (const x of s.alerts) evs.push({ t: x.t, i, run: () => agents[i].onAlert(x) });
  });
  evs.sort((a, b) => a.t - b.t || a.i - b.i);
  for (const e of evs) e.run();
  triggers.sort((a, b) => a.t - b.t);
  const runs = [];
  const opened = [];
  let n = 0;
  for (const tr of triggers) {
    if (opened.some((t) => Math.abs(tr.t - t) <= SAME_EVENT_MS)) continue;
    opened.push(tr.t);
    const incident = {
      id: `${trial.spec.key}-${++n}`,
      t0: tr.t,
      trigger: { nodeId: tr.nodeId, name: tr.name, kind: tr.kind, detail: tr.detail },
      status: "deliberating",
      expected: agents.map((a) => a.nodeId),
      simulated: true,
      scenario: trial.spec.key
    };
    const at = tr.t + GATHER_MS;
    const reports = agents.map((a) => a.report(incident.id, tr.t, at));
    const { positions, outcome } = await deliberate(incident, reports, { now: () => at, seenFingerprints: seen, map, brain });
    for (const r of reports) seen.add(fingerprint(r));
    runs.push({ incident, reports, positions, outcome });
  }
  return runs;
}
function baselineDecisions(trial) {
  const fires = trial.streams.map((s) => s.alerts.some((a) => a.kind === "fall"));
  const count = fires.filter(Boolean).length;
  return {
    single: fires[0] ? "alarm" : "none",
    any: count > 0 ? "alarm" : "none",
    majority: count > fires.length / 2 ? "alarm" : "none"
  };
}
function agentDecision(runs, trial) {
  if (runs.some((r) => r.outcome.kind === "escalate")) return "alarm";
  if (runs.some((r) => r.outcome.kind === "ask_human")) return "ask";
  const watched2 = runs.some((r) => r.outcome.kind === "stand_down" && r.reports.some((x) => x.sonar.sawPersonBefore && x.sonar.burstDb >= 16 && x.sonar.firstMoveAfter === null && !x.sonar.motionResumed));
  if (watched2 && trial && trial.spec.person.after === "floor" && trial.spec.person.event !== "none") return "ask";
  return "none";
}
async function runTrial(spec, seed, layout = LAYOUT) {
  const trial = generate(spec, seed, layout);
  const incidents = await runAgents(trial);
  const withMap = await runAgents(trial, /* @__PURE__ */ new Set(), simHomeMap(trial));
  return {
    scenario: spec.key,
    emergency: spec.emergency,
    decisions: { ...baselineDecisions(trial), agents: agentDecision(incidents, trial), agentsMap: agentDecision(withMap, trial) },
    incidents,
    incidentsMap: withMap
  };
}
function empty() {
  return { trials: 0, caught: 0, caughtAfterAsk: 0, missed: 0, falseAlarms: 0, prompts: 0, correctQuiet: 0 };
}
function add(s, emergency, d) {
  s.trials++;
  if (emergency) {
    if (d === "alarm") s.caught++;
    else if (d === "ask") s.caughtAfterAsk++;
    else s.missed++;
  } else if (d === "alarm") s.falseAlarms++;
  else if (d === "ask") s.prompts++;
  else s.correctQuiet++;
}
async function evaluate(trials = 50, specs = SCENARIOS, layout = LAYOUT) {
  const totals = Object.fromEntries(METHODS.map((m) => [m, empty()]));
  const scenarios = [];
  for (const spec of specs) {
    const scores = Object.fromEntries(METHODS.map((m) => [m, empty()]));
    for (let k = 0; k < trials; k++) {
      const r = await runTrial(spec, k + 1, layout);
      for (const m of METHODS) {
        add(scores[m], spec.emergency, r.decisions[m]);
        add(totals[m], spec.emergency, r.decisions[m]);
      }
    }
    scenarios.push({ spec, scores });
  }
  return { trialsPerScenario: trials, scenarios, totals };
}
function cell(s, emergency) {
  const pct = (x) => `${Math.round(100 * x / Math.max(1, s.trials))}%`;
  if (emergency) {
    const got = s.caught + s.caughtAfterAsk;
    return `${pct(got)} caught${s.caughtAfterAsk ? ` (${s.caughtAfterAsk} after asking)` : ""}`;
  }
  return `${pct(s.falseAlarms)} false alarm${s.prompts ? `, ${s.prompts} asked` : ""}`;
}
function formatTable(t) {
  const head = ["Scenario", "Single phone", "Any phone", "Majority vote", "Agents", "Agents + room map"];
  const rows = t.scenarios.map(({ spec, scores }) => [`${spec.title}${spec.emergency ? " (real)" : ""}`, ...METHODS.map((m) => cell(scores[m], spec.emergency))]);
  const tot = (m) => {
    const s = t.totals[m];
    const emerg = s.caught + s.caughtAfterAsk + s.missed;
    return `missed ${s.missed}/${emerg}, false alarms ${s.falseAlarms}/${s.trials - emerg}, asked ${s.prompts}`;
  };
  rows.push(["All scenarios", ...METHODS.map(tot)]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  return [line(head), `|${widths.map((w2) => "-".repeat(w2 + 2)).join("|")}|`, ...rows.map(line)].join("\n");
}

// src/agents/intent.ts
var STRONG_HELP = /\bhelp me\b|\bi('?m| am) (hurt|bleeding|stuck|on the floor|in pain|not ok|not okay|not alright|not all right|not fine|not good|not well)\b|\bi (fell|fall|have fallen|'ve fallen)\b|\bi can'?t (get up|stand|breathe|move|walk)\b|\bi cannot (get up|stand|breathe|move|walk)\b|\bcall (an? )?ambulance\b|\b911\b|\bnine one one\b|\bhelp help\b/;
var WEAK_HELP = [
  /\bhelp\b/,
  /\bhurts?\b|\bhurting\b|\bpain\b|\bpainful\b|\bache\b|\binjur/,
  /\bbleed|\bblood\b/,
  /\bfell\b|\bfallen\b/,
  /\bcan'?t (get up|stand|move|breathe|walk)\b|\bcannot (get up|stand|move|breathe|walk)\b/,
  /\bambulance\b|\bemergency\b|\bdoctor\b|\bhospital\b/,
  /\bcall (someone|somebody|my)\b/,
  /\bbroke(n)?\b|\bdizzy\b|\bchest\b|\bfaint/,
  /\bnot (ok|okay|fine|alright|all right|good|well)\b/
];
var STRONG_OK = /\bi('?m| am) (ok|okay|fine|alright|all right|good|great|doing (ok|okay|fine|good|alright))\b|\ball good\b|\beverything('?s| is) (ok|okay|fine|alright|all right)\b|\bfalse alarm\b|\bi('?m| am) (totally |perfectly |completely )?(ok|okay|fine|alright)\b/;
var SHORT_OK = /^(yes|yeah|yep|yup|ok|okay|fine|good|alright|all right)( (yes|yeah|i'?m|i am|fine|ok|okay|good|thanks|thank you))*$/;
var BARE_NO = /^(no+|nope|nah)( (no+|nope))*$/;
var PROMPT_ECHO = [
  /\bsay (i'?m|i am) (ok|okay),? or say help\b/g,
  /\b(ok|okay|k),? or say help\b/g,
  /\bor say help\b/g,
  /\bsay help\b/g,
  /\bare you (ok|okay)\b/g,
  /\bit looks like you may have fallen\b/g,
  /\botherwise i will call (for help|your family)\b/g,
  /\bi will call (for help|your family)\b/g,
  /\bi'?m about to call for help\b/g,
  /\bsay (i'?m|i am) (ok|okay) if you are (ok|okay)\b/g,
  /\bif you are (ok|okay),? say (i'?m|i am) (ok|okay)\b/g,
  /\bplease answer\b/g,
  /\bif i don'?t hear from you\b/g,
  /\bsorry,? i didn'?t catch that\b/g
];
function stripPromptEcho(raw) {
  let t = raw.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  let cut = -1;
  for (const re of PROMPT_ECHO) {
    re.lastIndex = 0;
    let m;
    while (m = re.exec(t)) cut = Math.max(cut, m.index + m[0].length);
  }
  if (cut >= 0) t = t.slice(cut).trim();
  return t;
}
function ruleIntent(raw) {
  raw = stripPromptEcho(raw);
  const t = raw.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const words = t ? t.split(" ").length : 0;
  const m = /\b(my|the) (\w+ )?(hip|head|leg|arm|back|wrist|knee|ankle|shoulder|neck|chest|hand|foot)\b/.exec(t);
  const injury = m ? m[0] : null;
  if (!words) return { answer: "unclear", injury: null, by: "rules" };
  if (STRONG_HELP.test(t)) return { answer: "help", injury, by: "rules" };
  if (BARE_NO.test(t)) return { answer: "unclear", injury, by: "rules" };
  const direct = words <= 12;
  if (words <= 7 && WEAK_HELP.some((r) => r.test(t))) return { answer: "help", injury, by: "rules" };
  if (direct && (STRONG_OK.test(t) || SHORT_OK.test(t))) return { answer: "ok", injury: null, by: "rules" };
  return { answer: "unclear", injury, by: "rules" };
}
async function understand(transcript, cfg, urgent, spend) {
  transcript = stripPromptEcho(transcript);
  const rules = ruleIntent(transcript);
  const words = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;
  if (rules.answer !== "unclear" || !cfg?.apiKey || cfg.mode === "off" || words === 0 || words > 25) return rules;
  if (spend && !spend({ input_tokens: 0, output_tokens: 0 })) return rules;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4e3);
  try {
    const res = await fetch(`${cfg.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", ...cfg.workspaceId ? { "anthropic-workspace-id": cfg.workspaceId } : {} },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 60,
        system: 'An older person was asked "Are you OK?" by their home safety system' + (urgent ? " because it thinks they may have fallen" : "") + '. This is what speech recognition heard (may contain errors, may be someone else talking, a phone call or the TV). Does it say they are hurt or need help? Reply with JSON only: {"help":true|false,"injury":"what hurts in their words, or null"}',
        messages: [{ role: "user", content: transcript }]
      })
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    if (body.usage) spend?.(body.usage);
    const mm = body.content.map((c) => c.text ?? "").join("").match(/\{[\s\S]*\}/);
    const out = mm ? JSON.parse(mm[0]) : {};
    const injury = typeof out.injury === "string" && out.injury && out.injury !== "null" ? out.injury : rules.injury;
    if (out.help === true) return { answer: "help", injury, by: "Claude" };
    return { answer: "unclear", injury, by: "rules and Claude" };
  } catch {
    return rules;
  } finally {
    clearTimeout(timer);
  }
}
function saysHelpOutright(raw) {
  return STRONG_HELP.test(stripPromptEcho(raw));
}

// src/agents/budget.ts
function price(model) {
  if (/haiku-4-5|haiku-4\.5/.test(model)) return [1, 5];
  if (/haiku/.test(model)) return [0.8, 4];
  if (/opus/.test(model)) return [15, 75];
  return [3, 15];
}
var Budget = class {
  constructor(dailyUsd, model, saved = null, save = () => {
  }) {
    this.dailyUsd = dailyUsd;
    this.model = model;
    this.save = save;
    this.state = saved && saved.day === today() ? saved : fresh();
  }
  roll() {
    if (this.state.day !== today()) this.state = fresh();
  }
  /** May we make one more call today? Worst case a call costs about a cent. */
  canSpend() {
    this.roll();
    const ok = this.state.dollars + 0.01 <= this.dailyUsd;
    if (!ok) {
      this.state.skipped++;
      this.save(this.state);
    }
    return ok;
  }
  add(u) {
    if (!u) return;
    this.roll();
    const [pi, po] = price(this.model());
    const input = u.input_tokens + (u.cache_read_input_tokens ?? 0);
    this.state.calls++;
    this.state.input += input;
    this.state.output += u.output_tokens;
    this.state.dollars += (u.input_tokens * pi + (u.cache_read_input_tokens ?? 0) * pi * 0.1 + u.output_tokens * po) / 1e6;
    this.save(this.state);
  }
  summary() {
    this.roll();
    return { today: +this.state.dollars.toFixed(4), cap: this.dailyUsd, calls: this.state.calls, skipped: this.state.skipped };
  }
};
function today() {
  return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}
function fresh() {
  return { day: today(), dollars: 0, calls: 0, input: 0, output: 0, skipped: 0 };
}

// src/server/stt.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_module = require("node:module");
var import_node_path = __toESM(require("node:path"));
var MODEL = "sherpa-onnx-moonshine-tiny-en-int8";
var URL2 = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL}.tar.bz2`;
var SpeechToText = class {
  constructor(root, log, onReady = () => {
  }) {
    this.log = log;
    this.onReady = onReady;
    this.status = "not started";
    this.rec = null;
    this.dir = import_node_path.default.join(root, "models", "speech");
  }
  get ready() {
    return !!this.rec;
  }
  start() {
    if (process.env.ECHOSENSE_STT === "0") {
      this.status = "off (ECHOSENSE_STT=0)";
      return;
    }
    let sherpa;
    try {
      sherpa = (0, import_node_module.createRequire)(__filename)("sherpa-onnx-node");
    } catch (e) {
      this.status = `off: run npm install (sherpa-onnx-node missing: ${e.message.split("\n")[0]})`;
      this.log(`speech understanding ${this.status}`);
      return;
    }
    const model = import_node_path.default.join(this.dir, MODEL);
    if ((0, import_node_fs.existsSync)(import_node_path.default.join(model, "tokens.txt"))) this.load(sherpa, model);
    else this.download(sherpa, model);
  }
  download(sherpa, model) {
    this.status = "downloading the speech model (about 110 MB, once)";
    this.log(`speech understanding: ${this.status}...`);
    (0, import_node_fs.mkdirSync)(this.dir, { recursive: true });
    const tar = import_node_path.default.join(this.dir, `${MODEL}.tar.bz2`);
    const p = (0, import_node_child_process.spawn)("sh", ["-c", `curl -fsSL -o "${tar}" "${URL2}" && tar xjf "${tar}" -C "${this.dir}" && rm -f "${tar}"`], { stdio: "ignore" });
    p.on("exit", (code) => {
      if (code === 0 && (0, import_node_fs.existsSync)(import_node_path.default.join(model, "tokens.txt"))) this.load(sherpa, model);
      else {
        (0, import_node_fs.rmSync)(tar, { force: true });
        this.status = `off: could not download the speech model (exit ${code}); check the internet and restart the hub`;
        this.log(`speech understanding ${this.status}`);
      }
    });
    p.on("error", (e) => {
      this.status = `off: ${e.message}`;
      this.log(`speech understanding ${this.status}`);
    });
  }
  load(sherpa, model) {
    try {
      const S = sherpa;
      this.rec = new S.OfflineRecognizer({
        featConfig: { sampleRate: 16e3, featureDim: 80 },
        modelConfig: {
          moonshine: {
            preprocessor: import_node_path.default.join(model, "preprocess.onnx"),
            encoder: import_node_path.default.join(model, "encode.int8.onnx"),
            uncachedDecoder: import_node_path.default.join(model, "uncached_decode.int8.onnx"),
            cachedDecoder: import_node_path.default.join(model, "cached_decode.int8.onnx")
          },
          tokens: import_node_path.default.join(model, "tokens.txt"),
          numThreads: 2,
          provider: "cpu",
          debug: 0
        }
      });
      this.status = "on (Moonshine, on this computer)";
      this.log(`speech understanding ${this.status}`);
      this.onReady();
    } catch (e) {
      this.status = `off: the speech model did not load (${e.message})`;
      this.log(`speech understanding ${this.status}`);
    }
  }
  /** 16 kHz mono samples to text. */
  transcribe(samples) {
    if (!this.rec) return "";
    const s = this.rec.createStream();
    s.acceptWaveform({ sampleRate: 16e3, samples });
    this.rec.decode(s);
    return this.rec.getResult(s).text.trim();
  }
};
function pcm16ToFloat(b64) {
  const buf = Buffer.from(b64, "base64");
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

// src/agents/notify.ts
var import_node_crypto3 = require("node:crypto");
function notifyFromEnv(env = process.env, webhook = "") {
  return {
    sid: env.TWILIO_ACCOUNT_SID ?? "",
    token: env.TWILIO_AUTH_TOKEN ?? "",
    from: env.TWILIO_FROM ?? "",
    to: (env.CAREGIVER_PHONE ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    publicUrl: (env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
    webhook: webhook || env.ECHOSENSE_WEBHOOK || "",
    sms: env.ECHOSENSE_SMS !== "0",
    webexToken: env.WEBEX_BOT_TOKEN ?? "",
    webexRoomId: env.WEBEX_ROOM_ID ?? "",
    webexToEmail: env.WEBEX_TO_EMAIL ?? ""
  };
}
function xml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
}
var Notifier = class {
  constructor(cfg) {
    this.cfg = cfg;
  }
  get twilioReady() {
    return !!(this.cfg.sid && this.cfg.token && this.cfg.from && this.cfg.to.length);
  }
  describe() {
    const tw = this.twilioReady ? `Calls and texts go to ${this.cfg.to.map(mask).join(", ")}${this.cfg.publicUrl ? ", caregiver can press 1 or 2" : ""}` : "Twilio not configured: calls and texts are dry runs";
    const wx = this.webexReady ? `Webex alerts to ${this.cfg.webexRoomId ? "your space" : this.cfg.webexToEmail}` : "Webex not set up";
    return `${tw}. ${wx}`;
  }
  async twilio(path3, form) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.cfg.sid}/${path3}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Basic " + Buffer.from(`${this.cfg.sid}:${this.cfg.token}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(form).toString()
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, detail: `Twilio ${res.status}: ${body.message ?? "error"}${body.code ? ` (code ${body.code})` : ""}` };
    return { ok: true, detail: body.sid ?? "sent" };
  }
  async call(incidentId, spoken) {
    if (!this.twilioReady) return { ok: true, detail: `dry run: would call the caregiver and say "${spoken}"` };
    const gather = this.cfg.publicUrl ? `<Gather numDigits="1" timeout="10" method="POST" action="${xml(`${this.cfg.publicUrl}/twilio/gather?incident=${encodeURIComponent(incidentId)}`)}"><Say voice="Polly.Joanna">Press 1 if you are on your way. Press 2 if they are OK and this is a false alarm.</Say></Gather><Say voice="Polly.Joanna">No key pressed. EchoSense will keep alerting.</Say>` : `<Pause length="1"/><Say voice="Polly.Joanna">${xml(spoken)}</Say>`;
    const twiml = `<Response><Say voice="Polly.Joanna">${xml(spoken)}</Say>${gather}</Response>`;
    const results = await Promise.all(this.cfg.to.map((to) => this.twilio("Calls.json", { To: to, From: this.cfg.from, Twiml: twiml })));
    return { ok: results.some((r) => r.ok), detail: results.map((r, i) => `${mask(this.cfg.to[i])}: ${r.ok ? "calling" : r.detail}`).join("; ") };
  }
  async sms(text) {
    if (!this.cfg.sms) return { ok: true, detail: "texts turned off" };
    if (!this.twilioReady) return { ok: true, detail: `dry run: would text "${text}"` };
    const results = await Promise.all(this.cfg.to.map((to) => this.twilio("Messages.json", { To: to, From: this.cfg.from, Body: text })));
    return { ok: results.some((r) => r.ok), detail: results.map((r, i) => `${mask(this.cfg.to[i])}: ${r.ok ? "sent" : r.detail}`).join("; ") };
  }
  async webhook(text) {
    if (!this.cfg.webhook) return { ok: true, detail: "no webhook set" };
    try {
      const res = await fetch(this.cfg.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text, text })
      });
      return { ok: res.ok, detail: res.ok ? "posted" : `webhook ${res.status}` };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }
  // ---------------------------------------------------------------- Cisco Webex
  get webexReady() {
    return !!(this.cfg.webexToken && (this.cfg.webexRoomId || this.cfg.webexToEmail));
  }
  async webexApi(method, path3, body) {
    const res = await fetch(`https://webexapis.com/v1/${path3}`, {
      method,
      headers: { authorization: `Bearer ${this.cfg.webexToken}`, "content-type": "application/json" },
      body: body === void 0 ? void 0 : JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  }
  target() {
    return this.cfg.webexRoomId ? { roomId: this.cfg.webexRoomId } : { toPersonEmail: this.cfg.webexToEmail };
  }
  /** Posts the alert to Webex as a card the caregiver can answer with one tap. */
  async webex(incidentId, title, text, facts, buttons) {
    if (!this.cfg.webexToken) return { ok: true, detail: "Webex not set up" };
    if (!this.webexReady) return { ok: false, detail: "set WEBEX_ROOM_ID or WEBEX_TO_EMAIL" };
    const card = {
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.2",
        body: [
          { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", color: buttons ? "Attention" : "Default", wrap: true },
          { type: "TextBlock", text, wrap: true },
          ...facts.length ? [{ type: "FactSet", facts }] : []
        ],
        actions: buttons ? [
          { type: "Action.Submit", title: "On my way", data: { incident: incidentId, answer: "on_my_way" } },
          { type: "Action.Submit", title: "They are OK", data: { incident: incidentId, answer: "false_alarm" } }
        ] : []
      }
    };
    try {
      const markdown = `**${title}**

${text}${facts.length ? `

${facts.map((f) => `- **${f.title}:** ${f.value}`).join("\n")}` : ""}`.slice(0, 7e3);
      const r = await this.webexApi("POST", "messages", { ...this.target(), markdown, attachments: [card] });
      if (r.ok) return { ok: true, detail: `posted to Webex${buttons && !this.cfg.publicUrl ? " (set PUBLIC_URL to make the buttons work)" : ""}` };
      const why = `${r.status}: ${r.json?.message ?? "error"}`;
      console.warn(`[witness] Webex card refused (${why}), sending plain text`);
      const plain = await this.webexApi("POST", "messages", { ...this.target(), markdown });
      return plain.ok ? { ok: true, detail: `posted to Webex as text (the card was refused: ${why})` } : { ok: false, detail: `Webex ${plain.status}: ${plain.json?.message ?? "error"} (card: ${why})` };
    } catch (e) {
      return { ok: false, detail: `Webex: ${e.message}` };
    }
  }
  async webexText(markdown) {
    if (!this.webexReady) return;
    const r = await this.webexApi("POST", "messages", { ...this.target(), markdown }).catch((e) => ({ ok: false, status: 0, json: { message: e.message } }));
    if (!r.ok) console.warn(`[witness] Webex message failed: ${r.status} ${r.json?.message ?? ""}`);
  }
  /** Registers (or refreshes) the webhook that tells the hub when a card button is pressed. */
  async registerWebex(secret) {
    if (!this.webexReady) return this.cfg.webexToken ? "Webex: set WEBEX_ROOM_ID or WEBEX_TO_EMAIL" : "Webex not set up";
    if (!this.cfg.publicUrl) return "Webex alerts on (set PUBLIC_URL for the card buttons)";
    try {
      const target = `${this.cfg.publicUrl}/webex/actions`;
      const list = await this.webexApi("GET", "webhooks");
      for (const h of list.json?.items ?? []) {
        if (h.name === "echosense-witness") await this.webexApi("DELETE", `webhooks/${h.id}`);
      }
      const r = await this.webexApi("POST", "webhooks", { name: "echosense-witness", targetUrl: target, resource: "attachmentActions", event: "created", secret });
      return r.ok ? "Webex alerts and card buttons on" : `Webex webhook failed: ${r.json?.message ?? r.status}`;
    } catch (e) {
      return `Webex webhook failed: ${e.message}`;
    }
  }
  /** Reads which button was pressed (Webex sends only the action id). */
  async webexAction(actionId) {
    const r = await this.webexApi("GET", `attachment/actions/${encodeURIComponent(actionId)}`);
    if (!r.ok) return null;
    const inputs = r.json?.inputs ?? {};
    if (!inputs.incident || !inputs.answer) return null;
    let person = "caregiver";
    const who = await this.webexApi("GET", `people/${encodeURIComponent(r.json.personId)}`).catch(() => null);
    if (who?.ok && who.json?.displayName) person = who.json.displayName;
    return { incident: inputs.incident, answer: inputs.answer, person };
  }
  /** Webex signs webhook bodies with HMAC SHA1 (hex) of the raw body. */
  static verifyWebex(raw, secret, signature) {
    if (!signature) return false;
    const expect = (0, import_node_crypto3.createHmac)("sha1", secret).update(raw).digest("hex");
    return expect.length === signature.length && (0, import_node_crypto3.timingSafeEqual)(Buffer.from(expect), Buffer.from(signature));
  }
  /** Validates Twilio's request signature on the key press callback. */
  verify(fullUrl, params, signature) {
    if (!this.cfg.token) return false;
    if (!signature) return false;
    const data = fullUrl + Object.keys(params).sort().map((k) => k + params[k]).join("");
    const expect = (0, import_node_crypto3.createHmac)("sha1", this.cfg.token).update(data).digest();
    const got = Buffer.from(signature, "base64");
    return got.length === expect.length && (0, import_node_crypto3.timingSafeEqual)(got, expect);
  }
};
function mask(n) {
  return n.length > 4 ? `${"*".repeat(Math.max(0, n.length - 4))}${n.slice(-4)}` : n;
}
function gatherReply(digit) {
  const say = digit === "1" ? "Thank you. We will tell them help is on the way." : digit === "2" ? "Thank you. EchoSense will stand down." : "Sorry, that key is not recognised. EchoSense will keep alerting.";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">${say}</Say></Response>`;
}

// src/server/server.ts
function loadEnvFile() {
  const file = import_node_path2.default.resolve(process.cwd(), ".env");
  if (!(0, import_node_fs2.existsSync)(file)) return;
  for (const line of (0, import_node_fs2.readFileSync)(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (v && process.env[m[1]] === void 0) process.env[m[1]] = v;
  }
}
loadEnvFile();
function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : void 0;
  };
  return {
    port: Number(get("--port") ?? process.env.PORT ?? 8080),
    https: a.includes("--https"),
    webhook: get("--webhook") ?? process.env.ECHOSENSE_WEBHOOK ?? "",
    bands: Number(get("--bands") ?? 0),
    root: get("--root") ?? import_node_path2.default.resolve(__dirname, "..", "public"),
    caregiver: get("--caregiver") ?? "",
    publicUrl: get("--public-url") ?? ""
  };
}
var args = parseArgs();
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".map": "application/json"
};
var VOICE_LINES = {
  ask1: "Are you OK? Say I'm OK, or say help.",
  ask2: "Are you OK? Please answer. If I don't hear from you, I will call your family.",
  urgent1: "It looks like you may have fallen. If you are OK, say I'm OK. Otherwise I will call for help.",
  urgent2: "I'm about to call for help. Say I'm OK if you are OK.",
  again1: "Sorry, I didn't catch that. Say I'm OK, or say help.",
  again2: "Please say I am OK, or say help.",
  glad: "Okay, glad you're OK.",
  toldok: "Okay. I've told your family you're OK.",
  help: "Help has been called. Stay where you are.",
  onway: "Help is on the way."
};
var voiceFile = (k) => `${k}-${(0, import_node_crypto4.createHash)("sha1").update(VOICE_LINES[k] ?? k).digest("hex").slice(0, 8)}.wav`;
var voiceDir = import_node_path2.default.resolve(process.cwd(), ".voice");
function makeVoice2() {
  try {
    (0, import_node_fs2.mkdirSync)(voiceDir, { recursive: true });
    for (const [k, text] of Object.entries(VOICE_LINES)) {
      const out = import_node_path2.default.join(voiceDir, voiceFile(k));
      if ((0, import_node_fs2.existsSync)(out)) continue;
      if (process.platform === "darwin") {
        (0, import_node_child_process2.execFileSync)("say", ["-r", "165", "--file-format=WAVE", "--data-format=LEI16@22050", "-o", out, text], { stdio: "ignore" });
      } else {
        (0, import_node_child_process2.execFileSync)("espeak-ng", ["-s", "150", "-w", out, text], { stdio: "ignore" });
      }
    }
  } catch (e) {
    console.warn("[hub] could not record the spoken prompts (phones fall back to speech synthesis):", e.message);
  }
}
makeVoice2();
function serveStatic(req, res) {
  const u = new URL(req.url ?? "/", "http://x");
  let p = decodeURIComponent(u.pathname);
  const voice = /^\/voice\/([a-z0-9]+)\.wav$/.exec(p);
  if (voice) {
    const f = import_node_path2.default.join(voiceDir, VOICE_LINES[voice[1]] ? voiceFile(voice[1]) : `${voice[1]}.wav`);
    if ((0, import_node_fs2.existsSync)(f)) {
      res.writeHead(200, { "content-type": "audio/wav", "cache-control": "public, max-age=3600" });
      res.end((0, import_node_fs2.readFileSync)(f));
    } else {
      res.writeHead(404);
      res.end();
    }
    return;
  }
  if (p === "/") p = "/index.html";
  if (p === "/console") p = "/console.html";
  if (p === "/twilio/gather" && req.method === "POST") {
    onGather(req, res, u);
    return;
  }
  if (p === "/webex/actions" && req.method === "POST") {
    onWebex(req, res);
    return;
  }
  const card = /^\/agents\/([a-z0-9.-]+)\/\.well-known\/agent-card\.json$/.exec(p);
  if (card) {
    const a = agentDirectory().agents.find((x) => x.name === card[1] || x.name.endsWith(`.${card[1]}`));
    res.writeHead(a ? 200 : 404, { "content-type": "application/json" });
    res.end(a ? JSON.stringify(agentCard(a), null, 2) : "{}");
    return;
  }
  if (p === "/agents" || p === "/.well-known/agents.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(agentDirectory(), null, 2));
    return;
  }
  if (p === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, nodes: nodes.size, consoles: consoles.size }));
    return;
  }
  const file = import_node_path2.default.normalize(import_node_path2.default.join(args.root, p));
  if (!file.startsWith(args.root) || !(0, import_node_fs2.existsSync)(file) || !(0, import_node_fs2.statSync)(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[import_node_path2.default.extname(file)] ?? "application/octet-stream",
    "cache-control": p.startsWith("/models/") ? "public, max-age=86400" : "no-cache",
    // Allows the microphone and motion sensors on this origin.
    "permissions-policy": "microphone=(self), accelerometer=(self), gyroscope=(self)"
  });
  res.end((0, import_node_fs2.readFileSync)(file));
}
var nodes = /* @__PURE__ */ new Map();
var consoles = /* @__PURE__ */ new Set();
var history = [];
var bandCount = Math.max(1, Math.min(3, args.bands || 1));
var counter = 0;
var notifyCfg = notifyFromEnv(process.env, args.webhook);
if (args.caregiver) notifyCfg.to = args.caregiver.split(",").map((x) => x.trim()).filter(Boolean);
if (args.publicUrl) notifyCfg.publicUrl = args.publicUrl.replace(/\/+$/, "");
var notifier = new Notifier(notifyCfg);
var llm = llmFromEnv();
var usageFile = import_node_path2.default.resolve(process.cwd(), "claude-usage.json");
var budget = new Budget(
  Number(process.env.ECHOSENSE_CLAUDE_DAILY_USD ?? 0.5),
  () => llm.model,
  (() => {
    try {
      return (0, import_node_fs2.existsSync)(usageFile) ? JSON.parse((0, import_node_fs2.readFileSync)(usageFile, "utf8")) : null;
    } catch {
      return null;
    }
  })(),
  (st) => {
    try {
      (0, import_node_fs2.writeFileSync)(usageFile, JSON.stringify(st));
    } catch {
    }
  }
);
var stt = new SpeechToText(process.cwd(), (line) => console.log(`[hub] ${line}`), () => {
  for (const n of nodes.values()) if (n.info.online !== false) send(n.ws, { type: "caps", stt: true });
  toConsoles({ type: "council_status", status: council.status() });
});
var council;
var mapFile = import_node_path2.default.resolve(process.cwd(), "homemap.json");
var memoryFile = import_node_path2.default.resolve(process.cwd(), "homememory.json");
var trainingFile = import_node_path2.default.resolve(process.cwd(), "training.jsonl");
async function startAgents() {
  const bus = await startBus({
    enabled: process.env.ECHOSENSE_SLIM !== "0",
    home: (process.env.ECHOSENSE_HOME ?? "home").toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    endpoint: process.env.SLIM_ENDPOINT || void 0,
    listen: process.env.SLIM_LISTEN ?? "127.0.0.1:46357",
    secret: process.env.SLIM_SECRET ?? "echosense-witness-local-secret-0123456789",
    log: (line) => console.log(`[witness] ${line}`)
  });
  council = new Council({
    bus,
    notifier,
    llm,
    publish: (msg, from) => toConsoles({ type: "board", msg, from }),
    askPhones: (incidentId, reason, urgent, seconds) => {
      for (const n of nodes.values()) if (n.info.online !== false) send(n.ws, { type: "ask", incidentId, reason, urgent, seconds });
    },
    clearPhones: () => {
      for (const n of nodes.values()) if (n.info.online !== false) send(n.ws, { type: "respond", answer: "ok" });
    },
    urgentMs: Number(process.env.ECHOSENSE_URGENT_SECONDS ?? 25) * 1e3,
    speechStatus: () => stt.status,
    budget,
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || void 0,
    tellPhones: (text) => {
      for (const n of nodes.values()) if (n.info.online !== false) send(n.ws, { type: "notice", text });
    },
    log: (line) => console.log(line),
    askTimeoutMs: Number(process.env.ECHOSENSE_ASK_TIMEOUT ?? 40) * 1e3,
    loadMap: () => {
      try {
        return (0, import_node_fs2.existsSync)(mapFile) ? JSON.parse((0, import_node_fs2.readFileSync)(mapFile, "utf8")) : null;
      } catch {
        return null;
      }
    },
    saveMap: (m) => {
      try {
        (0, import_node_fs2.writeFileSync)(mapFile, JSON.stringify(m, null, 1));
      } catch (e) {
        console.warn("[witness] could not save the room map:", e.message);
      }
    },
    loadMemory: () => {
      try {
        return (0, import_node_fs2.existsSync)(memoryFile) ? JSON.parse((0, import_node_fs2.readFileSync)(memoryFile, "utf8")) : null;
      } catch {
        return null;
      }
    },
    saveMemory: (m) => {
      try {
        (0, import_node_fs2.writeFileSync)(memoryFile, JSON.stringify(m));
      } catch (e) {
        console.warn("[witness] could not save the home memory:", e.message);
      }
    }
  });
  await council.start();
  stt.start();
  if (llm.mode !== "off")
    void checkKey(llm).then((r) => (council.llmHealth = r === "OK" ? "OK" : r.slice(0, 160), console.log(r === "OK" ? "[witness] Claude key check: OK, the agents are live" : `[witness] Claude key check FAILED: ${r}. Agents will use rules until this is fixed.`)));
  setInterval(() => {
    if (consoles.size) toConsoles({ type: "council_status", status: council.status() });
  }, 3e3);
  webexStatus = await notifier.registerWebex(webexSecret);
}
var webexStatus = "";
var answerGroup = null;
async function onAnswerAudio(n, nodeId, pcm, urgent, levelDb) {
  let transcript = "";
  const samples = pcm16ToFloat(pcm);
  const secs = samples.length / 16e3;
  saveAnswer(n.info.name, pcm);
  try {
    transcript = stt.transcribe(samples);
  } catch (e) {
    console.warn("[hub] speech to text failed:", e.message);
  }
  if (!transcript) {
    const why = !stt.ready ? `speech recognition is ${stt.status}` : levelDb !== void 0 && levelDb < -50 ? `the voice was very quiet on that phone (${levelDb} dB); speak closer to it` : `${secs.toFixed(1)} s clip${levelDb !== void 0 ? ` at ${levelDb} dB` : ""}, no words found`;
    console.log(`[hub] ${n.info.name}: no words recognised (${why}). Clip saved in .voice/answers`);
  } else console.log(`[hub] ${n.info.name} heard "${transcript}"${levelDb !== void 0 ? ` at ${levelDb} dB` : ""}`);
  const clip = { n, nodeId, transcript, levelDb: levelDb ?? -60, urgent };
  if (!answerGroup) answerGroup = { clips: [], timer: setTimeout(() => void judgeAnswers(), 2500) };
  answerGroup.clips.push(clip);
}
async function judgeAnswers() {
  const group = answerGroup;
  answerGroup = null;
  if (!group) return;
  const t0 = Date.now();
  const heard = group.clips.filter((c) => c.transcript.trim());
  const words = (c) => stripPromptEcho(c.transcript).split(" ").filter(Boolean).length;
  const loudest = Math.max(-99, ...heard.map((c) => c.levelDb));
  const best = heard.filter((c) => c.levelDb >= loudest - 8).sort((a, b) => words(b) - words(a) || b.levelDb - a.levelDb)[0];
  const cry = heard.find((c) => saysHelpOutright(c.transcript));
  const chosen = cry ?? best;
  const urgent = group.clips.some((c) => c.urgent);
  const transcript = chosen?.transcript ?? "";
  const u = await understand(transcript, llm.mode === "off" ? null : llm, urgent, (use) => {
    if (use.input_tokens || use.output_tokens) {
      budget.add(use);
      return true;
    }
    return budget.canSpend();
  });
  const others = group.clips.filter((c) => c !== chosen).map((c) => `${c.n.info.name}: "${c.transcript || "(no words)"}"`);
  console.log(`[hub] answer from ${group.clips.length} phone(s): "${transcript}" (${chosen?.n.info.name ?? "none"}) -> ${u.answer} (${u.by}, ${Date.now() - t0} ms)`);
  for (const c of group.clips) send(c.n.ws, { type: "heard", answer: u.answer, transcript, by: u.by });
  council.note(
    `${group.clips.length > 1 ? `${group.clips.length} phones heard the answer; ${cry ? "a plain call for help" : "the clearest recording"} (${chosen?.n.info.name ?? "none"})` : chosen?.n.info.name ?? group.clips[0].n.info.name} said "${transcript || "(no words recognised)"}": ${u.answer === "ok" ? "they are OK" : u.answer === "help" ? "they want help" : "not clear, asking again"} (understood by ${u.by})${others.length ? `. Also heard: ${others.join("; ")}` : ""}`
  );
  if (u.answer !== "unclear" && chosen) {
    const handled = council.personSaid(chosen.nodeId, chosen.n.info.name, transcript, u.answer, u.injury);
    if (!handled && u.answer === "ok") for (const c of group.clips) send(c.n.ws, { type: "notice", text: "Okay, glad you're OK." });
  }
}
function agentCard(a) {
  return {
    protocolVersion: "0.3.0",
    name: a.title,
    description: a.description,
    version: "1.0.0",
    url: `slim://${a.address}`,
    preferredTransport: "SLIM",
    additionalInterfaces: [{ url: `slim://${a.address}`, transport: "SLIM group session witness/home/board (MLS), A2A Message JSON" }],
    provider: { organization: "EchoSense Witness" },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: a.skills.map((s) => ({ id: s, name: s.replace(/[._]/g, " "), description: `${a.title}: ${s}`, tags: ["home-safety", "witness"] })),
    metadata: { reasoning: a.reasoning ?? "local" }
  };
}
function saveAnswer(phone, b64) {
  try {
    const dir = import_node_path2.default.join(voiceDir, "answers");
    (0, import_node_fs2.mkdirSync)(dir, { recursive: true });
    const pcm = Buffer.from(b64, "base64");
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + pcm.length, 4);
    h.write("WAVEfmt ", 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(16e3, 24);
    h.writeUInt32LE(32e3, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36);
    h.writeUInt32LE(pcm.length, 40);
    (0, import_node_fs2.writeFileSync)(import_node_path2.default.join(dir, `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${phone.replace(/\W+/g, "")}.wav`), Buffer.concat([h, pcm]));
    const files = (0, import_node_fs2.readdirSync)(dir).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 20))) (0, import_node_fs2.rmSync)(import_node_path2.default.join(dir, f), { force: true });
  } catch {
  }
}
function agentDirectory() {
  const info = council.status().bus;
  const channel = info.channel;
  const roles = Object.entries(ROLE_INFO).filter(([id]) => id !== "investigator").map(([id, r]) => ({
    name: `witness.${id}`,
    title: r.title,
    description: r.goal,
    skills: ["evidence.read", "position.post", "negotiate.offer", "negotiate.challenge", "negotiate.concede", "negotiate.accept", "phones.look_again", "cartographer.ask"],
    inputs: ["EvidenceReport[]", "ContextNote", "Position[] (round 1)", "Move[] (the negotiation so far)"],
    outputs: ["Position", "Move (offer, challenge, concede, counter, accept)", "AgentTrace"],
    reasoning: llm.mode === "agent" ? `local position for free; ${llm.model} for its negotiation moves when the agents disagree` : "local, deterministic, free",
    address: `${channel.replace(/\/board$/, "")}/${id}`
  }));
  const phones = [...council.agents.values()].filter((a) => !a.nodeId.startsWith("sim-")).map((a) => ({
    name: `witness.phone.${a.nodeId}`,
    title: a.name,
    description: "Turns its own sonar, sound and motion stream into evidence reports.",
    skills: ["trigger.raise", "evidence.report"],
    outputs: ["EvidenceReport"],
    address: `${channel.replace(/\/board$/, "")}/phone-${a.nodeId}`
  }));
  return {
    protocol: "witness/1",
    transport: info.kind === "slim" ? `AGNTCY SLIM group session ${channel}${info.encrypted ? " (MLS)" : ""}` : `in memory ${channel}`,
    outcomeRule: "escalate if no agent stands down and two or more escalate; stand down if none escalates and two or more stand down; otherwise ask the person",
    messages: "every channel message is an A2A Message (role agent, one data part, contextId = incident id)",
    patterns: "group chat: the incident board and the negotiation (moderated MLS group); broadcast: an agent asks every phone to look again; addressed: one phone",
    agentCards: "/agents/<name>/.well-known/agent-card.json",
    negotiation: "when the role agents disagree they negotiate a plan in up to 3 rounds (offer, challenge, concede, counter, accept); no deal keeps the disagreement on the record and asks the person (no answer calls for help); Claude spend capped at ECHOSENSE_CLAUDE_DAILY_USD a day",
    agents: [
      ...roles,
      {
        name: "witness.cartographer",
        title: "Cartographer",
        description: "Knows the room map. Does not vote; answers where a sound came from and where the person ended up.",
        skills: ["map.locate_source", "map.locate_person"],
        outputs: ["ContextNote"],
        address: `${channel.replace(/\/board$/, "")}/cartographer`
      },
      ...phones.map((p) => ({ ...p, skills: [...p.skills, "look.now"] }))
    ]
  };
}
function onGather(req, res, u) {
  let body = "";
  req.on("data", (c) => body += c);
  req.on("end", () => {
    const params = Object.fromEntries(new URLSearchParams(body));
    const full = `${notifier.cfg.publicUrl}${u.pathname}${u.search}`;
    const sig = req.headers["x-twilio-signature"];
    if (!notifier.verify(full, params, typeof sig === "string" ? sig : void 0)) {
      console.warn("[witness] rejected a key press callback with a bad signature");
      res.writeHead(403);
      res.end();
      return;
    }
    const digit = params.Digits ?? "";
    council.caregiver(u.searchParams.get("incident") ?? "", digit);
    res.writeHead(200, { "content-type": "text/xml" });
    res.end(gatherReply(digit));
  });
}
var webexSecret = process.env.WEBEX_WEBHOOK_SECRET ?? (0, import_node_crypto5.randomBytes)(16).toString("hex");
function onWebex(req, res) {
  let raw = "";
  req.on("data", (c) => raw += c);
  req.on("end", () => {
    const sig = req.headers["x-spark-signature"];
    console.log("[witness] Webex called the hub (a card button was pressed)");
    if (!Notifier.verifyWebex(raw, webexSecret, typeof sig === "string" ? sig : void 0)) {
      console.warn("[witness] Webex call rejected: bad signature (restart the hub so it registers again)");
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end();
    let id = "";
    try {
      id = JSON.parse(raw).data?.id ?? "";
    } catch {
      return;
    }
    void notifier.webexAction(id).then((a) => {
      if (!a) {
        console.warn("[witness] Webex: could not read which button was pressed");
        return;
      }
      console.log(`[witness] Webex: ${a.person} pressed ${a.answer}`);
      council.caregiver(a.incident, a.answer === "on_my_way" ? "1" : "2", a.person);
    });
  });
}
var evalCache = null;
async function runEval() {
  if (evalCache) return evalCache;
  const trials = 40;
  const t = await evaluate(trials);
  console.log("\n" + formatTable(t) + "\n");
  const rows = t.scenarios.map(({ spec, scores }) => ({
    title: spec.title,
    emergency: spec.emergency,
    heldOut: !!spec.heldOut,
    cells: METHODS.map((m) => cell(scores[m], spec.emergency))
  }));
  const totals = METHODS.map((m) => {
    const s = t.totals[m];
    const emerg = s.caught + s.caughtAfterAsk + s.missed;
    return `missed ${s.missed} of ${emerg} falls, ${s.falseAlarms} false alarms in ${s.trials - emerg}, asked ${s.prompts}`;
  });
  evalCache = { rows, totals, trials };
  return evalCache;
}
function send(ws, m) {
  if (ws.readyState === import_websocket.default.OPEN) ws.send(JSON.stringify(m));
}
function toConsoles(m) {
  for (const c of consoles) send(c, m);
}
function nodeList() {
  return [...nodes.values()].map((n) => n.info);
}
function rebalanceBands() {
  const want = args.bands || Math.max(bandCount, Math.min(3, nodes.size));
  if (want === bandCount && [...nodes.values()].every((n) => n.info.bandCount === bandCount)) return;
  bandCount = want;
  const used = /* @__PURE__ */ new Set();
  for (const n of nodes.values()) {
    let idx = n.info.bandIndex;
    if (idx >= bandCount || used.has(idx)) {
      idx = 0;
      while (used.has(idx)) idx++;
    }
    used.add(idx);
    n.info.bandIndex = idx;
    n.info.bandCount = bandCount;
    send(n.ws, { type: "band", bandIndex: idx, bandCount });
  }
  toConsoles({ type: "nodes", nodes: nodeList() });
}
async function forward(name, a) {
  if (!args.webhook || process.env.ECHOSENSE_RAW_ALERTS !== "1" || a.severity !== "critical" && a.severity !== "warning") return;
  const text = `EchoSense, ${name}: ${a.title}. ${a.detail} (${Math.round(a.confidence * 100)}% confidence)`;
  try {
    await fetch(args.webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `content` is read by Discord, `text` by Slack.
      body: JSON.stringify({ content: text, text })
    });
  } catch (e) {
    console.warn("Webhook failed:", e.message);
  }
}
function onConnection(ws) {
  let role = null;
  let nodeId = "";
  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.type === "hello") {
      role = m.role;
      if (role === "console") {
        consoles.add(ws);
        send(ws, { type: "nodes", nodes: nodeList() });
        send(ws, { type: "history", events: history.slice(-100) });
        for (const n of nodes.values()) if (n.last) send(ws, { type: "telemetry", telemetry: n.last });
        send(ws, { type: "board_history", msgs: council.board.slice(-300) });
        send(ws, { type: "council_status", status: council.status() });
        return;
      }
      const prev = m.nodeId ? nodes.get(m.nodeId) : void 0;
      if (prev && prev.info.online === false) {
        nodeId = m.nodeId;
        prev.ws = ws;
        prev.info.online = true;
        prev.info.lastSeen = Date.now();
        if (prev.dropTimer) clearTimeout(prev.dropTimer);
        console.log(`[hub] ${prev.info.name} reconnected`);
        send(ws, { type: "welcome", nodeId, bandIndex: prev.info.bandIndex, bandCount, serverTime: Date.now() });
        send(ws, { type: "caps", stt: stt.ready });
        toConsoles({ type: "nodes", nodes: nodeList() });
        return;
      }
      const num = /^node-(\d+)$/.exec(m.nodeId ?? "");
      if (num) counter = Math.max(counter, Number(num[1]));
      nodeId = m.nodeId && !nodes.has(m.nodeId) ? m.nodeId : `node-${++counter}`;
      const used = new Set([...nodes.values()].map((n) => n.info.bandIndex));
      let idx = 0;
      while (used.has(idx)) idx++;
      const info = {
        nodeId,
        name: `Phone ${nodeId.replace("node-", "")}`,
        device: m.device,
        bandIndex: idx,
        bandCount,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        sim: !!m.sim,
        online: true
      };
      nodes.set(nodeId, { ws, info, last: null, dropTimer: null });
      console.log(`[hub] ${info.name} connected (${m.device}${m.sim ? ", simulated" : ""})`);
      if (args.bands === 0) bandCount = Math.max(bandCount, Math.min(3, nodes.size));
      info.bandIndex = Math.min(info.bandIndex, bandCount - 1);
      info.bandCount = bandCount;
      send(ws, { type: "welcome", nodeId, bandIndex: info.bandIndex, bandCount, serverTime: Date.now() });
      send(ws, { type: "caps", stt: stt.ready });
      rebalanceBands();
      toConsoles({ type: "nodes", nodes: nodeList() });
      return;
    }
    if (m.type === "ping") {
      send(ws, { type: "pong", t: m.t, serverTime: Date.now() });
      return;
    }
    if (role === "node") {
      const n = nodes.get(nodeId);
      if (!n) return;
      n.info.lastSeen = Date.now();
      if (m.type === "telemetry") {
        const tel = { ...m.telemetry, nodeId };
        n.last = tel;
        n.info.sim = tel.sim;
        toConsoles({ type: "telemetry", telemetry: tel });
        if (!tel.sim) council.onTelemetry(nodeId, n.info.name, tel);
      } else if (m.type === "sound") {
        if (!n.info.sim) council.onSound(nodeId, n.info.name, m.sound);
      } else if (m.type === "answer_audio") {
        void onAnswerAudio(n, nodeId, m.pcm, !!m.urgent, m.levelDb);
      } else if (m.type === "event") {
        if (!n.info.sim) council.onAlert(nodeId, n.info.name, m.alert);
        const e = { nodeId, alert: m.alert, name: n.info.name };
        history.push(e);
        if (history.length > 500) history.shift();
        console.log(`[hub] ${n.info.name}: ${m.alert.severity} ${m.alert.title}`);
        toConsoles({ type: "event", ...e });
        void forward(n.info.name, m.alert);
      }
    } else if (role === "console" && m.type === "respond") {
      const n = nodes.get(m.nodeId);
      if (n) send(n.ws, { type: "respond", answer: m.answer });
    } else if (role === "console" && m.type === "council") {
      void onCouncil(ws, m);
    }
  });
  ws.on("close", () => {
    if (role === "console") consoles.delete(ws);
    const n = nodes.get(nodeId);
    if (role === "node" && n?.ws === ws) {
      console.log(`[hub] ${n.info.name} went offline`);
      n.info.online = false;
      toConsoles({ type: "nodes", nodes: nodeList() });
      n.dropTimer = setTimeout(() => {
        if (nodes.get(nodeId) !== n || n.info.online) return;
        console.log(`[hub] ${n.info.name} removed`);
        nodes.delete(nodeId);
        if (nodes.size === 0 && args.bands === 0) bandCount = 1;
        toConsoles({ type: "nodes", nodes: nodeList() });
      }, 12e4);
    }
  });
}
async function onCouncil(ws, m) {
  switch (m.action) {
    case "run_scenario":
      council.runScenario(m.key, m.seed);
      break;
    case "compromise":
      council.setCompromised(m.nodeId, m.on);
      break;
    case "inject_fake":
      council.injectFake(m.nodeId);
      break;
    case "human":
      council.human(m.incidentId, m.answer, "answered at the console");
      break;
    case "mark_place": {
      const r = await council.markPlace(m.name, m.kind);
      send(ws, { type: "map_result", ...r });
      break;
    }
    case "test_webex": {
      const r = await notifier.webex("test", "EchoSense test", "If you can read this, Webex alerts work.", [{ title: "From", value: "the hub console" }], false);
      toConsoles({ type: "board", msg: { type: "action", action: { incidentId: "-", action: "webex", ok: r.ok, detail: `test: ${r.detail}`, t: Date.now() } } });
      break;
    }
    case "label_incident": {
      const rec = council.incidentRecord(m.incidentId);
      let detail;
      if (!rec) detail = "training: that incident is no longer in memory";
      else if (rec.incident.simulated) detail = "training: simulated incidents are not saved, only real ones";
      else {
        (0, import_node_fs2.appendFileSync)(trainingFile, JSON.stringify({ label: m.label, subtype: m.subtype, location: m.location, heldOut: m.heldOut, labelledAt: Date.now(), ...rec }) + "\n");
        const lines = (0, import_node_fs2.readFileSync)(trainingFile, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x));
        const last = new Map(lines.map((x) => [x.incident.id, x.label]));
        const falls = [...last.values()].filter((x) => x === "fall").length;
        detail = `training: saved ${m.subtype.replace(/_/g, " ")} at ${m.location.replace(/_/g, " ")}${m.heldOut ? " (HELD OUT)" : ""}. So far ${falls} falls, ${last.size - falls} not falls.`;
      }
      toConsoles({ type: "board", msg: { type: "action", action: { incidentId: "-", action: "ask_phone", ok: !!rec, detail, t: Date.now() } } });
      break;
    }
    case "test_ask": {
      let n = 0;
      for (const node of nodes.values()) if (node.info.online !== false) {
        send(node.ws, { type: "ask", incidentId: "test", reason: "This is a test of the spoken check-in." });
        n++;
      }
      toConsoles({ type: "board", msg: { type: "action", action: { incidentId: "-", action: "ask_phone", ok: n > 0, detail: n ? `test: asked "Are you OK?" on ${n} phone${n > 1 ? "s" : ""}. Answer out loud; the result shows under Alerts.` : "test: no phone connected", t: Date.now() } } });
      break;
    }
    case "remove_place":
      council.removePlace(m.id);
      break;
    case "label_phone":
      council.labelPhone(m.nodeId, m.label, m.near);
      break;
    case "llm_mode":
      if (!council.setLlmMode(m.mode)) {
        toConsoles({ type: "board", msg: { type: "action", action: { incidentId: "-", action: "ask_phone", ok: false, detail: "Claude needs ANTHROPIC_API_KEY in .env (then restart the hub)", t: Date.now() } } });
      }
      break;
    case "sim_calls":
      council.realCallsForSims = m.on;
      break;
    case "eval": {
      const e = await runEval();
      send(ws, { type: "eval", ...e });
      break;
    }
    case "test_call": {
      const r = await notifier.call("test", "This is an EchoSense test call. Your phone number is set up correctly.");
      toConsoles({ type: "board", msg: { type: "action", action: { incidentId: "-", action: "call", ok: r.ok, detail: `test call: ${r.detail}`, t: Date.now() } } });
      break;
    }
  }
  toConsoles({ type: "council_status", status: council.status() });
}
function lanAddresses() {
  const out = [];
  for (const list of Object.values(import_node_os.default.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}
function selfSigned() {
  const dir = import_node_path2.default.resolve(process.cwd(), "certs");
  const key = import_node_path2.default.join(dir, "echosense-key.pem");
  const cert = import_node_path2.default.join(dir, "echosense-cert.pem");
  if (!(0, import_node_fs2.existsSync)(key) || !(0, import_node_fs2.existsSync)(cert)) {
    (0, import_node_fs2.mkdirSync)(dir, { recursive: true });
    const san = ["DNS:localhost", ...lanAddresses().map((a) => `IP:${a}`)].join(",");
    const base = ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "30", "-subj", "/CN=EchoSense local"];
    try {
      (0, import_node_child_process2.execFileSync)("openssl", [...base, "-addext", `subjectAltName=${san}`], { stdio: "ignore" });
    } catch {
      (0, import_node_child_process2.execFileSync)("openssl", base, { stdio: "ignore" });
    }
  }
  return { key: (0, import_node_fs2.readFileSync)(key), cert: (0, import_node_fs2.readFileSync)(cert) };
}
var server = import_node_http.default.createServer(serveStatic);
var wss = new import_websocket_server.default({ server, path: "/ws" });
wss.on("connection", onConnection);
var secure = null;
var httpsPort = Number(process.env.HTTPS_PORT ?? (args.https && args.port !== 8080 ? args.port : 8443));
if (!process.argv.includes("--no-https")) {
  try {
    secure = import_node_https.default.createServer(selfSigned(), serveStatic);
    new import_websocket_server.default({ server: secure, path: "/ws" }).on("connection", onConnection);
  } catch (e) {
    console.warn("[hub] no local https (openssl missing?):", e.message);
  }
}
var tunnelFile = import_node_path2.default.resolve(process.cwd(), "tunnel-url.txt");
var tunnelSeen = "";
setInterval(() => {
  try {
    if (!(0, import_node_fs2.existsSync)(tunnelFile)) return;
    const url = (0, import_node_fs2.readFileSync)(tunnelFile, "utf8").trim().replace(/\/+$/, "");
    if (!url || url === tunnelSeen) return;
    tunnelSeen = url;
    notifier.cfg.publicUrl = url;
    console.log(`[hub] public link is now ${url}`);
    void notifier.registerWebex(webexSecret).then((st) => {
      webexStatus = st;
      console.log(`[hub] Webex: ${st}`);
    });
  } catch {
  }
}, 3e3);
process.on("unhandledRejection", (e) => console.warn("[hub] background task failed:", e?.message ?? e));
void startAgents().then(() => {
  const port = args.https && args.port === httpsPort ? 8080 : args.port;
  server.listen(port, "0.0.0.0");
  secure?.listen(httpsPort, "0.0.0.0");
  const lan = lanAddresses();
  const lines = [
    "",
    "EchoSense hub is running.",
    "",
    `  Console (this computer):   http://localhost:${port}/console`,
    secure ? `  Phones (same wifi):        ${lan.map((a) => `https://${a}:${httpsPort}/`).join("   ") || `https://<this computer's IP>:${httpsPort}/`}` : "",
    secure ? '                             First time on each phone: tap "Show Details", then "visit this website".' : "",
    secure ? "                             If the phones cannot load it, put the laptop and phones on one phone's Personal Hotspot." : "",
    `  Public link (Webex buttons): run  sh tools/tunnel.sh  in another window`,
    "",
    args.webhook ? "  Agent decisions are posted to your webhook." : "",
    `  Witness agents: ${llm.mode === "off" ? llm.apiKey ? "Claude off (switch it on in the console)" : "rule reasoning (set ANTHROPIC_API_KEY in .env for Claude)" : llm.mode === "agent" ? `local agents; when they disagree they negotiate with Claude (${llm.model}, at most $${budget.dailyUsd.toFixed(2)} a day)` : `Claude ${llm.mode} with ${llm.model}`}`,
    `  Caregiver alerts: ${notifier.describe()}`,
    `  Webex: ${webexStatus}`,
    `  Agent channel: ${(() => {
      const b = council.status().bus;
      return b.kind === "slim" ? `AGNTCY SLIM ${b.channel}${b.encrypted ? ", MLS encrypted" : ""}` : `in memory (${b.channel})`;
    })()}`,
    ""
  ];
  console.log(lines.filter((l, i, a) => l || a[i - 1]).join("\n"));
});
