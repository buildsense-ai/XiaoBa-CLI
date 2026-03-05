package server

import "testing"

func TestHubTracksMultipleConnectionsPerUser(t *testing.T) {
	hub := NewHub(nil, nil)
	clientA := &Client{uid: 42, send: make(chan []byte, 1)}
	clientB := &Client{uid: 42, send: make(chan []byte, 1)}
	clientC := &Client{uid: 99, send: make(chan []byte, 1)}

	first, devices, online := hub.addClient(clientA)
	if !first || devices != 1 || online != 1 {
		t.Fatalf("first add = (%v, %d, %d), want (true, 1, 1)", first, devices, online)
	}

	first, devices, online = hub.addClient(clientB)
	if first || devices != 2 || online != 1 {
		t.Fatalf("second add = (%v, %d, %d), want (false, 2, 1)", first, devices, online)
	}

	first, devices, online = hub.addClient(clientC)
	if !first || devices != 1 || online != 2 {
		t.Fatalf("third add = (%v, %d, %d), want (true, 1, 2)", first, devices, online)
	}

	if !hub.IsOnline(42) || !hub.IsOnline(99) {
		t.Fatal("expected both users to be online")
	}

	removed, last, remaining, online := hub.removeClient(clientA)
	if !removed || last || remaining != 1 || online != 2 {
		t.Fatalf("remove first client = (%v, %v, %d, %d), want (true, false, 1, 2)", removed, last, remaining, online)
	}

	removed, last, remaining, online = hub.removeClient(clientB)
	if !removed || !last || remaining != 0 || online != 1 {
		t.Fatalf("remove last client = (%v, %v, %d, %d), want (true, true, 0, 1)", removed, last, remaining, online)
	}

	if hub.IsOnline(42) {
		t.Fatal("expected uid 42 to be offline after removing all connections")
	}
}

func TestSendToUserExceptAndSendToClient(t *testing.T) {
	hub := NewHub(nil, nil)
	clientA := &Client{uid: 7, send: make(chan []byte, 1)}
	clientB := &Client{uid: 7, send: make(chan []byte, 1)}
	clientC := &Client{uid: 8, send: make(chan []byte, 1)}

	hub.addClient(clientA)
	hub.addClient(clientB)
	hub.addClient(clientC)

	msg := &ServerMessage{Ctrl: &MsgServerCtrl{Code: 200, Text: "ok"}}

	hub.SendToUserExcept(7, msg, clientA)
	if !drainOne(clientB.send) {
		t.Fatal("expected included sibling connection to receive the message")
	}
	if drainOne(clientA.send) {
		t.Fatal("did not expect excluded connection to receive the message")
	}
	if drainOne(clientC.send) {
		t.Fatal("did not expect another user's connection to receive the message")
	}

	hub.SendToClient(clientC, msg)
	if !drainOne(clientC.send) {
		t.Fatal("expected direct connection send to deliver exactly once")
	}
	if drainOne(clientA.send) || drainOne(clientB.send) {
		t.Fatal("did not expect direct connection send to fan out")
	}
}

func drainOne(ch <-chan []byte) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}
