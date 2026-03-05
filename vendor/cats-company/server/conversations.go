package server

import (
	"encoding/json"
	"net/http"
	"sort"

	"github.com/openchat/openchat/server/db/mysql"
	"github.com/openchat/openchat/server/store/types"
)

// ConversationHandler serves chat-list summaries without per-topic N+1 fetches.
type ConversationHandler struct {
	db  *mysql.Adapter
	hub *Hub
}

// NewConversationHandler creates a new ConversationHandler.
func NewConversationHandler(db *mysql.Adapter, hub *Hub) *ConversationHandler {
	return &ConversationHandler{db: db, hub: hub}
}

// HandleList handles GET /api/conversations
func (h *ConversationHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())

	friends, err := h.db.GetFriends(uid)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to get friends"})
		return
	}

	groups, err := h.db.GetUserGroups(uid)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to get groups"})
		return
	}

	topicIDs := make([]string, 0, len(friends)+len(groups))
	for _, friend := range friends {
		topicIDs = append(topicIDs, p2pTopicID(uid, friend.ID))
	}
	for _, group := range groups {
		topicIDs = append(topicIDs, "grp_"+formatInt64(group.ID))
	}

	latestByTopic, err := h.db.GetLatestMessagesForTopics(topicIDs)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load latest messages"})
		return
	}

	conversations := make([]*types.ConversationSummary, 0, len(topicIDs))
	for _, friend := range friends {
		topicID := p2pTopicID(uid, friend.ID)
		summary := buildFriendConversationSummary(topicID, friend, latestByTopic[topicID], h.hub)
		conversations = append(conversations, summary)
	}
	for _, group := range groups {
		topicID := "grp_" + formatInt64(group.ID)
		summary := buildGroupConversationSummary(topicID, group, latestByTopic[topicID])
		conversations = append(conversations, summary)
	}

	sort.SliceStable(conversations, func(i, j int) bool {
		left := conversations[i].LastTime
		right := conversations[j].LastTime
		switch {
		case left == nil && right == nil:
			return conversations[i].Name < conversations[j].Name
		case left == nil:
			return false
		case right == nil:
			return true
		default:
			return left.After(*right)
		}
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{"conversations": conversations})
}

func buildFriendConversationSummary(topicID string, friend *types.User, latest *types.Message, hub *Hub) *types.ConversationSummary {
	summary := &types.ConversationSummary{
		ID:        topicID,
		Name:      displayNameOrUsername(friend.DisplayName, friend.Username),
		IsGroup:   false,
		FriendID:  friend.ID,
		AvatarURL: friend.AvatarURL,
		IsBot:     friend.BotDisclose,
		IsOnline:  hub != nil && hub.IsOnline(friend.ID),
	}
	applyLatestMessage(summary, latest)
	return summary
}

func buildGroupConversationSummary(topicID string, group *types.Group, latest *types.Message) *types.ConversationSummary {
	summary := &types.ConversationSummary{
		ID:        topicID,
		Name:      group.Name,
		IsGroup:   true,
		GroupID:   group.ID,
		AvatarURL: group.AvatarURL,
	}
	applyLatestMessage(summary, latest)
	return summary
}

func applyLatestMessage(summary *types.ConversationSummary, latest *types.Message) {
	if summary == nil || latest == nil {
		return
	}

	summary.Preview = summarizeConversationMessage(latest)
	summary.LatestSeq = latest.ID
	t := latest.CreatedAt
	summary.LastTime = &t
}

func summarizeConversationMessage(msg *types.Message) string {
	if msg == nil {
		return ""
	}

	switch msg.MsgType {
	case "image":
		return "[图片]"
	case "file":
		if name := richPayloadField(msg.Content, "name"); name != "" {
			return name
		}
		return "[文件]"
	case "card":
		if title := richPayloadField(msg.Content, "title"); title != "" {
			return title
		}
		if text := richPayloadField(msg.Content, "text"); text != "" {
			return text
		}
		return "[卡片]"
	case "link_preview":
		if title := richPayloadField(msg.Content, "title"); title != "" {
			return title
		}
		if url := richPayloadField(msg.Content, "url"); url != "" {
			return url
		}
		return "[链接]"
	default:
		if text := richPayloadField(msg.Content, "text"); text != "" {
			return text
		}
		return msg.Content
	}
}

func richPayloadField(content, field string) string {
	if content == "" {
		return ""
	}

	var rich struct {
		Payload map[string]interface{} `json:"payload"`
	}
	if err := json.Unmarshal([]byte(content), &rich); err != nil {
		return ""
	}
	if rich.Payload == nil {
		return ""
	}
	if value, ok := rich.Payload[field].(string); ok {
		return value
	}
	return ""
}

func displayNameOrUsername(displayName, username string) string {
	if displayName != "" {
		return displayName
	}
	return username
}

func formatInt64(v int64) string {
	if v == 0 {
		return "0"
	}

	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + (v % 10))
		v /= 10
	}
	return string(buf[i:])
}
