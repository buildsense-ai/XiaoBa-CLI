"use strict";
// Topic utility functions for Cats Company protocol.
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTopic = parseTopic;
exports.buildP2PTopic = buildP2PTopic;
exports.uidToNumber = uidToNumber;
exports.numberToUid = numberToUid;
/**
 * Parse a topic string into structured info.
 * For p2p topics, selfUid is used to determine the peer.
 */
function parseTopic(topic, selfUid) {
    if (topic.startsWith('grp_')) {
        const groupId = parseInt(topic.slice(4), 10);
        return { type: 'group', groupId: isNaN(groupId) ? undefined : groupId };
    }
    if (topic.startsWith('p2p_')) {
        const rest = topic.slice(4);
        const sep = rest.indexOf('_');
        if (sep > 0) {
            const uid1 = parseInt(rest.slice(0, sep), 10);
            const uid2 = parseInt(rest.slice(sep + 1), 10);
            if (!isNaN(uid1) && !isNaN(uid2)) {
                const peerUid = selfUid === uid1 ? uid2 : uid1;
                return { type: 'p2p', peerUid };
            }
        }
    }
    // Default to p2p if format is unrecognized
    return { type: 'p2p' };
}
/**
 * Build a deterministic p2p topic string from two numeric UIDs.
 * The smaller UID always comes first.
 */
function buildP2PTopic(uid1, uid2) {
    const min = Math.min(uid1, uid2);
    const max = Math.max(uid1, uid2);
    return `p2p_${min}_${max}`;
}
/**
 * Extract the numeric ID from a "usrN" string.
 */
function uidToNumber(uid) {
    if (uid.startsWith('usr')) {
        const n = parseInt(uid.slice(3), 10);
        return isNaN(n) ? 0 : n;
    }
    return 0;
}
/**
 * Convert a numeric UID to the "usrN" string format.
 */
function numberToUid(n) {
    return `usr${n}`;
}
//# sourceMappingURL=topic.js.map
