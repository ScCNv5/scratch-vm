// @ts-check

const {IRGenerator} = require('./irgen');
const {IROptimizer} = require('./iroptimizer');
const JSGenerator = require('./jsgen');

const generateIR = (/** @type {import("../engine/thread")} */ thread) => {
    const irGenerator = new IRGenerator(thread);
    const ir = irGenerator.generate();

    const irOptimizer = new IROptimizer(ir);
    irOptimizer.optimize();

    return ir;
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
        yields: ir.entry.yields,
        procedures,
        executableHat: ir.entry.executableHat
    };
};

// Build tools consume the optimized graph without evaluating generated JavaScript.
compile.toIR = generateIR;

module.exports = compile;
