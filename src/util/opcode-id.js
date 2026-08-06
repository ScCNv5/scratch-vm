// @ts-check

const {sha256} = require('./sha256');

const OPCODE_ID_DOMAIN = 'sb3c-opcode-v1';

/**
 * Derive the 48-bit numeric identifier for an opcode and public build salt.
 * @param {string} opcode Opcode to identify.
 * @param {string} salt Non-secret public build salt.
 * @returns {number} A non-negative JavaScript safe integer.
 */
const getOpcodeId = (opcode, salt) => {
    const digest = sha256(`${OPCODE_ID_DOMAIN}\0${salt}\0${opcode}`);
    return (digest[0] * 0x10000000000) +
        (digest[1] * 0x100000000) +
        (digest[2] * 0x1000000) +
        (digest[3] * 0x10000) +
        (digest[4] * 0x100) +
        digest[5];
};

/**
 * Build a reverse opcode lookup and reject ambiguous truncated hashes.
 * @param {string[]} opcodes Opcodes to index.
 * @param {string} salt Non-secret public build salt.
 * @param {Function} [deriveId] ID function, injectable for deterministic collision tests.
 * @returns {Map<number, string>} ID-to-opcode lookup.
 */
const createOpcodeIdMap = (opcodes, salt, deriveId = getOpcodeId) => {
    const result = new Map();
    for (const opcode of opcodes) {
        const id = deriveId(opcode, salt);
        const existing = result.get(id);
        if (typeof existing !== 'undefined' && existing !== opcode) {
            throw new Error(`Opcode ID collision between ${JSON.stringify(existing)} and ${JSON.stringify(opcode)}`);
        }
        result.set(id, opcode);
    }
    return result;
};

module.exports = {OPCODE_ID_DOMAIN, createOpcodeIdMap, getOpcodeId};
