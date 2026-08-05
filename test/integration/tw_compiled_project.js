const fs = require('fs');
const path = require('path');
const {test} = require('tap');
const JSZip = require('@turbowarp/jszip');

const VM = require('../../src/virtual-machine');
const JSGenerator = require('../../src/compiler/jsgen');
const BlockType = require('../../src/extension-support/block-type');
const makeTestStorage = require('../fixtures/make-test-storage');

const makeVM = () => {
    const vm = new VM();
    vm.attachStorage(makeTestStorage());
    return vm;
};

const fixture = fs.readFileSync(path.join(
    __dirname,
    '..',
    'fixtures',
    'execute',
    'tw-simple-string-operations.sb3'
));
const extensionFixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'tw-add-builtin-extension.sb3'));
const broadcastFixture = fs.readFileSync(path.join(
    __dirname,
    '..',
    'fixtures',
    'execute',
    'tw-broadcast-id-and-name-desync.sb3'
));

class TestBuiltinExtension {
    getInfo () {
        return {
            id: 'testbuiltin',
            name: 'Test Builtin',
            blocks: [{
                opcode: 'test',
                blockType: BlockType.REPORTER,
                text: 'test'
            }]
        };
    }

    test () {
        return 'extension result';
    }
}

const addRequiredBinding = artifact => {
    artifact.requiredBindings = ['__testBinding'];
    for (const target of artifact.targets) {
        for (const script of target.scripts) {
            script.startingFunction = `__testBinding(typeof __notDeclared, ${script.startingFunction})`;
            for (const procedureCode of Object.keys(script.procedures)) {
                script.procedures[procedureCode] =
                    `__testBinding(typeof __notDeclared, ${script.procedures[procedureCode]})`;
            }
        }
    }
    return artifact;
};

test('compiled projects survive JSON serialization and load without recompiling', async t => {
    const compilerVM = makeVM();
    compilerVM.setCompilerOptions({enabled: true, warpTimer: false});
    await compilerVM.loadProject(fixture);

    const artifact = JSON.parse(JSON.stringify(compilerVM.exportCompiledProject()));
    t.equal(artifact.format, 'scratch-vm-compiled-project');
    t.equal(artifact.formatVersion, 1);
    t.equal(artifact.compilerVersion, 1);
    t.equal(artifact.runtimeABI, 1);
    t.ok(artifact.targets.some(target => target.scripts.length > 0), 'contains compiled scripts');

    const playerVM = makeVM();
    playerVM.setCompilerOptions({enabled: true, warpTimer: false});
    await playerVM.loadProject(fixture);
    t.not(
        compilerVM.runtime.executableTargets[0].id,
        playerVM.runtime.executableTargets[0].id,
        'artifact does not rely on process-local target IDs'
    );
    playerVM.loadCompiledProject(artifact);

    const originalCompileToSource = JSGenerator.prototype.compileToSource;
    JSGenerator.prototype.compileToSource = () => {
        throw new Error('script was unexpectedly recompiled');
    };
    t.teardown(() => {
        JSGenerator.prototype.compileToSource = originalCompileToSource;
        compilerVM.quit();
        playerVM.quit();
    });

    const threads = playerVM.runtime.startHats('event_whenflagclicked');
    t.ok(threads.length > 0, 'green flag scripts started');
    t.ok(threads.every(thread => thread.isCompiled), 'all scripts used the loaded compiled artifact');
});

test('compiled protection build input contains independent artifact and full project clones', async t => {
    const vm = makeVM();
    vm.setCompilerOptions({enabled: true});
    await vm.loadProject(fixture);
    const first = vm.exportCompiledProjectBuildInput();
    const second = vm.exportCompiledProjectBuildInput();

    t.equal(first.artifact.format, 'scratch-vm-compiled-project');
    t.ok(first.project.targets.some(target => Object.keys(target.blocks).length > 1), 'project retains block sources');
    first.artifact.targets[0].name = 'changed artifact';
    first.project.targets[0].name = 'changed project';
    t.not(second.artifact.targets[0].name, 'changed artifact', 'artifact is cloned');
    t.not(second.project.targets[0].name, 'changed project', 'project is cloned');
    vm.quit();
});

test('compiled project loader rejects incompatible ABI without changing caches', async t => {
    const vm = makeVM();
    vm.setCompilerOptions({enabled: true});
    await vm.loadProject(fixture);

    const artifact = vm.exportCompiledProject();
    artifact.runtimeABI++;

    for (const target of vm.runtime.executableTargets) {
        target.blocks.resetCache();
    }

    t.throws(
        () => vm.loadCompiledProject(artifact),
        /unsupported runtime ABI/,
        'rejects an incompatible runtime ABI'
    );
    for (const target of vm.runtime.executableTargets) {
        for (const topBlockId of target.blocks.getScripts()) {
            t.equal(target.blocks.getCachedCompileResult(topBlockId), null, 'cache was not changed');
        }
    }
    vm.quit();
});

test('compiled project loader injects only declared runtime bindings into every factory', async t => {
    const compilerVM = makeVM();
    compilerVM.setCompilerOptions({enabled: true, warpTimer: false});
    await compilerVM.loadProject(fixture);
    const artifact = addRequiredBinding(compilerVM.exportCompiledProject());
    const sourceCount = artifact.targets.reduce((total, target) => total + target.scripts.reduce(
        (scriptTotal, script) => scriptTotal + 1 + Object.keys(script.procedures).length,
        0
    ), 0);

    const playerVM = makeVM();
    playerVM.setCompilerOptions({enabled: true, warpTimer: false});
    await playerVM.loadProject(fixture);
    let bindingCalls = 0;
    let undeclaredWasVisible = false;
    playerVM.loadCompiledProject(artifact, {
        bindings: {
            __testBinding: (undeclaredType, factory) => {
                bindingCalls++;
                undeclaredWasVisible = undeclaredWasVisible || undeclaredType !== 'undefined';
                return factory;
            },
            __notDeclared: true
        }
    });

    t.equal(bindingCalls, sourceCount, 'entry points and procedures received the binding');
    t.equal(undeclaredWasVisible, false, 'undeclared values were not injected');
    const threads = playerVM.runtime.startHats('event_whenflagclicked');
    t.ok(threads.every(thread => thread.isCompiled), 'bound factories execute as compiled scripts');
    compilerVM.quit();
    playerVM.quit();
});

test('compiled project validates binding declarations before changing caches', async t => {
    const compilerVM = makeVM();
    compilerVM.setCompilerOptions({enabled: true});
    await compilerVM.loadProject(fixture);
    const artifact = addRequiredBinding(compilerVM.exportCompiledProject());

    const playerVM = makeVM();
    playerVM.setCompilerOptions({enabled: true});
    await playerVM.loadProject(fixture);
    t.throws(
        () => playerVM.loadCompiledProject(artifact),
        /required binding __testBinding is missing/,
        'missing binding is rejected'
    );
    for (const target of playerVM.runtime.executableTargets) {
        for (const topBlockId of target.blocks.getScripts()) {
            t.equal(target.blocks.getCachedCompileResult(topBlockId), null, 'cache was not changed');
        }
    }

    const invalid = compilerVM.exportCompiledProject();
    invalid.requiredBindings = ['not-valid-name!'];
    t.throws(() => playerVM.loadCompiledProject(invalid), /invalid required binding/);
    invalid.requiredBindings = ['same', 'same'];
    t.throws(() => playerVM.loadCompiledProject(invalid), /duplicate required binding/);
    compilerVM.quit();
    playerVM.quit();
});

test('compiled project calls extensions provided by the player runtime', async t => {
    const compilerVM = makeVM();
    compilerVM.setCompilerOptions({enabled: true});
    compilerVM.extensionManager.addBuiltinExtension('testbuiltin', TestBuiltinExtension);
    await compilerVM.loadProject(extensionFixture);

    const artifact = JSON.parse(JSON.stringify(compilerVM.exportCompiledProject()));

    const playerVM = makeVM();
    playerVM.setCompilerOptions({enabled: true});
    playerVM.extensionManager.addBuiltinExtension('testbuiltin', TestBuiltinExtension);
    await playerVM.loadProject(extensionFixture);
    playerVM.loadCompiledProject(artifact);

    let said;
    playerVM.runtime.on('SAY', (target, type, text) => {
        said = text;
    });
    playerVM.greenFlag();
    playerVM.runtime._step();

    t.equal(said, 'extension result', 'extension implementation was resolved in the player VM');
    compilerVM.quit();
    playerVM.quit();
});

test('compiled project package removes script bodies and runs without recompiling', async t => {
    const compilerVM = makeVM();
    compilerVM.setCompilerOptions({enabled: true});
    compilerVM.extensionManager.addBuiltinExtension('testbuiltin', TestBuiltinExtension);
    await compilerVM.loadProject(extensionFixture);

    const packageData = await compilerVM.saveCompiledProject('nodebuffer');
    const zip = await JSZip.loadAsync(packageData);
    const project = JSON.parse(await zip.file('project.json').async('string'));
    const sprite = project.targets.find(target => !target.isStage);
    const opcodes = Object.values(sprite.blocks)
        .filter(block => !Array.isArray(block))
        .map(block => block.opcode);
    t.same(opcodes, ['event_whenflagclicked'], 'only the hat remains in project metadata');
    t.notOk(JSON.stringify(project).includes('looks_say'), 'script body is absent');
    t.ok(zip.file('compiled-project.json'), 'package contains compiled code');
    const manifest = JSON.parse(await zip.file('compiled-project.integrity.json').async('string'));
    t.equal(manifest.format, 'scratch-vm-compiled-project-integrity');
    t.same(
        manifest.files.map(file => file.path),
        manifest.files.map(file => file.path).slice()
            .sort(),
        'integrity entries are sorted'
    );

    const playerVM = makeVM();
    playerVM.extensionManager.addBuiltinExtension('testbuiltin', TestBuiltinExtension);
    let projectLoadedWithCompiledScripts = false;
    playerVM.runtime.on('PROJECT_LOADED', () => {
        projectLoadedWithCompiledScripts = playerVM.runtime.executableTargets.every(target =>
            target.blocks.getScripts().every(topBlockId => target.blocks.getCachedCompileResult(topBlockId))
        );
    });
    await playerVM.loadCompiledProjectPackage(packageData);
    t.equal(playerVM.runtime.compilerOptions.enabled, true, 'compiled execution was enabled');
    t.equal(projectLoadedWithCompiledScripts, true, 'PROJECT_LOADED was emitted after compiled scripts were ready');

    const originalCompileToSource = JSGenerator.prototype.compileToSource;
    JSGenerator.prototype.compileToSource = () => {
        throw new Error('script was unexpectedly recompiled');
    };
    t.teardown(() => {
        JSGenerator.prototype.compileToSource = originalCompileToSource;
        compilerVM.quit();
        playerVM.quit();
    });

    let said;
    playerVM.runtime.on('SAY', (target, type, text) => {
        said = text;
    });
    playerVM.greenFlag();
    playerVM.runtime._step();
    t.equal(said, 'extension result', 'compiled extension script ran from stripped package');
});

test('compiled package integrity and signatures are checked before VM state changes', async t => {
    const compilerVM = makeVM();
    compilerVM.setCompilerOptions({enabled: true});
    await compilerVM.loadProject(fixture);

    const deterministicArtifact = compilerVM.exportCompiledProject();
    const unsignedPackage = await compilerVM.saveCompiledProject('nodebuffer', {artifact: deterministicArtifact});
    const unsignedAgain = await compilerVM.saveCompiledProject('nodebuffer', {artifact: deterministicArtifact});
    t.same(unsignedPackage, unsignedAgain, 'default integrity packages are deterministic');

    const legacyPackage = await compilerVM.saveCompiledProject('nodebuffer', {integrity: false});
    const legacyPlayer = makeVM();
    await legacyPlayer.loadCompiledProjectPackage(legacyPackage);
    const strictLegacyPlayer = makeVM();
    await t.rejects(
        strictLegacyPlayer.loadCompiledProjectPackage(legacyPackage, {requireIntegrity: true}),
        /integrity manifest is required/
    );
    t.equal(strictLegacyPlayer.runtime.targets.length, 0, 'legacy policy failure is atomic');

    const unsignedStrictPlayer = makeVM();
    await t.rejects(
        unsignedStrictPlayer.loadCompiledProjectPackage(unsignedPackage, {requireSignature: true}),
        /integrity signature is required/
    );

    const signManifest = ({payload}) => ({
        algorithm: 'test-bytes-v1',
        keyId: 'test-key',
        value: Buffer.from(payload).toString('base64')
    });
    const signedPackage = await compilerVM.saveCompiledProject('nodebuffer', {integrity: {signManifest}});
    const missingVerifier = makeVM();
    await t.rejects(
        missingVerifier.loadCompiledProjectPackage(signedPackage),
        /signature verifier is required/
    );
    t.equal(missingVerifier.runtime.targets.length, 0, 'missing verifier failure is atomic');

    const rejectingVerifier = makeVM();
    await t.rejects(
        rejectingVerifier.loadCompiledProjectPackage(signedPackage, {
            verifyIntegritySignature: () => false
        }),
        /integrity signature is invalid/
    );
    const signedPlayer = makeVM();
    await signedPlayer.loadCompiledProjectPackage(signedPackage, {
        requireIntegrity: true,
        requireSignature: true,
        verifyIntegritySignature: ({payload, signature}) =>
            signature.algorithm === 'test-bytes-v1' &&
            signature.keyId === 'test-key' &&
            signature.value === Buffer.from(payload).toString('base64')
    });
    t.ok(signedPlayer.runtime.targets.length > 0, 'valid signed package loads');

    const tamperedZip = await JSZip.loadAsync(unsignedPackage);
    tamperedZip.file('compiled-project.json', '{}');
    const tamperedPackage = await tamperedZip.generateAsync({type: 'nodebuffer'});
    const tamperedPlayer = makeVM();
    await t.rejects(
        tamperedPlayer.loadCompiledProjectPackage(tamperedPackage),
        /integrity check failed for compiled-project.json/
    );
    t.equal(tamperedPlayer.runtime.targets.length, 0, 'file tampering failure is atomic');

    const extraZip = await JSZip.loadAsync(unsignedPackage);
    extraZip.file('unlisted.txt', 'extra');
    const extraPlayer = makeVM();
    await t.rejects(
        extraPlayer.loadCompiledProjectPackage(await extraZip.generateAsync({type: 'nodebuffer'})),
        /file list does not match package contents/
    );

    const resourceZip = await JSZip.loadAsync(unsignedPackage);
    const resourcePath = Object.keys(resourceZip.files).find(name => /\.(?:svg|png|wav)$/.test(name));
    resourceZip.file(resourcePath, 'tampered resource');
    const resourcePlayer = makeVM();
    await t.rejects(
        resourcePlayer.loadCompiledProjectPackage(await resourceZip.generateAsync({type: 'nodebuffer'})),
        new RegExp(`integrity check failed for ${resourcePath.replace('.', '\\.')}`)
    );

    const removedZip = await JSZip.loadAsync(unsignedPackage);
    removedZip.remove(resourcePath);
    const removedPlayer = makeVM();
    await t.rejects(
        removedPlayer.loadCompiledProjectPackage(await removedZip.generateAsync({type: 'nodebuffer'})),
        /file list does not match package contents/
    );

    for (const vm of [
        compilerVM,
        legacyPlayer,
        strictLegacyPlayer,
        unsignedStrictPlayer,
        missingVerifier,
        rejectingVerifier,
        signedPlayer,
        tamperedPlayer,
        extraPlayer,
        resourcePlayer,
        removedPlayer
    ]) vm.quit();
});

test('default integrity packaging rejects missing referenced resources', async t => {
    const vm = new VM();
    vm.setCompilerOptions({enabled: true});
    await vm.loadProject(fixture);
    await t.rejects(vm.saveCompiledProject('nodebuffer'), /referenced resource .* is missing/);
    vm.quit();
});

test('externally transformed artifacts can be packaged and require bindings before project load', async t => {
    const compilerVM = makeVM();
    compilerVM.setCompilerOptions({enabled: true, warpTimer: false});
    await compilerVM.loadProject(fixture);
    const artifact = addRequiredBinding(compilerVM.exportCompiledProject());
    const packageData = await compilerVM.saveCompiledProject('nodebuffer', {artifact});

    const missingBindingVM = makeVM();
    await t.rejects(
        missingBindingVM.loadCompiledProjectPackage(packageData),
        /required binding __testBinding is missing/,
        'missing package binding is rejected'
    );
    t.equal(missingBindingVM.runtime.targets.length, 0, 'package rejection did not modify the VM');

    const playerVM = makeVM();
    let bindingCalls = 0;
    await playerVM.loadCompiledProjectPackage(packageData, {
        bindings: {
            __testBinding: (_undeclaredType, factory) => {
                bindingCalls++;
                return factory;
            }
        }
    });
    t.ok(bindingCalls > 0, 'package factories received their binding');
    const threads = playerVM.runtime.startHats('event_whenflagclicked');
    t.ok(threads.every(thread => thread.isCompiled), 'packaged external artifact executes');

    const mismatched = compilerVM.exportCompiledProject();
    mismatched.targets[0].sourceHash = 'not-the-project-hash';
    t.throws(
        () => compilerVM.saveCompiledProject('nodebuffer', {artifact: mismatched}),
        /source for .* does not match/,
        'mismatched source cannot be packaged'
    );
    const incompatible = compilerVM.exportCompiledProject();
    incompatible.runtimeABI++;
    t.throws(
        () => compilerVM.saveCompiledProject('nodebuffer', {artifact: incompatible}),
        /unsupported runtime ABI/,
        'incompatible artifact cannot be packaged'
    );

    compilerVM.quit();
    missingBindingVM.quit();
    playerVM.quit();
});

test('compiled project loader accepts legacy artifacts without requiredBindings', async t => {
    const compilerVM = makeVM();
    compilerVM.setCompilerOptions({enabled: true});
    await compilerVM.loadProject(fixture);
    const artifact = compilerVM.exportCompiledProject();
    delete artifact.requiredBindings;

    const playerVM = makeVM();
    playerVM.setCompilerOptions({enabled: true});
    await playerVM.loadProject(fixture);
    playerVM.loadCompiledProject(artifact);
    const threads = playerVM.runtime.startHats('event_whenflagclicked');
    t.ok(threads.every(thread => thread.isCompiled), 'legacy artifact loaded');
    compilerVM.quit();
    playerVM.quit();
});

const runCompiledFixture = async fixtureData => {
    const compilerVM = makeVM();
    compilerVM.setCompilerOptions({enabled: true, warpTimer: false});
    await compilerVM.loadProject(fixtureData);
    const packageData = await compilerVM.saveCompiledProject('nodebuffer');

    const playerVM = makeVM();
    await playerVM.loadCompiledProjectPackage(packageData);
    const messages = [];
    playerVM.runtime.on('SAY', (target, type, text) => {
        messages.push(text);
    });
    playerVM.greenFlag();
    for (let i = 0; i < 100 && !messages.includes('end'); i++) {
        playerVM.runtime._step();
    }

    compilerVM.quit();
    playerVM.quit();
    return {messages, packageData};
};

test('compiled package runs custom procedures after definitions are removed', async t => {
    const {messages, packageData} = await runCompiledFixture(fixture);
    const zip = await JSZip.loadAsync(packageData);
    const projectJSON = await zip.file('project.json').async('string');
    t.notOk(projectJSON.includes('procedures_definition'), 'procedure definitions are absent');
    t.same(messages, ['plan 1', 'pass', 'end'], 'compiled procedure executed successfully');
});

test('compiled package preserves broadcast hat matching metadata', async t => {
    const {messages, packageData} = await runCompiledFixture(broadcastFixture);
    const zip = await JSZip.loadAsync(packageData);
    const project = JSON.parse(await zip.file('project.json').async('string'));
    const opcodes = Object.values(project.targets.find(target => !target.isStage).blocks)
        .filter(block => !Array.isArray(block))
        .map(block => block.opcode);
    t.ok(opcodes.includes('event_whenbroadcastreceived'), 'broadcast hat metadata remains');
    t.same(messages, ['plan 1', 'pass', 'end'], 'broadcast started the compiled receiver');
});

test('compiled package rejects mismatched runtime metadata before loading', async t => {
    const compilerVM = makeVM();
    compilerVM.setCompilerOptions({enabled: true});
    await compilerVM.loadProject(fixture);
    const packageData = await compilerVM.saveCompiledProject('nodebuffer');
    const zip = await JSZip.loadAsync(packageData);
    const projectFile = zip.file('project.json');
    const projectJSON = (await projectFile.async('string')).replace('Sprite1', 'Changed Sprite');
    zip.file('project.json', projectJSON);
    const tamperedPackage = await zip.generateAsync({type: 'nodebuffer'});

    const playerVM = makeVM();
    await t.rejects(
        playerVM.loadCompiledProjectPackage(tamperedPackage),
        /integrity check failed for project.json/,
        'mismatched metadata is rejected'
    );
    t.equal(playerVM.runtime.targets.length, 0, 'the player VM was not modified');
    compilerVM.quit();
    playerVM.quit();
});
