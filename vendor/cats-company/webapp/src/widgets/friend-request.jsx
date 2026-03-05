import React from 'react';
import t from '../i18n';
import Avatar from './avatar';

export default function FriendRequest({ request, onAccept, onReject }) {
  return (
    <div className="oc-friend-request">
      <Avatar
        name={request.display_name || request.from_username || `用户 #${request.from_user_id}`}
        src={request.avatar_url}
        size={40}
        className="oc-contact-avatar"
      />
      <div className="oc-friend-request-info">
        <div className="oc-friend-request-name">
          {request.display_name || request.from_username || `用户 #${request.from_user_id}`}
        </div>
        {request.message && (
          <div className="oc-friend-request-msg">{request.message}</div>
        )}
      </div>
      <div className="oc-friend-request-actions">
        <button className="oc-btn oc-btn-primary" onClick={onAccept}>
          {t('friend_request_accept')}
        </button>
        <button className="oc-btn oc-btn-default" onClick={onReject}>
          {t('friend_request_reject')}
        </button>
      </div>
    </div>
  );
}
