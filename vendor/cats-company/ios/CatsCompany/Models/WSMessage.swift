import Foundation

// MARK: - Client → Server

struct ClientMessage: Encodable {
    var hi: WSHi?
    var pub: WSPub?
    var get: WSGet?
    var note: WSNote?
    var sub: WSSub?
    var friend: WSFriendAction?
}

struct WSHi: Encodable {
    let id: String
    let ver: String = "0.1.0"
    let ua: String = "CatsCompany-iOS/1.0"
}

/// Wraps either a plain text string or a rich JSON object for pub content.
enum WSPubContent: Encodable {
    case text(String)
    case rich([String: Any])

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let s):
            try container.encode(s)
        case .rich(let dict):
            let data = try JSONSerialization.data(withJSONObject: dict)
            let raw = try JSONDecoder().decode(AnyEncodable.self, from: data)
            try container.encode(raw)
        }
    }
}

/// Helper to encode arbitrary JSON values.
private struct AnyEncodable: Encodable, Decodable {
    let value: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let dict = try? container.decode([String: AnyEncodable].self) {
            value = dict.mapValues { $0.value }
        } else if let arr = try? container.decode([AnyEncodable].self) {
            value = arr.map { $0.value }
        } else if let s = try? container.decode(String.self) {
            value = s
        } else if let i = try? container.decode(Int.self) {
            value = i
        } else if let d = try? container.decode(Double.self) {
            value = d
        } else if let b = try? container.decode(Bool.self) {
            value = b
        } else {
            value = NSNull()
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let dict = value as? [String: Any] {
            let wrapped = dict.mapValues { AnyEncodable(value: $0) }
            try container.encode(wrapped)
        } else if let arr = value as? [Any] {
            try container.encode(arr.map { AnyEncodable(value: $0) })
        } else if let s = value as? String {
            try container.encode(s)
        } else if let i = value as? Int {
            try container.encode(i)
        } else if let d = value as? Double {
            try container.encode(d)
        } else if let b = value as? Bool {
            try container.encode(b)
        } else {
            try container.encodeNil()
        }
    }

    init(value: Any) { self.value = value }
}

struct WSPub: Encodable {
    let id: String
    let topic: String
    let content: WSPubContent
    var replyTo: Int?

    enum CodingKeys: String, CodingKey {
        case id, topic, content
        case replyTo = "reply_to"
    }
}

struct WSGet: Encodable {
    let id: String
    let topic: String
    let what: String
    var seq: Int?
}

struct WSNote: Encodable {
    let topic: String
    let what: String // "kp", "read", "recv"
    var seq: Int?
}

struct WSSub: Encodable {
    let id: String
    let topic: String
}

struct WSFriendAction: Encodable {
    let id: String
    let action: String
    let userId: Int64
    var msg: String?

    enum CodingKeys: String, CodingKey {
        case id, action, msg
        case userId = "user_id"
    }
}

// MARK: - Server → Client

struct ServerMessage: Decodable {
    var ctrl: WSCtrl?
    var data: WSData?
    var pres: WSPres?
    var meta: WSMeta?
    var info: WSInfo?
    var friend: WSFriendEvent?
}

struct WSCtrl: Decodable {
    let id: String?
    let topic: String?
    let code: Int
    let text: String?
    let params: AnyCodable?
}

struct WSData: Decodable {
    let topic: String
    let from: String?
    let seq: Int
    let content: MessageContent
    var replyTo: Int?

    enum CodingKeys: String, CodingKey {
        case topic, from, seq, content
        case replyTo = "reply_to"
    }
}

struct WSPres: Decodable {
    let topic: String
    let what: String // "on", "off", "msg", "upd"
    let src: String?
}

struct WSMeta: Decodable {
    let id: String?
    let topic: String
    let desc: AnyCodable?
    let sub: AnyCodable?
}

struct WSInfo: Decodable {
    let topic: String
    let from: String
    let what: String // "kp", "read", "recv"
    let seq: Int?
}

struct WSFriendEvent: Decodable {
    let action: String
    let from: Int64
    let to: Int64
    var msg: String?
}

// MARK: - AnyCodable helper for dynamic JSON

struct AnyCodable: Decodable {
    let value: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else if let arr = try? container.decode([AnyCodable].self) {
            value = arr.map { $0.value }
        } else if let s = try? container.decode(String.self) {
            value = s
        } else if let i = try? container.decode(Int.self) {
            value = i
        } else if let d = try? container.decode(Double.self) {
            value = d
        } else if let b = try? container.decode(Bool.self) {
            value = b
        } else {
            value = NSNull()
        }
    }
}
