// Package mysql implements MySQL database adapter for Cats Company.
package mysql

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

// PoolConfig holds connection pool configuration.
type PoolConfig struct {
	MaxOpenConns    int           `json:"max_open_conns"`
	MaxIdleConns    int           `json:"max_idle_conns"`
	ConnMaxLifetime time.Duration `json:"conn_max_lifetime"`
	ConnMaxIdleTime time.Duration `json:"conn_max_idle_time"`
}

// DefaultPoolConfig returns sensible defaults for connection pool.
func DefaultPoolConfig() PoolConfig {
	return PoolConfig{
		MaxOpenConns:    64,
		MaxIdleConns:    16,
		ConnMaxLifetime: 10 * time.Minute,
		ConnMaxIdleTime: 5 * time.Minute,
	}
}

// Adapter is the MySQL database adapter.
type Adapter struct {
	db         *sql.DB
	dsn        string
	prefix     string
	poolConfig PoolConfig
}

// Config holds MySQL connection configuration.
type Config struct {
	DSN        string     `json:"dsn"`
	Prefix     string     `json:"prefix"`
	Pool       PoolConfig `json:"pool"`
}

// Open initializes the database connection with default pool settings.
func (a *Adapter) Open(dsn string) error {
	return a.OpenWithConfig(dsn, DefaultPoolConfig())
}

// OpenWithConfig initializes the database connection with custom pool settings.
func (a *Adapter) OpenWithConfig(dsn string, pool PoolConfig) error {
	var err error
	a.dsn = dsn
	a.poolConfig = pool
	a.db, err = sql.Open("mysql", dsn)
	if err != nil {
		return err
	}

	// Apply connection pool settings
	a.db.SetMaxOpenConns(pool.MaxOpenConns)
	a.db.SetMaxIdleConns(pool.MaxIdleConns)
	a.db.SetConnMaxLifetime(pool.ConnMaxLifetime)
	if pool.ConnMaxIdleTime > 0 {
		a.db.SetConnMaxIdleTime(pool.ConnMaxIdleTime)
	}

	return a.db.Ping()
}

// Close shuts down the database connection.
func (a *Adapter) Close() error {
	if a.db != nil {
		return a.db.Close()
	}
	return nil
}

// DB returns the underlying sql.DB for direct access.
func (a *Adapter) DB() *sql.DB {
	return a.db
}

// IsConnected checks if the database connection is still alive.
func (a *Adapter) IsConnected() bool {
	if a.db == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return a.db.PingContext(ctx) == nil
}

// PoolStats returns current connection pool statistics.
func (a *Adapter) PoolStats() *PoolStats {
	if a.db == nil {
		return nil
	}
	stats := a.db.Stats()
	return &PoolStats{
		MaxOpenConnections: stats.MaxOpenConnections,
		OpenConnections:    stats.OpenConnections,
		InUse:              stats.InUse,
		Idle:               stats.Idle,
		WaitCount:          stats.WaitCount,
		WaitDuration:       stats.WaitDuration.String(),
		MaxIdleClosed:      stats.MaxIdleClosed,
		MaxLifetimeClosed:  stats.MaxLifetimeClosed,
	}
}

// PoolStats holds connection pool statistics for monitoring.
type PoolStats struct {
	MaxOpenConnections int    `json:"max_open_connections"`
	OpenConnections    int    `json:"open_connections"`
	InUse              int    `json:"in_use"`
	Idle               int    `json:"idle"`
	WaitCount          int64  `json:"wait_count"`
	WaitDuration       string `json:"wait_duration"`
	MaxIdleClosed      int64  `json:"max_idle_closed"`
	MaxLifetimeClosed  int64  `json:"max_lifetime_closed"`
}

// HealthCheck returns detailed health status for monitoring.
func (a *Adapter) HealthCheck() map[string]interface{} {
	connected := a.IsConnected()
	result := map[string]interface{}{
		"connected": connected,
		"status":    "healthy",
	}

	if connected && a.db != nil {
		stats := a.db.Stats()
		result["pool"] = map[string]interface{}{
			"open_connections": stats.OpenConnections,
			"in_use":           stats.InUse,
			"idle":             stats.Idle,
			"max_open":         stats.MaxOpenConnections,
			"wait_count":       stats.WaitCount,
		}

		// Warn if pool is under pressure
		if stats.WaitCount > 1000 {
			result["status"] = "warning"
			result["message"] = fmt.Sprintf("high wait count: %d", stats.WaitCount)
		}
		if stats.OpenConnections == stats.MaxOpenConnections && stats.MaxOpenConnections > 0 {
			result["status"] = "warning"
			result["message"] = "connection pool at capacity"
		}
	} else {
		result["status"] = "unhealthy"
		result["message"] = "database not connected"
	}

	return result
}
