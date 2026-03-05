// Package mysql - Cats Company group database operations.
package mysql

import (
	"fmt"

	"github.com/openchat/openchat/server/store/types"
)

// CreateGroup creates a new group, adds the owner as a member, and creates the group topic.
// Returns the new group ID.
func (a *Adapter) CreateGroup(name string, ownerID int64) (int64, error) {
	tx, err := a.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("create group begin tx: %w", err)
	}
	defer tx.Rollback()

	res, err := tx.Exec(
		"INSERT INTO `groups` (name, owner_id) VALUES (?, ?)",
		name, ownerID,
	)
	if err != nil {
		return 0, fmt.Errorf("create group insert: %w", err)
	}
	groupID, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("create group last id: %w", err)
	}

	// Add owner as member with role "owner"
	_, err = tx.Exec(
		"INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'owner')",
		groupID, ownerID,
	)
	if err != nil {
		return 0, fmt.Errorf("create group add owner: %w", err)
	}

	// Create the group topic
	topicID := fmt.Sprintf("grp_%d", groupID)
	_, err = tx.Exec(
		"INSERT IGNORE INTO topics (id, type, name, owner_id) VALUES (?, 'group', ?, ?)",
		topicID, name, ownerID,
	)
	if err != nil {
		return 0, fmt.Errorf("create group topic: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("create group commit: %w", err)
	}
	return groupID, nil
}

// GetGroup returns a group by ID.
func (a *Adapter) GetGroup(groupID int64) (*types.Group, error) {
	g := &types.Group{}
	var avatarURL *string
	var announcement *string
	err := a.db.QueryRow(
		"SELECT id, name, owner_id, avatar_url, announcement, max_members, created_at FROM `groups` WHERE id = ?",
		groupID,
	).Scan(&g.ID, &g.Name, &g.OwnerID, &avatarURL, &announcement, &g.MaxMembers, &g.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("get group: %w", err)
	}
	if avatarURL != nil {
		g.AvatarURL = *avatarURL
	}
	if announcement != nil {
		g.Announcement = *announcement
	}
	return g, nil
}

// AddGroupMember adds a user to a group with the given role.
func (a *Adapter) AddGroupMember(groupID, userID int64, role string) error {
	_, err := a.db.Exec(
		"INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)",
		groupID, userID, role,
	)
	if err != nil {
		return fmt.Errorf("add group member: %w", err)
	}
	return nil
}

// RemoveGroupMember removes a user from a group.
func (a *Adapter) RemoveGroupMember(groupID, userID int64) error {
	_, err := a.db.Exec(
		"DELETE FROM group_members WHERE group_id = ? AND user_id = ?",
		groupID, userID,
	)
	if err != nil {
		return fmt.Errorf("remove group member: %w", err)
	}
	return nil
}

// GetGroupMembers returns all members of a group with user info.
func (a *Adapter) GetGroupMembers(groupID int64) ([]*types.GroupMember, error) {
	rows, err := a.db.Query(
		`SELECT gm.id, gm.group_id, gm.user_id, gm.role, gm.joined_at,
		        u.username, u.display_name, u.avatar_url,
		        u.account_type, COALESCE(u.bot_disclose, 0)
		 FROM group_members gm
		 JOIN users u ON u.id = gm.user_id
		 WHERE gm.group_id = ?
		 ORDER BY gm.joined_at ASC`,
		groupID,
	)
	if err != nil {
		return nil, fmt.Errorf("get group members: %w", err)
	}
	defer rows.Close()

	var members []*types.GroupMember
	for rows.Next() {
		m := &types.GroupMember{}
		var avatarURL *string
		var acctType string
		var botDisclose bool
		if err := rows.Scan(&m.ID, &m.GroupID, &m.UserID, &m.Role, &m.JoinedAt,
			&m.Username, &m.DisplayName, &avatarURL, &acctType, &botDisclose); err != nil {
			return nil, fmt.Errorf("scan group member: %w", err)
		}
		if avatarURL != nil {
			m.AvatarURL = *avatarURL
		}
		if botDisclose && acctType == "bot" {
			m.IsBot = true
		}
		members = append(members, m)
	}
	return members, rows.Err()
}

// GetUserGroups returns all groups a user belongs to.
func (a *Adapter) GetUserGroups(userID int64) ([]*types.Group, error) {
	rows, err := a.db.Query(
		`SELECT g.id, g.name, g.owner_id, g.avatar_url, g.max_members, g.created_at
		 FROM `+"`groups`"+` g
		 JOIN group_members gm ON gm.group_id = g.id
		 WHERE gm.user_id = ?
		 ORDER BY g.created_at DESC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("get user groups: %w", err)
	}
	defer rows.Close()

	var groups []*types.Group
	for rows.Next() {
		g := &types.Group{}
		var avatarURL *string
		if err := rows.Scan(&g.ID, &g.Name, &g.OwnerID, &avatarURL, &g.MaxMembers, &g.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan group: %w", err)
		}
		if avatarURL != nil {
			g.AvatarURL = *avatarURL
		}
		groups = append(groups, g)
	}
	return groups, rows.Err()
}

// IsGroupMember checks if a user is a member of a group.
func (a *Adapter) IsGroupMember(groupID, userID int64) (bool, error) {
	var count int
	err := a.db.QueryRow(
		"SELECT COUNT(*) FROM group_members WHERE group_id = ? AND user_id = ?",
		groupID, userID,
	).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("is group member: %w", err)
	}
	return count > 0, nil
}

// GetGroupMemberCount returns the number of members in a group.
func (a *Adapter) GetGroupMemberCount(groupID int64) (int, error) {
	var count int
	err := a.db.QueryRow(
		"SELECT COUNT(*) FROM group_members WHERE group_id = ?",
		groupID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("get group member count: %w", err)
	}
	return count, nil
}

// GetGroupBotCount returns the number of bot members in a group.
func (a *Adapter) GetGroupBotCount(groupID int64) (int, error) {
	var count int
	err := a.db.QueryRow(
		`SELECT COUNT(*) FROM group_members gm
		 JOIN users u ON u.id = gm.user_id
		 WHERE gm.group_id = ? AND u.account_type = 'bot'`,
		groupID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("get group bot count: %w", err)
	}
	return count, nil
}

// UpdateMemberRole updates a member's role in a group.
func (a *Adapter) UpdateMemberRole(groupID, userID int64, role string) error {
	_, err := a.db.Exec(
		"UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?",
		role, groupID, userID,
	)
	if err != nil {
		return fmt.Errorf("update member role: %w", err)
	}
	return nil
}

// DeleteGroup deletes a group and all its members (cascade).
func (a *Adapter) DeleteGroup(groupID int64) error {
	tx, err := a.db.Begin()
	if err != nil {
		return fmt.Errorf("delete group begin tx: %w", err)
	}
	defer tx.Rollback()

	topicID := fmt.Sprintf("grp_%d", groupID)

	// Delete messages for this topic
	_, _ = tx.Exec("DELETE FROM messages WHERE topic_id = ?", topicID)

	// Delete the topic
	_, _ = tx.Exec("DELETE FROM topics WHERE id = ?", topicID)

	// Delete group (cascades to group_members)
	_, err = tx.Exec("DELETE FROM `groups` WHERE id = ?", groupID)
	if err != nil {
		return fmt.Errorf("delete group: %w", err)
	}

	return tx.Commit()
}

// GetMemberRole returns the role of a user in a group, or empty string if not a member.
func (a *Adapter) GetMemberRole(groupID, userID int64) (string, error) {
	var role string
	err := a.db.QueryRow(
		"SELECT role FROM group_members WHERE group_id = ? AND user_id = ?",
		groupID, userID,
	).Scan(&role)
	if err != nil {
		return "", err
	}
	return role, nil
}

// IsMemberMuted checks if a member is muted in a group.
func (a *Adapter) IsMemberMuted(groupID, userID int64) (bool, error) {
	var muted bool
	err := a.db.QueryRow(
		"SELECT COALESCE(muted, 0) FROM group_members WHERE group_id = ? AND user_id = ?",
		groupID, userID,
	).Scan(&muted)
	if err != nil {
		return false, err
	}
	return muted, nil
}

// SetMemberMuted sets the muted status for a group member.
func (a *Adapter) SetMemberMuted(groupID, userID int64, muted bool) error {
	_, err := a.db.Exec(
		"UPDATE group_members SET muted = ? WHERE group_id = ? AND user_id = ?",
		muted, groupID, userID,
	)
	if err != nil {
		return fmt.Errorf("set member muted: %w", err)
	}
	return nil
}

// CanManageMember checks if actor can manage target in a group.
// Returns true if actor is owner, or if actor is admin and target is member.
func (a *Adapter) CanManageMember(groupID, actorID, targetID int64) (bool, error) {
	actorRole, err := a.GetMemberRole(groupID, actorID)
	if err != nil {
		return false, err
	}
	targetRole, err := a.GetMemberRole(groupID, targetID)
	if err != nil {
		return false, err
	}

	// Owner can manage anyone
	if actorRole == "owner" {
		return true, nil
	}
	// Admin can manage members (but not owner or other admins)
	if actorRole == "admin" && targetRole == "member" {
		return true, nil
	}
	return false, nil
}

// SetGroupAnnouncement sets the announcement text for a group.
func (a *Adapter) SetGroupAnnouncement(groupID int64, announcement string) error {
	_, err := a.db.Exec(
		"UPDATE `groups` SET announcement = ? WHERE id = ?",
		announcement, groupID,
	)
	if err != nil {
		return fmt.Errorf("set group announcement: %w", err)
	}
	return nil
}

// UpdateGroupProfile updates mutable group profile fields and keeps the topic name in sync.
func (a *Adapter) UpdateGroupProfile(groupID int64, name, avatarURL string) error {
	tx, err := a.db.Begin()
	if err != nil {
		return fmt.Errorf("update group begin tx: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		"UPDATE `groups` SET name = ?, avatar_url = ? WHERE id = ?",
		name, avatarURL, groupID,
	); err != nil {
		return fmt.Errorf("update group profile: %w", err)
	}

	topicID := fmt.Sprintf("grp_%d", groupID)
	if _, err := tx.Exec(
		"UPDATE topics SET name = ? WHERE id = ?",
		name, topicID,
	); err != nil {
		return fmt.Errorf("update group topic: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("update group commit: %w", err)
	}
	return nil
}

// IsUserBot checks if a user has account_type = 'bot'.
func (a *Adapter) IsUserBot(userID int64) (bool, error) {
	var acctType string
	err := a.db.QueryRow(
		"SELECT account_type FROM users WHERE id = ?",
		userID,
	).Scan(&acctType)
	if err != nil {
		return false, err
	}
	return acctType == "bot", nil
}

// SaveMessageWithReply inserts a message with an optional reply_to reference.
func (a *Adapter) SaveMessageWithReply(topicID string, fromUID int64, content, msgType string, replyTo int64) (int64, error) {
	var res interface{ LastInsertId() (int64, error) }
	var err error
	if replyTo > 0 {
		res2, err2 := a.db.Exec(
			"INSERT INTO messages (topic_id, from_uid, content, msg_type, reply_to) VALUES (?, ?, ?, ?, ?)",
			topicID, fromUID, content, msgType, replyTo,
		)
		res = res2
		err = err2
	} else {
		res2, err2 := a.db.Exec(
			"INSERT INTO messages (topic_id, from_uid, content, msg_type) VALUES (?, ?, ?, ?)",
			topicID, fromUID, content, msgType,
		)
		res = res2
		err = err2
	}
	if err != nil {
		return 0, fmt.Errorf("save message with reply: %w", err)
	}
	return res.LastInsertId()
}
