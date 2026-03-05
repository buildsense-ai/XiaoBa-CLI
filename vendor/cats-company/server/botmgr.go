// Package server implements Cats Company bot management REST API.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"

	"golang.org/x/crypto/bcrypt"

	"github.com/openchat/openchat/server/db/mysql"
	"github.com/openchat/openchat/server/store/types"
)

// BotHandler handles bot management API requests.
type BotHandler struct {
	db       *mysql.Adapter
	deployer *Deployer // nil = deploy functionality not available
}

// NewBotHandler creates a new BotHandler.
func NewBotHandler(db *mysql.Adapter, deployer *Deployer) *BotHandler {
	return &BotHandler{db: db, deployer: deployer}
}

// HandleBotsRouter routes /api/bots by HTTP method.
func (h *BotHandler) HandleBotsRouter(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.HandleListMyBots(w, r)
	case http.MethodPost:
		h.HandleCreateBot(w, r)
	case http.MethodDelete:
		h.HandleDeleteBot(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

// BotRegisterRequest is the JSON body for bot registration.
type BotRegisterRequest struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Password    string `json:"password"`
	Model       string `json:"model,omitempty"`
	APIEndpoint string `json:"api_endpoint,omitempty"`
}

// HandleRegisterBot handles POST /api/admin/bots - register a new bot account.
func (h *BotHandler) HandleRegisterBot(w http.ResponseWriter, r *http.Request) {
	var req BotRegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	if len(req.Username) < 3 || len(req.Password) < 6 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "username min 3, password min 6"})
		return
	}

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

	user := &types.User{
		Username:    req.Username,
		DisplayName: req.DisplayName,
		AccountType: types.AccountBot,
		PassHash:    hash,
	}

	uid, err := h.db.CreateUser(user)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "registration failed"})
		return
	}

	// Save bot config
	if err := h.db.SaveBotConfig(uid, req.APIEndpoint, req.Model); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "config save failed"})
		return
	}

	// Generate and store API key
	apiKey := GenerateAPIKey(uid)
	if err := h.db.SaveAPIKey(uid, apiKey); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "api key save failed"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"uid":      uid,
		"username": req.Username,
		"type":     "bot",
		"api_key":  apiKey,
	})
}

// HandleListBots handles GET /api/admin/bots
func (h *BotHandler) HandleListBots(w http.ResponseWriter, r *http.Request) {
	bots, err := h.db.ListBots()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list bots"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"bots": bots})
}

// HandleToggleBot handles POST /api/admin/bots/:id/toggle
func (h *BotHandler) HandleToggleBot(w http.ResponseWriter, r *http.Request) {
	uidStr := r.URL.Query().Get("uid")
	uid, err := strconv.ParseInt(uidStr, 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid uid"})
		return
	}

	if err := h.db.ToggleBotEnabled(uid); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "toggle failed"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "toggled"})
}

// HandleRotateAPIKey handles POST /api/admin/bots/rotate-key?uid=xxx
// Generates a new API key for the specified bot, invalidating the old one.
func (h *BotHandler) HandleRotateAPIKey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	uidStr := r.URL.Query().Get("uid")
	uid, err := strconv.ParseInt(uidStr, 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid uid"})
		return
	}

	// Verify the bot exists
	_, err = h.db.GetBotConfig(uid)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "bot not found"})
		return
	}

	// Generate and save new API key
	apiKey := GenerateAPIKey(uid)
	if err := h.db.SaveAPIKey(uid, apiKey); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "rotate failed"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"uid":     uid,
		"api_key": apiKey,
	})
}

// HandleBotDebugLog handles GET /api/admin/bots/debug?uid=xxx&limit=50
// Returns recent messages sent by the specified bot for debugging.
func (h *BotHandler) HandleBotDebugLog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	uidStr := r.URL.Query().Get("uid")
	if uidStr == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "uid parameter required"})
		return
	}
	uid, err := strconv.ParseInt(uidStr, 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid uid"})
		return
	}

	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	if limit > 200 {
		limit = 200
	}

	msgs, err := h.db.GetBotDebugMessages(uid, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to fetch debug messages"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"uid":      uid,
		"count":    len(msgs),
		"messages": msgs,
	})
}

// createBotResult holds the result of bot account creation.
type createBotResult struct {
	UID      int64
	Username string
	APIKey   string
}

func (h *BotHandler) deploymentStatus(ctx context.Context, botUID int64, tenantName string) (string, string) {
	if tenantName == "" || h.deployer == nil {
		return "", ""
	}

	apiKey, err := h.db.GetBotAPIKey(botUID)
	if err != nil {
		return "unknown", fmt.Sprintf("failed to load bot api key: %v", err)
	}
	if apiKey == "" {
		return "unknown", "missing bot api key"
	}

	status, err := h.deployer.Status(ctx, tenantName, apiKey)
	if err != nil {
		return "unknown", err.Error()
	}
	return status, ""
}

// createBotAccount is the shared logic for creating a bot account with owner.
func (h *BotHandler) createBotAccount(ownerUID int64, req BotRegisterRequest) (*createBotResult, int, error) {
	if len(req.Username) < 3 {
		return nil, http.StatusBadRequest, fmt.Errorf("username min 3 chars")
	}

	existing, err := h.db.GetUserByUsername(req.Username)
	if err != nil {
		return nil, http.StatusInternalServerError, fmt.Errorf("database error")
	}
	if existing != nil {
		return nil, http.StatusConflict, fmt.Errorf("username taken")
	}

	randPass := GenerateAPIKey(0)
	hash, err := bcrypt.GenerateFromPassword([]byte(randPass), bcrypt.DefaultCost)
	if err != nil {
		return nil, http.StatusInternalServerError, fmt.Errorf("internal error")
	}

	displayName := req.DisplayName
	if displayName == "" {
		displayName = req.Username
	}

	user := &types.User{
		Username:    req.Username,
		DisplayName: displayName,
		AccountType: types.AccountBot,
		PassHash:    hash,
	}

	uid, err := h.db.CreateUser(user)
	if err != nil {
		return nil, http.StatusInternalServerError, fmt.Errorf("registration failed")
	}

	if err := h.db.SaveBotConfigWithOwner(uid, ownerUID, req.APIEndpoint, req.Model); err != nil {
		return nil, http.StatusInternalServerError, fmt.Errorf("config save failed")
	}

	apiKey := GenerateAPIKey(uid)
	if err := h.db.SaveAPIKey(uid, apiKey); err != nil {
		return nil, http.StatusInternalServerError, fmt.Errorf("api key save failed")
	}

	return &createBotResult{UID: uid, Username: req.Username, APIKey: apiKey}, 0, nil
}

// HandleCreateBot handles POST /api/bots — authenticated user creates a bot they own.
func (h *BotHandler) HandleCreateBot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	ownerUID := UIDFromContext(r.Context())
	if ownerUID == 0 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req BotRegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	result, status, err := h.createBotAccount(ownerUID, req)
	if err != nil {
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"uid":      result.UID,
		"username": result.Username,
		"type":     "bot",
		"owner_id": ownerUID,
		"api_key":  result.APIKey,
	})
}

// HandleDeployBot handles POST /api/bots/deploy — create bot + deploy container via gauz-platform.
func (h *BotHandler) HandleDeployBot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	if h.deployer == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "deploy not available"})
		return
	}

	ownerUID := UIDFromContext(r.Context())
	if ownerUID == 0 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req BotRegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	result, status, err := h.createBotAccount(ownerUID, req)
	if err != nil {
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}

	tenantName := fmt.Sprintf("bot-%s", result.Username)

	if err := h.deployer.Deploy(r.Context(), tenantName, result.APIKey); err != nil {
		log.Printf("[deploy] failed for tenant %s: %v", tenantName, err)
		if rollbackErr := h.db.DeleteBot(result.UID); rollbackErr != nil {
			log.Printf("[deploy] rollback delete for uid %d failed: %v", result.UID, rollbackErr)
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to deploy managed bot"})
		return
	}

	if err := h.db.SetTenantName(result.UID, tenantName); err != nil {
		log.Printf("[deploy] failed to save tenant_name for uid %d: %v", result.UID, err)
		if removeErr := h.deployer.Remove(r.Context(), tenantName, result.APIKey); removeErr != nil {
			log.Printf("[deploy] rollback remove for tenant %s failed: %v", tenantName, removeErr)
		}
		if rollbackErr := h.db.DeleteBot(result.UID); rollbackErr != nil {
			log.Printf("[deploy] rollback delete for uid %d failed: %v", result.UID, rollbackErr)
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to finalize managed bot"})
		return
	}

	friendAutoAdded := false
	if _, err := h.db.CreateFriendRequest(ownerUID, result.UID, ""); err != nil {
		log.Printf("[deploy] failed to create auto-friend request for uid %d: %v", result.UID, err)
	} else if err := h.db.AcceptFriendRequest(ownerUID, result.UID); err != nil {
		log.Printf("[deploy] failed to auto-accept friend request for uid %d: %v", result.UID, err)
	} else {
		friendAutoAdded = true
	}

	deploymentStatus, deploymentError := h.deploymentStatus(r.Context(), result.UID, tenantName)
	if deploymentStatus == "" {
		deploymentStatus = "running"
	}

	resp := map[string]interface{}{
		"uid":               result.UID,
		"username":          result.Username,
		"type":              "bot",
		"owner_id":          ownerUID,
		"tenant_name":       tenantName,
		"deployment_status": deploymentStatus,
		"friend_auto_added": friendAutoAdded,
	}
	if deploymentError != "" {
		resp["deployment_error"] = deploymentError
	}
	writeJSON(w, http.StatusCreated, resp)
}

// HandleListMyBots handles GET /api/bots — list bots owned by the authenticated user.
func (h *BotHandler) HandleListMyBots(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	ownerUID := UIDFromContext(r.Context())
	if ownerUID == 0 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	bots, err := h.db.ListBotsByOwner(ownerUID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list bots"})
		return
	}
	if bots == nil {
		bots = []map[string]interface{}{}
	}
	for _, bot := range bots {
		tenantName, _ := bot["tenant_name"].(string)
		if tenantName == "" {
			continue
		}
		botUID, ok := bot["id"].(int64)
		if !ok {
			continue
		}
		status, deployErr := h.deploymentStatus(r.Context(), botUID, tenantName)
		if status == "" {
			status = "unknown"
		}
		bot["deployment_status"] = status
		if deployErr != "" {
			bot["deployment_error"] = deployErr
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"bots": bots})
}

// HandleDeleteBot handles DELETE /api/bots?uid=xxx — owner deletes their bot.
func (h *BotHandler) HandleDeleteBot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	ownerUID := UIDFromContext(r.Context())
	if ownerUID == 0 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	uidStr := r.URL.Query().Get("uid")
	botUID, err := strconv.ParseInt(uidStr, 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid uid"})
		return
	}

	// Verify ownership
	actualOwner, err := h.db.GetBotOwner(botUID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "bot not found"})
		return
	}
	if actualOwner != ownerUID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not your bot"})
		return
	}

	// Check if this bot has a managed deployment
	tenantName, _ := h.db.GetTenantName(botUID)
	apiKey, _ := h.db.GetBotAPIKey(botUID)

	if tenantName != "" && h.deployer != nil {
		if apiKey == "" {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "managed bot missing api key"})
			return
		}
		if err := h.deployer.Remove(r.Context(), tenantName, apiKey); err != nil {
			log.Printf("[deploy] remove %s failed before delete: %v", tenantName, err)
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to remove managed deployment"})
			return
		}
	}

	if err := h.db.DeleteBot(botUID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "delete failed"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// HandleSetBotVisibility handles PATCH /api/bots/visibility?uid=xxx&v=public|private
func (h *BotHandler) HandleSetBotVisibility(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch && r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	ownerUID := UIDFromContext(r.Context())
	if ownerUID == 0 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	uidStr := r.URL.Query().Get("uid")
	botUID, err := strconv.ParseInt(uidStr, 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid uid"})
		return
	}

	vis := r.URL.Query().Get("v")
	if vis != "public" && vis != "private" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "v must be public or private"})
		return
	}

	// Verify ownership
	actualOwner, err := h.db.GetBotOwner(botUID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "bot not found"})
		return
	}
	if actualOwner != ownerUID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not your bot"})
		return
	}

	if err := h.db.SetBotVisibility(botUID, vis); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "update failed"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"uid":        botUID,
		"visibility": vis,
	})
}

var globalBotStats *BotStats

// SetBotStats sets the global bot stats reference for the API.
func SetBotStats(bs *BotStats) {
	globalBotStats = bs
}

// HandleBotStats handles GET /api/admin/bots/stats
func (h *BotHandler) HandleBotStats(w http.ResponseWriter, r *http.Request) {
	if globalBotStats == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "stats not available"})
		return
	}
	uidStr := r.URL.Query().Get("uid")
	if uidStr != "" {
		uid, err := strconv.ParseInt(uidStr, 10, 64)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid uid"})
			return
		}
		writeJSON(w, http.StatusOK, globalBotStats.GetBotStats(uid))
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"bots": globalBotStats.GetStats()})
}

// HandleUpdateBotAvatar handles POST /api/bots/avatar
func (h *BotHandler) HandleUpdateBotAvatar(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	ownerUID := UIDFromContext(r.Context())
	if ownerUID == 0 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	uidStr := r.URL.Query().Get("uid")
	botUID, err := strconv.ParseInt(uidStr, 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid uid"})
		return
	}

	// Verify ownership
	actualOwner, err := h.db.GetBotOwner(botUID)
	if err != nil || actualOwner != ownerUID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not your bot"})
		return
	}

	// Parse multipart form
	if err := r.ParseMultipartForm(10 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid form"})
		return
	}

	avatarURL := r.FormValue("avatar_url")
	if avatarURL == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "avatar_url required"})
		return
	}

	// Update avatar
	if err := h.db.UpdateUserAvatar(botUID, avatarURL); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "update failed"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"avatar_url": avatarURL})
}
