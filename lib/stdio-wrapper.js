'use strict';

// Adapted from https://github.com/puppeteer/puppeteer/blob/7a2a41f2087b07e8ef1feaf3881bdcc3fd4922ca/src/PipeTransport.js

/**
 * Copyright 2018 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const { EventEmitter } = require('events');

function addEventListener(emitter, eventName, handler) {
    emitter.on(eventName, handler);
    return { emitter, eventName, handler };
}

function removeEventListeners(listeners) {
    for (const listener of listeners)
        listener.emitter.removeListener(listener.eventName, listener.handler);
    listeners.length = 0;
}

// wrapper for null-terminated stdio message transport
class StdioWrapper extends EventEmitter {
    constructor(pipeWrite, pipeRead) {
        super();
        this._pipeWrite = pipeWrite;
        this._pendingMessage = [];
        this._eventListeners = [
            addEventListener(pipeRead, 'data', buffer => this._dispatch(buffer)),
            addEventListener(pipeRead, 'close', () => {
                this._cleanup();
                this.emit('close');
            }),
            addEventListener(pipeRead, 'error', (err) => this.emit('error', err)),
            addEventListener(pipeWrite, 'error', (err) => this.emit('error', err)),
        ];
        setImmediate(() => this.emit('open'));
    }

    send(message, callback) {
        if (!this._pipeWrite) {
            callback(new Error('CDP pipeWrite closed'));
            return;
        }
        this._pipeWrite.cork();
        this._pipeWrite.write(message);
        this._pipeWrite.write('\0');
        this._pipeWrite.uncork();
        callback();
    }

    _cleanup() {
        if (!this._pipeWrite) {
            return;
        }
        this._pipeWrite = null;
        removeEventListeners(this._eventListeners);
        this._pendingMessage = [];
    }

    _dispatch(buffer) {
        this._pendingMessage.push(buffer);
        if (buffer.indexOf('\0') === -1) {
            return;
        }
        const concatBuffer = Buffer.concat(this._pendingMessage);
        let start = 0;
        let end = concatBuffer.indexOf('\0');
        while (end !== -1) {
            const message = concatBuffer.toString(undefined, start, end);
            setImmediate(()=>this.emit('message', message));
            start = end + 1;
            end = concatBuffer.indexOf('\0', start);
        }
        if (start >= concatBuffer.length) {
            this._pendingMessage = [];
        } else {
            this._pendingMessage = [concatBuffer.subarray(start)];
        }
    }

    close(callback) {
        this._cleanup();
        callback();
    }
}

module.exports = StdioWrapper;
