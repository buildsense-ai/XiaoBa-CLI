// Overlay-only contract: real CatsCo transport and XiaoBa handler/capture store,
// in-memory CatsCo admission/status/persistence and a synthetic socket bridge.
package server

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/openchat/openchat/server/store"
)

func pairedCaptureFixture(t *testing.T, r *pairedProbeRuntime) (*publicationWorkspaceFixture, *publicationCaptureTestStore) {
	t.Helper()
	f, s := newCaptureTransportFixture(t)
	f.h.userDevices.unregister(7, f.device.DeviceID)
	d, err := f.h.userDevices.register(7, RegisterUserDeviceRequest{BotUID: 42, DeviceID: "install-42", BodyID: "body-42", InstallationID: "install-42", RuntimeRole: "server", Status: "online",
		Capabilities: []string{string(DeviceCapabilitySkillHubPublicationProbe), string(DeviceCapabilitySkillHubPublicationCapture)}})
	if err != nil {
		t.Fatal(err)
	}
	f.h.bindDeviceClient(7, d, f.runtime)
	f.device = d
	source := &s.entries["capture-click"].Input.Source
	source.DeviceID, source.BodyID, source.InstallationID = d.DeviceID, d.BodyID, d.InstallationID
	source.LocalSkillID = r.source["local_skill_id"].(string)
	source.WorkspaceGeneration = r.source["workspace_generation"].(string)
	if err := s.entries["capture-click"].Input.Validate(); err != nil {
		t.Fatal(err)
	}
	return f, s
}

func pairedCaptureCall(t *testing.T, f *publicationWorkspaceFixture, r *pairedProbeRuntime) captureCallResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, done := startCaptureCall(t, f, ctx)
	reply := r.probe(t, req) // Pass the unchanged real CatsCo envelope.
	f.h.handleThinToolRPCResult(f.runtime, reply)
	result := captureWait(t, done)
	if result.err == nil {
		if reply.Error != nil {
			t.Fatalf("accepted an error reply: %+v", reply.Error)
		}
		deliveryAckStatus(t, f.runtime, 200)
	} else {
		deliveryAckStatus(t, f.runtime, 422)
	}
	return result
}

func TestXiaoBaPublicationCapturePairedReplay(t *testing.T) {
	for _, mode := range []string{"normal", "malformed"} {
		t.Run(mode, func(t *testing.T) {
			r := startPairedProbeRuntime(t, mode)
			f, s := pairedCaptureFixture(t, r)
			f.h.removeClient(f.owner) // Background capture does not need the owner's session.
			first := pairedCaptureCall(t, f, r)
			if first.err != nil || first.record == nil || s.calls != 1 {
				t.Fatalf("capture failed: %+v", first)
			}
			original := first.record.Input
			// Source is changed, then removed, but the exact retained entry must
			// survive handler reconstruction and a new transport request ID.
			r.action(t, "change")
			r.action(t, "remove")
			r.action(t, "recover")
			f.h.publicationCapture = newPublicationCaptureTransport(f.h)
			again := pairedCaptureCall(t, f, r)
			if again.err != nil || again.record == nil || s.calls != 2 || !reflect.DeepEqual(original, again.record.Input) {
				t.Fatalf("restart replaced retained evidence: %+v", again)
			}
		})
	}
}

func TestXiaoBaPublicationCapturePairedFailures(t *testing.T) {
	for _, action := range []string{"change", "remove", "disable", "owner", "switching"} {
		t.Run(action, func(t *testing.T) {
			r := startPairedProbeRuntime(t, "normal")
			f, s := pairedCaptureFixture(t, r)
			r.action(t, action)
			result := pairedCaptureCall(t, f, r)
			expected := store.ErrSkillHubPublicationInvalid
			if action == "switching" {
				// PR680 preserves transient unavailable replies as retryable.
				expected = store.ErrSkillHubPublicationBusy
			}
			if !errors.Is(result.err, expected) || s.calls != 0 {
				t.Fatalf("invalid runtime evidence stored: %+v calls=%d", result, s.calls)
			}
			if action == "switching" {
				r.action(t, "recover")
				recovered := pairedCaptureCall(t, f, r)
				if recovered.err != nil || recovered.record == nil || s.calls != 1 || recovered.record.Input.EntryID != publicationReadTestID {
					t.Fatalf("same entry failed after runtime recovered: %+v", recovered)
				}
			}
		})
	}
}

func TestXiaoBaPublicationCapturePairedLateOwnerChange(t *testing.T) {
	r := startPairedProbeRuntime(t, "normal")
	f, s := pairedCaptureFixture(t, r)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, done := startCaptureCall(t, f, ctx)
	reply := r.probe(t, req)
	if reply.Error != nil {
		t.Fatal(reply.Error)
	}
	s.config.OwnerID = 8
	f.h.handleThinToolRPCResult(f.runtime, reply)
	if result := captureWait(t, done); !errors.Is(result.err, store.ErrSkillHubPublicationStale) || s.calls != 0 {
		t.Fatalf("late authority change accepted: %+v", result)
	}
	deliveryAckStatus(t, f.runtime, 409)
}
