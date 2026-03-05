// Package server implements Cats Company rate limiting per account type.
package server

import (
	"sync"
	"time"

	"github.com/openchat/openchat/server/store/types"
)

// RateLimiter implements a token bucket rate limiter per user.
type RateLimiter struct {
	mu      sync.RWMutex
	buckets map[int64]*bucket
	configs map[types.AccountType]*types.RateLimitConfig
}

type bucket struct {
	tokens     float64
	maxTokens  float64
	refillRate float64 // tokens per second
	lastRefill time.Time
}

// DefaultRateLimits returns sensible defaults per account type.
func DefaultRateLimits() map[types.AccountType]*types.RateLimitConfig {
	return map[types.AccountType]*types.RateLimitConfig{
		types.AccountHuman: {
			AccountType:  types.AccountHuman,
			MaxPerSecond: 10,
			MaxPerMinute: 120,
			BurstSize:    20,
		},
		types.AccountBot: {
			AccountType:  types.AccountBot,
			MaxPerSecond: 5,
			MaxPerMinute: 60,
			BurstSize:    10,
		},
		types.AccountService: {
			AccountType:  types.AccountService,
			MaxPerSecond: 20,
			MaxPerMinute: 300,
			BurstSize:    50,
		},
	}
}

// NewRateLimiter creates a new rate limiter with the given configs.
func NewRateLimiter(configs map[types.AccountType]*types.RateLimitConfig) *RateLimiter {
	return &RateLimiter{
		buckets: make(map[int64]*bucket),
		configs: configs,
	}
}

// Allow checks if a request from the given user should be allowed.
func (rl *RateLimiter) Allow(uid int64, accountType types.AccountType) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, ok := rl.buckets[uid]
	if !ok {
		cfg := rl.configs[accountType]
		if cfg == nil {
			cfg = rl.configs[types.AccountHuman]
		}
		b = &bucket{
			tokens:     float64(cfg.BurstSize),
			maxTokens:  float64(cfg.BurstSize),
			refillRate: float64(cfg.MaxPerSecond),
			lastRefill: time.Now(),
		}
		rl.buckets[uid] = b
	}

	// Refill tokens
	now := time.Now()
	elapsed := now.Sub(b.lastRefill).Seconds()
	b.tokens += elapsed * b.refillRate
	if b.tokens > b.maxTokens {
		b.tokens = b.maxTokens
	}
	b.lastRefill = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// Cleanup removes stale buckets (call periodically).
func (rl *RateLimiter) Cleanup(maxAge time.Duration) {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	cutoff := time.Now().Add(-maxAge)
	for uid, b := range rl.buckets {
		if b.lastRefill.Before(cutoff) {
			delete(rl.buckets, uid)
		}
	}
}
