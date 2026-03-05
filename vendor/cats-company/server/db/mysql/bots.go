// Package mysql - Cats Company bot configuration database operations.
package mysql

import (
	"fmt"

	"github.com/openchat/openchat/server/store/types"
)

// SaveBotConfig saves or updates bot configuration with owner.
func (a *Adapter) SaveBotConfig(uid int64, apiEndpoint, model string) error {
	_, err := a.db.Exec(
		`INSERT INTO bot_config (user_id, api_endpoint, model, enabled)
		 VALUES (?, ?, ?, 1)
		 ON DUPLICATE KEY UPDATE api_endpoint = ?, model = ?, updated_at = CURRENT_TIMESTAMP`,
		uid, apiEndpoint, model, apiEndpoint, model,
	)
	return err
}

// SaveBotConfigWithOwner saves bot configuration with owner_id.
func (a *Adapter) SaveBotConfigWithOwner(uid, ownerID int64, apiEndpoint, model string) error {
	_, err := a.db.Exec(
		`INSERT INTO bot_config (user_id, owner_id, api_endpoint, model, enabled)
		 VALUES (?, ?, ?, ?, 1)
		 ON DUPLICATE KEY UPDATE api_endpoint = ?, model = ?, updated_at = CURRENT_TIMESTAMP`,
		uid, ownerID, apiEndpoint, model, apiEndpoint, model,
	)
	return err
}

// GetBotConfig retrieves bot configuration by user ID.
func (a *Adapter) GetBotConfig(uid int64) (*types.BotConfig, error) {
	bc := &types.BotConfig{}
	err := a.db.QueryRow(
		`SELECT user_id, api_endpoint, model, enabled FROM bot_config WHERE user_id = ?`, uid,
	).Scan(&bc.UserID, &bc.APIEndpoint, &bc.Model, &bc.Enabled)
	if err != nil {
		return nil, fmt.Errorf("get bot config: %w", err)
	}
	return bc, nil
}

// ListBots returns all bot users with their configs.
func (a *Adapter) ListBots() ([]map[string]interface{}, error) {
	rows, err := a.db.Query(
		`SELECT u.id, u.username, u.display_name, u.avatar_url, u.state,
		        COALESCE(b.api_endpoint, '') as api_endpoint,
		        COALESCE(b.model, '') as model,
		        COALESCE(b.enabled, 1) as enabled
		 FROM users u LEFT JOIN bot_config b ON u.id = b.user_id
		 WHERE u.account_type = 'bot'
		 ORDER BY u.created_at`,
	)
	if err != nil {
		return nil, fmt.Errorf("list bots: %w", err)
	}
	defer rows.Close()

	var bots []map[string]interface{}
	for rows.Next() {
		var id int64
		var username, displayName, avatarURL, apiEndpoint, model string
		var state int
		var enabled bool
		if err := rows.Scan(&id, &username, &displayName, &avatarURL, &state, &apiEndpoint, &model, &enabled); err != nil {
			return nil, err
		}
		bots = append(bots, map[string]interface{}{
			"id":           id,
			"username":     username,
			"display_name": displayName,
			"avatar_url":   avatarURL,
			"state":        state,
			"api_endpoint": apiEndpoint,
			"model":        model,
			"enabled":      enabled,
		})
	}
	return bots, rows.Err()
}

// ToggleBotEnabled toggles the enabled state of a bot.
func (a *Adapter) ToggleBotEnabled(uid int64) error {
	_, err := a.db.Exec(
		`UPDATE bot_config SET enabled = NOT enabled, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
		uid,
	)
	return err
}

// SaveAPIKey stores or updates the API key for a bot.
func (a *Adapter) SaveAPIKey(uid int64, apiKey string) error {
	_, err := a.db.Exec(
		`UPDATE bot_config SET api_key = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
		apiKey, uid,
	)
	return err
}

// GetBotDebugMessages returns recent messages sent by a bot, for debug purposes.
func (a *Adapter) GetBotDebugMessages(uid int64, limit int) ([]*types.Message, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := a.db.Query(
		`SELECT id, topic_id, from_uid, content, msg_type, created_at
		 FROM messages WHERE from_uid = ?
		 ORDER BY id DESC LIMIT ?`,
		uid, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("get bot debug messages: %w", err)
	}
	defer rows.Close()

	var msgs []*types.Message
	for rows.Next() {
		m := &types.Message{}
		if err := rows.Scan(&m.ID, &m.TopicID, &m.FromUID, &m.Content, &m.MsgType, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan debug message: %w", err)
		}
		msgs = append(msgs, m)
	}
	return msgs, rows.Err()
}

// GetBotByAPIKey looks up a bot's user ID by its API key.
func (a *Adapter) GetBotByAPIKey(apiKey string) (int64, error) {
	var uid int64
	err := a.db.QueryRow(
		`SELECT user_id FROM bot_config WHERE api_key = ? AND enabled = 1`, apiKey,
	).Scan(&uid)
	if err != nil {
		return 0, fmt.Errorf("get bot by api key: %w", err)
	}
	return uid, nil
}

// GetBotAPIKey returns the API key for a bot.
func (a *Adapter) GetBotAPIKey(botUID int64) (string, error) {
	var apiKey *string
	err := a.db.QueryRow(
		`SELECT api_key FROM bot_config WHERE user_id = ?`, botUID,
	).Scan(&apiKey)
	if err != nil {
		return "", fmt.Errorf("get bot api key: %w", err)
	}
	if apiKey == nil {
		return "", nil
	}
	return *apiKey, nil
}

// ListBotsByOwner returns bots owned by a specific user.
func (a *Adapter) ListBotsByOwner(ownerID int64) ([]map[string]interface{}, error) {
	rows, err := a.db.Query(
		`SELECT u.id, u.username, u.display_name, u.avatar_url, u.state,
		        COALESCE(b.api_endpoint, '') as api_endpoint,
		        COALESCE(b.model, '') as model,
		        COALESCE(b.enabled, 1) as enabled,
		        COALESCE(b.visibility, 'public') as visibility,
		        b.tenant_name
		 FROM users u LEFT JOIN bot_config b ON u.id = b.user_id
		 WHERE u.account_type = 'bot' AND b.owner_id = ?
		 ORDER BY u.created_at`,
		ownerID,
	)
	if err != nil {
		return nil, fmt.Errorf("list bots by owner: %w", err)
	}
	defer rows.Close()

	var bots []map[string]interface{}
	for rows.Next() {
		var id int64
		var username, displayName, avatarURL, apiEndpoint, model, visibility string
		var tenantName *string
		var state int
		var enabled bool
		if err := rows.Scan(&id, &username, &displayName, &avatarURL, &state,
			&apiEndpoint, &model, &enabled, &visibility, &tenantName); err != nil {
			return nil, err
		}
		bot := map[string]interface{}{
			"id":           id,
			"username":     username,
			"display_name": displayName,
			"avatar_url":   avatarURL,
			"state":        state,
			"api_endpoint": apiEndpoint,
			"model":        model,
			"enabled":      enabled,
			"visibility":   visibility,
		}
		if tenantName != nil {
			bot["tenant_name"] = *tenantName
		}
		bots = append(bots, bot)
	}
	return bots, rows.Err()
}

// GetBotOwner returns the owner_id for a bot.
func (a *Adapter) GetBotOwner(botUID int64) (int64, error) {
	var ownerID int64
	err := a.db.QueryRow(
		`SELECT COALESCE(owner_id, 0) FROM bot_config WHERE user_id = ?`, botUID,
	).Scan(&ownerID)
	if err != nil {
		return 0, fmt.Errorf("get bot owner: %w", err)
	}
	return ownerID, nil
}

// DeleteBot removes a bot's config, disables the user account, and removes all friend relationships.
func (a *Adapter) DeleteBot(botUID int64) error {
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Delete all friend relationships involving this bot (both directions)
	if _, err := tx.Exec(
		`DELETE FROM friends WHERE from_user_id = ? OR to_user_id = ?`,
		botUID, botUID,
	); err != nil {
		return fmt.Errorf("delete bot friends: %w", err)
	}
	// Delete bot config
	if _, err := tx.Exec(`DELETE FROM bot_config WHERE user_id = ?`, botUID); err != nil {
		return fmt.Errorf("delete bot config: %w", err)
	}
	// Disable the user account (state=1 means disabled)
	if _, err := tx.Exec(`UPDATE users SET state = 1 WHERE id = ?`, botUID); err != nil {
		return fmt.Errorf("disable bot user: %w", err)
	}
	return tx.Commit()
}

// SetTenantName sets the tenant_name for a bot (platform-managed deployment).
func (a *Adapter) SetTenantName(botUID int64, tenantName string) error {
	_, err := a.db.Exec(
		`UPDATE bot_config SET tenant_name = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
		tenantName, botUID,
	)
	return err
}

// GetTenantName returns the tenant_name for a bot. Empty string means self-hosted.
func (a *Adapter) GetTenantName(botUID int64) (string, error) {
	var tenantName *string
	err := a.db.QueryRow(
		`SELECT tenant_name FROM bot_config WHERE user_id = ?`, botUID,
	).Scan(&tenantName)
	if err != nil {
		return "", fmt.Errorf("get tenant name: %w", err)
	}
	if tenantName == nil {
		return "", nil
	}
	return *tenantName, nil
}

// SetBotVisibility updates the visibility of a bot.
func (a *Adapter) SetBotVisibility(botUID int64, visibility string) error {
	_, err := a.db.Exec(
		`UPDATE bot_config SET visibility = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
		visibility, botUID,
	)
	return err
}
