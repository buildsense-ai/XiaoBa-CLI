// Package server - Deployer client for gauz-platform deploy API.
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// Deployer wraps HTTP calls to the gauz-platform deploy API.
type Deployer struct {
	baseURL string
	client  *http.Client
}

// NewDeployer creates a Deployer pointing at the given gauz-platform base URL.
func NewDeployer(baseURL string) *Deployer {
	return &Deployer{
		baseURL: baseURL,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// Deploy calls POST /api/deploy on gauz-platform to create a container for the bot.
// Failures are logged but do not return errors to avoid blocking bot creation.
func (d *Deployer) Deploy(ctx context.Context, tenant, apiKey string) error {
	body, _ := json.Marshal(map[string]string{
		"tenant":     tenant,
		"cc_api_key": apiKey,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		d.baseURL+"/api/deploy", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("deploy request build: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "ApiKey "+apiKey)

	resp, err := d.client.Do(req)
	if err != nil {
		return fmt.Errorf("deploy request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return fmt.Errorf("deploy returned status %d", resp.StatusCode)
	}
	return nil
}

// Status calls GET /api/deploy/{tenant}/status on gauz-platform and returns the runtime state.
func (d *Deployer) Status(ctx context.Context, tenant, apiKey string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		d.baseURL+"/api/deploy/"+tenant+"/status", nil)
	if err != nil {
		return "", fmt.Errorf("status request build: %w", err)
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "ApiKey "+apiKey)
	}

	resp, err := d.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("status request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("status returned %d", resp.StatusCode)
	}

	var payload struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("status decode failed: %w", err)
	}
	if payload.Status == "" {
		return "", fmt.Errorf("status missing in deploy response")
	}
	return payload.Status, nil
}

// Remove calls DELETE /api/deploy/{tenant} on gauz-platform to tear down the container.
// Failures are logged but do not block the caller.
func (d *Deployer) Remove(ctx context.Context, tenant, apiKey string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		d.baseURL+"/api/deploy/"+tenant, nil)
	if err != nil {
		return fmt.Errorf("remove request build: %w", err)
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "ApiKey "+apiKey)
	}

	resp, err := d.client.Do(req)
	if err != nil {
		log.Printf("[deployer] remove %s failed: %v", tenant, err)
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		log.Printf("[deployer] remove %s returned status %d", tenant, resp.StatusCode)
		return fmt.Errorf("remove returned status %d", resp.StatusCode)
	}
	return nil
}
