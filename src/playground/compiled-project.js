const JSZip = require('@turbowarp/jszip');
const ScratchStorage = require('scratch-storage');
const ScratchRender = require('scratch-render');
const AudioEngine = require('scratch-audio');
const ScratchSVGRenderer = require('@turbowarp/scratch-svg-renderer');
const VirtualMachine = require('..');

const sourceFileInput = document.querySelector('#source-file');
const packageFileInput = document.querySelector('#package-file');
const compileButton = document.querySelector('#compile');
const useGeneratedButton = document.querySelector('#use-generated');
const greenFlagButton = document.querySelector('#green-flag');
const stopButton = document.querySelector('#stop');
const downloadLink = document.querySelector('#download');
const compileStatus = document.querySelector('#compile-status');
const playerStatus = document.querySelector('#player-status');

let sourceFile = null;
let generatedPackage = null;
let generatedPackageName = 'compiled-project.sb3c';
let downloadURL = null;

const compilerVM = new VirtualMachine();
compilerVM.attachStorage(new ScratchStorage());
compilerVM.setCompilerOptions({enabled: true});

const playerVM = new VirtualMachine();
playerVM.attachStorage(new ScratchStorage());
const canvas = document.querySelector('#scratch-stage');
playerVM.attachRenderer(new ScratchRender(canvas));
playerVM.attachAudioEngine(new AudioEngine());
playerVM.attachV2BitmapAdapter(new ScratchSVGRenderer.BitmapAdapter());
playerVM.start();

const setStatus = (element, message, type) => {
    element.textContent = message;
    element.className = `status${type ? ` ${type}` : ''}`;
};

const countRuntimeBlocks = project => project.targets.reduce(
    (total, target) => total + Object.keys(target.blocks || {}).length,
    0
);

const formatBytes = bytes => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
};

const packageBaseName = filename => filename.replace(/\.sb3$/i, '') || 'compiled-project';

const inspectPackage = async data => {
    const zip = await JSZip.loadAsync(data);
    const projectFile = zip.file('project.json');
    const artifactFile = zip.file('compiled-project.json');
    if (!projectFile || !artifactFile) throw new Error('产物缺少 project.json 或 compiled-project.json');
    const [project, artifact] = await Promise.all([
        projectFile.async('string').then(JSON.parse),
        artifactFile.async('string').then(JSON.parse)
    ]);
    return {
        runtimeBlocks: countRuntimeBlocks(project),
        compiledScripts: artifact.targets.reduce((total, target) => total + target.scripts.length, 0)
    };
};

sourceFileInput.addEventListener('change', () => {
    sourceFile = sourceFileInput.files[0] || null;
    document.querySelector('#source-name').textContent = sourceFile ? sourceFile.name : '尚未选择文件';
    compileButton.disabled = !sourceFile;
    setStatus(compileStatus, sourceFile ? '源项目已选择，可以开始编译' : '等待源项目');
});

compileButton.addEventListener('click', async () => {
    if (!sourceFile) return;
    compileButton.disabled = true;
    useGeneratedButton.disabled = true;
    downloadLink.classList.add('disabled');
    setStatus(compileStatus, '正在加载完整 SB3…');
    try {
        await compilerVM.loadProject(await sourceFile.arrayBuffer());
        const sourceBlocks = compilerVM.runtime.targets.reduce(
            (total, target) => total + Object.keys(target.blocks._blocks).length,
            0
        );
        setStatus(compileStatus, '正在编译脚本并移除脚本主体…');
        generatedPackage = await compilerVM.saveCompiledProject('arraybuffer');
        generatedPackageName = `${packageBaseName(sourceFile.name)}.sb3c`;
        const inspection = await inspectPackage(generatedPackage);

        document.querySelector('#source-blocks').textContent = sourceBlocks;
        document.querySelector('#runtime-blocks').textContent = inspection.runtimeBlocks;
        document.querySelector('#compiled-scripts').textContent = inspection.compiledScripts;
        document.querySelector('#package-size').textContent = formatBytes(generatedPackage.byteLength);
        document.querySelector('#compile-metrics').hidden = false;

        if (downloadURL) URL.revokeObjectURL(downloadURL);
        downloadURL = URL.createObjectURL(new Blob([generatedPackage], {
            type: 'application/x.scratch.compiled-project'
        }));
        downloadLink.setAttribute('href', downloadURL);
        downloadLink.setAttribute('download', generatedPackageName);
        downloadLink.classList.remove('disabled');
        useGeneratedButton.disabled = false;
        setStatus(compileStatus, '完成：产物已生成，原始脚本主体未写入包内', 'success');
    } catch (error) {
        generatedPackage = null;
        setStatus(compileStatus, `失败：${error.message}`, 'error');
    } finally {
        compileButton.disabled = !sourceFile;
    }
});

const loadPlayerPackage = async (data, name) => {
    greenFlagButton.disabled = true;
    stopButton.disabled = true;
    setStatus(playerStatus, '正在验证产物并载入独立 VM…');
    try {
        playerVM.stopAll();
        await playerVM.loadCompiledProjectPackage(data);
        document.querySelector('#package-name').textContent = name;
        greenFlagButton.disabled = false;
        stopButton.disabled = false;
        setStatus(playerStatus, '载入完成：播放器只持有编译代码与运行元数据', 'success');
    } catch (error) {
        setStatus(playerStatus, `载入失败：${error.message}`, 'error');
    }
};

useGeneratedButton.addEventListener('click', () => {
    if (generatedPackage) loadPlayerPackage(generatedPackage, generatedPackageName);
});

packageFileInput.addEventListener('change', async () => {
    const file = packageFileInput.files[0];
    if (file) loadPlayerPackage(await file.arrayBuffer(), file.name);
});

greenFlagButton.addEventListener('click', () => {
    playerVM.greenFlag();
    setStatus(playerStatus, '运行中：已触发绿旗', 'success');
});

stopButton.addEventListener('click', () => {
    playerVM.stopAll();
    setStatus(playerStatus, '已停止；可再次点击绿旗运行');
});

const postPointerData = (event, isDown) => {
    const rect = canvas.getBoundingClientRect();
    playerVM.postIOData('mouse', {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        canvasWidth: rect.width,
        canvasHeight: rect.height,
        isDown
    });
};

canvas.addEventListener('mousemove', event => postPointerData(event));
canvas.addEventListener('mousedown', event => postPointerData(event, true));
canvas.addEventListener('mouseup', event => postPointerData(event, false));

document.addEventListener('keydown', event => {
    if (event.target === document.body) {
        playerVM.postIOData('keyboard', {keyCode: event.keyCode, isDown: true});
    }
});
document.addEventListener('keyup', event => {
    playerVM.postIOData('keyboard', {keyCode: event.keyCode, isDown: false});
});

window.addEventListener('beforeunload', () => {
    if (downloadURL) URL.revokeObjectURL(downloadURL);
});
