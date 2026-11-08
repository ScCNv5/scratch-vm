/* eslint-disable max-len */
const JSGenerator = require('./jsgen');
const {InputOpcode: I, StackOpcode: S, InputType} = require('./enums');
const {IntermediateInput, IntermediateStack, IntermediateStackBlock} = require('./intermediate');

const quote = JSON.stringify;
const revive = value => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(revive);
    const result = {};
    for (const key of Object.keys(value)) result[key] = revive(value[key]);
    if (typeof result.opcode === 'string') {
        Object.setPrototypeOf(result, typeof result.type === 'number' ?
            IntermediateInput.prototype : IntermediateStackBlock.prototype);
    } else if (Array.isArray(result.blocks)) Object.setPrototypeOf(result, IntermediateStack.prototype);
    return result;
};

// Only this build-time backend sees Scratch procedure names. They never enter the player.
class ContinuationGenerator extends JSGenerator {
    constructor (program, script, ir, target, procedures, entry) {
        super(script, ir, {isStage: target.isStage,
            effects: {
                color: 0, fisheye: 0, whirl: 0, pixelate: 0, mosaic: 0, brightness: 0, ghost: 0
            },
            runtime: {debug: false, sampler: {enableCommands: false}}});
        this.program = program;
        this.targetIndex = target.index;
        this.procedureEntries = procedures;
        this.current = entry;
        this.owner = entry.id;
        entry.owner = entry.id;
        this.slotCount = 0;
        this.lastInLoop = false;
        this.atProcedureEnd = false;
        this.expressionSetups = [];
        this.nativeFrame = null;
        this.nativeDeclarations = null;
        this.nativeIndex = 0;
    }

    block () {
        return this.program.block(this.owner);
    }
    emit (source) {
        this.current.code.push(source);
    }
    slot () {
        return `frame.__spSlots[${this.slotCount++}]`;
    }
    jump (block) {
        this.emit(`frame.__spPC = ${block.id}; continue;`);
    }
    branch (test, yes, no) {
        this.emit(`frame.__spPC = (${test}) ? ${yes.id} : ${no.id}; continue;`);
    }
    evaluateOnce (source) {
        if (this.nativeDeclarations) {
            const name = `__spTemp${this.nativeIndex++}`;
            this.nativeDeclarations.push(name);
            this.expressionSetups.push(`${name} = ${source}`);
            return name;
        }
        const slot = this.slot();
        this.expressionSetups.push(`${slot} = ${source}`);
        return slot;
    }
    referenceVariable (variable) {
        const lookup = `${variable.scope === 'target' ? 'target' : 'stage'}.variables[${quote(variable.id)}]`;
        if (!this.program.variables.has(lookup)) this.program.variables.set(lookup, this.program.variables.size);
        const index = this.program.variables.get(lookup);
        const source = `(variables[${index}] || (variables[${index}] = ${lookup}))`;
        const refs = this.current.references || (this.current.references = new Map());
        if (!refs.has(source)) refs.set(source, `__spV${refs.size}`);
        const initial = variable.scope === 'target' ? this.program.initialTargets[this.targetIndex] : this.program.initialStage;
        if (Object.prototype.hasOwnProperty.call(initial.variables, variable.id) ||
            Object.prototype.hasOwnProperty.call(initial.lists, variable.id)) {
            const valid = this.current.cacheableReferences || (this.current.cacheableReferences = new Set());
            valid.add(refs.get(source));
        }
        return refs.get(source);
    }
    save (source) {
        const slot = this.slot();
        this.emit(`${slot} = ${source};`);
        return slot;
    }
    yieldTo (next, condition = 'true') {
        this.emit(`frame.__spPC = ${next.id}; if (${condition}) return; continue;`);
    }
    loopCondition (forceTimer = false) {
        return this.isWarp ? (this.warpTimer || forceTimer ? 'isStuck()' : 'false') : 'true';
    }

    // Spill inputs in evaluation order whenever a containing expression can suspend.
    // This also prevents a procedure in a later argument from changing an earlier variable read.
    prepare (value) {
        if (!value || typeof value !== 'object') return value;
        if (typeof value.opcode === 'string' && typeof value.type === 'number') {
            const result = Object.assign(Object.create(Object.getPrototypeOf(value)), value);
            result.__spExpression = this.save(this.descendInput(value));
            return result;
        }
        if (value.blocks) return value;
        if (Array.isArray(value)) return value.map(item => this.prepare(item));
        const result = {};
        for (const key of Object.keys(value)) result[key] = this.prepare(value[key]);
        return result;
    }

    canSuspend (value) {
        if (!value || typeof value !== 'object') return false;
        if (value.opcode === I.PROCEDURE_CALL || value.opcode === I.COMPATIBILITY_LAYER ||
            value.opcode === I.ADDON_CALL || value.opcode === I.OLD_COMPILER_COMPATIBILITY_LAYER) return true;
        if ([S.CONTROL_WAIT, S.CONTROL_WAIT_UNTIL, S.EVENT_BROADCAST_AND_WAIT,
            S.PROCEDURE_RETURN, S.CONTROL_STOP_SCRIPT, S.CONTROL_STOP_ALL, S.CONTROL_CLONE_DELETE,
            S.HAT_EDGE, S.HAT_PREDICATE].includes(value.opcode)) return true;
        return Object.values(value).some(item => this.canSuspend(item));
    }

    // Bound expansion and reject recursion, suspension and thread-invalidating
    // effects. Safe warp calls can then stay inside native loops without frames.
    nativeCost (value, visiting = new Set(), allowStop = false) {
        if (!value || typeof value !== 'object') return 0;
        const opcode = value.opcode;
        if (opcode === S.PROCEDURE_CALL) {
            if (typeof value.type === 'number') return Infinity;
            const node = value.inputs;
            const procedure = this.ir.procedures[node.variant];
            if (!procedure || !procedure.stack || !procedure.isWarp || procedure.yields || procedure.warpTimer ||
                visiting.has(node.variant)) return Infinity;
            const nested = new Set(visiting); nested.add(node.variant);
            const cost = this.nativeCost(procedure.stack, nested, true);
            return cost <= 700 ? cost + this.nativeCost(node.arguments, visiting, allowStop) : Infinity;
        }
        if ([I.COMPATIBILITY_LAYER, I.ADDON_CALL, I.OLD_COMPILER_COMPATIBILITY_LAYER,
            S.CONTROL_WAIT, S.CONTROL_WAIT_UNTIL, S.EVENT_BROADCAST, S.EVENT_BROADCAST_AND_WAIT,
            S.PROCEDURE_RETURN, S.CONTROL_STOP_ALL, S.CONTROL_STOP_OTHERS, S.CONTROL_CLONE_DELETE,
            S.HAT_EDGE, S.HAT_PREDICATE].includes(opcode)) return Infinity;
        if (opcode === S.CONTROL_STOP_SCRIPT && !allowStop) return Infinity;
        if (value.warpTimer) return Infinity;
        let cost = opcode ? 1 : 0;
        for (const item of Object.values(value)) {
            cost += this.nativeCost(item, visiting, allowStop);
            if (cost > 6000) return Infinity;
        }
        return cost;
    }

    hasValueReturn (value) {
        return Boolean(value && typeof value === 'object' &&
            (value.opcode === S.PROCEDURE_RETURN || Object.values(value).some(item => this.hasValueReturn(item))));
    }

    nativeRegion (generate) {
        this.source = '';
        this.nativeDeclarations = [];
        generate();
        const declarations = this.nativeDeclarations.length ? `let ${this.nativeDeclarations.join(',')};\n` : '';
        this.emit(`__spCompute: {\n${declarations}${this.source}\n}`);
        this.source = '';
        this.nativeDeclarations = null;
    }

    nativeCall (node) {
        const procedure = this.ir.procedures[node.variant];
        // Snapshot every argument before entering the callee, including unused
        // arguments and values that the callee will subsequently change.
        const args = node.arguments.map(input => {
            const name = `__spArg${this.nativeIndex++}`;
            this.source += `const ${name} = ${this.descendInput(input)};\n`;
            return name;
        });
        const previous = this.nativeFrame;
        const wasWarp = this.isWarp;
        const label = `__spExit${this.nativeIndex++}`;
        this.nativeFrame = {args, label};
        this.isWarp = true;
        this.source += `${label}: {\n`;
        this.descendStack(procedure.stack, {isLoop: false, isLastBlock: false});
        this.source += '}\n';
        this.isWarp = wasWarp;
        this.nativeFrame = previous;
    }

    descendStackedBlock (block) {
        if (this.nativeDeclarations) {
            if (block.opcode === S.PROCEDURE_CALL) {
                this.nativeCall(block.inputs); return;
            }
            if (block.opcode === S.CONTROL_STOP_SCRIPT) {
                this.source += this.nativeFrame ? `break ${this.nativeFrame.label};\n` : this.finishSource();
                return;
            }
        }
        super.descendStackedBlock(block);
    }

    descendInput (input) {
        const previous = this.expressionSetups;
        this.expressionSetups = [];
        const source = this.inputExpression(input);
        const setups = this.expressionSetups;
        this.expressionSetups = previous;
        return setups.length ? `(${setups.join(', ')}, ${source})` : source;
    }

    inputExpression (input) {
        if (input.__spExpression) return input.__spExpression;
        const node = input.inputs;
        if (input.opcode === I.PROCEDURE_ARGUMENT) {
            return this.nativeFrame ?
                this.nativeFrame.args[node.index] : `frame.__spArgs[${node.index}]`;
        }
        if (input.opcode === I.PROCEDURE_CALL) return this.call(node, true);
        if (input.opcode === I.COMPATIBILITY_LAYER) return this.compat(node, false);
        if (input.opcode === I.ADDON_CALL || input.opcode === I.OLD_COMPILER_COMPATIBILITY_LAYER) {
            throw new Error(`Specialized compilation does not support compiler-patching extension node ${input.opcode}`);
        }
        if (this.canSuspend(node)) {
            if (input.opcode === I.OP_AND || input.opcode === I.OP_OR) {
                const value = this.save(this.descendInput(node.left));
                const right = this.block();
                const end = this.block();
                this.branch(value, input.opcode === I.OP_AND ? right : end, input.opcode === I.OP_AND ? end : right);
                this.current = right;
                this.emit(`${value} = ${this.descendInput(node.right)};`);
                this.jump(end);
                this.current = end;
                return value;
            }
            input = Object.assign(Object.create(Object.getPrototypeOf(input)), input, {inputs: this.prepare(node)});
        }
        return super.descendInput(input);
    }

    call (node, reporter) {
        const procedure = this.ir.procedures[node.variant];
        if (!procedure || !procedure.stack) return '""';
        // Stack recursion yields before argument evaluation; reporter recursion after it.
        if (!reporter && Number.isFinite(this.nativeCost({opcode: S.PROCEDURE_CALL, inputs: node}))) {
            this.nativeRegion(() => this.nativeCall(node));
            return '""';
        }
        const yields = (!this.isWarp && node.code === this.script.procedureCode) || (reporter && this.isInHat);
        if (yields && !reporter) {
            const resume = this.block();
            this.yieldTo(resume);
            this.current = resume;
        }
        const spillArguments = this.canSuspend(node.arguments);
        const args = node.arguments.map(arg => (spillArguments ? this.save(this.descendInput(arg)) : this.descendInput(arg)));
        if (!this.program.calls.has(this.owner)) this.program.calls.set(this.owner, new Set());
        this.program.calls.get(this.owner).add(this.procedureEntries[node.variant].id);
        if (!reporter && this.atProcedureEnd && this.isProcedure && this.isWarp && !this.script.yields &&
            procedure.isWarp && !procedure.yields && !this.hasValueReturn(procedure.stack)) {
            // A terminal void warp call can reuse its continuation frame. Evaluate
            // arguments before replacing the caller's slots and parameter array.
            this.emit(`const args = [${args.join(',')}];
                frame.__spArgs = args; frame.__spSlots = [];
                frame.__spPC = ${this.procedureEntries[node.variant].id}; continue;`);
            this.current = this.block();
            return '""';
        }
        const resume = this.block();
        const destination = reporter ? this.slotCount++ : -1;
        this.emit(`frame.__spPC = ${resume.id};
            thread.__spFrames.push({__spPC: ${this.procedureEntries[node.variant].id}, __spSlots: [],
                __spArgs: [${args.join(',')}], __spReturn: ${destination}});
            ${yields && reporter ? 'return;' : 'continue;'}`);
        this.current = resume;
        return reporter ? `frame.__spSlots[${destination}]` : '""';
    }

    finish (value = '""') {
        this.emit(this.finishSource(value));
    }

    finishSource (value = '""') {
        return `__spLeave: { const result = ${value};
            thread.__spFrames.pop();
            if (!thread.__spFrames.length) { this.retireThread(thread); return; }
            if (frame.__spReturn >= 0) thread.__spFrames[thread.__spFrames.length - 1].__spSlots[frame.__spReturn] = result;
            continue __spRun; }`;
    }

    compat (node, setFlags, branchSlot = null) {
        this.program.primitives.add(node.opcode);
        const args = [];
        for (const [key, value] of Object.entries(node.inputs)) {
            args.push(`${quote(key)}: ${this.save(this.descendInput(value))}`);
        }
        for (const [key, value] of Object.entries(node.fields || {})) args.push(`${quote(key)}: ${quote(value)}`);
        const inputs = this.save(`{${args.join(',')}}`);
        const stack = branchSlot ? `${branchSlot}.stackFrame` : this.save('{}');
        const result = this.slot();
        const invoke = this.block();
        const finish = this.block();
        const next = this.block();
        this.jump(invoke);
        this.current = invoke;
        const id = quote(`p${invoke.id}`);
        // The primitive reference is resolved to a static import by the linker.
        this.emit(`const utility = thread.__spUtility || (thread.__spUtility = new SpecializedBlockUtility());
            utility.init(thread, ${id}, ${stack});
            const value = runtime.__spPrimitive(${quote(node.opcode)}, ${inputs}, utility);
            ${branchSlot ? `if (value === undefined && utility._startedBranch) {
                ${result} = utility._startedBranch[0]; ${branchSlot}.isLoop = utility._startedBranch[1];
            } else { ${result} = value; ${branchSlot}.isLoop = ${branchSlot}.defaultIsLoop; }` : `${result} = value;`}
            if (value !== null && typeof value === 'object' && typeof value.then === 'function') {
                frame.__spPC = ${finish.id};
                thread.status = 1;
                const lifetime = thread.__spLifetime;
                const settle = (resolved) => {
                    if (thread.__spLifetime !== lifetime || thread.isKilled || thread.status === 4 || !runtime.isActiveThread(thread)) return;
                    ${result} = resolved;
                    ${setFlags ? 'thread.__spResumedPromise = true;' : ''}
                    thread.status = 0;
                };
                value.then(settle, error => { log.warn('Extension promise rejected', error); settle('' + error); });
                return;
            }
            if (thread.status === 4 || thread.isKilled) return;
            if (thread.status === 1) { frame.__spPC = ${finish.id}; return; }
            if (thread.status === 2 || thread.status === 3) {
                if (thread.status === 3) return;
                thread.status = 0;
                if (${this.isWarp ? 'isStuck()' : 'true'}) return;
                continue;
            }`);
        this.jump(finish);
        this.current = finish;
        this.jump(next);
        this.current = next;
        return result;
    }

    stack (stack, loop = false, tail = false) {
        for (let index = 0; index < stack.blocks.length; index++) {
            // Bound straight-line expansion between commands. A native loop is
            // emitted as one region and never split into per-iteration dispatch.
            if (this.current.code.reduce((length, code) => length + code.length, 0) > 12000) {
                const next = this.block(); this.jump(next); this.current = next;
            }
            const previous = this.lastInLoop;
            const previousTail = this.atProcedureEnd;
            this.lastInLoop = loop && index === stack.blocks.length - 1;
            this.atProcedureEnd = tail && index === stack.blocks.length - 1;
            this.command(stack.blocks[index]);
            this.lastInLoop = previous;
            this.atProcedureEnd = previousTail;
        }
    }

    command (block) {
        const n = block.inputs;
        switch (block.opcode) {
        case S.PROCEDURE_CALL: this.call(n, false); return;
        case S.PROCEDURE_RETURN: this.finish(this.descendInput(n.value)); this.current = this.block(); return;
        case S.CONTROL_STOP_SCRIPT: this.finish(); this.current = this.block(); return;
        case S.CONTROL_STOP_ALL:
            this.emit('runtime.stopAll(); this.retireThread(thread); return;'); this.current = this.block(); return;
        case S.CONTROL_CLONE_DELETE:
            this.emit('if (!target.isOriginal) { runtime.disposeTarget(target); runtime.stopForTarget(target); this.retireThread(thread); return; }'); return;
        case S.HAT_EDGE: case S.HAT_PREDICATE: {
            this.isInHat = true;
            const value = this.save(this.descendInput(n.condition));
            this.isInHat = false;
            if (block.opcode === S.HAT_EDGE) {
                this.emit(`const id = thread.topBlock;
                    const had = target.hasEdgeActivatedValue(id);
                    const old = target.updateEdgeActivatedValue(id, ${value});
                    if (!(had ? !old && ${value} : ${value})) { this.retireThread(thread); return; }`);
            } else this.emit(`if (!${value}) { this.retireThread(thread); return; }`);
            const next = this.block(); this.yieldTo(next); this.current = next; return;
        }
        case S.CONTROL_IF_ELSE: {
            if (this.isWarp && !this.warpTimer && Number.isFinite(this.nativeCost(block, new Set(), true))) {
                this.nativeRegion(() => super.descendStackedBlock(block)); return;
            }
            const condition = this.descendInput(n.condition);
            const yes = this.block(); const no = this.block(); const end = this.block();
            this.branch(condition, yes, no);
            this.current = yes; this.stack(n.whenTrue, false, this.atProcedureEnd); this.jump(end);
            this.current = no; this.stack(n.whenFalse, false, this.atProcedureEnd); this.jump(end);
            this.current = end; return;
        }
        case S.CONTROL_REPEAT: case S.CONTROL_FOR: case S.CONTROL_WHILE: {
            // Preserve continuous warp computation, including safe small calls.
            if (this.isWarp && !this.warpTimer && Number.isFinite(this.nativeCost(block, new Set(), true))) {
                this.nativeRegion(() => super.descendStackedBlock(block)); return;
            }
            const counter = block.opcode === S.CONTROL_WHILE ? null :
                this.save(block.opcode === S.CONTROL_FOR ? '0' : this.descendInput(n.times));
            // A straight-line loop needs one resume region, not test/body/tail
            // dispatches. Preserve exactly the original end-of-iteration yield.
            const structured = [S.CONTROL_IF_ELSE, S.CONTROL_REPEAT, S.CONTROL_FOR, S.CONTROL_WHILE, S.COMPATIBILITY_LAYER];
            if (!this.canSuspend(block) && !n.do.blocks.some(item => structured.includes(item.opcode))) {
                const loop = this.block(); const end = this.block();
                this.jump(loop); this.current = loop;
                const condition = block.opcode === S.CONTROL_WHILE ? this.descendInput(n.condition) :
                    block.opcode === S.CONTROL_FOR ? `${counter} < ${this.descendInput(n.count)}` :
                        `${counter} ${n.times.isAlwaysType(InputType.NUMBER_INT | InputType.NUMBER_INF) ? '> 0' : '>= 0.5'}`;
                this.emit(`if (!(${condition})) { frame.__spPC = ${end.id}; continue; }`);
                if (block.opcode === S.CONTROL_FOR) this.emit(`${counter}++; ${this.referenceVariable(n.variable)}.value = ${counter};`);
                this.stack(n.do, true);
                if (block.opcode === S.CONTROL_REPEAT) this.emit(`${counter}--;`);
                this.yieldTo(loop, this.loopCondition(n.warpTimer));
                this.current = end; return;
            }
            const test = this.block(); const body = this.block(); const tail = this.block(); const end = this.block();
            this.jump(test); this.current = test;
            let condition;
            if (block.opcode === S.CONTROL_WHILE) condition = this.descendInput(n.condition);
            else if (block.opcode === S.CONTROL_FOR) condition = `${counter} < ${this.descendInput(n.count)}`;
            else condition = `${counter} ${n.times.isAlwaysType(InputType.NUMBER_INT | InputType.NUMBER_INF) ? '> 0' : '>= 0.5'}`;
            this.branch(condition, body, end); this.current = body;
            if (block.opcode === S.CONTROL_FOR) this.emit(`${counter}++; ${this.referenceVariable(n.variable)}.value = ${counter};`);
            this.stack(n.do, true); this.jump(tail); this.current = tail;
            if (block.opcode === S.CONTROL_REPEAT) this.emit(`${counter}--;`);
            this.emit(`if (thread.__spResumedPromise) { thread.__spResumedPromise = false; frame.__spPC = ${test.id}; continue; }`);
            this.yieldTo(test, this.loopCondition(n.warpTimer));
            this.current = end; return;
        }
        case S.CONTROL_WAIT: {
            this.emit('thread.timer = timer();');
            const duration = this.save(`Math.max(0, 1000 * ${this.descendInput(n.seconds)})`);
            this.emit('runtime.requestRedraw();');
            const test = this.block(); const end = this.block(); const wait = this.block();
            this.yieldTo(test, this.isWarp ? 'false' : 'true'); this.current = test;
            this.branch(`thread.timer.timeElapsed() < ${duration}`, wait, end);
            this.current = wait; this.yieldTo(test, this.isWarp ? 'isStuck()' : 'true');
            this.current = end; this.emit('thread.timer = null;'); return;
        }
        case S.CONTROL_WAIT_UNTIL: {
            const test = this.block(); const wait = this.block(); const end = this.block();
            this.jump(test); this.current = test;
            this.branch(this.descendInput(n.condition), end, wait);
            this.current = wait; this.yieldTo(test, this.isWarp ? 'isStuck()' : 'true');
            this.current = end; return;
        }
        case S.EVENT_BROADCAST:
            this.emit(`runtime.startHats('event_whenbroadcastreceived', {BROADCAST_OPTION: ${this.descendInput(n.broadcast)}});`); return;
        case S.EVENT_BROADCAST_AND_WAIT: {
            const threads = this.save(`runtime.startHats('event_whenbroadcastreceived', {BROADCAST_OPTION: ${this.descendInput(n.broadcast)}})`);
            const test = this.block(); const end = this.block();
            this.jump(test); this.current = test;
            this.emit(`if (${threads}.some(t => runtime.threads.indexOf(t) !== -1)) {
                if (${threads}.every(t => runtime.isWaitingThread(t))) thread.status = 3;
                return;
            }`);
            this.jump(end); this.current = end; return;
        }
        case S.COMPATIBILITY_LAYER: {
            if (n.blockType === 'conditional' || n.blockType === 'loop') {
                const branch = this.save(`{stackFrame: {}, defaultIsLoop: ${n.blockType === 'loop'}, isLoop: false}`);
                const invoke = this.block(); const end = this.block(); const tail = this.block();
                this.jump(invoke); this.current = invoke;
                const value = this.compat(n, false, branch);
                const cases = [];
                for (const index of Object.keys(n.substacks)) cases.push([Number(index), this.block(), n.substacks[index]]);
                this.emit(`switch (+${value}) {${cases.map(([index, target]) => `case ${index}: frame.__spPC=${target.id}; break;`).join('')}
                    default: frame.__spPC = +${value} ? ${tail.id} : ${end.id}; } continue;`);
                for (const [, target, substack] of cases) {
                    this.current = target; this.stack(substack); this.jump(tail);
                }
                this.current = tail;
                this.emit(`if (!${branch}.isLoop) { frame.__spPC = ${end.id}; continue; }`);
                this.yieldTo(invoke, this.loopCondition());
                this.current = end;
            } else this.compat(n, this.lastInLoop);
            return;
        }
        case S.ADDON_CALL: case S.OLD_COMPILER_COMPATIBILITY_LAYER:
            throw new Error(`Specialized compilation does not support compiler-patching extension node ${block.opcode}`);
        case S.DEBUGGER: return;
        default: {
            if (this.canSuspend(n)) block = Object.assign(Object.create(Object.getPrototypeOf(block)), block, {inputs: this.prepare(n)});
            this.source = '';
            super.descendStackedBlock(block);
            this.emit(this.source); this.source = '';
        }
        }
    }

    generate () {
        if (this.script.stack) {
            if (this.isWarp && !this.warpTimer && !this.script.yields &&
                this.nativeCost(this.script.stack, new Set([this.script.procedureVariant]), true) <= 700) {
                this.nativeRegion(() => {
                    const label = `__spExit${this.nativeIndex++}`;
                    const args = this.script.arguments.map((_, index) => {
                        const name = `__spArg${this.nativeIndex++}`;
                        this.source += `const ${name} = frame.__spArgs[${index}];\n`;
                        return name;
                    });
                    this.nativeFrame = {label, args};
                    this.source += `${label}: {\n`;
                    this.descendStack(this.script.stack, {isLoop: false, isLastBlock: false});
                    this.source += '}\n';
                    this.nativeFrame = null;
                });
            } else this.stack(this.script.stack, false, this.isProcedure);
        }
        this.finish();
        return this.slotCount;
    }
}

const lower = (input, seed) => {
    if (!input || input.format !== 'scratch-specialized-build' || input.version !== 1) {
        throw new Error('Unsupported specialized build input');
    }
    let state = seed >>> 0 || 1;
    const random = () => {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        return state >>> 0;
    };
    const used = new Set();
    const blocks = [];
    const primitives = new Set();
    const program = {
        primitives,
        calls: new Map(),
        variables: new Map(),
        initialTargets: input.project.targets,
        initialStage: input.project.targets.find(target => target.isStage),
        block (owner) {
            let id;
            do {
                id = random() & 0x7fffffff;
            } while (!id || used.has(id));
            used.add(id);
            const block = {id, owner, code: []}; blocks.push(block); return block;
        }
    };
    const hats = [];
    const slots = {};
    for (const target of input.targets) {
        for (const script of target.scripts) {
            const ir = revive(script.ir);
            const entry = program.block(null);
            const procedures = {};
            for (const key of Object.keys(ir.procedures)) procedures[key] = program.block(entry.id);
            hats.push({target: target.index,
                opcode: script.hat,
                fields: script.fields,
                metadata: script.metadata,
                pc: entry.id,
                executable: ir.entry.executableHat});
            slots[entry.id] = new ContinuationGenerator(program, ir.entry, ir, target, procedures, entry).generate();
            for (const key of Object.keys(ir.procedures)) {
                slots[procedures[key].id] = new ContinuationGenerator(program, ir.procedures[key], ir, target, procedures, procedures[key]).generate();
            }
        }
    }
    const slotMaps = {};
    for (const [owner, count] of Object.entries(slots)) {
        const order = Array.from({length: count}, (_, index) => index);
        for (let i = order.length - 1; i > 0; i--) {
            const j = random() % (i + 1); [order[i], order[j]] = [order[j], order[i]];
        }
        slotMaps[owner] = order;
    }
    for (const block of blocks) {
        const map = slotMaps[block.owner];
        if (block.references) {
            block.code.unshift(...[...block.references].map(([source, name]) => `const ${name} = ${source};`));
            delete block.references;
        }
        if (block.cacheableReferences) block.cacheableReferences = [...block.cacheableReferences];
        block.code = block.code.map(source => source
            .replace(/frame\.__spSlots\[(\d+)\]/g, (_, slot) => `frame.__spSlots[${map[slot]}]`)
            .replace(/__spReturn: (\d+)/g, (_, slot) => `__spReturn: ${map[slot]}`));
    }
    // A Fisher-Yates permutation mixes runtime continuations and unrelated scripts.
    for (let i = blocks.length - 1; i > 0; i--) {
        const j = random() % (i + 1); [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    }
    const reachable = new Set(hats.map(hat => hat.pc));
    for (const owner of reachable) {
        for (const callee of program.calls.get(owner) || []) reachable.add(callee);
    }
    return {blocks: blocks.filter(block => reachable.has(block.owner)),
        hats,
        primitives: [...primitives].sort(),
        slots,
        slotMaps};
};

module.exports = {lower, revive};
