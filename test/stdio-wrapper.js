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

    describe('cleanup', () => {
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
