import React, { useRef, useState } from 'react';
import { api } from '../api';
import t from '../i18n';
import Avatar from './avatar';

export default function ProfileEditor({ user, onClose, onSaved }) {
  const fileInputRef = useRef(null);
  const [displayName, setDisplayName] = useState(user?.display_name || user?.username || '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

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
    if (!displayName.trim()) {
      setError(t('display_name'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const updated = await api.updateMe(displayName.trim(), avatarUrl || '');
      if (onSaved) onSaved(updated);
      onClose();
    } catch (err) {
      setError(err.message || t('error_server'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="oc-modal-overlay" onClick={onClose}>
      <div className="oc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="oc-modal-title">{t('me_profile_edit')}</div>
        <div className="oc-settings-avatar-block">
          <Avatar name={displayName || user?.username} src={avatarUrl} size={88} />
          <button className="oc-btn oc-btn-default" onClick={() => fileInputRef.current?.click()}>
            {t('me_avatar_pick')}
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
          placeholder={t('display_name')}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
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
