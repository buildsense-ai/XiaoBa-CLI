import Foundation

struct Group: Codable, Identifiable {
    let id: Int64
    let name: String
    var ownerID: Int64?
    var avatarUrl: String?
    var maxMembers: Int?
    var members: [GroupMember]?

    enum CodingKeys: String, CodingKey {
        case id, name
        case ownerID = "owner_id"
        case avatarUrl = "avatar_url"
        case maxMembers = "max_members"
        case members
    }

    var topicId: String {
        "grp_\(id)"
    }
}

struct GroupMember: Codable, Identifiable {
    var id: Int64 { userId }
    let userId: Int64
    let username: String
    var displayName: String?
    var avatarUrl: String?
    var role: String? // "owner", "admin", "member"
    var isBot: Bool?

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case username
        case displayName = "display_name"
        case avatarUrl = "avatar_url"
        case role
        case isBot = "is_bot"
    }
}

struct FriendRequest: Codable, Identifiable {
    var id: Int64 { fromUserId }
    let fromUserId: Int64
    let fromUsername: String
    var message: String?
    var displayName: String?

    enum CodingKeys: String, CodingKey {
        case fromUserId = "from_user_id"
        case fromUsername = "from_username"
        case message
        case displayName = "display_name"
    }
}
