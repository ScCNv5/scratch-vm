const {test} = require('tap');
const BlockType = require('../../src/extension-support/block-type');
const Runtime = require('../../src/engine/runtime');
const {createOpcodeIdMap, getOpcodeId} = require('../../src/util/opcode-id');

test('opcode ID derivation matches fixed SHA-256 vectors', t => {
    t.equal(getOpcodeId('looks_say', 'release-2026'), 241901085521657);
    t.equal(getOpcodeId('testbuiltin_test', 'abc'), 168049635399280);
    t.equal(getOpcodeId('音乐_播放', '盐'), 244155180237300);
    t.not(getOpcodeId('looks_say', 'other-release'), getOpcodeId('looks_say', 'release-2026'));
    t.end();
});

test('opcode ID maps reject truncated hash collisions', t => {
    t.throws(
        () => createOpcodeIdMap(['first', 'second'], 'salt', () => 7),
        /Opcode ID collision between "first" and "second"/
    );
    t.end();
});

test('runtime resolves opcode IDs and preserves the legacy lookup', t => {
    const runtime = new Runtime();
    const salt = 'runtime-test';
    const opcode = 'looks_say';
    const expected = runtime.getOpcodeFunction(opcode);

    t.type(expected, 'function');
    t.equal(runtime.getOpcodeFunctionById(getOpcodeId(opcode, salt), salt), expected);
    t.equal(runtime.getOpcodeFunctionById(Number.MAX_SAFE_INTEGER, salt), undefined);
    t.throws(() => runtime.getOpcodeFunctionById(-1, salt), TypeError);
    t.throws(() => runtime.getOpcodeFunctionById(1.5, salt), TypeError);
    t.throws(() => runtime.getOpcodeFunctionById(1, ''), TypeError);
    t.throws(() => runtime.getOpcodeFunctionById(1, null), TypeError);
    t.end();
});

test('extension registration invalidates opcode ID lookup cache', t => {
    const runtime = new Runtime();
    const salt = 'extension-cache';
    runtime.getOpcodeFunctionById(getOpcodeId('looks_say', salt), salt);
    const implementation = () => 'extension result';

    runtime._registerExtensionPrimitives({
        id: 'opcodeidtest',
        name: 'Opcode ID Test',
        blocks: [{
            opcode: 'run',
            blockType: BlockType.REPORTER,
            text: 'run',
            func: implementation
        }],
        menus: {},
        customFieldTypes: {}
    });

    const resolved = runtime.getOpcodeFunctionById(getOpcodeId('opcodeidtest_run', salt), salt);
    t.equal(resolved, implementation);
    t.equal(resolved(), 'extension result');
    t.end();
});
