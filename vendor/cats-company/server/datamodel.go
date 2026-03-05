// Package server defines the wire protocol data model for Cats Company.
package server

// ClientMessage is the top-level client-to-server message envelope.
type ClientMessage struct {
	Hi      *MsgClientHi      `json:"hi,omitempty"`
	Acc     *MsgClientAcc     `json:"acc,omitempty"`
	Login   *MsgClientLogin   `json:"login,omitempty"`
	Sub     *MsgClientSub     `json:"sub,omitempty"`
	Pub     *MsgClientPub     `json:"pub,omitempty"`
	Get     *MsgClientGet     `json:"get,omitempty"`
	Set     *MsgClientSet     `json:"set,omitempty"`
	Del     *MsgClientDel     `json:"del,omitempty"`
	Note    *MsgClientNote    `json:"note,omitempty"`
	Friend  *MsgClientFriend  `json:"friend,omitempty"`
}

// ServerMessage is the top-level server-to-client message envelope.
type ServerMessage struct {
	Ctrl   *MsgServerCtrl   `json:"ctrl,omitempty"`
	Data   *MsgServerData   `json:"data,omitempty"`
	Pres   *MsgServerPres   `json:"pres,omitempty"`
	Meta   *MsgServerMeta   `json:"meta,omitempty"`
	Info   *MsgServerInfo   `json:"info,omitempty"`
	Friend *MsgServerFriend `json:"friend,omitempty"`
}

// --- Client messages ---

type MsgClientHi struct {
	ID        string `json:"id,omitempty"`
	UserAgent string `json:"ua,omitempty"`
	Version   string `json:"ver,omitempty"`
	Lang      string `json:"lang,omitempty"`
}

type MsgClientAcc struct {
	ID     string            `json:"id,omitempty"`
	User   string            `json:"user,omitempty"`
	Scheme string            `json:"scheme,omitempty"`
	Secret string            `json:"secret,omitempty"`
	Desc   map[string]string `json:"desc,omitempty"`
}

type MsgClientLogin struct {
	ID     string `json:"id,omitempty"`
	Scheme string `json:"scheme,omitempty"`
	Secret string `json:"secret,omitempty"`
}

type MsgClientSub struct {
	ID    string `json:"id,omitempty"`
	Topic string `json:"topic"`
}

type MsgClientPub struct {
	ID      string      `json:"id,omitempty"`
	Topic   string      `json:"topic"`
	Content interface{} `json:"content"`
	ReplyTo int         `json:"reply_to,omitempty"`
}

type MsgClientGet struct {
	ID    string `json:"id,omitempty"`
	Topic string `json:"topic"`
	What  string `json:"what,omitempty"`
	SeqID int    `json:"seq,omitempty"` // For history requests: fetch messages after this seq
}

type MsgClientSet struct {
	ID    string      `json:"id,omitempty"`
	Topic string      `json:"topic"`
	Desc  interface{} `json:"desc,omitempty"`
}

type MsgClientDel struct {
	ID    string `json:"id,omitempty"`
	Topic string `json:"topic,omitempty"`
	What  string `json:"what,omitempty"`
}

type MsgClientNote struct {
	Topic string `json:"topic"`
	What  string `json:"what"` // "read", "recv", "kp" (key press / typing)
	SeqID int    `json:"seq,omitempty"`
}

// MsgClientFriend is the new friend protocol message.
type MsgClientFriend struct {
	ID     string `json:"id,omitempty"`
	Action string `json:"action"` // "request", "accept", "reject", "block", "remove"
	UserID int64  `json:"user_id"`
	Msg    string `json:"msg,omitempty"`
}

// --- Server messages ---

type MsgServerCtrl struct {
	ID     string      `json:"id,omitempty"`
	Topic  string      `json:"topic,omitempty"`
	Code   int         `json:"code"`
	Text   string      `json:"text,omitempty"`
	Params interface{} `json:"params,omitempty"`
}

type MsgServerData struct {
	Topic    string      `json:"topic"`
	From     string      `json:"from,omitempty"`
	SeqID    int         `json:"seq"`
	Content  interface{} `json:"content"`
	ReplyTo  int         `json:"reply_to,omitempty"`
	Mentions []string    `json:"mentions,omitempty"` // @mentioned user IDs (e.g., ["usr123"])
}

type MsgServerPres struct {
	Topic string `json:"topic"`
	What  string `json:"what"` // "on", "off", "msg", "upd"
	Src   string `json:"src,omitempty"`
}

type MsgServerMeta struct {
	ID    string      `json:"id,omitempty"`
	Topic string      `json:"topic"`
	Desc  interface{} `json:"desc,omitempty"`
	Sub   interface{} `json:"sub,omitempty"`
}

type MsgServerInfo struct {
	Topic string `json:"topic"`
	From  string `json:"from"`
	What  string `json:"what"` // "read", "recv", "kp"
	SeqID int    `json:"seq,omitempty"`
}

// MsgServerFriend is the server-side friend notification.
type MsgServerFriend struct {
	Action string `json:"action"` // "request", "accepted", "rejected", "blocked", "removed"
	From   int64  `json:"from"`
	To     int64  `json:"to"`
	Msg    string `json:"msg,omitempty"`
}
