import Foundation

/// REST API client matching the backend endpoints.
@MainActor
class APIClient {
    static let shared = APIClient()

    /// Simulator → localhost; real device → cloud server.
    #if targetEnvironment(simulator)
    var baseURL = "http://localhost:6061"
    #else
    var baseURL = "http://118.145.116.152:6061"
    #endif

    private var token: String? { AuthManager.shared.token }

    // MARK: - Auth

    struct AuthResponse: Decodable {
        let token: String
        let uid: Int64
        let username: String
        let displayName: String?
        let avatarUrl: String?
        let accountType: String?

        enum CodingKeys: String, CodingKey {
            case token, uid, username
            case displayName = "display_name"
            case avatarUrl = "avatar_url"
            case accountType = "account_type"
        }

        var user: User {
            User(
                id: uid,
                username: username,
                displayName: displayName,
                avatarUrl: avatarUrl,
                accountType: accountType
            )
        }
    }

    func register(username: String, password: String, displayName: String?) async throws -> AuthResponse {
        var body: [String: Any] = ["username": username, "password": password]
        if let dn = displayName, !dn.isEmpty { body["display_name"] = dn }
        return try await request(.post, "/api/auth/register", body: body)
    }

    func login(username: String, password: String) async throws -> AuthResponse {
        try await request(.post, "/api/auth/login", body: [
            "username": username,
            "password": password
        ])
    }

    // MARK: - Response Wrappers

    private struct FriendsResponse: Decodable { let friends: [User]? }
    private struct RequestsResponse: Decodable { let requests: [FriendRequest]? }
    private struct UsersResponse: Decodable { let users: [User]? }
    private struct MessagesResponse: Decodable { let messages: [Message]? }
    private struct GroupsResponse: Decodable { let groups: [Group]? }
    private struct ConversationsResponse: Decodable { let conversations: [ConversationSummary]? }
    struct MeResponse: Decodable {
        let uid: Int64
        let username: String
        let displayName: String?
        let avatarUrl: String?
        let accountType: String?

        enum CodingKeys: String, CodingKey {
            case uid, username
            case displayName = "display_name"
            case avatarUrl = "avatar_url"
            case accountType = "account_type"
        }

        var user: User {
            User(
                id: uid,
                username: username,
                displayName: displayName,
                avatarUrl: avatarUrl,
                accountType: accountType
            )
        }
    }
    struct CreateGroupResponse: Decodable {
        let groupId: Int64
        let topic: String
        let name: String

        enum CodingKeys: String, CodingKey {
            case topic, name
            case groupId = "group_id"
        }
    }
    struct GroupInfoResponse: Decodable {
        let group: Group
        let members: [GroupMember]
    }
    struct GroupUpdateResponse: Decodable {
        let group: Group
    }
    struct ConversationSummary: Decodable {
        let id: String
        let name: String
        let preview: String?
        let isGroup: Bool
        let groupId: Int64?
        let friendId: Int64?
        let avatarUrl: String?
        let isBot: Bool
        let isOnline: Bool
        let lastTimeRaw: String?
        let latestSeq: Int?

        enum CodingKeys: String, CodingKey {
            case id, name, preview
            case isGroup = "is_group"
            case groupId = "group_id"
            case friendId = "friend_id"
            case avatarUrl = "avatar_url"
            case isBot = "is_bot"
            case isOnline = "is_online"
            case lastTimeRaw = "last_time"
            case latestSeq = "latest_seq"
        }

        var lastTime: Date? {
            guard let lastTimeRaw else { return nil }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: lastTimeRaw) {
                return date
            }
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: lastTimeRaw)
        }
    }

    // MARK: - Friends

    func getFriends() async throws -> [User] {
        let resp: FriendsResponse = try await request(.get, "/api/friends")
        return resp.friends ?? []
    }

    func getPendingRequests() async throws -> [FriendRequest] {
        let resp: RequestsResponse = try await request(.get, "/api/friends/pending")
        return resp.requests ?? []
    }

    func sendFriendRequest(userId: Int64, message: String? = nil) async throws -> EmptyResponse {
        var body: [String: Any] = ["user_id": userId]
        if let m = message { body["message"] = m }
        return try await request(.post, "/api/friends/request", body: body)
    }

    func acceptFriend(userId: Int64) async throws -> EmptyResponse {
        try await request(.post, "/api/friends/accept", body: ["user_id": userId])
    }

    /// Accept a friend request using bot's ApiKey auth (not Bearer token).
    func acceptFriendAsBot(apiKey: String, userId: Int64) async throws {
        guard let url = URL(string: baseURL + "/api/friends/accept") else {
            throw APIError.invalidURL
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("ApiKey \(apiKey)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["user_id": userId])

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        if http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode(ErrorResponse.self, from: data) {
                throw APIError.server(err.error)
            }
            throw APIError.httpError(http.statusCode)
        }
    }

    func rejectFriend(userId: Int64) async throws -> EmptyResponse {
        try await request(.post, "/api/friends/reject", body: ["user_id": userId])
    }

    func blockUser(userId: Int64) async throws -> EmptyResponse {
        try await request(.post, "/api/friends/block", body: ["user_id": userId])
    }

    func removeFriend(userId: Int64) async throws -> EmptyResponse {
        try await request(.delete, "/api/friends/remove?user_id=\(userId)")
    }

    func searchUsers(query: String) async throws -> [User] {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        let resp: UsersResponse = try await request(.get, "/api/users/search?q=\(q)")
        return resp.users ?? []
    }

    func getOnlineStatus() async throws -> [String: Bool] {
        try await request(.get, "/api/users/online")
    }

    func getConversations() async throws -> [ConversationSummary] {
        let resp: ConversationsResponse = try await request(.get, "/api/conversations")
        return resp.conversations ?? []
    }

    func getMe() async throws -> User {
        let resp: MeResponse = try await request(.get, "/api/me")
        return resp.user
    }

    func updateMe(displayName: String, avatarUrl: String?) async throws -> User {
        let resp: MeResponse = try await request(.post, "/api/me/update", body: [
            "display_name": displayName,
            "avatar_url": avatarUrl ?? ""
        ])
        return resp.user
    }

    // MARK: - Messages

    func getMessages(topicId: String, limit: Int = 50, offset: Int = 0, latest: Bool = false) async throws -> [Message] {
        let t = topicId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? topicId
        let latestFlag = latest ? "&latest=1" : ""
        let resp: MessagesResponse = try await request(.get, "/api/messages?topic_id=\(t)&limit=\(limit)&offset=\(offset)\(latestFlag)")
        return resp.messages ?? []
    }

    func sendMessage(topicId: String, content: String) async throws -> EmptyResponse {
        try await request(.post, "/api/messages/send", body: [
            "topic_id": topicId,
            "content": content,
            "msg_type": "text"
        ])
    }

    func sendRichMessage(topicId: String, content: [String: Any], msgType: String) async throws -> EmptyResponse {
        let contentData = try JSONSerialization.data(withJSONObject: content)
        guard let contentString = String(data: contentData, encoding: .utf8) else {
            throw APIError.unknown
        }
        return try await request(.post, "/api/messages/send", body: [
            "topic_id": topicId,
            "content": contentString,
            "msg_type": msgType
        ])
    }

    // MARK: - Groups

    func getGroups() async throws -> [Group] {
        let resp: GroupsResponse = try await request(.get, "/api/groups")
        return resp.groups ?? []
    }

    func createGroup(name: String, memberIds: [Int64]) async throws -> CreateGroupResponse {
        try await request(.post, "/api/groups/create", body: [
            "name": name,
            "member_ids": memberIds
        ] as [String: Any])
    }

    func getGroupInfo(groupId: Int64) async throws -> GroupInfoResponse {
        try await request(.get, "/api/groups/info?id=\(groupId)")
    }

    func updateGroup(groupId: Int64, name: String, avatarUrl: String?) async throws -> Group {
        let resp: GroupUpdateResponse = try await request(.post, "/api/groups/update", body: [
            "group_id": groupId,
            "name": name,
            "avatar_url": avatarUrl ?? ""
        ])
        return resp.group
    }

    func inviteToGroup(groupId: Int64, userIds: [Int64]) async throws -> EmptyResponse {
        try await request(.post, "/api/groups/invite", body: [
            "group_id": groupId,
            "user_ids": userIds
        ] as [String: Any])
    }

    func leaveGroup(groupId: Int64) async throws -> EmptyResponse {
        try await request(.post, "/api/groups/leave", body: ["group_id": groupId])
    }

    func kickMember(groupId: Int64, userId: Int64) async throws -> EmptyResponse {
        try await request(.post, "/api/groups/kick", body: [
            "group_id": groupId,
            "user_id": userId
        ])
    }

    func disbandGroup(groupId: Int64) async throws -> EmptyResponse {
        try await request(.post, "/api/groups/disband", body: ["group_id": groupId])
    }

    // MARK: - Bots

    private struct BotsResponse: Decodable { let bots: [Bot]? }

    struct CreateBotResponse: Decodable {
        let uid: Int64
        let username: String
        let displayName: String?
        let apiKey: String?
        let ownerId: Int64?
        let tenantName: String?

        enum CodingKeys: String, CodingKey {
            case uid, username
            case displayName = "display_name"
            case apiKey = "api_key"
            case ownerId = "owner_id"
            case tenantName = "tenant_name"
        }
    }

    func getMyBots() async throws -> [Bot] {
        let resp: BotsResponse = try await request(.get, "/api/bots")
        return resp.bots ?? []
    }

    func createBot(
        username: String,
        displayName: String,
        deployToCloud: Bool = false
    ) async throws -> CreateBotResponse {
        let path = deployToCloud ? "/api/bots/deploy" : "/api/bots"
        return try await request(.post, path, body: [
            "username": username,
            "display_name": displayName
        ])
    }

    func deleteBot(uid: Int64) async throws -> EmptyResponse {
        try await request(.delete, "/api/bots?uid=\(uid)")
    }

    func setBotVisibility(uid: Int64, visibility: String) async throws -> EmptyResponse {
        try await request(.post, "/api/bots/visibility?uid=\(uid)&v=\(visibility)")
    }

    // MARK: - Upload

    struct UploadResponse: Decodable {
        let url: String
        let name: String?
        let size: Int?
        let type: String?
        let fileKey: String?

        enum CodingKeys: String, CodingKey {
            case url, name, size, type
            case fileKey = "file_key"
        }
    }

    func uploadImage(data: Data, filename: String) async throws -> UploadResponse {
        try await upload("/api/upload?type=image", data: data, filename: filename, mimeType: "image/jpeg")
    }

    func uploadFile(data: Data, filename: String, mimeType: String = "application/octet-stream") async throws -> UploadResponse {
        try await upload("/api/upload?type=file", data: data, filename: filename, mimeType: mimeType)
    }

    // MARK: - Internal

    struct EmptyResponse: Decodable {}

    enum HTTPMethod: String {
        case get = "GET", post = "POST", delete = "DELETE"
    }

    private func request<T: Decodable>(_ method: HTTPMethod, _ path: String, body: [String: Any]? = nil) async throws -> T {
        guard let url = URL(string: baseURL + path) else {
            throw APIError.invalidURL
        }

        var req = URLRequest(url: url)
        req.httpMethod = method.rawValue
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let t = token {
            req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        }
        if let body = body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.unknown
        }
        if http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode(ErrorResponse.self, from: data) {
                throw APIError.server(err.error)
            }
            throw APIError.httpError(http.statusCode)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func upload(_ path: String, data: Data, filename: String, mimeType: String) async throws -> UploadResponse {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }

        let boundary = UUID().uuidString
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let t = token {
            req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        }

        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body

        let (respData, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.unknown
        }
        if http.statusCode >= 400 {
            if let err = try? JSONDecoder().decode(ErrorResponse.self, from: respData) {
                throw APIError.server(err.error)
            }
            throw APIError.httpError(http.statusCode)
        }
        return try JSONDecoder().decode(UploadResponse.self, from: respData)
    }

    private struct ErrorResponse: Decodable {
        let error: String
    }
}

enum APIError: LocalizedError {
    case invalidURL
    case httpError(Int)
    case server(String)
    case unknown

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "无效的URL"
        case .httpError(let code): return "请求失败 (\(code))"
        case .server(let msg): return msg
        case .unknown: return "未知错误"
        }
    }
}
