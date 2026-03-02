export interface TopicInfo {
    type: 'p2p' | 'group';
    peerUid?: number;
    groupId?: number;
}
/**
 * Parse a topic string into structured info.
 * For p2p topics, selfUid is used to determine the peer.
 */
export declare function parseTopic(topic: string, selfUid?: number): TopicInfo;
/**
 * Build a deterministic p2p topic string from two numeric UIDs.
 * The smaller UID always comes first.
 */
export declare function buildP2PTopic(uid1: number, uid2: number): string;
/**
 * Extract the numeric ID from a "usrN" string.
 */
export declare function uidToNumber(uid: string): number;
/**
 * Convert a numeric UID to the "usrN" string format.
 */
export declare function numberToUid(n: number): string;
//# sourceMappingURL=topic.d.ts.map
