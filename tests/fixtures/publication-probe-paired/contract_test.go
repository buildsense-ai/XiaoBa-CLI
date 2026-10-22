// Compiled into CatsCo's server test package using go -overlay. The source
// checkout is never edited. In-memory authority/store fixtures, real handlers.
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

type pairedProbeRuntime struct {
	in       io.WriteCloser
	out      *json.Decoder
	source   map[string]interface{}
	canShare bool
}

func startPairedProbeRuntime(t *testing.T, mode string) *pairedProbeRuntime {
	t.Helper()
	root, node := os.Getenv("XIAOBA_PAIRED_ROOT"), os.Getenv("XIAOBA_PAIRED_NODE")
	if root == "" || node == "" {
		t.Fatal("paired runtime paths are required; refusing to skip")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	cmd := exec.CommandContext(ctx, node, "--import", "tsx", filepath.Join(root, "tests", "fixtures", "publication-probe-paired", "runtime.ts"), t.TempDir(), mode)
	cmd.Dir = root
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	in, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		in.Close()
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("runtime exited: %v\n%s", err, stderr.String())
			}
		case <-time.After(5 * time.Second):
			cancel()
			<-done
			t.Errorf("runtime did not exit\n%s", stderr.String())
		}
		cancel()
	})
	r := &pairedProbeRuntime{in: in, out: json.NewDecoder(out)}
	var ready struct {
		Source    map[string]interface{} `json:"source"`
		Supported bool                   `json:"supported"`
		CanShare  bool                   `json:"can_share"`
	}
	if err := r.out.Decode(&ready); err != nil {
		t.Fatal("runtime readiness:", err)
	}
	if !ready.Supported || len(ready.Source) != 2 {
		t.Fatalf("invalid readiness: %+v", ready)
	}
	r.source, r.canShare = ready.Source, ready.CanShare
	return r
}

func (r *pairedProbeRuntime) call(t *testing.T, input interface{}, output interface{}) {
	t.Helper()
	if err := json.NewEncoder(r.in).Encode(input); err != nil {
		t.Fatal(err)
	}
	if err := r.out.Decode(output); err != nil {
		t.Fatal(err)
	}
}
func (r *pairedProbeRuntime) action(t *testing.T, action string) {
	t.Helper()
	var result struct {
		OK bool `json:"ok"`
	}
	r.call(t, map[string]interface{}{"action": action}, &result)
	if !result.OK {
		t.Fatal("fixture action failed:", action)
	}
}
func (r *pairedProbeRuntime) probe(t *testing.T, request *MsgThinToolRPC) *MsgThinToolRPC {
	t.Helper()
	var result struct {
		Reply *MsgThinToolRPC `json:"reply"`
	}
	// Pass the actual CatsCo-generated envelope, without repairing its fields.
	r.call(t, map[string]interface{}{"action": "probe", "request": request}, &result)
	if result.Reply == nil {
		t.Fatal("missing runtime reply")
	}
	return result.Reply
}

func pairProbeDevice(t *testing.T, f *publicationWorkspaceFixture) {
	t.Helper()
	// XiaoBa registers installationId as deviceId; model that real registration
	// convention rather than editing forwarded requests to make tests pass.
	f.h.userDevices.unregister(7, f.device.DeviceID)
	d, err := f.h.userDevices.register(7, RegisterUserDeviceRequest{BotUID: 42, DeviceID: "install-42", BodyID: "body-42", InstallationID: "install-42", RuntimeRole: "server", Status: "online", Capabilities: []string{string(DeviceCapabilitySkillHubPublicationProbe)}})
	if err != nil {
		t.Fatal(err)
	}
	f.h.bindDeviceClient(7, d, f.runtime)
	f.device = d
}

func pairedWorkspaceRequest(r *pairedProbeRuntime) *MsgThinToolRPC {
	req := publicationWorkspaceRequest()
	req.TargetDeviceID = "install-42"
	req.Payload["local_skill_id"] = r.source["local_skill_id"]
	req.Payload["workspace_generation"] = r.source["workspace_generation"]
	return req
}

func TestXiaoBaPublicationProbePairedAdmission(t *testing.T) {
	for _, mode := range []string{"normal", "malformed"} {
		t.Run(mode, func(t *testing.T) {
			r := startPairedProbeRuntime(t, mode)
			if mode == "malformed" && r.canShare {
				t.Fatal("malformed metadata should fail legacy share, not source probing")
			}
			f := newPublicationWorkspaceFixture(t)
			pairProbeDevice(t, f)
			for i := 0; i < 2; i++ {
				probe := f.start(t, pairedWorkspaceRequest(r))
				if f.db.creates != i {
					t.Fatal("entry persisted before probe")
				}
				reply := r.probe(t, probe)
				if reply.Error != nil {
					t.Fatalf("real runtime rejected: %+v", reply.Error)
				}
				f.h.handleThinToolRPCResult(f.runtime, reply)
				deliveryAckStatus(t, f.runtime, 200)
				response := publicationWorkspaceResponse(t, f.owner)
				if response.Error != nil {
					t.Fatalf("admission failed: %+v", response.Error)
				}
				result := response.Result.(map[string]interface{})
				if result["state"] != "waiting_runtime" || result["replay"] != (i == 1) {
					t.Fatalf("response=%v", result)
				}
			}
			if len(f.db.entries) != 1 {
				t.Fatal("duplicate entry")
			}
		})
	}
}

func TestXiaoBaPublicationProbePairedFailures(t *testing.T) {
	for _, tc := range []struct{ action, runtimeCode, publicCode string }{
		{"change", "publication.source_changed", "publication.source_changed"},
		{"remove", "publication.source_missing", "publication.source_missing"},
		{"disable", "publication.runtime_unsupported", "publication.runtime_unsupported"},
		{"owner", "OWNER_MISMATCH", "publication.runtime_unsupported"},
	} {
		t.Run(tc.action, func(t *testing.T) {
			r := startPairedProbeRuntime(t, "normal")
			f := newPublicationWorkspaceFixture(t)
			pairProbeDevice(t, f)
			probe := f.start(t, pairedWorkspaceRequest(r))
			r.action(t, tc.action)
			reply := r.probe(t, probe)
			if reply.Error == nil || reply.Error.Code != tc.runtimeCode {
				t.Fatalf("runtime error=%+v", reply.Error)
			}
			f.h.handleThinToolRPCResult(f.runtime, reply)
			deliveryAckStatus(t, f.runtime, 200)
			response := publicationWorkspaceResponse(t, f.owner)
			if response.Error == nil || response.Error.Code != tc.publicCode || f.db.creates != 0 {
				t.Fatalf("response=%+v creates=%d", response, f.db.creates)
			}
		})
	}
}

func TestXiaoBaPublicationProbePairedDeliveryRecovery(t *testing.T) {
	r := startPairedProbeRuntime(t, "normal")
	f, s, w := newPublicationDeliveryFixture(t)
	pairProbeDevice(t, f)
	in := &s.entries["delivery-click"].Input.Source
	in.DeviceID = "install-42"
	in.LocalSkillID = r.source["local_skill_id"].(string)
	in.WorkspaceGeneration = r.source["workspace_generation"].(string)
	r.action(t, "switching")
	w.sweep()
	first := deliveryProbe(t, f.runtime)
	reply := r.probe(t, first)
	if reply.Error == nil || reply.Error.Code != "BOT_NOT_ACTIVE" {
		t.Fatalf("switching error=%+v", reply.Error)
	}
	f.h.handleThinToolRPCResult(f.runtime, reply)
	deliveryProcess(t, w)
	deliveryAckStatus(t, f.runtime, 200)
	job := s.jobs[publicationReadTestID]
	if job.state != "pending" || job.code != "publication.runtime_unavailable" {
		t.Fatalf("job=%+v", job)
	}
	w.sweep()
	if len(f.runtime.send) != 0 {
		t.Fatal("ignored backoff")
	}
	r.action(t, "recover")
	job.next = time.Now().Add(-time.Second)
	w.sweep()
	second := deliveryProbe(t, f.runtime)
	if second.RequestID == first.RequestID {
		t.Fatal("reused delivery request")
	}
	reply = r.probe(t, second)
	if reply.Error != nil {
		t.Fatalf("recovered runtime error=%+v", reply.Error)
	}
	f.h.handleThinToolRPCResult(f.runtime, reply)
	deliveryProcess(t, w)
	deliveryAckStatus(t, f.runtime, 200)
	if s.jobs[publicationReadTestID].state != "source_verified" || s.creates != 1 {
		t.Fatal("recovery did not settle original entry")
	}
}
