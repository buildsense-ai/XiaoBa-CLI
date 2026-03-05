import React, { useState, useEffect, useCallback } from 'react';
import { api, setToken, getToken, connectWS, disconnectWS } from '../api';
import t from '../i18n';
import ChatListView from './sidepanel-view';
import FriendsView from './friends-view';
import MessagesView from './messages-view';
import BotAdminView from './bot-admin-view';
import ProfileEditor from '../widgets/profile-editor';
import Avatar from '../widgets/avatar';
import '../css/openchat-theme.css';

const TABS = {
  CHATS: 'chats',
  CONTACTS: 'contacts',
  ME: 'me',
};

export default function TinodeWeb() {
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState(TABS.CHATS);
  const [activeTopic, setActiveTopic] = useState(null);
  const [meScreen, setMeScreen] = useState('profile');
  const [authMode, setAuthMode] = useState('login');
  const [onlineUsers, setOnlineUsers] = useState({});
  const [wsStatus, setWsStatus] = useState('disconnected');
  const [showProfileEditor, setShowProfileEditor] = useState(false);

  // Restore session
  useEffect(() => {
    const token = getToken();
    if (token) {
      const saved = localStorage.getItem('oc_user');
      if (saved) setUser(JSON.parse(saved));
    }
  }, []);

  const persistUser = useCallback((nextUser) => {
    localStorage.setItem('oc_user', JSON.stringify(nextUser));
    setUser(nextUser);
  }, []);

  // WebSocket message handler
  const handleWSMessage = useCallback((msg) => {
    // Internal events
    if (msg._type === 'ws_open') {
      setWsStatus('connected');
      return;
    }
    if (msg._type === 'ws_close') {
      setWsStatus('reconnecting');
      return;
    }

    // Online status response from {get what="online"}
    if (msg.meta && msg.meta.sub) {
      const online = {};
      for (const u of msg.meta.sub) {
        if (u.uid && u.online) {
          online[u.uid] = true;
        }
      }
      setOnlineUsers((prev) => ({ ...prev, ...online }));
    }

    // Presence notifications (friend came online/offline)
    if (msg.pres) {
      const uid = parseUid(msg.pres.src);
      if (uid > 0) {
        setOnlineUsers((prev) => {
          const next = { ...prev };
          if (msg.pres.what === 'on') {
            next[uid] = true;
          } else if (msg.pres.what === 'off') {
            delete next[uid];
          }
          return next;
        });
      }
    }
  }, []);

  // Connect WebSocket when user logs in
  useEffect(() => {
    if (user) {
      connectWS(handleWSMessage);
    }
    return () => {
      if (user) disconnectWS();
    };
  }, [user, handleWSMessage]);

  const handleLogin = async (username, password) => {
    const res = await api.login({ username, password });
    setToken(res.token);
    persistUser({
      uid: res.uid,
      username: res.username,
      display_name: res.display_name || res.username,
      avatar_url: res.avatar_url || '',
      account_type: res.account_type || 'human',
    });
  };

  const handleRegister = async (username, password, displayName) => {
    await api.register({ username, password, display_name: displayName });
    await handleLogin(username, password);
  };

  const handleLogout = () => {
    disconnectWS();
    setToken(null);
    localStorage.removeItem('oc_user');
    setUser(null);
    setOnlineUsers({});
    setActiveTopic(null);
    setMeScreen('profile');
  };

  const handleUserUpdated = (nextUser) => {
    persistUser({
      uid: nextUser.uid,
      username: nextUser.username,
      display_name: nextUser.display_name || nextUser.username,
      avatar_url: nextUser.avatar_url || '',
      account_type: nextUser.account_type || 'human',
    });
    window.dispatchEvent(new Event('cc:data-changed'));
  };

  const handleTopicUpdated = (nextTopic) => {
    setActiveTopic((prev) => {
      if (!prev || prev.topicId !== nextTopic.topicId) return prev;
      return { ...prev, ...nextTopic };
    });
  };

  if (!user) {
    return <AuthView mode={authMode} setMode={setAuthMode} onLogin={handleLogin} onRegister={handleRegister} />;
  }

  return (
    <div className="oc-app">
      <div className="oc-sidebar">
        <SidebarContent
          activeTab={activeTab}
          activeTopic={activeTopic ? activeTopic.topicId : null}
          onSelectTopic={setActiveTopic}
          user={user}
          onLogout={handleLogout}
          meScreen={meScreen}
          onOpenBots={() => setMeScreen('bots')}
          onOpenProfile={() => setShowProfileEditor(true)}
          onBackFromBots={() => setMeScreen('profile')}
          onlineUsers={onlineUsers}
          wsStatus={wsStatus}
        />
        <TabBar activeTab={activeTab} onTabChange={setActiveTab} />
      </div>
      <div className="oc-main">
        {activeTopic ? (
          <MessagesView
            topic={activeTopic.topicId}
            topicName={activeTopic.name}
            user={user}
            isGroup={activeTopic.isGroup || (activeTopic.topicId && activeTopic.topicId.startsWith('grp_'))}
            groupId={activeTopic.groupId}
            topicAvatarUrl={activeTopic.avatar_url}
            onTopicUpdated={handleTopicUpdated}
          />
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
            {t('chats_empty')}
          </div>
        )}
      </div>
      {showProfileEditor && (
        <ProfileEditor
          user={user}
          onClose={() => setShowProfileEditor(false)}
          onSaved={handleUserUpdated}
        />
      )}
    </div>
  );
}

function SidebarContent({
  activeTab,
  activeTopic,
  onSelectTopic,
  user,
  onLogout,
  meScreen,
  onOpenBots,
  onOpenProfile,
  onBackFromBots,
  onlineUsers,
  wsStatus,
}) {
  switch (activeTab) {
    case TABS.CONTACTS:
      return <FriendsView onSelectUser={onSelectTopic} user={user} />;
    case TABS.ME:
      if (meScreen === 'bots') {
        return <BotAdminView onBack={onBackFromBots} user={user} />;
      }
      return <ProfileView user={user} onLogout={onLogout} onOpenBots={onOpenBots} onOpenProfile={onOpenProfile} wsStatus={wsStatus} />;
    default:
      return <ChatListView activeTopic={activeTopic} onSelectTopic={onSelectTopic} user={user} onlineUsers={onlineUsers} />;
  }
}

function TabBar({ activeTab, onTabChange }) {
  const tabs = [
    { key: TABS.CHATS, label: t('tab_chats'), icon: '\u{1F4AC}' },
    { key: TABS.CONTACTS, label: t('tab_contacts'), icon: '\u{1F464}' },
    { key: TABS.ME, label: t('tab_me'), icon: '\u{1F9D1}' },
  ];

  return (
    <div className="oc-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          className={`oc-tab ${activeTab === tab.key ? 'active' : ''}`}
          onClick={() => onTabChange(tab.key)}
        >
          <span className="oc-tab-icon">{tab.icon}</span>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function ProfileView({ user, onLogout, onOpenBots, onOpenProfile, wsStatus }) {
  const statusText = wsStatus === 'connected' ? t('online') : t('offline');
  const statusClass = wsStatus === 'connected' ? 'online' : '';

  return (
    <div className="oc-profile">
      <div className="oc-header">{t('me_title')}</div>
      <div className="oc-profile-card">
        <Avatar
          name={user.display_name || user.username}
          src={user.avatar_url}
          size={64}
          isBot={user.account_type === 'bot'}
          className="oc-profile-avatar"
        />
        <div>
          <div className="oc-profile-name">{user.display_name || user.username}</div>
          <div className="oc-profile-id">ID: {user.username}</div>
          <div className="oc-profile-status">
            <span className={`oc-online-dot ${statusClass}`} />
            {statusText}
          </div>
        </div>
      </div>
      <div className="oc-contact-item" onClick={onOpenProfile}>
        {t('me_profile_edit')}
      </div>
      <div className="oc-contact-item" onClick={onOpenBots}>
        {t('bot_admin')}
      </div>
      <div className="oc-contact-item" onClick={onLogout} style={{ color: '#FA5151', cursor: 'pointer' }}>
        {t('logout')}
      </div>
    </div>
  );
}

function AuthView({ mode, setMode, onLogin, onRegister }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (mode === 'login') {
        await onLogin(username, password);
      } else {
        await onRegister(username, password, displayName);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="oc-auth">
      <form className="oc-auth-card" onSubmit={handleSubmit}>
        <div className="oc-auth-logo">Cats Company</div>
        {error && <div style={{ color: '#FA5151', marginBottom: 12, fontSize: 13 }}>{error}</div>}
        <input
          className="oc-auth-input"
          placeholder={t('username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        {mode === 'register' && (
          <input
            className="oc-auth-input"
            placeholder={t('display_name')}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        )}
        <input
          className="oc-auth-input"
          type="password"
          placeholder={t('password')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="oc-auth-btn" type="submit">
          {mode === 'login' ? t('login') : t('register')}
        </button>
        <div className="oc-auth-link">
          {mode === 'login' ? (
            <span>{t('register')} <a href="#" onClick={(e) => { e.preventDefault(); setMode('register'); }}>{t('register')}</a></span>
          ) : (
            <span>{t('login')} <a href="#" onClick={(e) => { e.preventDefault(); setMode('login'); }}>{t('login')}</a></span>
          )}
        </div>
      </form>
    </div>
  );
}

function parseUid(uidStr) {
  if (!uidStr) return 0;
  if (uidStr.startsWith('usr')) {
    return parseInt(uidStr.slice(3), 10) || 0;
  }
  return parseInt(uidStr, 10) || 0;
}
