import React, { useState, useEffect } from 'react';
import { api } from '../api';
import t from '../i18n';
import FriendRequest from '../widgets/friend-request';
import AddFriend from '../widgets/add-friend';
import CreateGroup from '../widgets/create-group';
import Avatar from '../widgets/avatar';

export default function FriendsView({ onSelectUser, user }) {
  const [friends, setFriends] = useState([]);
  const [groups, setGroups] = useState([]);
  const [pending, setPending] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [showPending, setShowPending] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);

  useEffect(() => {
    loadFriends();
    loadPending();
    loadGroups();
  }, []);

  useEffect(() => {
    const reload = () => {
      loadFriends();
      loadPending();
      loadGroups();
    };
    window.addEventListener('cc:data-changed', reload);
    return () => window.removeEventListener('cc:data-changed', reload);
  }, []);

  const loadFriends = async () => {
    try {
      const res = await api.getFriends();
      setFriends(res.friends || []);
    } catch (e) {
      console.error('load friends:', e);
    }
  };

  const loadPending = async () => {
    try {
      const res = await api.getPendingRequests();
      setPending(res.requests || []);
    } catch (e) {
      console.error('load pending:', e);
    }
  };

  const loadGroups = async () => {
    try {
      const res = await api.getGroups();
      setGroups(res.groups || []);
    } catch (e) {
      console.error('load groups:', e);
    }
  };

  const handleAccept = async (userId) => {
    await api.acceptFriend(userId);
    loadFriends();
    loadPending();
  };

  const handleReject = async (userId) => {
    await api.rejectFriend(userId);
    loadPending();
  };

  const handleGroupCreated = () => {
    loadGroups();
  };

  return (
    <>
      <div className="oc-header">
        {t('contacts_title')}
        <button className="oc-header-action" onClick={() => setShowAdd(true)}>+</button>
      </div>
      <div className="oc-search">
        <input placeholder={t('contacts_search_placeholder')} />
      </div>
      <div className="oc-contacts">
        {/* New Friends Section */}
        <div className="oc-contact-item" onClick={() => setShowPending(!showPending)}>
          <div className="oc-contact-avatar" style={{ background: '#FF9500', borderRadius: 6 }} />
          <span className="oc-contact-name">
            {t('contacts_new_friends')}
            {pending.length > 0 && (
              <span style={{
                background: '#FA5151', color: '#fff', borderRadius: 10,
                padding: '1px 6px', fontSize: 11, marginLeft: 8
              }}>
                {pending.length}
              </span>
            )}
          </span>
        </div>

        {showPending && pending.map((req) => (
          <FriendRequest
            key={req.id}
            request={req}
            onAccept={() => handleAccept(req.from_user_id)}
            onReject={() => handleReject(req.from_user_id)}
          />
        ))}

        {/* Groups Section */}
        <div className="oc-contact-section">
          <div className="oc-contact-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{t('contacts_groups')}</span>
            <button
              onClick={() => setShowCreateGroup(true)}
              style={{
                background: 'none', border: 'none', color: '#07C160',
                fontSize: 13, cursor: 'pointer', padding: '0 4px',
              }}
            >
              {t('group_create')}
            </button>
          </div>
          {groups.length === 0 ? (
            <div style={{ padding: 12, textAlign: 'center', color: '#888', fontSize: 13 }}>
              {t('group_no_groups')}
            </div>
          ) : (
            groups.map((group) => (
              <div
                key={group.id}
                className="oc-contact-item"
                onClick={() => onSelectUser({
                  topicId: `grp_${group.id}`,
                  name: group.name,
                  isGroup: true,
                  groupId: group.id,
                  avatar_url: group.avatar_url,
                })}
              >
                <Avatar name={group.name} src={group.avatar_url} size={40} isGroup className="oc-contact-avatar oc-group-avatar" />
                <span className="oc-contact-name">{group.name}</span>
              </div>
            ))
          )}
        </div>

        {/* Friends List */}
        <div className="oc-contact-section">
          <div className="oc-contact-section-title">{t('contacts_friends')}</div>
          {friends.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: '#888', fontSize: 13 }}>
              {t('contacts_empty')}
            </div>
          ) : (
            friends.map((friend) => (
              <div
                key={friend.id}
                className="oc-contact-item"
                onClick={() => onSelectUser({
                  topicId: p2pTopicId(user.uid, friend.id),
                  name: friend.display_name || friend.username,
                  isGroup: false,
                  avatar_url: friend.avatar_url,
                  friendId: friend.id,
                })}
              >
                <Avatar
                  name={friend.display_name || friend.username}
                  src={friend.avatar_url}
                  size={40}
                  isBot={friend.account_type === 'bot'}
                  className="oc-contact-avatar"
                />
                <span className="oc-contact-name">{friend.display_name || friend.username}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {showAdd && <AddFriend onClose={() => setShowAdd(false)} onSent={loadPending} />}
      {showCreateGroup && (
        <CreateGroup
          onClose={() => setShowCreateGroup(false)}
          onCreated={handleGroupCreated}
        />
      )}
    </>
  );
}

function p2pTopicId(uid1, uid2) {
  if (uid1 > uid2) [uid1, uid2] = [uid2, uid1];
  return `p2p_${uid1}_${uid2}`;
}
