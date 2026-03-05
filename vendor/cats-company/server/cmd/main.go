// Package main is the entry point for the Cats Company server.
package main

import (
	"encoding/json"
	"log"
	"os"
)

// Config holds the server configuration.
type Config struct {
	Listen    string      `json:"listen"`
	GRPCPort  string      `json:"grpc_port"`
	Database  DBConfig    `json:"database"`
	WebSocket WSConfig    `json:"websocket"`
	Static    StaticConfig `json:"static"`
}

type DBConfig struct {
	DSN string `json:"dsn"`
}

type WSConfig struct {
	Path string `json:"path"`
}

type StaticConfig struct {
	Dir string `json:"dir"`
}

func loadConfig(path string) (*Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	cfg := &Config{}
	if err := json.NewDecoder(f).Decode(cfg); err != nil {
		return nil, err
	}
	applyEnvOverrides(cfg)
	return cfg, nil
}

func defaultConfig() *Config {
	cfg := &Config{
		Listen:   ":6061",
		GRPCPort: ":6062",
		Database: DBConfig{
			DSN: "openchat:openchat@tcp(localhost:3306)/openchat?parseTime=true&charset=utf8mb4",
		},
		WebSocket: WSConfig{Path: "/v0/channels"},
		Static:    StaticConfig{Dir: "../webapp/build"},
	}
	applyEnvOverrides(cfg)
	return cfg
}

func applyEnvOverrides(cfg *Config) {
	if dsn := os.Getenv("OC_DB_DSN"); dsn != "" {
		cfg.Database.DSN = dsn
	}
}

func init() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
}
