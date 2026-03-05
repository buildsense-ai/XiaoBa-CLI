// Package server - Cats Company WebSocket client read/write pumps and message dispatch.
package server

import (
	"encoding/json"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 65536
)

// SendToUser sends a server message to a specific user if online.
func (h *Hub) SendToUser(uid int64, msg *ServerMessage) {
	h.SendToUserExcept(uid, msg, nil)
}

// SendToUserExcept sends a server message to all of a user's connections except one.
func (h *Hub) SendToUserExcept(uid int64, msg *ServerMessage, exclude *Client) {
	clients := h.getClients(uid)
	if len(clients) == 0 {
		return
	}

	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("marshal error: %v", err)
		return
	}

	for _, client := range clients {
		if client == exclude {
			continue
		}
		h.sendRawToClient(client, data)
	}
}

// SendToClient sends a server message to a specific connection.
func (h *Hub) SendToClient(client *Client, msg *ServerMessage) {
	if client == nil {
		return
	}

	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("marshal error: %v", err)
		return
	}

	h.sendRawToClient(client, data)
}

func (h *Hub) sendRawToClient(client *Client, data []byte) {
	if client == nil {
		return
	}
	if client.trySend(data) {
		return
	}
	h.disconnectClient(client, "send buffer full")
}

func (h *Hub) disconnectClient(client *Client, reason string) {
	removed, lastConn, remaining, onlineUsers := h.removeClient(client)
	client.closeSend()
	if client.conn != nil {
		_ = client.conn.Close()
	}

	if !removed {
		return
	}

	if reason == "" {
		log.Printf("client disconnected: uid=%d (devices: %d, online users: %d)", client.uid, remaining, onlineUsers)
	} else {
		log.Printf("client disconnected: uid=%d (%s, devices: %d, online users: %d)", client.uid, reason, remaining, onlineUsers)
	}
	if lastConn {
		h.enqueuePresence(client.uid, "off")
	}
}

func (h *Hub) getClients(uid int64) []*Client {
	h.mu.RLock()
	defer h.mu.RUnlock()

	clients := h.clients[uid]
	if len(clients) == 0 {
		return nil
	}

	out := make([]*Client, 0, len(clients))
	for client := range clients {
		out = append(out, client)
	}
	return out
}

// IsOnline checks if a user is currently connected.
func (h *Hub) IsOnline(uid int64) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients[uid]) > 0
}

func (c *Client) trySend(message []byte) bool {
	c.sendMu.RLock()
	defer c.sendMu.RUnlock()

	if c.sendClosed {
		return false
	}

	select {
	case c.send <- message:
		return true
	default:
		return false
	}
}

func (c *Client) closeSend() {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()

	if c.sendClosed {
		return
	}
	close(c.send)
	c.sendClosed = true
}

// ReadPump pumps messages from the WebSocket connection to the hub.
func (c *Client) ReadPump(handler func(client *Client, msg *ClientMessage)) {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("ws read error: %v", err)
			}
			break
		}

		var msg ClientMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("unmarshal error: %v", err)
			continue
		}

		handler(c, &msg)
	}
}

// WritePump pumps messages from the hub to the WebSocket connection.
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
