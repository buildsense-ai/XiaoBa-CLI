import Foundation

struct User: Codable, Identifiable, Hashable {
    let id: Int64
    let username: String
    var displayName: String?
    var avatarUrl: String?
    var accountType: String? // "human", "bot", "service"
    var isOnline: Bool = false

    enum CodingKeys: String, CodingKey {
        case id
        case username
        case displayName = "display_name"
        case avatarUrl = "avatar_url"
        case accountType = "account_type"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int64.self, forKey: .id)
        username = try c.decode(String.self, forKey: .username)
        displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
        avatarUrl = try c.decodeIfPresent(String.self, forKey: .avatarUrl)
        accountType = try c.decodeIfPresent(String.self, forKey: .accountType)
        isOnline = false
    }

    init(id: Int64, username: String, displayName: String? = nil, avatarUrl: String? = nil, accountType: String? = nil) {
        self.id = id
        self.username = username
        self.displayName = displayName
        self.avatarUrl = avatarUrl
        self.accountType = accountType
    }

    var label: String {
        displayName ?? username
    }

    var isBot: Bool {
        accountType == "bot" || accountType == "service"
    }
}
