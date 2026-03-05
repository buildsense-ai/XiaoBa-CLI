import Foundation

struct Message: Codable, Identifiable, Equatable {
    let id: Int? // DB id, may be nil for optimistic sends
    let topicId: String
    let fromUid: String
    var content: MessageContent
    var seq: Int
    var replyTo: Int?
    var createdAt: String?
    var msgType: String?

    enum CodingKeys: String, CodingKey {
        case id
        case topicId = "topic_id"
        case fromUid = "from_uid"
        case content
        case seq
        case replyTo = "reply_to"
        case createdAt = "created_at"
        case msgType = "msg_type"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(Int.self, forKey: .id)
        topicId = try c.decode(String.self, forKey: .topicId)
        // from_uid can be Int or String from server
        if let intUid = try? c.decode(Int64.self, forKey: .fromUid) {
            fromUid = String(intUid)
        } else {
            fromUid = try c.decodeIfPresent(String.self, forKey: .fromUid) ?? ""
        }
        content = try c.decode(MessageContent.self, forKey: .content)
        seq = try c.decodeIfPresent(Int.self, forKey: .seq) ?? (id ?? 0)
        replyTo = try c.decodeIfPresent(Int.self, forKey: .replyTo)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        msgType = try c.decodeIfPresent(String.self, forKey: .msgType)
    }

    init(id: Int?, topicId: String, fromUid: String, content: MessageContent, seq: Int, replyTo: Int? = nil, createdAt: String? = nil, msgType: String? = nil) {
        self.id = id
        self.topicId = topicId
        self.fromUid = fromUid
        self.content = content
        self.seq = seq
        self.replyTo = replyTo
        self.createdAt = createdAt
        self.msgType = msgType
    }

    static func == (lhs: Message, rhs: Message) -> Bool {
        lhs.seq == rhs.seq && lhs.topicId == rhs.topicId
    }

    var timestamp: Date? {
        guard let str = createdAt else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: str) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: str)
    }
}

/// Flexible message content: can be plain text or rich JSON
enum MessageContent: Codable, Equatable {
    case text(String)
    case rich(RichContent)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let text = try? container.decode(String.self) {
            // Check if the string is actually a JSON-encoded rich content
            if let data = text.data(using: .utf8),
               let parsed = try? JSONDecoder().decode(ServerRichContent.self, from: data),
               parsed.type != nil {
                self = .rich(parsed.toRichContent())
            } else {
                self = .text(text)
            }
            return
        }
        if let parsed = try? container.decode(ServerRichContent.self),
           parsed.type != nil {
            self = .rich(parsed.toRichContent())
            return
        }
        if let rich = try? container.decode(RichContent.self) {
            self = .rich(rich)
            return
        }
        self = .text("")
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let s): try container.encode(s)
        case .rich(let r): try container.encode(r)
        }
    }

    var displayText: String {
        switch self {
        case .text(let s): return s
        case .rich(let r):
            if r.type == "file" {
                return r.fileName ?? "[文件]"
            }
            return r.text ?? r.title ?? "[富媒体消息]"
        }
    }
}

struct RichContent: Codable, Equatable {
    var type: String? // "image", "file", "link", "card"
    var text: String?
    var title: String?
    var url: String?
    var description: String?
    var imageUrl: String?
    var fileName: String?
    var fileSize: Int?
    var mimeType: String?

    enum CodingKeys: String, CodingKey {
        case type, text, title, url, description
        case imageUrl = "image_url"
        case fileName = "file_name"
        case fileSize = "file_size"
        case mimeType = "mime_type"
    }
}

/// Maps the server's `{"type":"image","payload":{...}}` format to RichContent
struct ServerRichContent: Decodable {
    let type: String?
    let payload: Payload?

    struct Payload: Decodable {
        let url: String?
        let thumbnail: String?
        let name: String?
        let size: Int?
        let fileKey: String?
        let mimeType: String?
        let title: String?
        let text: String?
        let description: String?
        let image: String?
        let imageURL: String?
        let siteName: String?

        enum CodingKeys: String, CodingKey {
            case url, thumbnail, name, size, title, text, description, image
            case fileKey = "file_key"
            case mimeType = "mime_type"
            case imageURL = "image_url"
            case siteName = "site_name"
        }
    }

    func toRichContent() -> RichContent {
        let resolvedImage = payload?.thumbnail ?? payload?.imageURL ?? payload?.image ?? payload?.url
        return RichContent(
            type: type,
            text: payload?.text,
            title: payload?.title,
            url: payload?.url,
            description: payload?.description ?? payload?.siteName,
            imageUrl: resolvedImage,
            fileName: payload?.name,
            fileSize: payload?.size,
            mimeType: payload?.mimeType
        )
    }
}
