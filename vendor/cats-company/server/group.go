// Package server implements Cats Company group chat HTTP handlers.
package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/openchat/openchat/server/db/mysql"
)

// GroupHandler handles group-related API requests.
type GroupHandler struct {
	db  *mysql.Adapter
	hub *Hub
}

// NewGroupHandler creates a new GroupHandler.
func NewGroupHandler(db *mysql.Adapter, hub *Hub) *GroupHandler {
	return &GroupHandler{db: db, hub: hub}
}

// CreateGroupRequest is the JSON body for creating a group.
type CreateGroupRequest struct {
	Name      string  `json:"name"`
	MemberIDs []int64 `json:"member_ids"`
}

// GroupActionRequest is the JSON body for group member actions.
type GroupActionRequest struct {
	GroupID int64   `json:"group_id"`
	UserIDs []int64 `json:"user_ids,omitempty"`
	UserID  int64   `json:"user_id,omitempty"`
	Role    string  `json:"role,omitempty"`
}

// UpdateGroupRequest is the JSON body for updating group profile fields.
type UpdateGroupRequest struct {
	GroupID   int64  `json:"group_id"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

// HandleCreateGroup handles POST /api/groups/create
func (h *GroupHandler) HandleCreateGroup(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())

	var req CreateGroupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "group name required"})
		return
	}

	// Check total member count (creator + invited)
	if len(req.MemberIDs)+1 > 200 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "max 200 members per group"})
		return
	}

	// Count bots in the member list
	botCount := 0
	for _, mid := range req.MemberIDs {
		isBot, _ := h.db.IsUserBot(mid)
		if isBot {
			botCount++
		}
	}
	if botCount > 10 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "max 10 bots per group"})
		return
	}

	// Create the group (also creates topic and adds owner)
	groupID, err := h.db.CreateGroup(req.Name, uid)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create group"})
		return
	}

	// Add initial members
	for _, mid := range req.MemberIDs {
		if mid == uid {
			continue // owner already added
		}
		_ = h.db.AddGroupMember(groupID, mid, "member")
	}

	topicID := fmt.Sprintf("grp_%d", groupID)

	// Notify all members via WebSocket
	h.notifyGroupEvent(groupID, "group_created", map[string]interface{}{
		"group_id": groupID,
		"name":     req.Name,
		"topic":    topicID,
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"group_id": groupID,
		"topic":    topicID,
		"name":     req.Name,
	})
}

// HandleUpdateGroup handles POST /api/groups/update
func (h *GroupHandler) HandleUpdateGroup(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())

	var req UpdateGroupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	if req.GroupID == 0 || req.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "group id and name required"})
		return
	}

	role, err := h.db.GetMemberRole(req.GroupID, uid)
	if err != nil || (role != "owner" && role != "admin") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only owner or admin can update group"})
		return
	}

	if err := h.db.UpdateGroupProfile(req.GroupID, req.Name, req.AvatarURL); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update group"})
		return
	}

	group, err := h.db.GetGroup(req.GroupID)
	if err != nil || group == nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load updated group"})
		return
	}

	h.notifyGroupEvent(req.GroupID, "group_updated", map[string]interface{}{
		"group_id":   req.GroupID,
		"name":       group.Name,
		"avatar_url": group.AvatarURL,
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"group": group,
	})
}

// HandleGetGroups handles GET /api/groups
func (h *GroupHandler) HandleGetGroups(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())

	groups, err := h.db.GetUserGroups(uid)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to get groups"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"groups": groups})
}

// HandleGetGroupInfo handles GET /api/groups/info?id=xxx
func (h *GroupHandler) HandleGetGroupInfo(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())

	groupID, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid group id"})
		return
	}

	// Verify caller is a member
	isMember, err := h.db.IsGroupMember(groupID, uid)
	if err != nil || !isMember {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a group member"})
		return
	}

	group, err := h.db.GetGroup(groupID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "group not found"})
		return
	}

	members, err := h.db.GetGroupMembers(groupID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to get members"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"group":   group,
		"members": members,
	})
}

// HandleInviteMembers handles POST /api/groups/invite
func (h *GroupHandler) HandleInviteMembers(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())

	var req GroupActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	// Check caller is owner or admin
	role, err := h.db.GetMemberRole(req.GroupID, uid)
	if err != nil || (role != "owner" && role != "admin") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only owner or admin can invite"})
		return
	}

	// Check member count limit
	currentCount, _ := h.db.GetGroupMemberCount(req.GroupID)
	if currentCount+len(req.UserIDs) > 200 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "would exceed max 200 members"})
		return
	}

	// Check bot limit
	currentBots, _ := h.db.GetGroupBotCount(req.GroupID)
	newBots := 0
	for _, mid := range req.UserIDs {
		isBot, _ := h.db.IsUserBot(mid)
		if isBot {
			newBots++
		}
	}
	if currentBots+newBots > 10 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "would exceed max 10 bots"})
		return
	}

	added := 0
	for _, mid := range req.UserIDs {
		if err := h.db.AddGroupMember(req.GroupID, mid, "member"); err == nil {
			added++
		}
	}

	// Notify new members
	h.notifyGroupEvent(req.GroupID, "members_invited", map[string]interface{}{
		"group_id":  req.GroupID,
		"invited":   req.UserIDs,
		"by":        uid,
	})

	writeJSON(w, http.StatusOK, map[string]interface{}{"added": added})
}

// HandleLeaveGroup handles POST /api/groups/leave
func (h *GroupHandler) HandleLeaveGroup(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())

	var req GroupActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	// Owner cannot leave
	role, err := h.db.GetMemberRole(req.GroupID, uid)
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a group member"})
		return
	}
	if role == "owner" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "owner cannot leave, must disband or transfer"})
		return
	}

	if err := h.db.RemoveGroupMember(req.GroupID, uid); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to leave"})
		return
	}

	h.notifyGroupEvent(req.GroupID, "member_left", map[string]interface{}{
		"group_id": req.GroupID,
		"user_id":  uid,
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "left"})
}

// HandleKickMember handles POST /api/groups/kick
func (h *GroupHandler) HandleKickMember(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())

	var req GroupActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	// Check caller is owner or admin
	callerRole, err := h.db.GetMemberRole(req.GroupID, uid)
	if err != nil || (callerRole != "owner" && callerRole != "admin") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only owner or admin can kick"})
		return
	}

	// Cannot kick the owner
	targetRole, _ := h.db.GetMemberRole(req.GroupID, req.UserID)
	if targetRole == "owner" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "cannot kick the owner"})
		return
	}

	// Admin cannot kick another admin
	if callerRole == "admin" && targetRole == "admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin cannot kick another admin"})
		return
	}

	if err := h.db.RemoveGroupMember(req.GroupID, req.UserID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to kick"})
		return
	}

	h.notifyGroupEvent(req.GroupID, "member_kicked", map[string]interface{}{
		"group_id": req.GroupID,
		"user_id":  req.UserID,
		"by":       uid,
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "kicked"})
}

// HandleDisbandGroup handles POST /api/groups/disband
func (h *GroupHandler) HandleDisbandGroup(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())

	var req GroupActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	// Only owner can disband
	role, err := h.db.GetMemberRole(req.GroupID, uid)
	if err != nil || role != "owner" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only owner can disband"})
		return
	}

	// Notify before deleting
	h.notifyGroupEvent(req.GroupID, "group_disbanded", map[string]interface{}{
		"group_id": req.GroupID,
	})

	if err := h.db.DeleteGroup(req.GroupID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to disband"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "disbanded"})
}

// HandleUpdateRole handles POST /api/groups/role
func (h *GroupHandler) HandleUpdateRole(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())

	var req GroupActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	if req.Role != "admin" && req.Role != "member" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "role must be admin or member"})
		return
	}

	// Only owner can change roles
	callerRole, err := h.db.GetMemberRole(req.GroupID, uid)
	if err != nil || callerRole != "owner" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only owner can change roles"})
		return
	}

	// Cannot change owner's own role
	if req.UserID == uid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot change own role"})
		return
	}

	if err := h.db.UpdateMemberRole(req.GroupID, req.UserID, req.Role); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update role"})
		return
	}

	h.notifyGroupEvent(req.GroupID, "role_updated", map[string]interface{}{
		"group_id": req.GroupID,
		"user_id":  req.UserID,
		"role":     req.Role,
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

// notifyGroupEvent sends a real-time notification to all online group members.
func (h *GroupHandler) notifyGroupEvent(groupID int64, event string, data map[string]interface{}) {
	members, err := h.db.GetGroupMembers(groupID)
	if err != nil {
		return
	}
	msg := &ServerMessage{
		Pres: &MsgServerPres{
			Topic: fmt.Sprintf("grp_%d", groupID),
			What:  event,
			Src:   fmt.Sprintf("grp_%d", groupID),
		},
	}
	for _, m := range members {
		h.hub.SendToUser(m.UserID, msg)
	}
}

// HandleMuteMember handles POST /api/groups/mute
func (h *GroupHandler) HandleMuteMember(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())

	var req GroupActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	// Check caller can manage target
	canManage, err := h.db.CanManageMember(req.GroupID, uid, req.UserID)
	if err != nil || !canManage {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "no permission to mute"})
		return
	}

	if err := h.db.SetMemberMuted(req.GroupID, req.UserID, true); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to mute"})
		return
	}

	h.notifyGroupEvent(req.GroupID, "member_muted", map[string]interface{}{
		"group_id": req.GroupID,
		"user_id":  req.UserID,
		"by":       uid,
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "muted"})
}

// HandleUnmuteMember handles POST /api/groups/unmute
func (h *GroupHandler) HandleUnmuteMember(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())

	var req GroupActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	// Check caller can manage target
	canManage, err := h.db.CanManageMember(req.GroupID, uid, req.UserID)
	if err != nil || !canManage {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "no permission to unmute"})
		return
	}

	if err := h.db.SetMemberMuted(req.GroupID, req.UserID, false); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to unmute"})
		return
	}

	h.notifyGroupEvent(req.GroupID, "member_unmuted", map[string]interface{}{
		"group_id": req.GroupID,
		"user_id":  req.UserID,
		"by":       uid,
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "unmuted"})
}

// HandleSetAnnouncement handles POST /api/groups/announcement
func (h *GroupHandler) HandleSetAnnouncement(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())

	var req struct {
		GroupID      int64  `json:"group_id"`
		Announcement string `json:"announcement"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	// Only owner or admin can set announcement
	role, err := h.db.GetMemberRole(req.GroupID, uid)
	if err != nil || (role != "owner" && role != "admin") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only owner or admin can set announcement"})
		return
	}

	if err := h.db.SetGroupAnnouncement(req.GroupID, req.Announcement); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to set announcement"})
		return
	}

	h.notifyGroupEvent(req.GroupID, "announcement_updated", map[string]interface{}{
		"group_id":      req.GroupID,
		"announcement":  req.Announcement,
		"by":            uid,
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}
