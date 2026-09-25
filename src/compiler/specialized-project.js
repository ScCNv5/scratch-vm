const Thread = require('../engine/thread');
const compile = require('./compile');
const BlocksRuntimeCache = require('../engine/blocks-runtime-cache');

// Deliberately omit optimizer caches (which contain back references) and live VM objects.
const copyIR = value => {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'function' || typeof value === 'symbol') {
            throw new Error('Specialized build input must not contain executable values');
        }
        return value;
    }
    if (Array.isArray(value)) return value.map(copyIR);
    const result = {};
    for (const key of Object.keys(value)) {
        if (key.startsWith('cached') || key === 'entryState' || key === 'exitState') continue;
        result[key] = copyIR(value[key]);
    }
    return result;
};

const create = vm => {
    const runtime = vm.runtime;
    const targets = [];
    const originals = runtime.targets.filter(target => target.isOriginal);
    for (let index = 0; index < originals.length; index++) {
        const target = originals[index];
        const scripts = [];
        target.blocks.resetCache();
        for (const id of target.blocks.getScripts()) {
            const block = target.blocks.getBlock(id);
            if (!block || !runtime.getIsHat(block.opcode)) continue;
            const thread = new Thread(id);
            thread.target = target;
            thread.blockContainer = target.blocks;
            const ir = compile.toIR(thread);
            scripts.push({
                hat: block.opcode,
                fields: Object.fromEntries(Object.entries(
                    new BlocksRuntimeCache._RuntimeScriptCache(target.blocks, id).fieldsOfInputs
                ).map(([key, field]) => [key, field.value])),
                metadata: copyIR(runtime._hats[block.opcode]),
                ir: copyIR(ir)
            });
        }
        targets.push({index, name: target.getName(), isStage: target.isStage, scripts});
    }
    const project = JSON.parse(vm.toJSON());
    // The regular serializer only writes layerOrder when a renderer is attached.
    // Build frontends are headless, but executable target order is also the
    // Scratch 2 broadcast/clone scheduling order and must survive serialization.
    if (!runtime.renderer) {
        project.targets.forEach((target, index) => {
            target.layerOrder = runtime.executableTargets.indexOf(originals[index]);
        });
    }
    const usedKeys = new Set();
    for (const target of project.targets) {
        for (const block of Object.values(target.blocks)) {
            if (block.opcode === 'event_whenkeypressed' || (block.opcode === 'sensing_keyoptions' && block.parent)) {
                usedKeys.add(block.fields.KEY_OPTION[0]);
            }
        }
    }
    let gamepadSettings = null;
    for (const comment of Object.values(project.targets.find(target => target.isStage).comments || {})) {
        const magic = ' // _gamepad_';
        const line = comment.text.split('\n').find(item => item.endsWith(magic));
        if (!line) continue;
        try {
            const value = JSON.parse(line.slice(0, -magic.length));
            if (value && Array.isArray(value.buttons) && Array.isArray(value.axes)) gamepadSettings = value;
        } catch (error) {
            throw new Error(`Invalid gamepad settings: ${error.message}`);
        }
        break;
    }
    for (const target of project.targets) {
        target.blocks = {};
        target.comments = {};
    }
    delete project.meta;
    return {
        format: 'scratch-specialized-build',
        version: 1,
        compilerOptions: {warpTimer: runtime.compilerOptions.warpTimer},
        targets,
        project,
        extensions: Array.from(vm.extensionManager._loadedExtensions.keys()),
        addons: {usedKeys: [...usedKeys], gamepadSettings},
        extensionURLs: copyIR(project.extensionURLs || {})
    };
};

module.exports = {create, copyIR};
