// Overlay into CatsCompany's test package. Store/queues are simulated; metadata,
// CLI parsing/routing/serialization and Go dispatch are production code.
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/openchat/openchat/server/store/types"
)

func TestXiaoBaMultiDevicePairedContract(t *testing.T) {
	root, node := os.Getenv("XIAOBA_PAIRED_ROOT"), os.Getenv("XIAOBA_PAIRED_NODE")
	if root == "" || node == "" {
		t.Fatal("paired paths required; refusing to skip")
	}
	hub, handler := deviceSelectionFixture(t)
	bot := &Client{uid: 42, accountType: types.AccountBot, bodyID: "cloud-body", send: make(chan []byte, 32)}
	hub.addClient(bot)
	metadata := func() map[string]interface{} {
		return map[string]interface{}{
			"catsco_identity": hub.buildCatscoIdentityMetadata(7, 42, "p2p_7_42", 1, "读取我的文件"),
			"xiaoba_runtime":  hub.buildXiaobaRuntimeMetadata(7, 42, "p2p_7_42"),
		}
	}
	choose := func(device string) {
		t.Helper()
		snapshot := selectionSnapshot(t, handler, 7, "p2p_7_42", "42")
		body := fmt.Sprintf(`{"device_id":%q,"expected_revision":%q}`, device, snapshot["revision"])
		if reply := selectionRequest(t, handler, 7, "p2p_7_42", "42", http.MethodPost, body); reply.Code != 200 {
			t.Fatalf("confirmation: %d %s", reply.Code, reply.Body.String())
		}
	}
	type output struct {
		Route struct {
			OK        bool   `json:"ok"`
			Mode      string `json:"mode"`
			ErrorCode string `json:"errorCode"`
			Message   string `json:"message"`
		} `json:"route"`
		Wire    *MsgThinToolRPC `json:"wire"`
		Devices []string        `json:"devices"`
	}
	call := func(meta map[string]interface{}, target string) output {
		t.Helper()
		payload, err := json.Marshal(map[string]interface{}{"metadata": meta, "target": target})
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, node, "--import", "tsx", filepath.Join(root, "tests", "fixtures", "multi-device-paired", "runtime.ts"))
		cmd.Dir, cmd.Stdin = root, bytes.NewReader(payload)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		raw, err := cmd.Output()
		if err != nil {
			t.Fatalf("CLI bridge: %v\n%s", err, stderr.String())
		}
		var result output
		if err := json.Unmarshal(raw, &result); err != nil {
			t.Fatalf("CLI output: %v\n%s", err, raw)
		}
		return result
	}
	var oldA *MsgThinToolRPC
	t.Run("multiple_devices_require_selection", func(t *testing.T) {
		got := call(metadata(), "alice")
		if got.Route.OK || got.Wire != nil || len(got.Devices) != 3 {
			t.Fatalf("unexpected route/directory: %+v", got)
		}
	})
	t.Run("no_default_explicit_B", func(t *testing.T) {
		// A picker GET initializes an empty revision, without choosing a default.
		selectionSnapshot(t, handler, 7, "p2p_7_42", "42")
		got := call(metadata(), "b")
		if !got.Route.OK || got.Wire == nil || got.Wire.TargetDeviceID != "b" {
			t.Fatalf("exact B requires no default: %+v", got)
		}
		if err := hub.authorizeOrdinaryThinToolRPC(bot, got.Wire, 7, "b", "read_file"); err != nil {
			t.Fatal(err)
		}
	})
	for _, device := range []string{"a", "b"} {
		t.Run("selected_"+device, func(t *testing.T) {
			choose(device)
			got := call(metadata(), "alice")
			if !got.Route.OK || got.Wire == nil || got.Wire.TargetDeviceID != device {
				t.Fatalf("wrong wire: %+v", got)
			}
			hub.handleMessage(bot, &ClientMessage{ThinToolRPC: got.Wire})
			_, receiver := hub.findDeviceRPCTarget(7, UserDevice{DeviceID: device})
			var forwarded ServerMessage
			decodeQueuedServerMessage(t, receiver.send, &forwarded)
			if forwarded.ThinToolRPC == nil || forwarded.ThinToolRPC.TargetDeviceID != device {
				t.Fatal("real wire was not accepted")
			}
			if device == "a" {
				oldA = got.Wire
				t.Run("explicit_B_while_default_A", func(t *testing.T) {
					explicit := call(metadata(), "b")
					if !explicit.Route.OK || explicit.Wire == nil || explicit.Wire.TargetDeviceID != "b" {
						t.Fatalf("default A blocked explicit B: %+v", explicit)
					}
					if err := hub.authorizeOrdinaryThinToolRPC(bot, explicit.Wire, 7, "b", "read_file"); err != nil {
						t.Fatal(err)
					}
					forged := *explicit.Wire
					forged.TargetDeviceID = "a"
					if err := hub.authorizeOrdinaryThinToolRPC(bot, &forged, 7, "a", "read_file"); err == nil {
						t.Fatal("B grant executed on A")
					}
				})
				t.Run("both_targets_keep_default_A", func(t *testing.T) {
					meta := metadata()
					for _, target := range []string{"a", "b", "alice"} {
						explicit := call(meta, target)
						want := target
						if target == "alice" {
							want = "a"
						}
						if !explicit.Route.OK || explicit.Wire == nil || explicit.Wire.TargetDeviceID != want {
							t.Fatalf("wrong multi-target route: %+v", explicit)
						}
						if err := hub.authorizeOrdinaryThinToolRPC(bot, explicit.Wire, 7, want, "read_file"); err != nil {
							t.Fatal(err)
						}
					}
					if selectionSnapshot(t, handler, 7, "p2p_7_42", "42")["selected_device_id"] != "a" {
						t.Fatal("explicit task changed persisted default")
					}
				})
			}
		})
	}
	t.Run("old_A_wire_rejected_after_switch", func(t *testing.T) {
		if oldA == nil {
			t.Fatal("missing A fixture")
		}
		if err := hub.authorizeOrdinaryThinToolRPC(bot, oldA, 7, "a", "read_file"); err == nil {
			t.Fatal("stale wire accepted")
		}
	})
	t.Run("legacy_unscoped_wire_requires_upgrade", func(t *testing.T) {
		msg := &MsgThinToolRPC{Type: "request", TargetOwnerUserID: "usr7", TargetDeviceID: "b", ToolName: "read_file"}
		err := hub.authorizeOrdinaryThinToolRPC(bot, msg, 7, "b", "read_file")
		if err == nil || thinToolRPCAuthorizationErrorCode(err) != "device_authorization_required" {
			t.Fatal("legacy wire bypassed upgrade requirement", err)
		}
	})
	t.Run("server_host_without_desktop_authorization", func(t *testing.T) {
		got := call(map[string]interface{}{}, "")
		if !got.Route.OK || got.Route.Mode != "local" || got.Wire != nil {
			t.Fatalf("cloud host rerouted: %+v", got)
		}
	})
	t.Run("selected_B_offline_does_not_fallback_to_A", func(t *testing.T) {
		_, receiver := hub.findDeviceRPCTarget(7, UserDevice{DeviceID: "b"})
		if receiver == nil {
			t.Fatal("missing B fixture")
		}
		hub.unbindDeviceClient(receiver)
		got := call(metadata(), "alice")
		if got.Route.OK || got.Wire != nil {
			t.Fatalf("offline B fell back: %+v", got)
		}
	})
	t.Run("explicit_A_while_default_B_offline", func(t *testing.T) {
		got := call(metadata(), "a")
		if !got.Route.OK || got.Wire == nil || got.Wire.TargetDeviceID != "a" {
			t.Fatalf("offline default blocked explicitly requested A: %+v", got)
		}
		if err := hub.authorizeOrdinaryThinToolRPC(bot, got.Wire, 7, "a", "read_file"); err != nil {
			t.Fatal(err)
		}
	})
}
