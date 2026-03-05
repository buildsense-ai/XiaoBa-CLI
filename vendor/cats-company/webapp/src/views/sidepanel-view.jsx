import React, { useState, useEffect } from 'react';
import { api, onWSMessage, updateTopicSeq } from '../api';
import t from '../i18n';
import CreateGroup from '../widgets/create-group';
import Avatar from '../widgets/avatar';

export default function ChatListView({ activeTopic, onSelectTopic, user, onlineUsers }) {
  const [chats, setChats] = useState([]);
  const [search, setSearch] = useState('');
  const [showCreateGroup, setShowCreateGroup] = useState(false);

  useEffect(() => {
    loadChats();
  }, []);

  useEffect(() => {
    const reload = () => loadChats();
    window.addEventListener('cc:data-changed', reload);
    return () => window.removeEventListener('cc:data-changed', reload);
  }, []);

  // Listen for real-time message updates and group events
  useEffect(() => {
    const unsub = onWSMessage((msg) => {
      if (msg.data) {
        const topicId = msg.data.topic;
        const seq = msg.data.seq;
        updateTopicSeq(topicId, seq);
        setChats((prev) => {
          const idx = prev.findIndex((c) => c.id === topicId);
          if (idx !== -1) {
            const updated = {
              ...prev[idx],
              preview: summarizeMessage({ content: msg.data.content }),
              time: formatTime(new Date()),
              seq,
            };
            return [updated, ...prev.filter((c) => c.id !== topicId)];
          }
          if (topicId.startsWith('grp_') || topicId.startsWith('p2p_')) {
            loadChats();
          }
          return prev;
        });
      }

      // Reload chat list on group events
      if (msg.pres && msg.pres.what && msg.pres.what.startsWith('group_')) {
        loadChats();
      }
      if (msg.pres && msg.pres.what === 'members_invited') {
        loadChats();
      }
    });
    return () => unsub();
  }, []);

  const loadChats = async () => {
    try {
      const res = await api.getConversations();
      const conversations = (res.conversations || []).map((item) => ({
        id: item.id,
        friendId: item.friend_id,
        groupId: item.group_id,
        name: item.name,
        preview: item.preview || '',
        time: item.last_time ? formatTime(new Date(item.last_time)) : '',
        isGroup: item.is_group,
        avatar_url: item.avatar_url,
        isBot: item.is_bot,
        isOnline: item.is_online,
        seq: item.latest_seq || 0,
      }));
      setChats(conversations);
    } catch (e) {
      console.error('Failed to load chats:', e);
    }
  };

  const handleGroupCreated = () => {
    loadChats();
  };

  const filtered = chats.filter(
    (c) => c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <>
      <div className="oc-header">
        {t('chats_title')}
        <button
          className="oc-header-action"
          onClick={() => setShowCreateGroup(true)}
          title={t('group_create')}
        >
          +
        </button>
      </div>
      <div className="oc-search">
        <input
          placeholder={t('chats_search_placeholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="oc-chat-list">
        {filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>
            {t('chats_empty')}
          </div>
        ) : (
          filtered.map((chat) => {
            const isOnline = !chat.isGroup && (
              (onlineUsers && onlineUsers[chat.friendId]) ||
              chat.isOnline
            );
            return (
              <div
                key={chat.id}
                className={`oc-chat-item ${activeTopic === chat.id ? 'active' : ''}`}
                onClick={() => onSelectTopic({
                  topicId: chat.id,
                  name: chat.name,
                  isGroup: chat.isGroup,
                  groupId: chat.groupId,
                  avatar_url: chat.avatar_url,
                  friendId: chat.friendId,
                })}
              >
                <div className="oc-chat-avatar-wrap">
                  <Avatar
                    name={chat.name}
                    src={chat.avatar_url}
                    size={48}
                    isGroup={chat.isGroup}
                    isBot={chat.isBot}
                    className="oc-chat-avatar"
                  />
                  {!chat.isGroup && (
                    <span className={`oc-online-dot ${isOnline ? 'online' : ''}`} />
                  )}
                </div>
                <div className="oc-chat-info">
                  <div className="oc-chat-name">
                    <span>{chat.name}</span>
                    <span className="oc-chat-time">{chat.time}</span>
                  </div>
                  <div className="oc-chat-preview">
                    {chat.preview || (isOnline ? t('online') : '')}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {showCreateGroup && (
        <CreateGroup
          onClose={() => setShowCreateGroup(false)}
          onCreated={handleGroupCreated}
        />
      )}
    </>
  );
}

function formatTime(date) {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function summarizeMessage(message) {
  if (!message) return '';
  if (typeof message.content === 'string') {
    try {
      const parsed = JSON.parse(message.content);
      if (parsed?.type === 'file') return parsed?.payload?.name || '[文件]';
      if (parsed?.type === 'image') return '[图片]';
    } catch (err) {
      return message.content;
    }
    return message.content;
  }
  if (message.content?.type === 'file') return message.content?.payload?.name || '[文件]';
  if (message.content?.type === 'image') return '[图片]';
  return message.content?.text || '';
}
