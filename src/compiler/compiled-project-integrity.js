// @ts-check

let TextEncoderImplementation;
if (typeof TextEncoder === 'undefined') {
    TextEncoderImplementation = require('text-encoding').TextEncoder;
} else {
    TextEncoderImplementation = TextEncoder;
}

const {sha256Hex} = require('../util/sha256');

const MANIFEST_PATH = 'compiled-project.integrity.json';
const FORMAT = 'scratch-vm-compiled-project-integrity';
const FORMAT_VERSION = 1;
const FIXED_DATE = new Date(1591657163000);

const invalidPackage = message => new Error(`Invalid compiled project package: ${message}`);
const encode = value => new TextEncoderImplementation().encode(value);

const canonicalize = value => {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw invalidPackage('manifest contains a non-finite number');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
            .join(',')}}`;
    }
    throw invalidPackage('manifest contains a non-JSON value');
};

const validatePath = path => {
    if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\') ||
        path.split('/').some(part => part === '' || part === '.' || part === '..')) {
        throw invalidPackage(`unsafe file path ${path}`);
    }
};

const toInputBytes = async input => {
    if (input && typeof input.arrayBuffer === 'function') {
        return new Uint8Array(await input.arrayBuffer());
    }
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return null;
};

// JSZip intentionally sanitizes relative paths and exposes files by name, which can hide duplicate central-directory
// entries. Inspect names before loading so malformed archives cannot become an apparently valid manifest input.
const validateArchivePaths = async input => {
    const bytes = await toInputBytes(input);
    if (!bytes || bytes.byteLength < 22) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let endOffset = -1;
    const minimumOffset = Math.max(0, bytes.byteLength - 65557);
    for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset--) {
        if (view.getUint32(offset, true) === 0x06054b50) {
            endOffset = offset;
            break;
        }
    }
    if (endOffset === -1) return;
    const entryCount = view.getUint16(endOffset + 10, true);
    let offset = view.getUint32(endOffset + 16, true);
    if (entryCount === 0xffff || offset === 0xffffffff) return;
    const names = new Set();
    for (let index = 0; index < entryCount; index++) {
        if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
            throw invalidPackage('invalid zip central directory');
        }
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const nameEnd = offset + 46 + nameLength;
        if (nameEnd > bytes.byteLength) throw invalidPackage('invalid zip file name');
        let name = '';
        for (let position = offset + 46; position < nameEnd; position++) {
            name += String.fromCharCode(bytes[position]);
        }
        validatePath(name.endsWith('/') ? name.slice(0, -1) : name);
        if (names.has(name)) throw invalidPackage(`duplicate file path ${name}`);
        names.add(name);
        offset = nameEnd + extraLength + commentLength;
    }
};

const getFiles = zip => {
    const paths = [];
    for (const path of Object.keys(zip.files)) {
        const file = zip.files[path];
        const originalPath = file.unsafeOriginalName || path;
        validatePath(originalPath);
        if (originalPath !== path) throw invalidPackage(`unsafe file path ${originalPath}`);
        if (!file.dir && path !== MANIFEST_PATH) paths.push(path);
    }
    return paths.sort();
};

const getReferencedResources = project => {
    const result = new Set();
    for (const target of project.targets || []) {
        for (const item of [...(target.costumes || []), ...(target.sounds || [])]) {
            const path = item.md5ext || (item.assetId && item.dataFormat ? `${item.assetId}.${item.dataFormat}` : null);
            if (path) result.add(path);
        }
    }
    for (const font of project.customFonts || []) {
        if (!font.system && typeof font.md5ext === 'string') result.add(font.md5ext);
    }
    return result;
};

const validateResources = (projectJSON, fileNames) => {
    let project;
    try {
        project = JSON.parse(projectJSON);
    } catch (error) {
        throw invalidPackage(`invalid project.json: ${error.message}`);
    }
    const files = new Set(fileNames);
    for (const path of getReferencedResources(project)) {
        validatePath(path);
        if (!files.has(path)) throw invalidPackage(`referenced resource ${path} is missing`);
    }
};

const unsignedManifest = manifest => ({
    format: manifest.format,
    formatVersion: manifest.formatVersion,
    hashAlgorithm: manifest.hashAlgorithm,
    files: manifest.files
});

const validateManifestShape = manifest => {
    if (!manifest || typeof manifest !== 'object' || manifest.format !== FORMAT ||
        manifest.formatVersion !== FORMAT_VERSION || manifest.hashAlgorithm !== 'sha256' ||
        !Array.isArray(manifest.files)) {
        throw invalidPackage('unsupported integrity manifest');
    }
    const expectedKeys = manifest.signature === void 0 ?
        ['files', 'format', 'formatVersion', 'hashAlgorithm'] :
        ['files', 'format', 'formatVersion', 'hashAlgorithm', 'signature'];
    if (Object.keys(manifest).sort()
        .join(',') !== expectedKeys.sort()
        .join(',')) {
        throw invalidPackage('integrity manifest contains unknown fields');
    }
    let previousPath = null;
    for (const file of manifest.files) {
        if (!file || typeof file !== 'object' ||
            Object.keys(file).sort()
                .join(',') !== 'path,sha256,size') {
            throw invalidPackage('invalid integrity file entry');
        }
        validatePath(file.path);
        if (file.path <= previousPath) throw invalidPackage('integrity file entries must be unique and sorted');
        previousPath = file.path;
        if (!Number.isSafeInteger(file.size) || file.size < 0 ||
            typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
            throw invalidPackage(`invalid integrity metadata for ${file.path}`);
        }
    }
    if (manifest.signature !== void 0) {
        const signature = manifest.signature;
        if (!signature || typeof signature !== 'object' || typeof signature.algorithm !== 'string' ||
            signature.algorithm.length === 0 || typeof signature.value !== 'string' || signature.value.length === 0 ||
            (signature.keyId !== void 0 && typeof signature.keyId !== 'string')) {
            throw invalidPackage('invalid integrity signature');
        }
        const signatureKeys = signature.keyId === void 0 ? ['algorithm', 'value'] : ['algorithm', 'keyId', 'value'];
        if (Object.keys(signature).sort()
            .join(',') !== signatureKeys.sort()
            .join(',')) {
            throw invalidPackage('integrity signature contains unknown fields');
        }
    }
};

const createManifest = async (zip, options) => {
    if (zip.file(MANIFEST_PATH)) throw invalidPackage(`reserved file ${MANIFEST_PATH} already exists`);
    const paths = getFiles(zip);
    for (const path of paths) validatePath(path);
    const projectFile = zip.file('project.json');
    if (!projectFile) throw invalidPackage('project.json is missing');
    const projectJSON = await projectFile.async('string');
    validateResources(projectJSON, paths);

    const files = [];
    for (const path of paths) {
        const data = await zip.file(path).async('uint8array');
        files.push({path, size: data.byteLength, sha256: sha256Hex(data)});
    }
    const manifest = {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        hashAlgorithm: 'sha256',
        files
    };
    const payload = encode(canonicalize(manifest));
    if (options && options.signManifest !== void 0 && typeof options.signManifest !== 'function') {
        throw invalidPackage('signManifest must be a function');
    }
    if (options && options.signManifest) {
        const signature = await options.signManifest({payload, manifest: JSON.parse(JSON.stringify(manifest))});
        manifest.signature = signature;
    }
    validateManifestShape(manifest);
    zip.file(MANIFEST_PATH, canonicalize(manifest), {date: FIXED_DATE, compression: 'DEFLATE'});
    return manifest;
};

const validate = async (zip, options) => {
    const manifestFile = zip.file(MANIFEST_PATH);
    if (!manifestFile) {
        if (options && (options.requireIntegrity || options.requireSignature)) {
            throw invalidPackage('integrity manifest is required');
        }
        return null;
    }

    let manifest;
    try {
        manifest = JSON.parse(await manifestFile.async('string'));
    } catch (error) {
        throw invalidPackage(`invalid integrity manifest JSON: ${error.message}`);
    }
    validateManifestShape(manifest);
    const actualPaths = getFiles(zip);
    const expectedPaths = manifest.files.map(file => file.path);
    if (actualPaths.length !== expectedPaths.length ||
        actualPaths.some((path, index) => path !== expectedPaths[index])) {
        throw invalidPackage('integrity file list does not match package contents');
    }
    const projectFile = zip.file('project.json');
    if (!projectFile) throw invalidPackage('project.json is missing');
    validateResources(await projectFile.async('string'), actualPaths);

    for (const expected of manifest.files) {
        const data = await zip.file(expected.path).async('uint8array');
        if (data.byteLength !== expected.size || sha256Hex(data) !== expected.sha256) {
            throw invalidPackage(`integrity check failed for ${expected.path}`);
        }
    }

    if (manifest.signature) {
        if (!options || typeof options.verifyIntegritySignature !== 'function') {
            throw invalidPackage('integrity signature verifier is required');
        }
        const unsigned = unsignedManifest(manifest);
        const payload = encode(canonicalize(unsigned));
        const verified = await options.verifyIntegritySignature({
            payload,
            manifest: JSON.parse(JSON.stringify(unsigned)),
            signature: JSON.parse(JSON.stringify(manifest.signature))
        });
        if (!verified) throw invalidPackage('integrity signature is invalid');
    } else if (options && options.requireSignature) {
        throw invalidPackage('integrity signature is required');
    }
    return manifest;
};

module.exports = {
    FORMAT,
    FORMAT_VERSION,
    MANIFEST_PATH,
    canonicalize,
    createManifest,
    validateArchivePaths,
    validate
};
