import Foundation

struct Bot: Codable, Identifiable {
    let id: Int64
    let username: String
    let displayName: String?
    let enabled: Bool?
    let visibility: String?
    let ownerId: Int64?
    let apiKey: String?
    let tenantName: String?

    enum CodingKeys: String, CodingKey {
        case id
        case username
        case displayName = "display_name"
        case enabled
        case visibility
        case ownerId = "owner_id"
        case apiKey = "api_key"
        case tenantName = "tenant_name"
    }

    var label: String {
        displayName ?? username
    }

    var isPublic: Bool {
        visibility == "public"
    }

    var isManaged: Bool {
        if let tenantName, !tenantName.isEmpty {
            return true
        }
        return false
    }
}
