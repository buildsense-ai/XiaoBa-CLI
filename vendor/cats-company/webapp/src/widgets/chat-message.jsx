import React, { useState } from 'react';
import t from '../i18n';
import Avatar from './avatar';
import { resolveMediaURL } from '../api';

export default function ChatMessage({ message, isSelf, isGroup, senderName, senderAvatarUrl, senderIsBot, replyMessage, onReply }) {
  const content = message.content;

  // Parse rich content
  let parsed = null;
  if (typeof content === 'object' && content !== null && content.type) {
    parsed = content;
  } else if (typeof content === 'string') {
    // Try to parse JSON rich content from server
    try {
      const obj = JSON.parse(content);
      if (obj && obj.type) parsed = obj;
    } catch (e) {
      // plain text
    }
  }

  return (
    <div className={`oc-msg ${isSelf ? 'self' : ''}`}>
      {!isSelf && (
        <Avatar
          name={senderName || message.from_name || message.from_uid}
          src={senderAvatarUrl}
          size={40}
          isBot={senderIsBot}
          className="oc-msg-avatar"
        />
      )}
      <div className="oc-msg-body">
        {/* Sender name in group chats */}
        {isGroup && !isSelf && senderName && (
          <div className="oc-msg-sender">{senderName}</div>
        )}

        {/* Reply quote */}
        {replyMessage && (
          <div className="oc-msg-reply-quote">
            <span className="oc-msg-reply-text">
              {typeof replyMessage.content === 'string'
                ? replyMessage.content.slice(0, 80)
                : '[media]'}
            </span>
          </div>
        )}

        <div className="oc-msg-bubble">
          {parsed ? <RichContent content={parsed} /> : <TextContent content={content} isGroup={isGroup} />}
          {/* Reply button */}
          {onReply && (
            <button className="oc-msg-reply-btn" onClick={onReply} title={t('chat_reply')}>
              &#8617;
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TextContent({ content, isGroup }) {
  const text = typeof content === 'string' ? content : content?.text || String(content || '');

  if (isGroup) {
    // Highlight @mentions
    const parts = text.split(/(@usr\d+)/g);
    return (
      <span>
        {parts.map((part, i) =>
          part.match(/^@usr\d+$/) ? (
            <span key={i} className="oc-mention">{part}</span>
          ) : (
            <span key={i}>{part}</span>
          )
        )}
      </span>
    );
  }

  return <span>{text}</span>;
}

function RichContent({ content }) {
  switch (content.type) {
    case 'image':
      return <ImageContent payload={content.payload} />;
    case 'file':
      return <FileContent payload={content.payload} />;
    case 'link_preview':
      return <LinkPreviewContent payload={content.payload} />;
    case 'card':
      return <CardContent payload={content.payload} />;
    default:
      return <TextContent content={content.payload?.text || JSON.stringify(content)} />;
  }
}

function ImageContent({ payload }) {
  const [expanded, setExpanded] = useState(false);
  if (!payload) return null;
  const src = payload.url || payload.thumbnail;
  return (
    <div className="oc-rich-image">
      <img
        src={resolveMediaURL(src)}
        alt="image"
        className="oc-rich-image-thumb"
        onClick={() => setExpanded(true)}
        style={{ maxWidth: 240, maxHeight: 240, borderRadius: 4, cursor: 'pointer' }}
      />
      {expanded && (
        <div className="oc-modal-overlay" onClick={() => setExpanded(false)}>
          <img src={resolveMediaURL(payload.url || src)} alt="full" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8 }} />
        </div>
      )}
    </div>
  );
}

function FileContent({ payload }) {
  if (!payload) return null;
  const sizeStr = payload.size ? formatFileSize(payload.size) : '';
  return (
    <div className="oc-rich-file">
      <div className="oc-rich-file-icon">{'\uD83D\uDCC4'}</div>
      <div className="oc-rich-file-info">
        <div className="oc-rich-file-name">{payload.name || 'File'}</div>
        {sizeStr && <div className="oc-rich-file-size">{sizeStr}</div>}
      </div>
      {payload.url && (
        <a href={resolveMediaURL(payload.url)} download className="oc-rich-file-download" target="_blank" rel="noopener noreferrer">
          下载
        </a>
      )}
    </div>
  );
}

function LinkPreviewContent({ payload }) {
  if (!payload) return null;
  return (
    <a href={resolveMediaURL(payload.url)} target="_blank" rel="noopener noreferrer" className="oc-rich-link" style={{ textDecoration: 'none', color: 'inherit' }}>
      {payload.image && <img src={resolveMediaURL(payload.image)} alt="" style={{ width: '100%', maxHeight: 160, objectFit: 'cover', borderRadius: '4px 4px 0 0' }} />}
      <div style={{ padding: '8px 0' }}>
        <div style={{ fontWeight: 500, fontSize: 14 }}>{payload.title || payload.url}</div>
        {payload.description && <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>{payload.description}</div>}
        {payload.site_name && <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>{payload.site_name}</div>}
      </div>
    </a>
  );
}

function CardContent({ payload }) {
  if (!payload) return null;
  return (
    <div className="oc-rich-card">
      {payload.image && <img src={resolveMediaURL(payload.image)} alt="" style={{ width: '100%', maxHeight: 120, objectFit: 'cover', borderRadius: '4px 4px 0 0' }} />}
      <div style={{ padding: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{payload.title}</div>
        {payload.text && <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>{payload.text}</div>}
      </div>
      {payload.buttons && payload.buttons.length > 0 && (
        <div className="oc-rich-card-buttons">
          {payload.buttons.map((btn, i) => (
            <button
              key={i}
              className="oc-btn oc-btn-default"
              onClick={() => {
                if (btn.action === 'url') window.open(btn.value, '_blank');
                if (btn.action === 'copy') navigator.clipboard?.writeText(btn.value);
              }}
              style={{ flex: 1 }}
            >
              {btn.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
