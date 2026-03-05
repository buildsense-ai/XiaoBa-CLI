#!/bin/bash
set -e

# Wait for MySQL to be ready
until mysql -u root -p"${MYSQL_ROOT_PASSWORD}" -e "SELECT 1" &> /dev/null; do
  echo "Waiting for MySQL..."
  sleep 2
done

# Generate bcrypt hash for bot password
# Requires htpasswd (apache2-utils) or python3 with bcrypt
if command -v python3 &> /dev/null; then
  BOT_PASSWORD_HASH=$(python3 -c "
import bcrypt
import sys
password = sys.argv[1].encode('utf-8')
salt = bcrypt.gensalt(rounds=10)
print(bcrypt.hashpw(password, salt).decode('utf-8'))
" "${BOT_ASSISTANT_PASSWORD:-changeme}" 2>/dev/null || echo "")
fi

# Fallback: use a pre-generated hash for default password if python fails
if [ -z "$BOT_PASSWORD_HASH" ]; then
  # This is a bcrypt hash for "changeme" - should be replaced in production
  BOT_PASSWORD_HASH='$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZRGdjGj/n3/ItB/XBG/eCknfIrqS6'
fi

# Run the SQL initialization
mysql -u root -p"${MYSQL_ROOT_PASSWORD}" openchat <<EOF
-- Users table
CREATE TABLE IF NOT EXISTS users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    email VARCHAR(255) DEFAULT NULL,
    phone VARCHAR(32) DEFAULT NULL,
    display_name VARCHAR(128) NOT NULL DEFAULT '',
    avatar_url VARCHAR(512) DEFAULT NULL,
    account_type ENUM('human','bot','service') NOT NULL DEFAULT 'human',
    bot_disclose TINYINT(1) NOT NULL DEFAULT 0,
    pass_hash VARBINARY(128) NOT NULL,
    state TINYINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_users_account_type (account_type),
    INDEX idx_users_phone (phone),
    INDEX idx_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Friends table
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
    FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Topics table
CREATE TABLE IF NOT EXISTS topics (
    id VARCHAR(64) PRIMARY KEY,
    type ENUM('p2p','group') NOT NULL DEFAULT 'p2p',
    name VARCHAR(128) DEFAULT '',
    owner_id BIGINT DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_topics_type (type),
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    topic_id VARCHAR(64) NOT NULL,
    from_uid BIGINT NOT NULL,
    content TEXT NOT NULL,
    msg_type ENUM('text','image','voice','file') NOT NULL DEFAULT 'text',
    reply_to BIGINT DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_messages_topic (topic_id, created_at),
    FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE CASCADE,
    FOREIGN KEY (from_uid) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bot config table
CREATE TABLE IF NOT EXISTS bot_config (
    user_id BIGINT PRIMARY KEY,
    api_endpoint VARCHAR(512) DEFAULT '',
    model VARCHAR(128) DEFAULT '',
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    api_key VARCHAR(128) DEFAULT NULL,
    config JSON DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rate limits table
CREATE TABLE IF NOT EXISTS rate_limits (
    account_type ENUM('human','bot','service') PRIMARY KEY,
    max_per_second INT NOT NULL DEFAULT 10,
    max_per_minute INT NOT NULL DEFAULT 120,
    burst_size INT NOT NULL DEFAULT 20
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Groups table
CREATE TABLE IF NOT EXISTS \`groups\` (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    owner_id BIGINT NOT NULL,
    avatar_url VARCHAR(512) DEFAULT NULL,
    announcement TEXT DEFAULT NULL,
    max_members INT NOT NULL DEFAULT 200,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Group members table
CREATE TABLE IF NOT EXISTS group_members (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    group_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    role ENUM('owner','admin','member') NOT NULL DEFAULT 'member',
    muted TINYINT(1) NOT NULL DEFAULT 0,
    joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_group_user (group_id, user_id),
    INDEX idx_gm_user (user_id),
    FOREIGN KEY (group_id) REFERENCES \`groups\`(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Default rate limits
INSERT INTO rate_limits (account_type, max_per_second, max_per_minute, burst_size) VALUES
  ('human', 10, 120, 20),
  ('bot', 5, 60, 10),
  ('service', 20, 300, 50)
ON DUPLICATE KEY UPDATE max_per_second=VALUES(max_per_second);

-- Default AI assistant bot account (only if not exists)
INSERT IGNORE INTO users (username, display_name, account_type, pass_hash, state) VALUES
  ('ai_assistant', 'AI 助手', 'bot', '${BOT_PASSWORD_HASH}', 0);

INSERT IGNORE INTO bot_config (user_id, api_endpoint, model, enabled)
  SELECT id, '', 'gpt-3.5-turbo', 1 FROM users WHERE username = 'ai_assistant';
EOF

echo "Database initialization complete."
