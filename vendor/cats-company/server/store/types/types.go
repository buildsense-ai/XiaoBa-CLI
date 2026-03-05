// Package types defines core data types for Cats Company.
package types

import (
	"time"
)

// AccountType distinguishes human users from bots/services internally.
type AccountType string

const (
	AccountHuman   AccountType = "human"
	AccountBot     AccountType = "bot"
	AccountService AccountType = "service"
)

// User represents a registered user in the system.
type User struct {
	ID          int64       `json:"id"`
	Username    string      `json:"username"`
	Email       string      `json:"email,omitempty"`
	Phone       string      `json:"phone,omitempty"`
	DisplayName string      `json:"display_name"`
	AvatarURL   string      `json:"avatar_url,omitempty"`
	AccountType AccountType `json:"-"`    // internal only, never exposed to other users
	BotDisclose bool        `json:"bot,omitempty"` // if true, disclose bot identity to other users
	PassHash    []byte      `json:"-"`
	State       int         `json:"state"`
	CreatedAt   time.Time   `json:"created_at"`
	UpdatedAt   time.Time   `json:"updated_at"`
}

// FriendStatus represents the state of a friend relationship.
type FriendStatus string

const (
	FriendPending  FriendStatus = "pending"
	FriendAccepted FriendStatus = "accepted"
	FriendRejected FriendStatus = "rejected"
	FriendBlocked  FriendStatus = "blocked"
)

// FriendRequest represents a friend relationship between two users.
type FriendRequest struct {
	ID           int64        `json:"id"`
	FromUserID   int64        `json:"from_user_id"`
	ToUserID     int64        `json:"to_user_id"`
	FromUsername string       `json:"from_username,omitempty"`
	DisplayName  string       `json:"display_name,omitempty"`
	Status       FriendStatus `json:"status"`
	Message      string       `json:"message,omitempty"`
	CreatedAt    time.Time    `json:"created_at"`
	UpdatedAt    time.Time    `json:"updated_at"`
}

// Topic represents a chat topic (conversation).
type Topic struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"` // "p2p", "group"
	Name      string    `json:"name,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// Message represents a chat message.
type Message struct {
	ID        int64     `json:"id"`
	TopicID   string    `json:"topic_id"`
	FromUID   int64     `json:"from_uid"`
	Content   string    `json:"content"`
	MsgType   string    `json:"msg_type"` // "text", "image", "voice", "file"
	CreatedAt time.Time `json:"created_at"`
}

// ConversationSummary is the lightweight chat-list payload for a topic.
type ConversationSummary struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Preview   string     `json:"preview,omitempty"`
	IsGroup   bool       `json:"is_group"`
	GroupID   int64      `json:"group_id,omitempty"`
	FriendID  int64      `json:"friend_id,omitempty"`
	AvatarURL string     `json:"avatar_url,omitempty"`
	IsBot     bool       `json:"is_bot,omitempty"`
	IsOnline  bool       `json:"is_online,omitempty"`
	LastTime  *time.Time `json:"last_time,omitempty"`
	LatestSeq int64      `json:"latest_seq,omitempty"`
}

// RichContent is the unified message payload structure.
// All messages use this format: { "type": "text"|"image"|"file"|"card"|"link_preview", "payload": {...} }
type RichContent struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload"`
}

// ImagePayload is the payload for image messages.
type ImagePayload struct {
	FileKey   string `json:"file_key"`
	URL       string `json:"url"`
	Thumbnail string `json:"thumbnail,omitempty"`
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`
	Size      int64  `json:"size,omitempty"`
}

// FilePayload is the payload for file messages.
type FilePayload struct {
	FileKey  string `json:"file_key"`
	URL      string `json:"url"`
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	MimeType string `json:"mime_type,omitempty"`
}

// LinkPreviewPayload is the payload for link preview messages.
type LinkPreviewPayload struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Image       string `json:"image,omitempty"`
	SiteName    string `json:"site_name,omitempty"`
}

// CardPayload is the payload for card messages (structured content).
type CardPayload struct {
	Title   string       `json:"title"`
	Text    string       `json:"text,omitempty"`
	Image   string       `json:"image,omitempty"`
	Buttons []CardButton `json:"buttons,omitempty"`
}

// CardButton is a button in a card message.
type CardButton struct {
	Label  string `json:"label"`
	Action string `json:"action"` // "url", "copy", "callback"
	Value  string `json:"value"`
}

// BotVisibility controls whether a bot is discoverable via search.
type BotVisibility string

const (
	BotPublic  BotVisibility = "public"
	BotPrivate BotVisibility = "private"
)

// BotConfig holds configuration for a registered bot.
type BotConfig struct {
	UserID      int64             `json:"user_id"`
	OwnerID     int64             `json:"owner_id"`
	APIEndpoint string            `json:"api_endpoint,omitempty"`
	Model       string            `json:"model,omitempty"`
	Enabled     bool              `json:"enabled"`
	Visibility  BotVisibility     `json:"visibility"`
	Config      map[string]string `json:"config,omitempty"`
}

// Group represents a chat group.
type Group struct {
	ID           int64     `json:"id"`
	Name         string    `json:"name"`
	OwnerID      int64     `json:"owner_id"`
	AvatarURL    string    `json:"avatar_url,omitempty"`
	Announcement string    `json:"announcement,omitempty"`
	MaxMembers   int       `json:"max_members"`
	CreatedAt    time.Time `json:"created_at"`
}

// GroupMember represents a member of a group.
type GroupMember struct {
	ID        int64     `json:"id"`
	GroupID   int64     `json:"group_id"`
	UserID    int64     `json:"user_id"`
	Role      string    `json:"role"` // "owner", "admin", "member"
	JoinedAt  time.Time `json:"joined_at"`
	// Joined fields from user table (populated by queries)
	Username    string `json:"username,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	IsBot       bool   `json:"is_bot,omitempty"`
}

// RateLimitConfig defines rate limits per account type.
type RateLimitConfig struct {
	AccountType    AccountType `json:"account_type"`
	MaxPerSecond   int         `json:"max_per_second"`
	MaxPerMinute   int         `json:"max_per_minute"`
	BurstSize      int         `json:"burst_size"`
}
