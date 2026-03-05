// Echo Bot - a minimal Cats Company bot example using the Go SDK.
//
// This bot echoes back every message it receives, prefixed with "Echo: ".
// It demonstrates the basic Bot SDK usage: connect, handle messages, reply.
//
// Environment variables:
//   BOT_API_KEY  - the bot's API key (required, format: cc_{hex_uid}_{random})
//   BOT_WS_URL   - WebSocket server URL (default: ws://localhost:6061/v0/channels)
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	botsdk "github.com/openchat/openchat/bot-sdk/go"
)

func main() {
	apiKey := os.Getenv("BOT_API_KEY")
	if apiKey == "" {
		log.Fatal("BOT_API_KEY environment variable is required")
	}

	wsURL := os.Getenv("BOT_WS_URL")
	if wsURL == "" {
		wsURL = "ws://localhost:6061/v0/channels"
	}

	bot := botsdk.New(wsURL, apiKey)

	// Log when the bot is ready
	bot.OnReady(func() {
		log.Println("Echo bot is ready and listening for messages")
	})

	// Echo back every message
	bot.OnMessage(func(ctx *botsdk.Context) {
		reply := fmt.Sprintf("Echo: %s", ctx.Content)
		if err := ctx.ReplyWithTyping(reply); err != nil {
			log.Printf("reply error: %v", err)
		}
	})

	// Run with graceful shutdown on SIGINT/SIGTERM
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	log.Printf("starting echo bot, server=%s", wsURL)
	if err := bot.Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatalf("bot error: %v", err)
	}
	log.Println("echo bot stopped")
}
