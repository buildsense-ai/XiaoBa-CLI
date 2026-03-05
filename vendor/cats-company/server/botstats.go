// Package server implements Cats Company bot traffic statistics.
package server

import (
	"sync"
	"time"
)

// BotStats tracks per-bot traffic metrics.
type BotStats struct {
	mu    sync.RWMutex
	stats map[int64]*BotMetrics
}

// BotMetrics holds metrics for a single bot.
type BotMetrics struct {
	MessagesSent int64     `json:"messages_sent"`
	MessagesRecv int64     `json:"messages_recv"`
	ActiveTopics int       `json:"active_topics"`
	LastActive   time.Time `json:"last_active"`
	topics       map[string]bool
}

// NewBotStats creates a new BotStats tracker.
func NewBotStats() *BotStats {
	return &BotStats{stats: make(map[int64]*BotMetrics)}
}

// RecordSent records a message sent by a bot.
func (bs *BotStats) RecordSent(uid int64, topic string) {
	bs.mu.Lock()
	defer bs.mu.Unlock()
	m := bs.getOrCreate(uid)
	m.MessagesSent++
	m.LastActive = time.Now()
	m.topics[topic] = true
	m.ActiveTopics = len(m.topics)
}

// RecordRecv records a message received by a bot.
func (bs *BotStats) RecordRecv(uid int64) {
	bs.mu.Lock()
	defer bs.mu.Unlock()
	m := bs.getOrCreate(uid)
	m.MessagesRecv++
}

func (bs *BotStats) getOrCreate(uid int64) *BotMetrics {
	m, ok := bs.stats[uid]
	if !ok {
		m = &BotMetrics{topics: make(map[string]bool)}
		bs.stats[uid] = m
	}
	return m
}

// GetStats returns a snapshot of all bot metrics.
func (bs *BotStats) GetStats() map[int64]*BotMetrics {
	bs.mu.RLock()
	defer bs.mu.RUnlock()
	result := make(map[int64]*BotMetrics, len(bs.stats))
	for uid, m := range bs.stats {
		result[uid] = &BotMetrics{
			MessagesSent: m.MessagesSent,
			MessagesRecv: m.MessagesRecv,
			ActiveTopics: m.ActiveTopics,
			LastActive:   m.LastActive,
		}
	}
	return result
}

// GetBotStats returns metrics for a specific bot.
func (bs *BotStats) GetBotStats(uid int64) *BotMetrics {
	bs.mu.RLock()
	defer bs.mu.RUnlock()
	m, ok := bs.stats[uid]
	if !ok {
		return &BotMetrics{}
	}
	return &BotMetrics{
		MessagesSent: m.MessagesSent,
		MessagesRecv: m.MessagesRecv,
		ActiveTopics: m.ActiveTopics,
		LastActive:   m.LastActive,
	}
}
