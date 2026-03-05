// Package server implements Cats Company authentication middleware with JWT and API Key.
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/openchat/openchat/server/db/mysql"
	"github.com/openchat/openchat/server/store/types"
)

// jwtSecret is the signing key. In production, load from env/config.
var jwtSecret []byte

func init() {
	// Generate a random secret on startup. Override with OC_JWT_SECRET env var.
	b := make([]byte, 32)
	rand.Read(b)
	jwtSecret = b
}

// SetJWTSecret allows overriding the JWT secret (e.g., from env).
func SetJWTSecret(secret string) {
	if secret != "" {
		jwtSecret = []byte(secret)
	}
}

// JWTClaims defines the claims stored in the token.
type JWTClaims struct {
	UID      int64  `json:"uid"`
	Username string `json:"username"`
	jwt.RegisteredClaims
}

// GenerateToken creates a signed JWT for the given user.
func GenerateToken(uid int64, username string) (string, error) {
	claims := JWTClaims{
		UID:      uid,
		Username: username,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(7 * 24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "catscompany",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(jwtSecret)
}

// GenerateRefreshToken creates a long-lived refresh token.
func GenerateRefreshToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// ParseToken validates a JWT and returns the claims.
func ParseToken(tokenStr string) (*JWTClaims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &JWTClaims{}, func(t *jwt.Token) (interface{}, error) {
		return jwtSecret, nil
	})
	if err != nil {
		return nil, err
	}
	if claims, ok := token.Claims.(*JWTClaims); ok && token.Valid {
		return claims, nil
	}
	return nil, jwt.ErrSignatureInvalid
}

// GenerateAPIKey creates an API Key for a bot with the given uid.
// Format: "cc_" + hex(uid) + "_" + random(32bytes)
func GenerateAPIKey(uid int64) string {
	b := make([]byte, 32)
	rand.Read(b)
	return fmt.Sprintf("cc_%x_%s", uid, hex.EncodeToString(b))
}

// ParseAPIKey validates an API Key format and extracts the uid.
// It only parses the format; the caller must verify the key exists in the database.
func ParseAPIKey(key string) (int64, error) {
	if !strings.HasPrefix(key, "cc_") {
		return 0, fmt.Errorf("invalid api key prefix")
	}
	rest := key[3:] // strip "cc_"
	idx := strings.Index(rest, "_")
	if idx <= 0 {
		return 0, fmt.Errorf("invalid api key format")
	}
	uidHex := rest[:idx]
	uid, err := strconv.ParseInt(uidHex, 16, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid uid in api key: %w", err)
	}
	return uid, nil
}

type contextKey string

const uidKey contextKey = "uid"
const usernameKey contextKey = "username"

func contextWithClaims(ctx context.Context, claims *JWTClaims) context.Context {
	ctx = context.WithValue(ctx, uidKey, claims.UID)
	ctx = context.WithValue(ctx, usernameKey, claims.Username)
	return ctx
}

// AuthMiddleware extracts the JWT token and sets uid in context.
func AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tokenStr := extractToken(r)
		if tokenStr == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}

		claims, err := ParseToken(tokenStr)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid or expired token"})
			return
		}

		ctx := contextWithClaims(r.Context(), claims)
		next(w, r.WithContext(ctx))
	}
}

// AuthMiddlewareWithDB returns an auth middleware that accepts both JWT and API Key.
// JWT is tried first; on failure, it falls back to API Key authentication.
func AuthMiddlewareWithDB(db *mysql.Adapter) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			// Try JWT first
			tokenStr := extractToken(r)
			if tokenStr != "" {
				claims, err := ParseToken(tokenStr)
				if err == nil {
					ctx := contextWithClaims(r.Context(), claims)
					next(w, r.WithContext(ctx))
					return
				}
			}

			// Fallback: API Key from header or query param
			apiKey := extractAPIKey(r)
			if apiKey != "" {
				parsedUID, err := ParseAPIKey(apiKey)
				if err == nil {
					botUID, err := db.GetBotByAPIKey(apiKey)
					if err == nil && botUID == parsedUID {
						ctx := context.WithValue(r.Context(), uidKey, parsedUID)
						next(w, r.WithContext(ctx))
						return
					}
				}
			}

			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		}
	}
}

func ownerClaimsFromRequest(r *http.Request, lookupUser func(int64) (*types.User, error)) (*JWTClaims, int, string) {
	tokenStr := extractToken(r)
	if tokenStr == "" {
		return nil, http.StatusUnauthorized, "unauthorized"
	}

	claims, err := ParseToken(tokenStr)
	if err != nil {
		return nil, http.StatusUnauthorized, "invalid or expired token"
	}

	user, err := lookupUser(claims.UID)
	if err != nil || user == nil {
		return nil, http.StatusUnauthorized, "invalid or expired token"
	}

	if user.AccountType != types.AccountHuman {
		return nil, http.StatusForbidden, "owner access requires a human user token"
	}

	return claims, 0, ""
}

// OwnerMiddlewareWithDB requires a valid human-user JWT.
// It is intended for owner-management endpoints, not bot runtime endpoints.
func OwnerMiddlewareWithDB(db *mysql.Adapter) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			claims, status, msg := ownerClaimsFromRequest(r, db.GetUser)
			if status != 0 {
				writeJSON(w, status, map[string]string{"error": msg})
				return
			}

			ctx := contextWithClaims(r.Context(), claims)
			next(w, r.WithContext(ctx))
		}
	}
}

// AdminMiddleware requires a valid JWT and a username listed in OC_ADMIN_USERNAMES.
func AdminMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tokenStr := extractToken(r)
		if tokenStr == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}

		claims, err := ParseToken(tokenStr)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid or expired token"})
			return
		}

		if !isAdminUsername(claims.Username) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin access required"})
			return
		}

		ctx := contextWithClaims(r.Context(), claims)
		next(w, r.WithContext(ctx))
	}
}

// UIDFromContext extracts the user ID from the request context.
func UIDFromContext(ctx context.Context) int64 {
	uid, _ := ctx.Value(uidKey).(int64)
	return uid
}

// UsernameFromContext extracts the username from the request context.
func UsernameFromContext(ctx context.Context) string {
	username, _ := ctx.Value(usernameKey).(string)
	return username
}

// extractToken gets the token from Authorization header or query param.
func extractToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	return r.URL.Query().Get("token")
}

// extractAPIKey gets the API key from Authorization header or query param.
func extractAPIKey(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "ApiKey ") {
		return strings.TrimPrefix(auth, "ApiKey ")
	}
	return r.URL.Query().Get("api_key")
}

func isAdminUsername(username string) bool {
	if username == "" {
		return false
	}

	allowed := os.Getenv("OC_ADMIN_USERNAMES")
	if allowed == "" {
		return false
	}

	for _, candidate := range strings.Split(allowed, ",") {
		if strings.TrimSpace(candidate) == username {
			return true
		}
	}
	return false
}
