// Real CatsCo upload envelope -> XiaoBa RPC/retained candidate -> local HTTPS.
// Authority and Cloud acceptance are fixtures, NOT deployed end-to-end proof.
package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/openchat/openchat/server/store"
)

func TestXiaoBaPublicationUploadPaired(t *testing.T) {
	for _, mode := range []string{"normal", "changed-source", "owner", "disabled", "cloud-reject"} {
		t.Run(mode, func(t *testing.T) {
			r := startPairedProbeRuntime(t, "normal")
			f, s := newUploadTransportFixture(t)
			f.h.userDevices.unregister(7, f.device.DeviceID)
			d, err := f.h.userDevices.register(7, RegisterUserDeviceRequest{BotUID: 42, DeviceID: "install-42", BodyID: "body-42", InstallationID: "install-42", RuntimeRole: "server", Status: "online",
				Capabilities: []string{string(DeviceCapabilitySkillHubPublicationProbe), string(DeviceCapabilitySkillHubPublicationCapture), string(DeviceCapabilitySkillHubPublicationUpload)}})
			if err != nil {
				t.Fatal(err)
			}
			f.h.bindDeviceClient(7, d, f.runtime)
			f.device = d
			source := &s.entries["capture-click"].Input.Source
			source.DeviceID, source.BodyID, source.InstallationID = d.DeviceID, d.BodyID, d.InstallationID
			source.LocalSkillID = r.source["local_skill_id"].(string)
			source.WorkspaceGeneration = r.source["workspace_generation"].(string)
			captured := pairedCaptureCall(t, f, r)
			if captured.err != nil {
				t.Fatal(captured.err)
			}
			s.record = captured.record
			var uploads atomic.Int32
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				uploads.Add(1)
				b, err := io.ReadAll(io.LimitReader(req.Body, 32*1024*1024+1))
				sum := sha256.Sum256(b)
				if err != nil || req.Method != "POST" || req.URL.Path != "/api/skills/publication-delegations/candidates" ||
					req.Header.Get("Authorization") != "Bearer pubupload_"+strings.Repeat("e", 64) ||
					req.Header.Get("Idempotency-Key") != "pubcandidate_"+strings.Repeat("f", 32) ||
					len(b) != int(s.record.Input.RequestBytes) || hex.EncodeToString(sum[:]) != s.record.Input.RequestHash {
					t.Error("upload changed captured bytes or scope")
					w.WriteHeader(400)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				if mode == "cloud-reject" {
					w.WriteHeader(422)
					_, _ = w.Write([]byte(`{"error":"fixture"}`))
					return
				}
				w.WriteHeader(201)
				_ = json.NewEncoder(w).Encode(map[string]interface{}{"schemaVersion": 1, "accepted": true, "created": true, "association": map[string]interface{}{
					"taskId": "pubtask_12345678-1234-4123-8123-123456789abc", "eventId": "pubevent_12345678-1234-4123-8123-123456789abc",
					"entryRequestId": publicationReadTestID, "candidateRevision": 1, "candidateHash": s.record.Input.SourceSnapshotHash, "requestHash": s.record.Input.RequestHash,
					"authorityEpoch": 1, "state": "delegated_pending", "candidateAvailable": true,
				}})
			}))
			defer server.Close()
			var configured struct {
				OK bool `json:"ok"`
			}
			r.call(t, map[string]interface{}{"action": "upload-config", "origin": server.URL, "ca": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}))}, &configured)
			if !configured.OK {
				t.Fatal("upload configuration")
			}
			f.h.publicationUpload = newPublicationUploadTransport(f.h, "https://cats.example", server.URL)
			switch mode {
			case "changed-source":
				r.action(t, "change")
				r.action(t, "remove")
			case "owner":
				r.action(t, "owner")
			case "disabled":
				r.action(t, "disable")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			req, done := startUploadCall(t, f, ctx)
			reply := r.probe(t, req)
			f.h.handleThinToolRPCResult(f.runtime, reply)
			result := uploadWait(t, done)
			if mode == "normal" || mode == "changed-source" {
				if result != nil || uploads.Load() != 1 {
					t.Fatal("upload failed", result, reply.Error)
				}
				deliveryAckStatus(t, f.runtime, 200)
			} else {
				if !errors.Is(result, store.ErrSkillHubPublicationInvalid) {
					t.Fatal("invalid acceptance", result)
				}
				deliveryAckStatus(t, f.runtime, 422)
				want := int32(0)
				if mode == "cloud-reject" {
					want = 1
				}
				if uploads.Load() != want {
					t.Fatal("unexpected HTTP request")
				}
			}
			if s.entries["capture-click"].State != "waiting_runtime" || s.calls != 1 {
				t.Fatal("runtime ACK mutated authority")
			}
		})
	}
}
