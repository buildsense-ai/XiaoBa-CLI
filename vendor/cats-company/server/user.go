// Package server implements Cats Company user registration and authentication.
package server

import (
	"encoding/json"
	"net/http"

	"golang.org/x/crypto/bcrypt"

	"github.com/openchat/openchat/server/db/mysql"
	"github.com/openchat/openchat/server/store/types"
)

// UserHandler handles user-related API requests.
type UserHandler struct {
	db *mysql.Adapter
}

// NewUserHandler creates a new UserHandler.
func NewUserHandler(db *mysql.Adapter) *UserHandler {
	return &UserHandler{db: db}
}

// RegisterRequest is the JSON body for user registration.
type RegisterRequest struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email,omitempty"`
	Phone       string `json:"phone,omitempty"`
}

// LoginRequest is the JSON body for login.
type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// UpdateProfileRequest is the JSON body for updating the current user's profile.
type UpdateProfileRequest struct {
	DisplayName string `json:"display_name"`
	AvatarURL   string `json:"avatar_url"`
}

// HandleRegister handles POST /api/auth/register
func (h *UserHandler) HandleRegister(w http.ResponseWriter, r *http.Request) {
	var req RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	if len(req.Username) < 3 || len(req.Password) < 6 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "username min 3 chars, password min 6 chars"})
		return
	}

	// Check if username exists
	existing, err := h.db.GetUserByUsername(req.Username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "database error"})
		return
	}
	if existing != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "username taken"})
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	displayName := req.DisplayName
	if displayName == "" {
		displayName = req.Username
	}

	user := &types.User{
		Username:    req.Username,
		Email:       req.Email,
		Phone:       req.Phone,
		DisplayName: displayName,
		AccountType: types.AccountHuman,
		PassHash:    hash,
	}

	uid, err := h.db.CreateUser(user)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "registration failed"})
		return
	}

	token, err := GenerateToken(uid, req.Username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "token generation failed"})
		return
	}

	// Auto-add default AI assistant as friend
	autoAddAssistantFriend(h.db, uid)

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"token":        token,
		"uid":          uid,
		"username":     req.Username,
		"display_name": displayName,
		"avatar_url":   user.AvatarURL,
		"account_type": user.AccountType,
	})
}

// HandleLogin handles POST /api/auth/login
func (h *UserHandler) HandleLogin(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	user, err := h.db.GetUserByUsername(req.Username)
	if err != nil || user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}

	if err := bcrypt.CompareHashAndPassword(user.PassHash, []byte(req.Password)); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}

	token, err := GenerateToken(user.ID, user.Username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "token generation failed"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"token":        token,
		"uid":          user.ID,
		"username":     user.Username,
		"display_name": user.DisplayName,
		"avatar_url":   user.AvatarURL,
		"account_type": user.AccountType,
	})
}

// HandleMe handles GET /api/me — returns the authenticated user's profile.
func (h *UserHandler) HandleMe(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())
	if uid == 0 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	user, err := h.db.GetUser(uid)
	if err != nil || user == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"uid":          user.ID,
		"username":     user.Username,
		"display_name": user.DisplayName,
		"avatar_url":   user.AvatarURL,
		"account_type": user.AccountType,
		"created_at":   user.CreatedAt,
	})
}

// HandleUpdateMe handles POST /api/me/update — updates the authenticated user's profile.
func (h *UserHandler) HandleUpdateMe(w http.ResponseWriter, r *http.Request) {
	uid := UIDFromContext(r.Context())
	if uid == 0 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req UpdateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	if req.DisplayName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "display name required"})
		return
	}

	if err := h.db.UpdateUser(uid, req.DisplayName, req.AvatarURL); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update profile"})
		return
	}

	user, err := h.db.GetUser(uid)
	if err != nil || user == nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load updated profile"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"uid":          user.ID,
		"username":     user.Username,
		"display_name": user.DisplayName,
		"avatar_url":   user.AvatarURL,
		"account_type": user.AccountType,
	})
}

// autoAddAssistantFriend adds the default AI assistant as a friend for new users.
func autoAddAssistantFriend(db *mysql.Adapter, uid int64) {
	assistant, _ := db.GetUserByUsername("ai_assistant")
	if assistant != nil {
		db.CreateFriendRequest(assistant.ID, uid, "你好！我是 AI 助手，有什么可以帮你的？")
		db.AcceptFriendRequest(assistant.ID, uid)
	}
}
