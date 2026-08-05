// @ts-check

const Thread = require('../engine/thread');
const md5 = require('js-md5');
const compile = require('./compile');
const jsexecute = require('./jsexecute');
const {serializeBlocks} = require('../serialization/sb3');

const FORMAT = 'scratch-vm-compiled-project';
const FORMAT_VERSION = 1;
const COMPILER_VERSION = 1;
const RUNTIME_ABI = jsexecute.RUNTIME_ABI;

const invalidArtifact = message => new Error(`Invalid compiled project: ${message}`);

const clone = value => JSON.parse(JSON.stringify(value));

const hashBlocks = blocks => md5(JSON.stringify(serializeBlocks(blocks)[0]));

const isValidBindingName = name => {
    if (typeof name !== 'string' || name.length === 0) return false;
    try {
        // Let the JavaScript parser decide whether this is valid in a parameter binding position.
        Function(`return function (${name}) {}`);
        return true;
    } catch (e) {
        return false;
    }
};

const getRequiredBindings = artifact => artifact.requiredBindings || [];

const validateScript = script => {
    if (!script || typeof script !== 'object') {
        throw invalidArtifact('script must be an object');
    }
    if (typeof script.topBlockId !== 'string') {
        throw invalidArtifact('script.topBlockId must be a string');
    }
    if (typeof script.hatOpcode !== 'string' || !Number.isInteger(script.hatOpcodeIndex) ||
        script.hatOpcodeIndex < 0) {
        throw invalidArtifact('script must have a hat opcode and non-negative opcode index');
    }
    if (typeof script.startingFunction !== 'string') {
        throw invalidArtifact('script.startingFunction must be a string');
    }
    if (!script.procedures || typeof script.procedures !== 'object' || Array.isArray(script.procedures)) {
        throw invalidArtifact('script.procedures must be an object');
    }
    for (const procedureCode of Object.keys(script.procedures)) {
        if (typeof script.procedures[procedureCode] !== 'string') {
            throw invalidArtifact(`procedure ${procedureCode} must be a string`);
        }
    }
    if (typeof script.executableHat !== 'boolean') {
        throw invalidArtifact('script.executableHat must be a boolean');
    }
};

const validate = artifact => {
    if (!artifact || typeof artifact !== 'object') {
        throw invalidArtifact('artifact must be an object');
    }
    if (artifact.format !== FORMAT) {
        throw invalidArtifact(`unsupported format ${artifact.format}`);
    }
    if (artifact.formatVersion !== FORMAT_VERSION) {
        throw invalidArtifact(`unsupported format version ${artifact.formatVersion}`);
    }
    if (artifact.compilerVersion !== COMPILER_VERSION) {
        throw invalidArtifact(`unsupported compiler version ${artifact.compilerVersion}`);
    }
    if (artifact.runtimeABI !== RUNTIME_ABI) {
        throw invalidArtifact(`unsupported runtime ABI ${artifact.runtimeABI}`);
    }
    if (artifact.requiredBindings !== void 0 && !Array.isArray(artifact.requiredBindings)) {
        throw invalidArtifact('requiredBindings must be an array');
    }
    const bindingNames = new Set();
    for (const name of getRequiredBindings(artifact)) {
        if (!isValidBindingName(name)) {
            throw invalidArtifact(`invalid required binding ${name}`);
        }
        if (bindingNames.has(name)) {
            throw invalidArtifact(`duplicate required binding ${name}`);
        }
        bindingNames.add(name);
    }
    if (!Array.isArray(artifact.targets)) {
        throw invalidArtifact('targets must be an array');
    }
    for (const target of artifact.targets) {
        if (!target || typeof target.name !== 'string' || typeof target.isStage !== 'boolean' ||
            typeof target.sourceHash !== 'string' || !Array.isArray(target.scripts)) {
            throw invalidArtifact('target must have a name, isStage flag, source hash, and scripts array');
        }
        for (const script of target.scripts) {
            validateScript(script);
        }
    }
};

const resolveBindings = (artifact, bindings) => {
    validate(artifact);
    if (bindings !== void 0 && (!bindings || typeof bindings !== 'object' || Array.isArray(bindings))) {
        throw invalidArtifact('bindings must be an object');
    }
    const selected = Object.create(null);
    for (const name of getRequiredBindings(artifact)) {
        if (!bindings || !Object.prototype.hasOwnProperty.call(bindings, name)) {
            throw invalidArtifact(`required binding ${name} is missing`);
        }
        selected[name] = bindings[name];
    }
    return selected;
};

const findRuntimeTarget = (runtime, targetArtifact) => (
    targetArtifact.isStage ?
        runtime.getTargetForStage() :
        runtime.getSpriteTargetByName(targetArtifact.name)
);

const validateForRuntime = (runtime, artifact) => {
    validate(artifact);
    if (artifact.targets.length !== runtime.executableTargets.length) {
        throw invalidArtifact('artifact targets do not match the loaded project');
    }
    const matchedTargets = new Set();
    for (const targetArtifact of artifact.targets) {
        const target = findRuntimeTarget(runtime, targetArtifact);
        if (!target || target.isStage !== targetArtifact.isStage || target.getName() !== targetArtifact.name ||
            matchedTargets.has(target)) {
            throw invalidArtifact(`target ${targetArtifact.name} does not match the loaded project`);
        }
        matchedTargets.add(target);
        if (hashBlocks(target.blocks._blocks) !== targetArtifact.sourceHash) {
            throw invalidArtifact(`source for target ${targetArtifact.name} does not match`);
        }
    }
};

const addReferencedInputBlocks = (originalBlocks, strippedBlocks, block) => {
    for (const input of Object.values(block.inputs || {})) {
        if (!Array.isArray(input)) continue;
        for (let i = 1; i < input.length; i++) {
            const blockId = input[i];
            if (typeof blockId !== 'string' || !originalBlocks[blockId]) continue;
            const inputBlock = clone(originalBlocks[blockId]);
            if (!Array.isArray(inputBlock)) {
                inputBlock.next = null;
                inputBlock.inputs = {};
            }
            strippedBlocks[blockId] = inputBlock;
        }
    }
};

/**
 * Remove script bodies from serialized SB3 project JSON while preserving enough hat metadata to start compiled code.
 * The passed artifact is bound to the resulting runtime project.
 * @param {object} project Parsed SB3 project.json.
 * @param {object} artifact Compiled project artifact.
 * @returns {string} Serialized source-stripped project.json.
 */
const createRuntimeProject = (project, artifact) => {
    validate(artifact);
    project = clone(project);

    for (const targetArtifact of artifact.targets) {
        const target = project.targets.find(candidate =>
            candidate.isStage === targetArtifact.isStage && candidate.name === targetArtifact.name
        );
        if (!target) {
            throw invalidArtifact(`target ${targetArtifact.name} does not exist in project metadata`);
        }

        const originalBlocks = target.blocks;
        const strippedBlocks = {};
        for (const script of targetArtifact.scripts) {
            const matchingHats = Object.entries(originalBlocks)
                .filter(([, block]) => !Array.isArray(block) && block.topLevel && block.opcode === script.hatOpcode);
            const match = matchingHats[script.hatOpcodeIndex];
            const topBlockId = match && match[0];
            const originalHat = match && match[1];
            if (!originalHat || Array.isArray(originalHat)) {
                throw invalidArtifact(`hat ${script.hatOpcode} does not exist on target ${targetArtifact.name}`);
            }
            const hat = clone(originalHat);
            hat.next = null;
            strippedBlocks[topBlockId] = hat;
            addReferencedInputBlocks(originalBlocks, strippedBlocks, hat);
        }
        target.blocks = strippedBlocks;
        target.comments = {};
    }

    const runtimeProject = JSON.stringify(project);
    artifact.runtimeProjectHash = md5(runtimeProject);
    return runtimeProject;
};

const validateRuntimeProject = (runtimeProject, artifact) => {
    validate(artifact);
    if (typeof artifact.runtimeProjectHash !== 'string') {
        throw invalidArtifact('runtime project hash is missing');
    }
    if (md5(runtimeProject) !== artifact.runtimeProjectHash) {
        throw invalidArtifact('runtime project does not match compiled code');
    }
};

/**
 * Compile all hat scripts in a loaded project into a JSON-serializable artifact.
 * @param {import('../engine/runtime')} runtime Runtime containing the loaded project.
 * @returns {object} Compiled project artifact.
 */
const create = runtime => {
    const targets = [];

    for (const target of runtime.executableTargets) {
        const scripts = [];
        const hatOpcodeCounts = {};
        for (const topBlockId of target.blocks.getScripts()) {
            const topBlock = target.blocks.getBlock(topBlockId);
            if (!topBlock || !runtime.getIsHat(topBlock.opcode)) {
                continue;
            }

            const thread = new Thread(topBlockId);
            thread.target = target;
            thread.blockContainer = target.blocks;
            const source = compile.toSource(thread);
            const hatOpcodeIndex = hatOpcodeCounts[topBlock.opcode] || 0;
            hatOpcodeCounts[topBlock.opcode] = hatOpcodeIndex + 1;
            scripts.push(Object.assign({
                topBlockId,
                hatOpcode: topBlock.opcode,
                hatOpcodeIndex
            }, source));
        }
        targets.push({
            name: target.getName(),
            isStage: target.isStage,
            sourceHash: hashBlocks(target.blocks._blocks),
            scripts
        });
    }

    return {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        compilerVersion: COMPILER_VERSION,
        runtimeABI: RUNTIME_ABI,
        compilerOptions: {
            warpTimer: runtime.compilerOptions.warpTimer
        },
        requiredBindings: [],
        targets
    };
};

/**
 * Load trusted compiled code into the caches of an already loaded project.
 * The artifact contains executable JavaScript and must not come from an untrusted source.
 * @param {import('../engine/runtime')} runtime Runtime containing the corresponding project.
 * @param {object} artifact Compiled project artifact.
 * @param {object} [options] Internal loading options.
 * @param {boolean} [options.skipSourceHash] Skip full source validation for a verified source-stripped package.
 * @param {object} [options.bindings] Runtime values for artifact.requiredBindings.
 */
const load = (runtime, artifact, options) => {
    validate(artifact);
    const bindings = resolveBindings(artifact, options && options.bindings);

    // Evaluate and validate everything before changing any caches.
    const pending = [];
    for (const targetArtifact of artifact.targets) {
        const target = findRuntimeTarget(runtime, targetArtifact);
        if (!target) {
            throw invalidArtifact(`target ${targetArtifact.name} does not exist`);
        }
        const sourceHash = hashBlocks(target.blocks._blocks);
        if (!(options && options.skipSourceHash) && sourceHash !== targetArtifact.sourceHash) {
            throw invalidArtifact(`source for target ${targetArtifact.name} does not match`);
        }
        for (const script of targetArtifact.scripts) {
            const matchingHats = target.blocks.getScripts()
                .map(blockId => target.blocks.getBlock(blockId))
                .filter(block => block && block.opcode === script.hatOpcode);
            const topBlock = matchingHats[script.hatOpcodeIndex];
            if (!topBlock) {
                throw invalidArtifact(`hat ${script.hatOpcode} does not exist on target ${targetArtifact.name}`);
            }
            pending.push({
                blocks: target.blocks,
                topBlockId: topBlock.id,
                result: compile.evaluateSource(script, bindings)
            });
        }
    }

    for (const item of pending) {
        item.blocks.cacheCompileResult(item.topBlockId, item.result);
    }
};

module.exports = {
    FORMAT,
    FORMAT_VERSION,
    COMPILER_VERSION,
    RUNTIME_ABI,
    create,
    createRuntimeProject,
    getRequiredBindings,
    load,
    resolveBindings,
    validate,
    validateForRuntime,
    validateRuntimeProject
};
