import Foundation

@MainActor
class IdentityStore: ObservableObject {
    static let shared = IdentityStore()

    @Published private(set) var usersById: [Int64: User] = [:]
    @Published private(set) var groupsByTopic: [String: Group] = [:]

    private init() {}

    func clear() {
        usersById = [:]
        groupsByTopic = [:]
    }

    func upsertCurrentUser(_ user: User?) {
        guard let user else { return }
        usersById[user.id] = user
    }

    func upsertUsers(_ users: [User]) {
        for user in users {
            usersById[user.id] = user
        }
    }

    func upsertGroup(_ group: Group) {
        groupsByTopic[group.topicId] = group
    }

    func upsertGroups(_ groups: [Group]) {
        for group in groups {
            upsertGroup(group)
        }
    }

    func upsertGroupMembers(_ members: [GroupMember]) {
        for member in members {
            usersById[member.userId] = User(
                id: member.userId,
                username: member.username,
                displayName: member.displayName,
                avatarUrl: member.avatarUrl,
                accountType: member.isBot == true ? "bot" : nil
            )
        }
    }

    func user(forRawID rawID: String) -> User? {
        guard let id = normalizeUserID(rawID) else { return nil }
        return usersById[id]
    }

    func displayName(forRawID rawID: String, fallback: String) -> String {
        user(forRawID: rawID)?.label ?? fallback
    }

    func avatarURL(forRawID rawID: String) -> String? {
        user(forRawID: rawID)?.avatarUrl
    }

    func isBot(forRawID rawID: String) -> Bool {
        user(forRawID: rawID)?.isBot ?? false
    }

    func group(forTopic topic: String) -> Group? {
        groupsByTopic[topic]
    }

    func groupName(forTopic topic: String, fallback: String) -> String {
        groupsByTopic[topic]?.name ?? fallback
    }

    func groupAvatarURL(forTopic topic: String) -> String? {
        groupsByTopic[topic]?.avatarUrl
    }

    private func normalizeUserID(_ rawID: String) -> Int64? {
        let trimmed = rawID.trimmingCharacters(in: .whitespacesAndNewlines)
        if let id = Int64(trimmed) {
            return id
        }
        if trimmed.hasPrefix("usr") {
            return Int64(trimmed.dropFirst(3))
        }
        return nil
    }
}
