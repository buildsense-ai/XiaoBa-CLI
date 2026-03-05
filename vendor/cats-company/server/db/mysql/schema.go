// Package mysql - schema initialization for Cats Company.
package mysql

import "fmt"

// CreateSchema creates all required database tables and runs migrations.
func (a *Adapter) CreateSchema() error {
	tables := []string{
		createUsersTable,
		createFriendsTable,
		createTopicsTable,
		createMessagesTable,
		createBotConfigTable,
		createRateLimitTable,
		createGroupsTable,
		createGroupMembersTable,
	}
	for _, q := range tables {
		if _, err := a.db.Exec(q); err != nil {
			return fmt.Errorf("schema creation failed: %w", err)
		}
	}

	// Run migrations (safe to re-run; uses IF NOT EXISTS / column checks)
	migrations := []string{
		migrateBotConfigAddAPIKey,
		migrateUsersAddBotDisclose,
		migrateMessagesAddReplyTo,
		migrateBotConfigAddOwnerID,
		migrateBotConfigAddVisibility,
		migrateBotConfigAddTenantName,
	}
	for _, m := range migrations {
		if _, err := a.db.Exec(m); err != nil {
			// Ignore "duplicate column" errors for idempotent migrations
			if !isDuplicateColumnError(err) {
				return fmt.Errorf("migration failed: %w", err)
			}
		}
	}
	return nil
}

// isDuplicateColumnError checks if the error is a MySQL duplicate column error (1060).
func isDuplicateColumnError(err error) bool {
	return err != nil && (fmt.Sprintf("%v", err) == "" ||
		len(fmt.Sprintf("%v", err)) > 0 &&
			(contains(fmt.Sprintf("%v", err), "1060") ||
				contains(fmt.Sprintf("%v", err), "Duplicate column")))
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && searchString(s, substr)
}

func searchString(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

const createUsersTable = `
CREATE TABLE IF NOT EXISTS users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    email VARCHAR(255) DEFAULT NULL,
    phone VARCHAR(32) DEFAULT NULL,
    display_name VARCHAR(128) NOT NULL DEFAULT '',
    avatar_url VARCHAR(512) DEFAULT NULL,
    account_type ENUM('human','bot','service') NOT NULL DEFAULT 'human',
    pass_hash VARBINARY(128) NOT NULL,
    state TINYINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_users_account_type (account_type),
    INDEX idx_users_phone (phone),
    INDEX idx_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`

const createFriendsTable = `
CREATE TABLE IF NOT EXISTS friends (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    from_user_id BIGINT NOT NULL,
    to_user_id BIGINT NOT NULL,
    status ENUM('pending','accepted','rejected','blocked') NOT NULL DEFAULT 'pending',
    message VARCHAR(255) DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_friend_pair (from_user_id, to_user_id),
    INDEX idx_friends_to_user (to_user_id, status),
    INDEX idx_friends_status (status),
    FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`

const createTopicsTable = `
CREATE TABLE IF NOT EXISTS topics (
    id VARCHAR(64) PRIMARY KEY,
    type ENUM('p2p','group') NOT NULL DEFAULT 'p2p',
    name VARCHAR(128) DEFAULT '',
    owner_id BIGINT DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_topics_type (type),
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`

const createMessagesTable = `
CREATE TABLE IF NOT EXISTS messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    topic_id VARCHAR(64) NOT NULL,
    from_uid BIGINT NOT NULL,
    content TEXT NOT NULL,
    msg_type ENUM('text','image','voice','file') NOT NULL DEFAULT 'text',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_messages_topic (topic_id, created_at),
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
    FOREIGN KEY (from_uid) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`

const createBotConfigTable = `
CREATE TABLE IF NOT EXISTS bot_config (
    user_id BIGINT PRIMARY KEY,
    api_endpoint VARCHAR(512) DEFAULT '',
    model VARCHAR(128) DEFAULT '',
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    config JSON DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`

const createRateLimitTable = `
CREATE TABLE IF NOT EXISTS rate_limits (
    account_type ENUM('human','bot','service') PRIMARY KEY,
    max_per_second INT NOT NULL DEFAULT 10,
    max_per_minute INT NOT NULL DEFAULT 120,
    burst_size INT NOT NULL DEFAULT 20
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`

// Migration: add api_key column to bot_config table.
const migrateBotConfigAddAPIKey = `
ALTER TABLE bot_config ADD COLUMN api_key VARCHAR(128) DEFAULT NULL;
`

// Migration: add bot_disclose column to users table.
const migrateUsersAddBotDisclose = `
ALTER TABLE users ADD COLUMN bot_disclose TINYINT(1) NOT NULL DEFAULT 0;
`

const createGroupsTable = `
CREATE TABLE IF NOT EXISTS ` + "`groups`" + ` (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    owner_id BIGINT NOT NULL,
    avatar_url VARCHAR(512) DEFAULT NULL,
    max_members INT NOT NULL DEFAULT 200,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`

const createGroupMembersTable = `
CREATE TABLE IF NOT EXISTS group_members (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    group_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    role ENUM('owner','admin','member') NOT NULL DEFAULT 'member',
    joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_group_user (group_id, user_id),
    INDEX idx_gm_user (user_id),
    FOREIGN KEY (group_id) REFERENCES ` + "`groups`" + `(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`

// Migration: add reply_to column to messages table.
const migrateMessagesAddReplyTo = `
ALTER TABLE messages ADD COLUMN reply_to BIGINT DEFAULT NULL;
`

// Migration: add owner_id column to bot_config table.
const migrateBotConfigAddOwnerID = `
ALTER TABLE bot_config ADD COLUMN owner_id BIGINT DEFAULT NULL;
`

// Migration: add visibility column to bot_config table.
const migrateBotConfigAddVisibility = `
ALTER TABLE bot_config ADD COLUMN visibility ENUM('public','private') NOT NULL DEFAULT 'public';
`

// Migration: add tenant_name column to bot_config table.
// NULL = self-hosted (third-party), non-NULL = platform-managed deployment.
const migrateBotConfigAddTenantName = `
ALTER TABLE bot_config ADD COLUMN tenant_name VARCHAR(128) DEFAULT NULL;
`
