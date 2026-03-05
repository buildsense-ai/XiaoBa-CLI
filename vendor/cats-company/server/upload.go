// Package server implements Cats Company file upload service.
package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	maxImageSize = 10 << 20  // 10MB
	maxFileSize  = 100 << 20 // 100MB
	uploadDir    = "uploads"
)

// Allowed image MIME types
var allowedImageTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

// Allowed file extensions (whitelist)
var allowedFileExts = map[string]bool{
	".txt": true, ".pdf": true, ".doc": true, ".docx": true,
	".xls": true, ".xlsx": true, ".ppt": true, ".pptx": true,
	".zip": true, ".rar": true, ".7z": true,
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
	".mp3": true, ".mp4": true, ".wav": true,
	".csv": true, ".json": true, ".xml": true,
	".md": true, ".go": true, ".py": true, ".js": true,
}

// UploadHandler handles file upload requests.
type UploadHandler struct {
	baseDir string
	baseURL string
}

// NewUploadHandler creates a new UploadHandler.
func NewUploadHandler(baseDir, baseURL string) *UploadHandler {
	os.MkdirAll(filepath.Join(baseDir, "images"), 0755)
	os.MkdirAll(filepath.Join(baseDir, "files"), 0755)
	return &UploadHandler{baseDir: baseDir, baseURL: baseURL}
}

// HandleUpload handles POST /api/upload
func (h *UploadHandler) HandleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeUploadJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	// Parse multipart form
	uploadType := r.URL.Query().Get("type") // "image" or "file"
	maxSize := maxFileSize
	if uploadType == "image" {
		maxSize = maxImageSize
	}

	r.Body = http.MaxBytesReader(w, r.Body, int64(maxSize))
	if err := r.ParseMultipartForm(int64(maxSize)); err != nil {
		writeUploadJSON(w, http.StatusBadRequest, map[string]string{"error": "file too large"})
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeUploadJSON(w, http.StatusBadRequest, map[string]string{"error": "no file provided"})
		return
	}
	defer file.Close()

	// Validate file extension
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !allowedFileExts[ext] {
		writeUploadJSON(w, http.StatusBadRequest, map[string]string{"error": "file type not allowed"})
		return
	}

	// For images, also validate MIME type
	if uploadType == "image" {
		contentType := header.Header.Get("Content-Type")
		if !allowedImageTypes[contentType] {
			writeUploadJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid image type"})
			return
		}
	}

	// Generate unique file key
	fileKey := generateFileKey(ext)
	subDir := "files"
	if uploadType == "image" {
		subDir = "images"
	}

	destPath := filepath.Join(h.baseDir, subDir, fileKey)
	if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
		writeUploadJSON(w, http.StatusInternalServerError, map[string]string{"error": "upload failed"})
		return
	}

	dest, err := os.Create(destPath)
	if err != nil {
		writeUploadJSON(w, http.StatusInternalServerError, map[string]string{"error": "upload failed"})
		return
	}
	defer dest.Close()

	written, err := io.Copy(dest, file)
	if err != nil {
		os.Remove(destPath)
		writeUploadJSON(w, http.StatusInternalServerError, map[string]string{"error": "upload failed"})
		return
	}

	url := fmt.Sprintf("%s/%s/%s", h.baseURL, subDir, fileKey)

	writeUploadJSON(w, http.StatusOK, map[string]interface{}{
		"file_key": fileKey,
		"url":      url,
		"name":     header.Filename,
		"size":     written,
		"type":     uploadType,
	})
}

// HandleServeFile handles GET /uploads/* - serves uploaded files.
func (h *UploadHandler) HandleServeFile(w http.ResponseWriter, r *http.Request) {
	// Strip the /uploads/ prefix
	path := strings.TrimPrefix(r.URL.Path, "/uploads/")
	if path == "" || strings.Contains(path, "..") {
		http.NotFound(w, r)
		return
	}
	fullPath := filepath.Join(h.baseDir, path)
	http.ServeFile(w, r, fullPath)
}

func generateFileKey(ext string) string {
	b := make([]byte, 16)
	rand.Read(b)
	ts := time.Now().Format("20060102")
	return fmt.Sprintf("%s_%s%s", ts, hex.EncodeToString(b), ext)
}

// writeUploadJSON writes a JSON response (local to upload to avoid conflict with friends.go writeJSON).
func writeUploadJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
