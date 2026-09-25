const BlockUtility = require('../engine/block-utility');

// Each thread owns its utility. Nested hats and async extensions cannot overwrite it.
class SpecializedBlockUtility extends BlockUtility {
    get stackFrame () {
        return this.thread.compatibilityStackFrame;
    }
    startBranch (branch, loop) {
        this._startedBranch = [branch, loop];
    }
    startProcedure () {
        throw new Error('Extensions cannot invoke unlinked procedures');
    }
    init (thread, blockId, frame) {
        this.thread = thread;
        this.sequencer = thread.target.runtime.sequencer;
        this._startedBranch = null;
        thread.stack[0] = blockId;
        thread.compatibilityStackFrame = frame;
    }
}

module.exports = SpecializedBlockUtility;
