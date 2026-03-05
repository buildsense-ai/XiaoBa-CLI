import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import t from '../i18n';
import Avatar from './avatar';

export default function GroupSettings({ groupId, onClose, onSaved }) {
  const fileInputRef = useRef(null);
  const [group, setGroup] = useState(null);
  const [members, setMembers] = useState([]);
  const [friends, setFriends] = useState([]);
  const [name, setName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadData();
  }, [groupId]);

  const loadData = async () => {
    try {
      const [groupRes, friendsRes] = await Promise.all([
        api.getGroupInfo(groupId),
        api.getFriends(),
      ]);
      setGroup(groupRes.group || null);
      setMembers(groupRes.members || []);
      setFriends(friendsRes.friends || []);
      setName(groupRes.group?.name || '');
      setAvatarUrl(groupRes.group?.avatar_url || '');
      setError('');
    } catch (err) {
      setError(err.message || t('error_server'));
    }
  };

  const availableFriends = useMemo(() => {
    const memberIds = new Set(members.map((member) => member.user_id));
    return friends.filter((friend) => !memberIds.has(friend.id));
  }, [friends, members]);

  const toggleInvite = (userId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleSelectAvatar = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setError('');
    try {
      const uploaded = await api.uploadFile(file, 'image');
      setAvatarUrl(uploaded.url || '');
    } catch (err) {
      setError(err.message || t('error_server'));
    } finally {
      event.target.value = '';
    }
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError(t('group_name_placeholder'));
      return;
    }

    setSaving(true);
    setError('');
    try {
      if (group && (group.name !== name.trim() || (group.avatar_url || '') !== (avatarUrl || ''))) {
        const updated = await api.updateGroup(groupId, name.trim(), avatarUrl || '');
        setGroup(updated.group || updated);
      }
      if (selected.size > 0) {
        await api.inviteToGroup(groupId, Array.from(selected));
      }
      const refreshed = await api.getGroupInfo(groupId);
      setGroup(refreshed.group || null);
      setMembers(refreshed.members || []);
      setSelected(new Set());
      if (onSaved) onSaved(refreshed.group || group);
      onClose();
    } catch (err) {
      setError(err.message || t('error_server'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="oc-modal-overlay" onClick={onClose}>
      <div className="oc-modal oc-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="oc-modal-title">{t('group_settings')}</div>
        <div className="oc-settings-avatar-block">
          <Avatar name={name || group?.name || t('contacts_groups')} src={avatarUrl} size={88} isGroup />
          <button className="oc-btn oc-btn-default" onClick={() => fileInputRef.current?.click()}>
            {t('group_avatar_pick')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleSelectAvatar}
          />
        </div>
        <input
          className="oc-auth-input"
          placeholder={t('group_name_placeholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div className="oc-settings-section">
          <div className="oc-settings-section-title">{t('group_members')} ({members.length})</div>
          <div className="oc-settings-list">
            {members.map((member) => (
              <div key={member.user_id} className="oc-settings-list-item">
                <Avatar
                  name={member.display_name || member.username}
                  src={member.avatar_url}
                  size={32}
                  isBot={member.is_bot}
                />
                <div className="oc-settings-list-text">
                  <div>{member.display_name || member.username}</div>
                  <div className="oc-settings-secondary">@{member.username}</div>
                </div>
                <div className="oc-settings-secondary">
                  {member.role === 'owner' ? t('group_owner') : member.role === 'admin' ? t('group_admin') : t('group_member')}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="oc-settings-section">
          <div className="oc-settings-section-title">{t('group_add_members')}</div>
          <div className="oc-settings-list">
            {availableFriends.length === 0 ? (
              <div className="oc-settings-empty">{t('group_no_invitable_members')}</div>
            ) : availableFriends.map((friend) => (
              <button
                key={friend.id}
                type="button"
                className="oc-settings-list-item oc-settings-list-button"
                onClick={() => toggleInvite(friend.id)}
              >
                <Avatar name={friend.display_name || friend.username} src={friend.avatar_url} size={32} isBot={friend.account_type === 'bot'} />
                <div className="oc-settings-list-text">
                  <div>{friend.display_name || friend.username}</div>
                  <div className="oc-settings-secondary">@{friend.username}</div>
                </div>
                <div className="oc-settings-check">{selected.has(friend.id) ? '✓' : ''}</div>
              </button>
            ))}
          </div>
        </div>

        {error && <div className="oc-form-error">{error}</div>}
        <div className="oc-settings-actions">
          <button className="oc-btn oc-btn-default" onClick={onClose}>{t('cancel')}</button>
          <button className="oc-btn oc-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? t('loading') : t('save')}
          </button>
        </div>
      </div>
    </div>
  );
}
