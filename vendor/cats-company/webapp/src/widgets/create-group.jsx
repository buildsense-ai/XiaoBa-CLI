import React, { useState, useEffect } from 'react';
import { api } from '../api';
import t from '../i18n';
import Avatar from './avatar';

export default function CreateGroup({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [friends, setFriends] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadFriends();
  }, []);

  const loadFriends = async () => {
    try {
      const res = await api.getFriends();
      setFriends(res.friends || []);
    } catch (e) {
      console.error('load friends for group:', e);
    }
  };

  const toggleMember = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError(t('group_name_placeholder'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.createGroup(name.trim(), Array.from(selected));
      if (onCreated) onCreated(res);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="oc-modal-overlay" onClick={onClose}>
      <div className="oc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="oc-modal-title">{t('group_create')}</div>
        {error && <div style={{ color: '#FA5151', fontSize: 13, marginBottom: 8 }}>{error}</div>}
        <input
          className="oc-auth-input"
          placeholder={t('group_name_placeholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        <div style={{ fontSize: 13, color: '#888', marginBottom: 8 }}>
          {t('group_select_members')} ({selected.size})
        </div>
        <div style={{ maxHeight: 280, overflowY: 'auto', marginBottom: 16 }}>
          {friends.map((f) => (
            <label
              key={f.id}
              className="oc-group-member-check"
              style={{
                display: 'flex', alignItems: 'center', padding: '8px 0',
                cursor: 'pointer', gap: 10,
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(f.id)}
                onChange={() => toggleMember(f.id)}
                style={{ width: 18, height: 18, accentColor: '#07C160' }}
              />
              <Avatar
                name={f.display_name || f.username}
                src={f.avatar_url}
                size={32}
                isBot={f.account_type === 'bot'}
                className="oc-contact-avatar"
              />
              <span style={{ fontSize: 14 }}>{f.display_name || f.username}</span>
            </label>
          ))}
          {friends.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: '#888', fontSize: 13 }}>
              {t('contacts_empty')}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="oc-btn oc-btn-default" onClick={onClose}>{t('cancel')}</button>
          <button className="oc-btn oc-btn-primary" onClick={handleCreate} disabled={loading}>
            {loading ? t('loading') : t('confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
