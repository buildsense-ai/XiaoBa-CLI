// Package server implements Cats Company message-related API handlers.
package server

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/openchat/openchat/server/db/mysql"
)

// MessageHandler handles message-related API requests.
type MessageHandler struct {
	db *mysql.Adapter
}

// NewMessageHandler creates a new MessageHandler.
func NewMessageHandler(db *mysql.Adapter) *MessageHandler {
	return &MessageHandler{db: db}
}

// SendMessageRequest is the JSON body for sending a message.
type SendMessageRequest struct {
	TopicID string `json:"topic_id"`
	Content string `json:"content"`
	MsgType string `json:"msg_type,omitempty"`
}

// HandleSendMessage handles POST /api/messages/send
func (h *MessageHandler) HandleSendMessage(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())

	var req SendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	if req.Content == "" || req.TopicID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "topic_id and content required"})
		return
	}

	msgType := req.MsgType
	if msgType == "" {
		msgType = "text"
	}

	// Ensure topic exists
	h.db.CreateTopic(req.TopicID, "p2p", uid)

	id, err := h.db.SaveMessage(req.TopicID, uid, req.Content, msgType)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to send"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"id":       id,
		"topic_id": req.TopicID,
		"from_uid": uid,
		"content":  req.Content,
		"msg_type": msgType,
	})
}

// HandleGetMessages handles GET /api/messages?topic_id=xxx&limit=50&offset=0
func (h *MessageHandler) HandleGetMessages(w http.ResponseWriter, r *http.Request) {
	_ = UIDFromContext(r.Context())

	topicID := r.URL.Query().Get("topic_id")
	if topicID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "topic_id required"})
		return
	}

	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	latest := r.URL.Query().Get("latest") == "1" || r.URL.Query().Get("latest") == "true"

	var msgs interface{}
	var err error
	if latest {
		msgs, err = h.db.GetLatestMessages(topicID, limit, offset)
	} else {
		msgs, err = h.db.GetMessages(topicID, limit, offset)
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load messages"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"messages": msgs})
}
