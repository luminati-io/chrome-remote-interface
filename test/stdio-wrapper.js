'use strict';

const assert = require('assert');
const { PassThrough } = require('stream');

const StdioWrapper = require('../lib/stdio-wrapper');

function createMockStreams(highWaterMark = 64) {
    const pipeWrite = new PassThrough({ highWaterMark });
    const pipeRead = new PassThrough();
    return { pipeWrite, pipeRead };
}

describe('StdioWrapper', () => {
    describe('send/receive', () => {
        it('should write with null terminator and receive messages', (done) => {
            const { pipeWrite, pipeRead } = createMockStreams();
            const wrapper = new StdioWrapper(pipeWrite, pipeRead);
            const chunks = [];
            const messages = [];

            pipeWrite.on('data', chunk => chunks.push(chunk));
            wrapper.on('message', msg => messages.push(msg));

            wrapper.on('open', () => {
                wrapper.send('outgoing', (err) => {
                    assert.ifError(err);
                    assert.strictEqual(Buffer.concat(chunks).toString(), 'outgoing\0');
                });

                pipeRead.write(Buffer.from('incoming1\0incoming2\0'));
                setImmediate(() => {
                    assert.deepStrictEqual(messages, ['incoming1', 'incoming2']);
                    wrapper.close(() => done());
                });
            });
        });

        it('should handle split messages across chunks', (done) => {
            const { pipeWrite, pipeRead } = createMockStreams();
            const wrapper = new StdioWrapper(pipeWrite, pipeRead);

            wrapper.on('message', (msg) => {
                assert.strictEqual(msg, 'split message');
                wrapper.close(() => done());
            });

            wrapper.on('open', () => {
                pipeRead.write(Buffer.from('split '));
                pipeRead.write(Buffer.from('message\0'));
            });
        });
    });

    describe('backpressure', () => {
        it('should queue during backpressure, flush on drain, and emit drain time', (done) => {
            const { pipeWrite, pipeRead } = createMockStreams(4);
            const wrapper = new StdioWrapper(pipeWrite, pipeRead);
            const chunks = [];
            const drainTimes = [];

            pipeWrite.on('data', chunk => chunks.push(chunk));
            wrapper.on('stdio_drain_time', (duration) => {
                drainTimes.push(duration);
            });

            // Simulate backpressure - return false on second write (null terminator of msg1)
            // _writeMessage does: write(message) + write('\0'), returns result of second write
            const originalWrite = pipeWrite.write.bind(pipeWrite);
            let writeCount = 0;
            pipeWrite.write = (data, ...args) => {
                writeCount++;
                originalWrite(data, ...args);
                return writeCount !== 2; // Second write (null terminator) triggers backpressure
            };

            wrapper.on('open', () => {
                const callbacks = [];
                wrapper.send('msg1', () => callbacks.push(1));
                wrapper.send('msg2', () => callbacks.push(2));
                wrapper.send('msg3', () => {
                    callbacks.push(3);
                    setImmediate(() => {
                        const data = Buffer.concat(chunks).toString();
                        assert(data.includes('msg1\0'), 'msg1 missing');
                        assert(data.includes('msg2\0'), 'msg2 missing');
                        assert(data.includes('msg3\0'), 'msg3 missing');
                        assert.deepStrictEqual(callbacks, [1, 2, 3]);
                        // Should have emitted drain time
                        assert.strictEqual(drainTimes.length, 1, 'should emit stdio_drain_time once');
                        assert(typeof drainTimes[0] === 'number', 'drain time should be a number');
                        assert(drainTimes[0] >= 0, 'drain time should be non-negative');
                        wrapper.close(() => done());
                    });
                });

                setImmediate(() => pipeWrite.emit('drain'));
            });
        });
    });

    describe('cleanup', () => {
        it('should fail queued callbacks and remove listeners on close', (done) => {
            const { pipeWrite, pipeRead } = createMockStreams(4);
            const wrapper = new StdioWrapper(pipeWrite, pipeRead);
            const errors = [];

            // Simulate backpressure - return false on second write (null terminator of msg1)
            // _writeMessage does: write(message) + write('\0'), returns result of second write
            const originalWrite = pipeWrite.write.bind(pipeWrite);
            let writeCount = 0;
            pipeWrite.write = (data, ...args) => {
                writeCount++;
                originalWrite(data, ...args);
                return writeCount !== 2; // Second write (null terminator) triggers backpressure
            };

            wrapper.on('open', () => {
                // msg1 writes and triggers backpressure, callback called immediately
                wrapper.send('msg1', err => { if (err) errors.push(err); });
                // msg2 is queued because we're draining
                wrapper.send('msg2', err => { if (err) errors.push(err); });

                wrapper.close(() => {
                    // Queued callback (msg2) should fail
                    assert.strictEqual(errors.length, 1, 'should have 1 error for queued message');
                    assert.strictEqual(errors[0].message, 'CDP pipeWrite closed');
                    // Listeners cleaned up
                    assert.strictEqual(wrapper._eventListeners.length, 0);
                    assert.strictEqual(wrapper._pipeWrite, null);
                    assert.strictEqual(wrapper._pendingMessage, '');
                    // Further sends should fail
                    wrapper.send('after', (err) => {
                        assert(err instanceof Error);
                        done();
                    });
                });
            });
        });

        it('should emit error from pipes', (done) => {
            const { pipeWrite, pipeRead } = createMockStreams();
            const wrapper = new StdioWrapper(pipeWrite, pipeRead);

            wrapper.on('error', (err) => {
                assert.strictEqual(err.message, 'write error');
                wrapper.close(() => done());
            });

            wrapper.on('open', () => {
                pipeWrite.emit('error', new Error('write error'));
            });
        });

        it('should not dispatch messages after close', (done) => {
            const { pipeWrite, pipeRead } = createMockStreams();
            const wrapper = new StdioWrapper(pipeWrite, pipeRead);
            const messages = [];

            wrapper.on('message', msg => messages.push(msg));

            wrapper.on('open', () => {
                pipeRead.write(Buffer.from('before\0'));
                setImmediate(() => {
                    wrapper.close(() => {
                        pipeRead.write(Buffer.from('after\0'));
                        setImmediate(() => {
                            assert.deepStrictEqual(messages, ['before']);
                            done();
                        });
                    });
                });
            });
        });
    });
});
