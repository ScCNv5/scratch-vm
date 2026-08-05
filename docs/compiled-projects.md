# Compiled projects

Compiled project packages are source-stripped, read-only project archives. They retain runtime state and assets, but
replace script bodies and custom block definitions with compiled JavaScript factories. Hat blocks and the minimum input
metadata needed for event matching remain in `project.json`.

Compiled artifacts contain executable JavaScript. Only load artifacts and packages produced by a trusted compiler.
The legacy `sourceHash` and `runtimeProjectHash` checks bind the artifact to its source graph and stripped
`project.json`; they do not cover the whole archive or authenticate a publisher. New packages therefore include a
SHA-256 integrity manifest by default.

## Create a transportable artifact

After loading a project and all of its extensions, enable the compiler and export the artifact:

```js
vm.setCompilerOptions({enabled: true});
await vm.loadProject(sb3Data);

const artifact = vm.exportCompiledProject();
const serialized = JSON.stringify(artifact);
```

Protection pipelines which derive build material from project metadata should use the paired export. Both values are
clones, and `project` is the complete, unstripped `project.json` object:

```js
const {artifact, project} = vm.exportCompiledProjectBuildInput();
```

Artifacts may declare external values required by transformed compiled code in a top-level `requiredBindings` array.
Native VM exports use an empty array. A loader must provide every declared value through the `bindings` option:

```js
playerVM.loadCompiledProject(artifact, {
    bindings: {
        __vmAccess: accessor
    }
});
```

Bindings are trusted runtime dependencies, not a sandbox boundary. The VM injects only names declared by the artifact;
other properties in the supplied object are ignored.

The receiving VM must first load the matching full project before loading this artifact:

```js
await playerVM.loadProject(sb3Data);
playerVM.loadCompiledProject(JSON.parse(serialized));
```

The loader validates the format version, compiler version, runtime ABI, targets, and serialized block graph before
installing any compiled functions.

## Create a source-stripped package

Use `saveCompiledProject()` when the player should not receive the original block graph:

```js
const packageData = await vm.saveCompiledProject('arraybuffer');
```

By default this also creates `compiled-project.integrity.json`. Its sorted SHA-256 entries cover every final package
file other than the manifest itself. Packaging fails if a costume, sound, or custom-font reference is missing from the
archive. Use `{integrity: false}` only when intentionally creating a legacy-compatible package without a manifest.

The resulting zip contains:

- `project.json` with runtime state, assets metadata, extension dependencies, and minimal hat metadata;
- `compiled-project.json` with compiled script factories and compatibility metadata;
- the same costume, sound, and font assets as the source project.

Load it using the dedicated package API:

```js
await playerVM.loadCompiledProjectPackage(packageData);
playerVM.greenFlag();
```

If a deployment requires a manifest and publisher signature, provide asynchronous signing and verification adapters:

```js
const packageData = await vm.saveCompiledProject('arraybuffer', {
    artifact,
    integrity: {signManifest}
});

await playerVM.loadCompiledProjectPackage(packageData, {
    bindings,
    requireIntegrity: true,
    requireSignature: true,
    verifyIntegritySignature
});
```

`signManifest({payload, manifest})` returns `{algorithm, keyId, value}`. `payload` is the canonical UTF-8 manifest
without `signature`. A signed package is always rejected when no verifier is supplied, even when signature enforcement
was not explicitly requested. Manifest, file, or signature failures happen before project state is changed.

An external compiler transform can be packaged without rebuilding the original scripts:

```js
const artifact = vm.exportCompiledProject();
const transformed = transformCompiledArtifact(artifact);
const packageData = await vm.saveCompiledProject('arraybuffer', {
    artifact: transformed
});
```

The supplied artifact must match the currently loaded project, compiler format, and runtime ABI. Packages whose artifact
declares runtime bindings must receive them before any project state is installed:

```js
await playerVM.loadCompiledProjectPackage(packageData, {
    bindings: {
        __vmAccess: accessor
    }
});
```

The package loader verifies the metadata before modifying the VM, loads required extensions, enables compiled
execution, installs every compiled script, and only then emits `PROJECT_LOADED`.

This format removes the original Scratch block source but does not make client-side behavior impossible to reverse
engineer. Generated JavaScript, literal values, runtime calls, and extension implementations remain observable to the
client.

## Try the two-stage playground

Run `npm start`, then open `http://localhost:8073/playground/compiled-project.html`. The left side loads a full SB3 and creates a
source-stripped `.sb3c` package. The right side uses a separate VM to load and run either the in-memory result or a
previously downloaded package, which models the compiler and player as separate processes.
