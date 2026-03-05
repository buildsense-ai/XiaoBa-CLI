import Foundation

/// Lightweight local message cache using UserDefaults.
/// Stores recent messages per topic to survive view lifecycle and app restarts.
@MainActor
class MessageStore {
    static let shared = MessageStore()

    private let defaults = UserDefaults.standard
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let maxPerTopic = 1000
    private let hiddenTopicsKey = "cc_hidden_topics"

    private func key(for topic: String) -> String {
        "cc_msgs_\(topic)"
    }

    private func clearedSeqKey(for topic: String) -> String {
        "cc_msgs_cleared_seq_\(topic)"
    }

    private func clearedSeq(for topic: String) -> Int {
        defaults.object(forKey: clearedSeqKey(for: topic)) as? Int ?? 0
    }

    func filterVisible(_ messages: [Message], for topic: String) -> [Message] {
        let cutoff = clearedSeq(for: topic)
        guard cutoff > 0 else { return messages }
        return messages.filter { $0.seq < 0 || $0.seq > cutoff }
    }

    // MARK: - Read / Write

    func loadMessages(for topic: String, limit: Int? = nil) -> [Message] {
        guard let data = defaults.data(forKey: key(for: topic)) else { return [] }
        let decoded = (try? decoder.decode([Message].self, from: data)) ?? []
        let visible = filterVisible(decoded, for: topic)
        if let limit = limit {
            return Array(visible.suffix(limit))
        }
        return visible
    }

    func saveMessages(_ messages: [Message], for topic: String) {
        let normalized = normalize(filterVisible(messages, for: topic))
        let trimmed = Array(normalized.suffix(maxPerTopic))
        if let data = try? encoder.encode(trimmed) {
            defaults.set(data, forKey: key(for: topic))
        }
    }

    func appendMessage(_ message: Message, for topic: String) {
        if message.seq > 0 && message.seq <= clearedSeq(for: topic) {
            return
        }
        unhideConversation(topic: topic)
        var msgs = loadMessages(for: topic)
        if !msgs.contains(where: { $0.seq == message.seq }) {
            msgs.append(message)
            saveMessages(msgs, for: topic)
        }
    }

    func updateMessageSeq(in topic: String, oldSeq: Int, newSeq: Int) {
        var msgs = loadMessages(for: topic)
        if let idx = msgs.firstIndex(where: { $0.seq == oldSeq }) {
            msgs[idx].seq = newSeq
            saveMessages(msgs, for: topic)
        }
    }

    // MARK: - Clear

    func clearMessages(for topic: String, upToSeq: Int? = nil) {
        defaults.removeObject(forKey: key(for: topic))
        if let upToSeq, upToSeq > 0 {
            defaults.set(upToSeq, forKey: clearedSeqKey(for: topic))
        } else {
            defaults.removeObject(forKey: clearedSeqKey(for: topic))
        }
    }

    func hideConversation(topic: String) {
        var topics = hiddenTopics()
        topics.insert(topic)
        defaults.set(Array(topics), forKey: hiddenTopicsKey)
    }

    func unhideConversation(topic: String) {
        var topics = hiddenTopics()
        if topics.remove(topic) != nil {
            defaults.set(Array(topics), forKey: hiddenTopicsKey)
        }
    }

    func isConversationHidden(topic: String) -> Bool {
        hiddenTopics().contains(topic)
    }

    private func hiddenTopics() -> Set<String> {
        Set(defaults.stringArray(forKey: hiddenTopicsKey) ?? [])
    }

    func clearAllMessages() {
        let allKeys = defaults.dictionaryRepresentation().keys
        for k in allKeys where k.hasPrefix("cc_msgs_") {
            defaults.removeObject(forKey: k)
        }
        defaults.removeObject(forKey: hiddenTopicsKey)
    }

    private func normalize(_ messages: [Message]) -> [Message] {
        var bySeq: [Int: Message] = [:]
        for message in messages {
            bySeq[message.seq] = message
        }
        return bySeq.values.sorted { lhs, rhs in
            if lhs.seq == rhs.seq {
                return (lhs.timestamp ?? .distantPast) < (rhs.timestamp ?? .distantPast)
            }
            return lhs.seq < rhs.seq
        }
    }
}
