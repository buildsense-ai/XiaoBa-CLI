import React, { useState } from 'react';
import { api } from '../api';
import t from '../i18n';
import Avatar from './avatar';

export default function AddFriend({ onClose, onSent }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [sent, setSent] = useState(new Set());

  const handleSearch = async () => {
    if (query.length < 2) return;
    try {
      const res = await api.searchUsers(query);
      setResults(res.users || []);
    } catch (e) {
      console.error('search:', e);
    }
  };

  const handleSend = async (userId) => {
    try {
      await api.sendFriendRequest(userId, message);
      setSent((prev) => new Set([...prev, userId]));
      onSent();
    } catch (e) {
      console.error('send request:', e);
    }
  };

  return (
    <div className="oc-modal-overlay" onClick={onClose}>
      <div className="oc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="oc-modal-title">{t('contacts_add_friend')}</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            className="oc-auth-input"
            style={{ marginBottom: 0, flex: 1 }}
            placeholder={t('contacts_search_placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
          <button className="oc-btn oc-btn-primary" onClick={handleSearch}>
            {t('search')}
          </button>
        </div>

        {results.map((user) => (
          <div key={user.id} className="oc-contact-item">
            <Avatar
              name={user.display_name || user.username}
              src={user.avatar_url}
              size={40}
              isBot={user.account_type === 'bot'}
              className="oc-contact-avatar"
            />
            <span className="oc-contact-name" style={{ flex: 1 }}>
              {user.display_name || user.username}
            </span>
            {sent.has(user.id) ? (
              <span style={{ color: '#888', fontSize: 13 }}>
                {t('friend_request_sent')}
              </span>
            ) : (
              <button
                className="oc-btn oc-btn-primary"
                onClick={() => handleSend(user.id)}
              >
                {t('friend_request_send')}
              </button>
            )}
          </div>
        ))}

        {results.length === 0 && query.length >= 2 && (
          <div style={{ textAlign: 'center', color: '#888', padding: 20 }}>
            {t('no_data')}
          </div>
        )}
      </div>
    </div>
  );
}
