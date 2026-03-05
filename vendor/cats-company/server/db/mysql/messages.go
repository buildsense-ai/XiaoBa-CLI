// Package mysql - Cats Company message database operations.
package mysql

import (
	"fmt"
	"strings"

	"github.com/openchat/openchat/server/store/types"
)

// CreateTopic creates a topic if it doesn't exist.
func (a *Adapter) CreateTopic(id, topicType string, ownerID int64) error {
	_, err := a.db.Exec(
		`INSERT IGNORE INTO topics (id, type, owner_id) VALUES (?, ?, ?)`,
		id, topicType, ownerID,
	)
	return err
}

// SaveMessage inserts a message and returns its ID.
func (a *Adapter) SaveMessage(topicID string, fromUID int64, content, msgType string) (int64, error) {
	res, err := a.db.Exec(
		`INSERT INTO messages (topic_id, from_uid, content, msg_type) VALUES (?, ?, ?, ?)`,
		topicID, fromUID, content, msgType,
	)
	if err != nil {
		return 0, fmt.Errorf("save message: %w", err)
	}
	return res.LastInsertId()
}

// GetMessagesSince returns messages after a given ID for a topic.
func (a *Adapter) GetMessagesSince(topicID string, sinceID int64, limit int) ([]*types.Message, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := a.db.Query(
		`SELECT id, topic_id, from_uid, content, msg_type, created_at
		 FROM messages WHERE topic_id = ? AND id > ?
		 ORDER BY id ASC LIMIT ?`,
		topicID, sinceID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("get messages since: %w", err)
	}
	defer rows.Close()

	var msgs []*types.Message
	for rows.Next() {
		m := &types.Message{}
		if err := rows.Scan(&m.ID, &m.TopicID, &m.FromUID, &m.Content, &m.MsgType, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan message: %w", err)
		}
		msgs = append(msgs, m)
	}
	return msgs, rows.Err()
}

// GetMessages returns messages for a topic, ordered by time.
func (a *Adapter) GetMessages(topicID string, limit, offset int) ([]*types.Message, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := a.db.Query(
		`SELECT id, topic_id, from_uid, content, msg_type, created_at
		 FROM messages WHERE topic_id = ?
		 ORDER BY created_at ASC LIMIT ? OFFSET ?`,
		topicID, limit, offset,
	)
	if err != nil {
		return nil, fmt.Errorf("get messages: %w", err)
	}
	defer rows.Close()

	var msgs []*types.Message
	for rows.Next() {
		m := &types.Message{}
		if err := rows.Scan(&m.ID, &m.TopicID, &m.FromUID, &m.Content, &m.MsgType, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan message: %w", err)
		}
		msgs = append(msgs, m)
	}
	return msgs, rows.Err()
}

// GetLatestMessages returns the newest messages for a topic, but in ascending order for rendering.
func (a *Adapter) GetLatestMessages(topicID string, limit, offset int) ([]*types.Message, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := a.db.Query(
		`SELECT id, topic_id, from_uid, content, msg_type, created_at
		 FROM (
		 	SELECT id, topic_id, from_uid, content, msg_type, created_at
		 	FROM messages WHERE topic_id = ?
		 	ORDER BY id DESC LIMIT ? OFFSET ?
		 ) recent
		 ORDER BY id ASC`,
		topicID, limit, offset,
	)
	if err != nil {
		return nil, fmt.Errorf("get latest messages: %w", err)
	}
	defer rows.Close()

	var msgs []*types.Message
	for rows.Next() {
		m := &types.Message{}
		if err := rows.Scan(&m.ID, &m.TopicID, &m.FromUID, &m.Content, &m.MsgType, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan latest message: %w", err)
		}
		msgs = append(msgs, m)
	}
	return msgs, rows.Err()
}

// GetLatestMessagesForTopics returns the newest persisted message for each topic.
func (a *Adapter) GetLatestMessagesForTopics(topicIDs []string) (map[string]*types.Message, error) {
	if len(topicIDs) == 0 {
		return map[string]*types.Message{}, nil
	}

	placeholders := strings.TrimRight(strings.Repeat("?,", len(topicIDs)), ",")
	args := make([]interface{}, 0, len(topicIDs)*2)
	for _, topicID := range topicIDs {
		args = append(args, topicID)
	}
	for _, topicID := range topicIDs {
		args = append(args, topicID)
	}

	rows, err := a.db.Query(
		fmt.Sprintf(
			`SELECT m.id, m.topic_id, m.from_uid, m.content, m.msg_type, m.created_at
			 FROM messages m
			 JOIN (
			 	SELECT topic_id, MAX(id) AS max_id
			 	FROM messages
			 	WHERE topic_id IN (%s)
			 	GROUP BY topic_id
			 ) latest ON latest.max_id = m.id
			 WHERE m.topic_id IN (%s)`,
			placeholders,
			placeholders,
		),
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("get latest messages for topics: %w", err)
	}
	defer rows.Close()

	latest := make(map[string]*types.Message, len(topicIDs))
	for rows.Next() {
		msg := &types.Message{}
		if err := rows.Scan(&msg.ID, &msg.TopicID, &msg.FromUID, &msg.Content, &msg.MsgType, &msg.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan latest message for topic: %w", err)
		}
		latest[msg.TopicID] = msg
	}
	return latest, rows.Err()
}
