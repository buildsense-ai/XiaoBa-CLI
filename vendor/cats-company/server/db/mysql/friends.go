// Package mysql - Cats Company friend relationship database operations.
package mysql

import (
	"fmt"

	"github.com/openchat/openchat/server/store/types"
)

// CreateFriendRequest creates a new friend request.
func (a *Adapter) CreateFriendRequest(fromUID, toUID int64, message string) (int64, error) {
	res, err := a.db.Exec(
		`INSERT INTO friends (from_user_id, to_user_id, status, message)
		 VALUES (?, ?, 'pending', ?)
		 ON DUPLICATE KEY UPDATE status = 'pending', message = ?, updated_at = CURRENT_TIMESTAMP`,
		fromUID, toUID, message, message,
	)
	if err != nil {
		return 0, fmt.Errorf("create friend request: %w", err)
	}
	return res.LastInsertId()
}

// AcceptFriendRequest accepts a pending friend request and creates the reverse relationship.
func (a *Adapter) AcceptFriendRequest(fromUID, toUID int64) error {
	tx, err := a.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Update the original request to accepted
	_, err = tx.Exec(
		`UPDATE friends SET status = 'accepted', updated_at = CURRENT_TIMESTAMP
		 WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'`,
		fromUID, toUID,
	)
	if err != nil {
		return fmt.Errorf("accept request: %w", err)
	}

	// Create the reverse relationship
	_, err = tx.Exec(
		`INSERT INTO friends (from_user_id, to_user_id, status)
		 VALUES (?, ?, 'accepted')
		 ON DUPLICATE KEY UPDATE status = 'accepted', updated_at = CURRENT_TIMESTAMP`,
		toUID, fromUID,
	)
	if err != nil {
		return fmt.Errorf("create reverse friendship: %w", err)
	}

	return tx.Commit()
}

// RejectFriendRequest rejects a pending friend request.
func (a *Adapter) RejectFriendRequest(fromUID, toUID int64) error {
	_, err := a.db.Exec(
		`UPDATE friends SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
		 WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'`,
		fromUID, toUID,
	)
	return err
}

// BlockUser blocks a user (one-directional).
func (a *Adapter) BlockUser(uid, blockedUID int64) error {
	_, err := a.db.Exec(
		`INSERT INTO friends (from_user_id, to_user_id, status)
		 VALUES (?, ?, 'blocked')
		 ON DUPLICATE KEY UPDATE status = 'blocked', updated_at = CURRENT_TIMESTAMP`,
		uid, blockedUID,
	)
	return err
}

// RemoveFriend removes a friend relationship (both directions).
func (a *Adapter) RemoveFriend(uid1, uid2 int64) error {
	_, err := a.db.Exec(
		`DELETE FROM friends WHERE
		 (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`,
		uid1, uid2, uid2, uid1,
	)
	return err
}

// GetFriends returns all accepted friends for a user.
func (a *Adapter) GetFriends(uid int64) ([]*types.User, error) {
	rows, err := a.db.Query(
		`SELECT u.id, u.username, u.display_name, COALESCE(u.avatar_url, ''),
		        u.account_type, COALESCE(u.bot_disclose, 0)
		 FROM friends f JOIN users u ON f.to_user_id = u.id
		 WHERE f.from_user_id = ? AND f.status = 'accepted'
		 ORDER BY u.display_name`,
		uid,
	)
	if err != nil {
		return nil, fmt.Errorf("get friends: %w", err)
	}
	defer rows.Close()

	var friends []*types.User
	for rows.Next() {
		u := &types.User{}
		var acctType string
		var botDisclose bool
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarURL, &acctType, &botDisclose); err != nil {
			return nil, fmt.Errorf("scan friend: %w", err)
		}
		// Only disclose bot status if bot_disclose is true
		if botDisclose && acctType == "bot" {
			u.BotDisclose = true
		}
		friends = append(friends, u)
	}
	return friends, rows.Err()
}

// GetPendingRequests returns pending friend requests sent to a user.
func (a *Adapter) GetPendingRequests(uid int64) ([]*types.FriendRequest, error) {
	rows, err := a.db.Query(
		`SELECT f.id, f.from_user_id, f.to_user_id, f.status, f.message, f.created_at,
		        u.username, COALESCE(u.display_name, '')
		 FROM friends f JOIN users u ON f.from_user_id = u.id
		 WHERE f.to_user_id = ? AND f.status = 'pending'
		 ORDER BY f.created_at DESC`,
		uid,
	)
	if err != nil {
		return nil, fmt.Errorf("get pending requests: %w", err)
	}
	defer rows.Close()

	var requests []*types.FriendRequest
	for rows.Next() {
		r := &types.FriendRequest{}
		if err := rows.Scan(&r.ID, &r.FromUserID, &r.ToUserID, &r.Status, &r.Message, &r.CreatedAt,
			&r.FromUsername, &r.DisplayName); err != nil {
			return nil, fmt.Errorf("scan request: %w", err)
		}
		requests = append(requests, r)
	}
	return requests, rows.Err()
}

// AreFriends checks if two users are friends.
func (a *Adapter) AreFriends(uid1, uid2 int64) (bool, error) {
	var count int
	err := a.db.QueryRow(
		`SELECT COUNT(*) FROM friends
		 WHERE from_user_id = ? AND to_user_id = ? AND status = 'accepted'`,
		uid1, uid2,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// IsBlocked checks if uid has blocked blockedUID.
func (a *Adapter) IsBlocked(uid, blockedUID int64) (bool, error) {
	var count int
	err := a.db.QueryRow(
		`SELECT COUNT(*) FROM friends
		 WHERE from_user_id = ? AND to_user_id = ? AND status = 'blocked'`,
		uid, blockedUID,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// Compile-time check
var _ = (*Adapter)(nil)
