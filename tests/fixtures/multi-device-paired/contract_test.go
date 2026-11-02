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
	// Exercise the real hi decoder/handler. Old server main ignores the new
	// additive field, so the paired fixture works before and after negotiation
	// is deployed without granting capabilities through reflection or helpers.
	declareCapabilities := func(hub *Hub, bot *Client) {
		t.Helper()
		var hi MsgClientHi
		if err := json.Unmarshal([]byte(`{"id":"paired-hi","runtime_capabilities":["device-targets.v1"]}`), &hi); err != nil {
			t.Fatal(err)
		}
		hub.handleHi(bot, "paired-bot", &hi)
		var ack ServerMessage
		decodeQueuedServerMessage(t, bot.send, &ack)
		if ack.Ctrl == nil || ack.Ctrl.Code != http.StatusOK {
			t.Fatalf("paired hi failed: %#v", ack)
		}
	}
	hub, handler := deviceSelectionFixture(t)
	bot := &Client{uid: 42, accountType: types.AccountBot, bodyID: "cloud-body", send: make(chan []byte, 32)}
	hub.addClient(bot)
	declareCapabilities(hub, bot)
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
		Wire              *MsgThinToolRPC `json:"wire"`
		RenewalWire       json.RawMessage `json:"renewalWire"`
		Devices           []string        `json:"devices"`
		HistorySessionKey string          `json:"historySessionKey"`
		Attempts          []struct {
			Route struct {
				OK        bool   `json:"ok"`
				ErrorCode string `json:"errorCode"`
			} `json:"route"`
			Wire *MsgThinToolRPC `json:"wire"`
		} `json:"attempts"`
	}
	call := func(meta map[string]interface{}, target string, identity ...map[string]interface{}) output {
		t.Helper()
		input := map[string]interface{}{"metadata": meta, "target": target}
		for _, fields := range identity {
			for key, value := range fields {
				input[key] = value
			}
		}
		payload, err := json.Marshal(input)
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
	t.Run("renewal_capability_is_additive", func(t *testing.T) {
		// No compile-time dependency on the new server structs: this suite must
		// also work when CLI merges first and the paired server is still old.
		h, _ := deviceSelectionFixture(t)
		now := time.Now().Truncate(time.Millisecond)
		h.userDevices.now = func() time.Time { return now }
		cloud := &Client{uid: 42, accountType: types.AccountBot, bodyID: "renew-cloud", send: make(chan []byte, 32)}
		h.addClient(cloud)
		_, err := h.bodyLeases.acquire(42, cloud.bodyID, cloud.connectionID)
		if err != nil {
			t.Fatal(err)
		}
		h.handleHi(cloud, "cloud", &MsgClientHi{ID: "renew-hi", RuntimeCapabilities: []string{"device-targets.v1"}})
		var hi ServerMessage
		decodeQueuedServerMessage(t, cloud.send, &hi)
		encoded, _ := json.Marshal(hi)
		available := bytes.Contains(encoded, []byte(`"device_grant_renewal.v1"`))
		session := buildCatsCoSessionKey("p2p_7_42", "p2p", "usr42", 7)
		_, err = h.userDevices.confirmDeviceSelection(7, session, "a", "test", "")
		if err != nil {
			t.Fatal(err)
		}
		meta := map[string]interface{}{"catsco_identity": h.buildCatscoIdentityMetadata(7, 42, "p2p_7_42", 1, "read"), "xiaoba_runtime": h.buildXiaobaRuntimeMetadata(7, 42, "p2p_7_42")}
		old := call(meta, "a")
		if old.Wire == nil {
			t.Fatal("missing initial wire")
		}
		now = now.Add(4 * time.Minute)
		var reply map[string]interface{}
		if available {
			payload, _ := json.Marshal(map[string]interface{}{"device_grant_renewal": map[string]interface{}{"type": "request", "request_id": "paired-renewal", "grant_id": old.Wire.GrantID}})
			var request ClientMessage
			if err := json.Unmarshal(payload, &request); err != nil {
				t.Fatal(err)
			}
			h.handleMessage(cloud, &request)
			var response ServerMessage
			decodeQueuedServerMessage(t, cloud.send, &response)
			raw, _ := json.Marshal(response)
			var generic map[string]interface{}
			_ = json.Unmarshal(raw, &generic)
			reply, _ = generic["device_grant_renewal"].(map[string]interface{})
			if reply == nil || reply["error"] != nil {
				t.Fatal("renewal refused")
			}
		}
		fields := map[string]interface{}{"now": unixMillis(now)}
		if available {
			fields["renewalResult"] = reply
		}
		got := call(meta, "a", fields)
		if got.Wire == nil {
			t.Fatal("CLI lost original authorized device")
		}
		if available {
			if got.Wire.GrantID == old.Wire.GrantID || len(got.RenewalWire) == 0 {
				t.Fatal("CLI did not consume renewed wire grant")
			}
		} else if got.Wire.GrantID != old.Wire.GrantID || len(got.RenewalWire) > 0 {
			t.Fatal("old server received a new protocol")
		}
		now = now.Add(7 * time.Minute)
		h.userDevices.touch(7, "a")
		// Fresh transport deadline but the exact same captured authority: after
		// eleven minutes only the renewed capability may dispatch.
		got.Wire.ExpiresAt = unixMillis(now.Add(time.Minute))
		authorization := h.authorizeOrdinaryThinToolRPC(cloud, got.Wire, 7, "a", "read_file")
		if available && authorization != nil {
			t.Fatal(authorization)
		}
		if !available && authorization == nil {
			t.Fatal("old server revived expired authority")
		}
		selection, _ := h.userDevices.selectionRecord(7, session)
		_, _ = h.userDevices.confirmDeviceSelection(7, session, "b", "test", selection.Revision)
		if err := h.authorizeOrdinaryThinToolRPC(cloud, got.Wire, 7, "a", "read_file"); err == nil {
			t.Fatal("renewed authority survived switch to B")
		}
	})
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
					t.Run("scope_cannot_be_omitted", func(t *testing.T) {
						legacyShape := *explicit.Wire
						legacyShape.TargetScope = ""
						if err := hub.authorizeOrdinaryThinToolRPC(bot, &legacyShape, 7, "b", "read_file"); err == nil {
							t.Fatal("explicit B capability executed as a default request")
						}
					})
					forged := *explicit.Wire
					forged.TargetDeviceID = "a"
					if err := hub.authorizeOrdinaryThinToolRPC(bot, &forged, 7, "a", "read_file"); err == nil {
						t.Fatal("B grant executed on A")
					}
				})
				t.Run("legacy_grant_list_stays_default_only", func(t *testing.T) {
					meta := metadata()
					identity := meta["catsco_identity"].(map[string]interface{})
					delete(identity, "device_target_authorizations")
					grants := identity["device_grants"].([]ScopedDeviceGrant)
					if len(grants) != 1 || grants[0].DeviceID != "a" || grants[0].TargetScope != "" {
						t.Fatalf("old consumer got non-default grants: %#v", grants)
					}
					got := call(meta, "alice")
					if !got.Route.OK || got.Wire == nil || got.Wire.TargetDeviceID != "a" || got.Wire.TargetScope != "" {
						t.Fatalf("default A compatibility failed: %+v", got)
					}
					if err := hub.authorizeOrdinaryThinToolRPC(bot, got.Wire, 7, "a", "read_file"); err != nil {
						t.Fatal(err)
					}
					if other := call(meta, "b"); other.Route.OK || other.Wire != nil {
						t.Fatal("legacy grant list authorized non-default B")
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
	t.Run("v1_rollout_keeps_selected_only_authority", func(t *testing.T) {
		t.Setenv("CATSCO_XIAOBA_RUNTIME_V2_ENABLED", "")
		meta := metadata()
		identity := meta["catsco_identity"].(map[string]interface{})
		if _, ok := identity["device_target_authorizations"]; ok {
			t.Fatal("v1 emitted explicit authorization envelope")
		}
		got := call(meta, "alice")
		if !got.Route.OK || got.Wire == nil || got.Wire.TargetDeviceID != "b" || got.Wire.TargetScope != "" {
			t.Fatalf("v1 default B unavailable: %+v", got)
		}
		if err := hub.authorizeOrdinaryThinToolRPC(bot, got.Wire, 7, "b", "read_file"); err != nil {
			t.Fatal(err)
		}
		if other := call(meta, "a"); other.Route.OK || other.Wire != nil {
			t.Fatal("v1 authorized non-default A")
		}
	})
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
	t.Run("partial_failure_same_run_preserves_authorized_A", func(t *testing.T) {
		got := call(metadata(), "", map[string]interface{}{"targets": []string{"b", "a", "speaker_default", "b"}})
		if len(got.Attempts) != 4 {
			t.Fatalf("missing per-target results: %+v", got)
		}
		for index, attempt := range got.Attempts {
			if index == 1 {
				if !attempt.Route.OK || attempt.Wire == nil || attempt.Wire.TargetDeviceID != "a" {
					t.Fatalf("offline B poisoned explicit A: %+v", attempt)
				}
				if err := hub.authorizeOrdinaryThinToolRPC(bot, attempt.Wire, 7, "a", "read_file"); err != nil {
					t.Fatal(err)
				}
			} else if attempt.Route.OK || attempt.Wire != nil {
				t.Fatalf("offline B dispatched or fell back: %+v", attempt)
			}
		}
		if got.Attempts[3].Route.ErrorCode != "TARGET_RESOLUTION_BLOCKED" {
			t.Fatal("same failed target was not remembered")
		}
		if selectionSnapshot(t, handler, 7, "p2p_7_42", "42")["selected_device_id"] != "b" {
			t.Fatal("partial failure changed the default")
		}
	})
	t.Run("group", func(t *testing.T) {
		// Independent registry: private-chat selection and clock changes must not
		// accidentally establish group authorization for this fixture.
		hub, handler := deviceSelectionFixture(t)
		bots := map[int64]*Client{}
		for _, uid := range []int64{42, 43} {
			bots[uid] = &Client{uid: uid, accountType: types.AccountBot, bodyID: fmt.Sprintf("cloud-%d", uid), send: make(chan []byte, 32)}
			hub.addClient(bots[uid])
			declareCapabilities(hub, bots[uid])
		}
		choose := func(actor, agent int64, device string) {
			t.Helper()
			botID := fmt.Sprint(agent)
			snapshot := selectionSnapshot(t, handler, actor, "grp_1", botID)
			body := fmt.Sprintf(`{"device_id":%q,"expected_revision":%q}`, device, snapshot["revision"])
			if reply := selectionRequest(t, handler, actor, "grp_1", botID, http.MethodPost, body); reply.Code != 200 {
				t.Fatalf("group selection: %d %s", reply.Code, reply.Body.String())
			}
		}
		metadata := func(actor, agent int64) map[string]interface{} {
			return map[string]interface{}{
				"catsco_identity": hub.buildCatscoIdentityMetadata(actor, agent, "grp_1", 1, "读取我的文件"),
				"xiaoba_runtime":  hub.buildXiaobaRuntimeMetadata(actor, agent, "grp_1"),
			}
		}
		identity := func(actor, agent int64) map[string]interface{} {
			return map[string]interface{}{"topic": "grp_1", "senderId": fmt.Sprintf("usr%d", actor), "botUid": fmt.Sprint(agent)}
		}
		accept := func(t *testing.T, actor, agent int64, device string) output {
			t.Helper()
			got := call(metadata(actor, agent), "speaker_default", identity(actor, agent))
			if !got.Route.OK || got.Wire == nil || got.Wire.TargetDeviceID != device || got.HistorySessionKey != "cc_group:grp_1" {
				t.Fatalf("wrong group wire/history: %+v", got)
			}
			hub.handleMessage(bots[agent], &ClientMessage{ThinToolRPC: got.Wire})
			_, receiver := hub.findDeviceRPCTarget(actor, UserDevice{DeviceID: device})
			var forwarded ServerMessage
			decodeQueuedServerMessage(t, receiver.send, &forwarded)
			if forwarded.ThinToolRPC == nil || forwarded.ThinToolRPC.TargetDeviceID != device {
				t.Fatal("real group wire was not accepted")
			}
			return got
		}
		var oldA *MsgThinToolRPC
		t.Run("selected_A_preserves_shared_history", func(t *testing.T) {
			choose(7, 42, "a")
			oldA = accept(t, 7, 42, "a").Wire
		})
		t.Run("other_actor_uses_only_own_device", func(t *testing.T) {
			got := accept(t, 8, 42, "private")
			if len(got.Devices) != 1 || got.Devices[0] != "private" {
				t.Fatalf("actor directory leaked: %+v", got)
			}
		})
		t.Run("other_bot_selection_is_independent", func(t *testing.T) {
			choose(7, 43, "b")
			accept(t, 7, 43, "b")
			accept(t, 7, 42, "a")
		})
		t.Run("cross_actor_or_bot_metadata_rejected", func(t *testing.T) {
			for _, pair := range [][2]int64{{8, 42}, {7, 43}} {
				got := call(metadata(pair[0], pair[1]), "speaker_default", identity(7, 42))
				if got.Route.OK || got.Wire != nil {
					t.Fatalf("foreign group authorization dispatched: %+v", got)
				}
			}
		})
		t.Run("switch_invalidates_old_wire", func(t *testing.T) {
			choose(7, 42, "b")
			if oldA == nil {
				t.Fatal("missing group A wire")
			}
			if err := hub.authorizeOrdinaryThinToolRPC(bots[42], oldA, 7, "a", "read_file"); err == nil {
				t.Fatal("old group wire accepted")
			}
			accept(t, 7, 42, "b")
		})
		t.Run("offline_B_never_falls_back_to_A", func(t *testing.T) {
			hub.userDevices.now = func() time.Time { return time.Now().Add(hub.userDevices.ttl + time.Minute) }
			hub.userDevices.touch(7, "a")
			got := call(metadata(7, 42), "speaker_default", identity(7, 42))
			if got.Route.OK || got.Wire != nil {
				t.Fatalf("offline group B fell back: %+v", got)
			}
		})
	})
}
