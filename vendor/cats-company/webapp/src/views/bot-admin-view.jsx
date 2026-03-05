import React, { useEffect, useState } from 'react';
import { api, getWebSocketURL } from '../api';
import t from '../i18n';

const CREATE_MODES = {
  SELF_HOSTED: 'self_hosted',
  MANAGED: 'managed',
};

const initialForm = {
  display_name: '',
};

export default function BotAdminView({ onBack, user }) {
  const [bots, setBots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState(initialForm);
  const [createMode, setCreateMode] = useState(CREATE_MODES.SELF_HOSTED);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [createdBot, setCreatedBot] = useState(null);
  const [createdMode, setCreatedMode] = useState(CREATE_MODES.SELF_HOSTED);
  const [friendStatus, setFriendStatus] = useState('');
  const [friendSuccess, setFriendSuccess] = useState(false);
  const [copiedField, setCopiedField] = useState('');
  const [managedProgressStep, setManagedProgressStep] = useState(0);

  useEffect(() => {
    loadBots();
  }, []);

  useEffect(() => {
    if (!(isSubmitting && createMode === CREATE_MODES.MANAGED)) {
      setManagedProgressStep(0);
      return;
    }
    setManagedProgressStep(0);
    const timers = [
      window.setTimeout(() => setManagedProgressStep(1), 1200),
      window.setTimeout(() => setManagedProgressStep(2), 4200),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [isSubmitting, createMode]);

  useEffect(() => {
    if (!bots.some((bot) => bot.tenant_name)) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      loadBots({ silent: true });
    }, 7000);
    return () => window.clearInterval(timer);
  }, [bots]);

  const loadBots = async ({ silent = false } = {}) => {
    try {
      if (!silent) {
        setLoading(true);
      }
      const botsRes = await api.getMyBots();
      setBots(botsRes.bots || []);
    } catch (e) {
      console.error('Load bots error:', e);
      setError(e.message || t('error_server'));
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    const displayName = createForm.display_name.trim();
    if (!displayName) {
      setError(t('bot_create_name_required'));
      return;
    }

    const username = buildBotUsername(displayName);
    const isManaged = createMode === CREATE_MODES.MANAGED;

    try {
      setError('');
      setCreatedBot(null);
      setCopiedField('');
      setFriendStatus('');
      setFriendSuccess(false);
      setIsSubmitting(true);

      const result = await api.createBot(
        { username, display_name: displayName },
        isManaged
      );
      const fullResult = {
        ...result,
        id: result.uid,
        display_name: result.display_name || displayName,
        visibility: result.visibility || 'public',
      };
      setBots((prev) => {
        const nextBot = {
          ...fullResult,
          tenant_name: fullResult.tenant_name,
          deployment_status: fullResult.deployment_status || (isManaged ? 'running' : undefined),
        };
        const remaining = prev.filter((bot) => bot.id !== nextBot.id);
        return [nextBot, ...remaining];
      });
      setCreatedBot(fullResult);
      setCreatedMode(createMode);
      setShowCreate(false);
      setCreateForm(initialForm);
      await loadBots({ silent: true });

      if (isManaged) {
        const autoAdded = Boolean(fullResult.friend_auto_added);
        setFriendSuccess(autoAdded);
        setFriendStatus(autoAdded ? t('bot_friend_success') : t('bot_friend_manual'));
      } else {
        await autoAddFriend(fullResult);
      }
    } catch (e) {
      setError(e.message || t('error_server'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleVisibility = async (bot) => {
    try {
      const next = bot.visibility === 'public' ? 'private' : 'public';
      await api.setBotVisibility(bot.id, next);
      await loadBots({ silent: true });
    } catch (e) {
      setError(e.message || t('error_server'));
    }
  };

  const handleDelete = async (bot) => {
    if (!window.confirm(t('bot_delete_confirm', { name: bot.display_name || bot.username }))) {
      return;
    }
    try {
      await api.deleteBot(bot.id);
      setBots((prev) => prev.filter((item) => item.id !== bot.id));
      if (createdBot?.id === bot.id) {
        setCreatedBot(null);
        setFriendStatus('');
      }
    } catch (e) {
      setError(e.message || t('error_server'));
    }
  };

  const autoAddFriend = async (bot) => {
    if (!user?.uid || !bot?.api_key) {
      setFriendStatus(t('bot_friend_manual'));
      setFriendSuccess(false);
      return;
    }

    try {
      await api.sendFriendRequest(bot.uid);
      await api.acceptFriendAsBot(bot.api_key, user.uid);
      setFriendStatus(t('bot_friend_success'));
      setFriendSuccess(true);
    } catch (e) {
      console.error('Auto add friend failed:', e);
      setFriendStatus(`${t('bot_friend_failed')}: ${e.message}`);
      setFriendSuccess(false);
    }
  };

  const handleCopy = async (field, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      window.setTimeout(() => {
        setCopiedField((current) => (current === field ? '' : current));
      }, 2000);
    } catch (e) {
      console.error('Copy failed:', e);
    }
  };

  const wsUrl = getWebSocketURL();

  if (loading) {
    return <div className="oc-loading">{t('loading') || 'Loading...'}</div>;
  }

  return (
    <div className="oc-bot-admin">
      <div className="oc-header">
        <button className="oc-back-btn" onClick={onBack}>←</button>
        {t('bot_admin')}
        <button className="oc-header-action" onClick={() => {
          setError('');
          setShowCreate(true);
        }}>+</button>
      </div>

      {createdBot && createdMode === CREATE_MODES.SELF_HOSTED && (
        <SelfHostedBanner
          bot={createdBot}
          wsUrl={wsUrl}
          copiedField={copiedField}
          handleCopy={handleCopy}
          friendStatus={friendStatus}
          friendSuccess={friendSuccess}
          onClose={() => {
            setCreatedBot(null);
            setFriendStatus('');
          }}
        />
      )}

      {createdBot && createdMode === CREATE_MODES.MANAGED && (
        <ManagedBanner
          bot={createdBot}
          friendStatus={friendStatus}
          friendSuccess={friendSuccess}
          onClose={() => {
            setCreatedBot(null);
            setFriendStatus('');
          }}
        />
      )}

      {error && (
        <div className="oc-bot-error">{error}</div>
      )}

      <div className="oc-bot-list">
        {bots.length === 0 ? (
          <div className="oc-empty-state">
            <div className="oc-empty-icon">CPU</div>
            <div>{t('no_bots')}</div>
            <div className="oc-empty-subtitle">{t('bot_empty_hint')}</div>
          </div>
        ) : (
          bots.map((bot) => {
            const isManaged = Boolean(bot.tenant_name);
            const deploymentStatus = bot.deployment_status || 'unknown';
            const deploymentTone = deploymentStatusTone(deploymentStatus);
            return (
              <div key={bot.id} className="oc-bot-card">
                <div className="oc-bot-header">
                  <div className="oc-bot-avatar">B</div>
                  <div className="oc-bot-info">
                    <div className="oc-bot-name">{bot.display_name || bot.username}</div>
                    <div className="oc-bot-username">
                      @{bot.username}
                      {isManaged && (
                        <span className="oc-bot-badge managed">{t('bot_managed_badge')}</span>
                      )}
                      {isManaged && (
                        <span className={`oc-bot-badge status ${deploymentTone}`}>
                          {deploymentStatusLabel(deploymentStatus)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className={`oc-bot-status ${bot.visibility === 'public' ? 'enabled' : 'disabled'}`}>
                    {bot.visibility === 'public' ? t('bot_visibility_public') : t('bot_visibility_private')}
                  </div>
                </div>

                <div className="oc-bot-details">
                  <div className="oc-bot-detail-row">
                    <span>{t('bot_connection_mode')}</span>
                    <strong>{isManaged ? t('bot_connection_managed') : t('bot_connection_self_hosted')}</strong>
                  </div>
                  {isManaged && (
                    <div className="oc-bot-detail-row">
                      <span>{t('bot_deploy_status')}</span>
                      <strong className={`oc-deploy-status ${deploymentTone}`}>
                        {deploymentStatusLabel(deploymentStatus)}
                      </strong>
                    </div>
                  )}
                  {isManaged && bot.tenant_name && (
                    <div className="oc-bot-detail-row">
                      <span>{t('bot_tenant_label')}</span>
                      <code>{bot.tenant_name}</code>
                    </div>
                  )}
                  {isManaged && bot.deployment_error && (
                    <div className="oc-bot-detail-row multi-line">
                      <span>{t('bot_deploy_error')}</span>
                      <strong>{bot.deployment_error}</strong>
                    </div>
                  )}
                </div>

                <div className="oc-bot-actions">
                  <button
                    className="oc-btn oc-btn-default"
                    onClick={() => handleToggleVisibility(bot)}
                  >
                    {bot.visibility === 'public' ? t('bot_make_private') : t('bot_make_public')}
                  </button>
                  <button
                    className="oc-btn oc-btn-danger"
                    onClick={() => handleDelete(bot)}
                  >
                    {t('delete')}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {showCreate && (
        <div className="oc-modal-overlay" onClick={() => {
          if (!isSubmitting) {
            setShowCreate(false);
          }
        }}>
          <div className="oc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="oc-modal-header">
              <h3>{t('register_bot')}</h3>
              <button onClick={() => {
                if (!isSubmitting) {
                  setShowCreate(false);
                }
              }}>×</button>
            </div>
            <form className="oc-modal-body" onSubmit={handleCreate}>
              <div className="oc-mode-switch">
                <button
                  type="button"
                  className={`oc-mode-option ${createMode === CREATE_MODES.SELF_HOSTED ? 'active' : ''}`}
                  onClick={() => setCreateMode(CREATE_MODES.SELF_HOSTED)}
                  disabled={isSubmitting}
                >
                  <span>{t('bot_mode_self_hosted')}</span>
                  <small>{t('bot_mode_self_hosted_desc')}</small>
                </button>
                <button
                  type="button"
                  className={`oc-mode-option ${createMode === CREATE_MODES.MANAGED ? 'active' : ''}`}
                  onClick={() => setCreateMode(CREATE_MODES.MANAGED)}
                  disabled={isSubmitting}
                >
                  <span>{t('bot_mode_managed')}</span>
                  <small>{t('bot_mode_managed_desc')}</small>
                </button>
              </div>
              <div className="oc-form-group">
                <label>{t('bot_display_name')}</label>
                <input
                  type="text"
                  value={createForm.display_name}
                  onChange={(e) => setCreateForm({ ...createForm, display_name: e.target.value })}
                  placeholder={t('bot_display_name_placeholder')}
                  required
                  disabled={isSubmitting}
                />
              </div>
              <div className="oc-bot-inline-note">
                {createMode === CREATE_MODES.MANAGED ? t('bot_mode_managed_desc') : t('bot_mode_self_hosted_desc')}
              </div>
              {error && (
                <div className="oc-bot-error compact">{error}</div>
              )}
              <div className="oc-bot-inline-note">
                {createMode === CREATE_MODES.MANAGED ? t('bot_username_hint_managed') : t('bot_username_hint')}
              </div>
              {isSubmitting && createMode === CREATE_MODES.MANAGED && (
                <ManagedDeployProgress step={managedProgressStep} />
              )}
              <div className="oc-modal-footer">
                <button type="button" className="oc-btn oc-btn-default" onClick={() => setShowCreate(false)} disabled={isSubmitting}>
                  {t('cancel')}
                </button>
                <button type="submit" className="oc-btn oc-btn-primary" disabled={isSubmitting}>
                  {isSubmitting ? t('loading') : t('bot_create_submit')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function SelfHostedBanner({ bot, wsUrl, copiedField, handleCopy, friendStatus, friendSuccess, onClose }) {
  return (
    <div className="oc-api-key-banner">
      <div className="oc-api-key-stack">
        <div className="oc-api-key-label">{t('bot_created_title')}</div>
        <div className="oc-api-key-meta">
          <span>{bot.display_name || bot.username}</span>
          <span>@{bot.username}</span>
        </div>
        <div className="oc-credential-row">
          <span>{t('bot_api_key')}</span>
          <code className="oc-api-key-value">{bot.api_key}</code>
          <button className="oc-btn oc-btn-default" onClick={() => handleCopy('api_key', bot.api_key)}>
            {copiedField === 'api_key' ? t('bot_copied') : t('bot_copy')}
          </button>
        </div>
        <div className="oc-credential-row">
          <span>{t('bot_ws_url')}</span>
          <code className="oc-api-key-value">{wsUrl}</code>
          <button className="oc-btn oc-btn-default" onClick={() => handleCopy('ws_url', wsUrl)}>
            {copiedField === 'ws_url' ? t('bot_copied') : t('bot_copy')}
          </button>
        </div>
        {friendStatus && (
          <div className={`oc-bot-inline-note ${friendSuccess ? 'success' : 'warning'}`}>
            {friendStatus}
          </div>
        )}
        <div className="oc-bot-inline-note warning">
          {t('bot_api_key_note')}
        </div>
      </div>
      <button className="oc-banner-close" onClick={onClose}>×</button>
    </div>
  );
}

function ManagedBanner({ bot, friendStatus, friendSuccess, onClose }) {
  const deploymentStatus = bot.deployment_status || 'running';
  const deploymentTone = deploymentStatusTone(deploymentStatus);
  return (
    <div className="oc-api-key-banner managed">
      <div className="oc-api-key-stack">
        <div className="oc-api-key-label">{t('bot_created_managed_title')}</div>
        <div className="oc-api-key-meta">
          <span>{bot.display_name || bot.username}</span>
          <span>@{bot.username}</span>
          {bot.tenant_name && (
            <span>{t('bot_tenant_label')}: {bot.tenant_name}</span>
          )}
        </div>
        <div className="oc-bot-detail-row">
          <span>{t('bot_deploy_status')}</span>
          <strong className={`oc-deploy-status ${deploymentTone}`}>
            {deploymentStatusLabel(deploymentStatus)}
          </strong>
        </div>
        {friendStatus && (
          <div className={`oc-bot-inline-note ${friendSuccess ? 'success' : 'warning'}`}>
            {friendStatus}
          </div>
        )}
        {bot.deployment_error && (
          <div className="oc-bot-inline-note warning">
            {bot.deployment_error}
          </div>
        )}
        <div className="oc-bot-inline-note success">
          {t('bot_created_managed_desc')}
        </div>
      </div>
      <button className="oc-banner-close" onClick={onClose}>×</button>
    </div>
  );
}

function ManagedDeployProgress({ step }) {
  const steps = [
    t('bot_deploy_step_account'),
    t('bot_deploy_step_runtime'),
    t('bot_deploy_step_ready'),
  ];

  return (
    <div className="oc-managed-progress">
      <div className="oc-managed-progress-title">{t('bot_deploy_progress_title')}</div>
      <div className="oc-managed-progress-steps">
        {steps.map((label, index) => {
          const state = index < step ? 'done' : index === step ? 'active' : 'pending';
          return (
            <div key={label} className={`oc-managed-progress-step ${state}`}>
              <span className="oc-managed-progress-dot">{index + 1}</span>
              <span>{label}</span>
            </div>
          );
        })}
      </div>
      <div className="oc-bot-inline-note">
        {t('bot_deploy_progress_note')}
      </div>
    </div>
  );
}

function buildBotUsername(displayName) {
  const slug = displayName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const base = (slug || 'bot').slice(0, 16);
  const suffix = Math.floor(Math.random() * 9000) + 1000;
  return `bot-${base}-${suffix}`;
}

function deploymentStatusTone(status) {
  switch (status) {
    case 'running':
      return 'running';
    case 'restarting':
      return 'warning';
    case 'not_created':
      return 'muted';
    default:
      return 'warning';
  }
}

function deploymentStatusLabel(status) {
  switch (status) {
    case 'running':
      return t('bot_deploy_status_running');
    case 'restarting':
      return t('bot_deploy_status_restarting');
    case 'not_created':
      return t('bot_deploy_status_not_created');
    default:
      return t('bot_deploy_status_unknown');
  }
}
