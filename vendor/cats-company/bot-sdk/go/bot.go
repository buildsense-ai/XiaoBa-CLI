// Package botsdk provides a Go SDK for building Cats Company bots over WebSocket.
package botsdk

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// MessageHandler processes incoming messages.
type MessageHandler func(ctx *Context)

// Context provides message context to handlers.
type Context struct {
	Topic   string
	From    string
	Content string
	SeqID   int
	bot     *Bot
}

// Reply sends a text reply to the same topic.
func (c *Context) Reply(text string) error {
	return c.bot.SendMessage(c.Topic, text)
}

// ReplyWithTyping sends a typing indicator, waits briefly, then replies.
func (c *Context) ReplyWithTyping(text string) error {
	c.bot.SendTypingIndicator(c.Topic)
	time.Sleep(500 * time.Millisecond)
	return c.bot.SendMessage(c.Topic, text)
}

// Bot represents a connected bot instance using WebSocket.
type Bot struct {
	serverURL string
	apiKey    string
	conn      *websocket.Conn
	handlers  map[string]MessageHandler
	onReady   func()
	sendCh    chan []byte
	done      chan struct{}
	closeOnce sync.Once
	msgID     atomic.Int64
}

// New creates a new Bot instance.
// serverURL is the WebSocket endpoint, e.g. "ws://localhost:6061/v0/channels".
// apiKey is the bot's API key (format: cc_{hex_uid}_{random}).
func New(serverURL, apiKey string) *Bot {
	return &Bot{
		serverURL: serverURL,
		apiKey:    apiKey,
		handlers:  make(map[string]MessageHandler),
		sendCh:    make(chan []byte, 64),
		done:      make(chan struct{}),
	}
}

// OnMessage registers a handler for incoming data messages.
func (b *Bot) OnMessage(handler MessageHandler) {
	b.handlers["message"] = handler
}

// OnReady registers a callback for when the bot has completed the handshake.
func (b *Bot) OnReady(handler func()) {
	b.onReady = handler
}

// nextID returns a monotonically increasing message ID string.
func (b *Bot) nextID() string {
	return fmt.Sprintf("%d", b.msgID.Add(1))
}

// Connect establishes the WebSocket connection and performs the handshake.
func (b *Bot) Connect() error {
	url := fmt.Sprintf("%s?api_key=%s", b.serverURL, b.apiKey)
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		return fmt.Errorf("ws dial: %w", err)
	}
	b.conn = conn

	// Send handshake
	hi := map[string]interface{}{
		"hi": map[string]interface{}{
			"id":  b.nextID(),
			"ver": "0.1.0",
		},
	}
	data, _ := json.Marshal(hi)
	if err := b.conn.WriteMessage(websocket.TextMessage, data); err != nil {
		b.conn.Close()
		return fmt.Errorf("handshake write: %w", err)
	}

	// Wait for handshake response
	_, msg, err := b.conn.ReadMessage()
	if err != nil {
		b.conn.Close()
		return fmt.Errorf("handshake read: %w", err)
	}

	var resp serverMessage
	if err := json.Unmarshal(msg, &resp); err != nil {
		b.conn.Close()
		return fmt.Errorf("handshake parse: %w", err)
	}
	if resp.Ctrl == nil || resp.Ctrl.Code != 200 {
		b.conn.Close()
		return fmt.Errorf("handshake rejected: %s", string(msg))
	}

	log.Printf("bot connected to %s", b.serverURL)

	if b.onReady != nil {
		b.onReady()
	}
	return nil
}

// Close shuts down the bot connection.
func (b *Bot) Close() {
	b.closeOnce.Do(func() {
		close(b.done)
		if b.conn != nil {
			b.conn.WriteMessage(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
			)
			b.conn.Close()
		}
	})
}

// SendMessage sends a text message to a topic.
func (b *Bot) SendMessage(topic, text string) error {
	msg := map[string]interface{}{
		"pub": map[string]interface{}{
			"id":      b.nextID(),
			"topic":   topic,
			"content": text,
		},
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	select {
	case b.sendCh <- data:
		return nil
	case <-b.done:
		return fmt.Errorf("bot closed")
	}
}

// SendTypingIndicator sends a typing notification to a topic.
func (b *Bot) SendTypingIndicator(topic string) {
	msg := map[string]interface{}{
		"note": map[string]interface{}{
			"topic": topic,
			"what":  "kp",
		},
	}
	data, _ := json.Marshal(msg)
	select {
	case b.sendCh <- data:
	case <-b.done:
	}
}

// Run starts the bot's message loop (blocking). Cancel the context to stop.
func (b *Bot) Run(ctx context.Context) error {
	if err := b.Connect(); err != nil {
		return err
	}
	defer b.Close()

	// Writer goroutine
	go b.writePump()

	// Reader loop (blocking)
	return b.readPump(ctx)
}

// writePump sends queued messages to the WebSocket connection.
func (b *Bot) writePump() {
	for {
		select {
		case data := <-b.sendCh:
			if err := b.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				log.Printf("bot write error: %v", err)
				return
			}
		case <-b.done:
			return
		}
	}
}

// readPump reads messages from the WebSocket and dispatches to handlers.
func (b *Bot) readPump(ctx context.Context) error {
	readErr := make(chan error, 1)

	go func() {
		for {
			_, raw, err := b.conn.ReadMessage()
			if err != nil {
				readErr <- err
				return
			}

			var msg serverMessage
			if err := json.Unmarshal(raw, &msg); err != nil {
				log.Printf("bot unmarshal error: %v", err)
				continue
			}

			if msg.Data != nil {
				handler, ok := b.handlers["message"]
				if ok {
					handler(&Context{
						Topic:   msg.Data.Topic,
						From:    msg.Data.From,
						Content: fmt.Sprintf("%v", msg.Data.Content),
						SeqID:   msg.Data.SeqID,
						bot:     b,
					})
				}
			}
		}
	}()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-readErr:
		return fmt.Errorf("read pump: %w", err)
	case <-b.done:
		return nil
	}
}

// serverMessage mirrors the server-to-client envelope (subset needed by SDK).
type serverMessage struct {
	Ctrl *msgCtrl `json:"ctrl,omitempty"`
	Data *msgData `json:"data,omitempty"`
}

type msgCtrl struct {
	ID   string `json:"id,omitempty"`
	Code int    `json:"code"`
	Text string `json:"text,omitempty"`
}

type msgData struct {
	Topic   string      `json:"topic"`
	From    string      `json:"from,omitempty"`
	SeqID   int         `json:"seq"`
	Content interface{} `json:"content"`
}
