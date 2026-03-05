const API_BASE = process.env.REACT_APP_API_BASE || '';
const WS_URL = process.env.REACT_APP_WS_URL || `ws://${window.location.host}/v0/channels`;

let token = localStorage.getItem('oc_token');
let wsConn = null;
let wsReconnectTimer = null;
let msgHandlers = [];
let wsConnected = false;
let topicLastSeq = {};

export function updateTopicSeq(topicId, seq) {
  if (!topicLastSeq[topicId] || seq > topicLastSeq[topicId]) {
    topicLastSeq[topicId] = seq;
  }
}

export function requestMissedMessages(topicId) {
  const lastSeq = topicLastSeq[topicId] || 0;
  if (lastSeq > 0) {
    sendWS({ get: { id: nextMsgId(), topic: topicId, what: 'history', seq: lastSeq } });
  }
}

export function setToken(t) {
  token = t;
  if (t) localStorage.setItem('oc_token', t);
  else localStorage.removeItem('oc_token');
}

export function getToken() {
  return token;
}

export function getWebSocketURL() {
  return WS_URL;
}

export function resolveMediaURL(url) {
  if (!url) return '';
  if (/^https?:\/\//.test(url)) return url;
  return `${API_BASE}${url}`;
}

export function isWSConnected() {
  return wsConnected;
}

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export const api = {
  register: (data) => request('POST', '/api/auth/register', data),
  login: (data) => request('POST', '/api/auth/login', data),
  getMe: () => request('GET', '/api/me'),
  updateMe: (displayName, avatarUrl) =>
    request('POST', '/api/me/update', { display_name: displayName, avatar_url: avatarUrl }),

  getFriends: () => request('GET', '/api/friends'),
  getPendingRequests: () => request('GET', '/api/friends/pending'),
  sendFriendRequest: (userId, message) =>
    request('POST', '/api/friends/request', { user_id: userId, message }),
  acceptFriend: (userId) =>
    request('POST', '/api/friends/accept', { user_id: userId }),
  rejectFriend: (userId) =>
    request('POST', '/api/friends/reject', { user_id: userId }),
  blockUser: (userId) =>
    request('POST', '/api/friends/block', { user_id: userId }),
  removeFriend: (userId) =>
    request('DELETE', `/api/friends/remove?user_id=${userId}`),

  searchUsers: (q) => request('GET', `/api/users/search?q=${encodeURIComponent(q)}`),

  // Send message via REST
  sendMessage: (topicId, content) =>
    request('POST', '/api/messages/send', { topic_id: topicId, content, msg_type: 'text' }),

  // REST fallback for message history
  getMessages: (topicId, limit, offset, latest = false) =>
    request('GET', `/api/messages?topic_id=${encodeURIComponent(topicId)}&limit=${limit || 50}&offset=${offset || 0}${latest ? '&latest=1' : ''}`),
  getConversations: () => request('GET', '/api/conversations'),

  getOnlineStatus: () => request('GET', '/api/users/online'),

  // Groups
  createGroup: (name, memberIds) => request('POST', '/api/groups/create', { name, member_ids: memberIds }),
  getGroups: () => request('GET', '/api/groups'),
  getGroupInfo: (groupId) => request('GET', `/api/groups/info?id=${groupId}`),
  updateGroup: (groupId, name, avatarUrl) =>
    request('POST', '/api/groups/update', { group_id: groupId, name, avatar_url: avatarUrl }),
  inviteToGroup: (groupId, userIds) => request('POST', '/api/groups/invite', { group_id: groupId, user_ids: userIds }),
  leaveGroup: (groupId) => request('POST', '/api/groups/leave', { group_id: groupId }),
  kickMember: (groupId, userId) => request('POST', '/api/groups/kick', { group_id: groupId, user_id: userId }),
  disbandGroup: (groupId) => request('POST', '/api/groups/disband', { group_id: groupId }),
  updateMemberRole: (groupId, userId, role) => request('POST', '/api/groups/role', { group_id: groupId, user_id: userId, role }),

  // Bot management
  getMyBots: () => request('GET', '/api/bots'),
  createBot: ({ username, display_name }, deployToCloud = false) =>
    request('POST', deployToCloud ? '/api/bots/deploy' : '/api/bots', { username, display_name }),
  deleteBot: (uid) => request('DELETE', `/api/bots?uid=${uid}`),
  setBotVisibility: (uid, visibility) => request('PATCH', `/api/bots/visibility?uid=${uid}&v=${visibility}`),
  acceptFriendAsBot: async (apiKey, userId) => {
    const res = await fetch(`${API_BASE}/api/friends/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${apiKey}`,
      },
      body: JSON.stringify({ user_id: userId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },
  uploadFile: async (file, type = 'file') => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API_BASE}/api/upload?type=${type}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data;
  },
};

// --- WebSocket ---

let _msgIdCounter = 0;
function nextMsgId() {
  return String(++_msgIdCounter);
}

export function connectWS(onMessage) {
  if (wsConn) {
    wsConn.close();
    wsConn = null;
  }
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (!token) return;

  const url = `${WS_URL}?token=${token}`;
  wsConn = new WebSocket(url);

  wsConn.onopen = () => {
    console.log('WebSocket connected');
    wsConnected = true;
    // Send handshake
    sendWS({ hi: { id: nextMsgId(), ver: '0.1.0' } });
    // Request online status of friends
    sendWS({ get: { id: nextMsgId(), topic: 'me', what: 'online' } });
    // Request missed messages for all tracked topics
    Object.keys(topicLastSeq).forEach((tid) => {
      requestMissedMessages(tid);
    });
    onMessage({ _type: 'ws_open' });
  };

  wsConn.onclose = () => {
    console.log('WebSocket disconnected');
    wsConnected = false;
    onMessage({ _type: 'ws_close' });
    // Reconnect after 3s
    wsReconnectTimer = setTimeout(() => connectWS(onMessage), 3000);
  };

  wsConn.onerror = (err) => {
    console.error('WebSocket error:', err);
  };

  wsConn.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      onMessage(msg);
      msgHandlers.forEach((h) => h(msg));
    } catch (e) {
      console.error('WS parse error:', e);
    }
  };
}

export function disconnectWS() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (wsConn) {
    wsConn.close();
    wsConn = null;
  }
  wsConnected = false;
}

export function sendWS(msg) {
  if (wsConn && wsConn.readyState === WebSocket.OPEN) {
    wsConn.send(JSON.stringify(msg));
  }
}

// Send a chat message via WebSocket, with REST fallback
export async function wsSendMessage(topicId, content, replyTo) {
  if (wsConn && wsConn.readyState === WebSocket.OPEN) {
    const id = nextMsgId();
    const pub = { id, topic: topicId, content };
    if (replyTo) pub.reply_to = replyTo;
    sendWS({ pub });
    return id;
  }
  // Fallback to REST if WebSocket is not connected
  await api.sendMessage(topicId, content);
  return null;
}

// Send typing indicator
export function wsSendTyping(topicId) {
  sendWS({ note: { topic: topicId, what: 'kp' } });
}

// Send read receipt
export function wsSendRead(topicId, seqId) {
  sendWS({ note: { topic: topicId, what: 'read', seq: seqId } });
}

export function onWSMessage(handler) {
  msgHandlers.push(handler);
  return () => {
    msgHandlers = msgHandlers.filter((h) => h !== handler);
  };
}
