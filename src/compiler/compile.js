// @ts-check

const {IRGenerator} = require('./irgen');
const {IROptimizer} = require('./iroptimizer');
const JSGenerator = require('./jsgen');
const jsexecute = require('./jsexecute');

const generateIR = (/** @type {import("../engine/thread")} */ thread) => {
    const irGenerator = new IRGenerator(thread);
    const ir = irGenerator.generate();

    const irOptimizer = new IROptimizer(ir);
    irOptimizer.optimize();

    return ir;
};

const compileToSource = (/** @type {import("../engine/thread")} */ thread) => {
    const ir = generateIR(thread);

    const procedures = {};
    const target = thread.target;

    const compileScript = (/** @type {import("./intermediate").IntermediateScript} */ script) => {
        if (script.cachedCompileSource) {
            return script.cachedCompileSource;
        }
        const compiler = new JSGenerator(script, ir, target);
        const source = compiler.compileToSource();
        script.cachedCompileSource = source;
        return source;
    };

    const entry = compileScript(ir.entry);

    for (const procedureVariant of Object.keys(ir.procedures)) {
        procedures[procedureVariant] = compileScript(ir.procedures[procedureVariant]);
    }

    return {
        startingFunction: entry,
        procedures,
        executableHat: ir.entry.executableHat
    };
};

const evaluateSource = (source, bindings) => {
    const procedures = {};
    for (const procedureVariant of Object.keys(source.procedures)) {
        procedures[procedureVariant] = jsexecute.scopedEval(source.procedures[procedureVariant], bindings);
    }
    return {
        startingFunction: jsexecute.scopedEval(source.startingFunction, bindings),
        procedures,
        executableHat: source.executableHat
    };
};

const compile = (/** @type {import("../engine/thread")} */ thread) => {
    const ir = generateIR(thread);
    const procedures = {};
    const target = thread.target;

    const compileScript = (/** @type {import("./intermediate").IntermediateScript} */ script) => {
        if (script.cachedCompileResult) {
            return script.cachedCompileResult;
        }
        const compiler = new JSGenerator(script, ir, target);
        const result = compiler.compile();
        script.cachedCompileResult = result;
        return result;
    };

    const entry = compileScript(ir.entry);
    for (const procedureVariant of Object.keys(ir.procedures)) {
        procedures[procedureVariant] = compileScript(ir.procedures[procedureVariant]);
    }

    return {
        startingFunction: entry,
        procedures,
        executableHat: ir.entry.executableHat
    };
};

compile.toSource = compileToSource;
compile.evaluateSource = evaluateSource;

module.exports = compile;
