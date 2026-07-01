import React, { useEffect, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { mountChatPage } from './chat-page';
import { mountCompanionPage } from './companion-page';
import { mountGlobalModals } from './global-modals';
import { mountPromptsPage } from './prompts-page';
import { mountServicesPage } from './services-page';
import { mountStorePage } from './store-page';

declare global {
  interface Window {
    __catscoDashboardShell?: {
      mounted: boolean;
      version: string;
    };
    __catscoApplyActivePage?: (name: string) => void;
    __catscoRenderShell?: (payload: ShellRenderPayload) => void;
    __catscoSetDashboardUiZoom?: (zoom: number) => void;
    autoResizeCatsMessageInput?: () => void;
    handleDashboardFontScaleShortcut?: (event: KeyboardEvent) => void;
    refreshDashboardFontScaleForViewport?: () => void;
    showUpdateModal?: (show: boolean) => void;
    switchPage?: (name: string) => void;
  }
}

type NavItem = {
  icon: string;
  label: string;
  page: string;
};

type ShellRenderPayload = {
  activePage?: string;
  uiZoom?: number;
  version?: string;
};

const NAV_ITEMS: NavItem[] = [
  { icon: '@', label: 'CatsCo', page: 'chat' },
  { icon: '#', label: '提示词', page: 'prompts' },
  { icon: '>', label: '智能体中心', page: 'services' },
  { icon: '+', label: 'Skills', page: 'store' },
  { icon: '*', label: '伙伴中心', page: 'companion' },
];

let dashboardShellRoot: ReturnType<typeof createRoot> | undefined;
let dashboardShellState = {
  activePage: 'chat',
  uiZoom: 1,
  version: '-',
};

const PAGE_ITEMS = [
  { id: 'services-page-root', page: 'services' },
  { id: 'prompts-page-root', page: 'prompts' },
  { id: 'companion-page-root', page: 'companion' },
  { id: 'store-page-root', page: 'store' },
  { id: 'chat-page-root', page: 'chat' },
];

function DashboardSidebar({ activePage, version }: { activePage: string; version: string }) {
  const handleNavClick = (event: React.MouseEvent<HTMLAnchorElement>, page: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof window.switchPage === 'function') {
      window.switchPage(page);
      return;
    }
    applyActivePage(page);
  };

  return (
    <>
      <div className="sidebar-brand">
        <div className="sidebar-brand-icon">
          <img className="sidebar-brand-logo" src="cat-icon.png" alt="CatsCo" />
        </div>
        <div>
          <div className="sidebar-brand-text">CatsCo</div>
          <div className="sidebar-brand-ver">v{version}</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map(item => (
          <a
            className={`nav-item${item.page === activePage ? ' active' : ''}`}
            href={`#${item.page}`}
            key={item.page}
            onClick={event => handleNavClick(event, item.page)}
          >
            <span className="nav-icon">{item.icon}</span> <span>{item.label}</span>
          </a>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-footer-info">
          <button className="btn sidebar-update-btn" id="sidebar-update-btn" type="button" onClick={() => window.showUpdateModal?.(true)}>
            检查更新
          </button>
        </div>
      </div>
    </>
  );
}

function DashboardPages({ activePage }: { activePage: string }) {
  return (
    <div className="main-wrapper">
      <div className="page-content">
        {PAGE_ITEMS.map(item => (
          <div className={`page${item.page === activePage ? ' active' : ''}`} id={`page-${item.page}`} key={item.page}>
            <div id={item.id}></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DashboardApp({ activePage, uiZoom, version }: { activePage: string; uiZoom: number; version: string }) {
  const appClassName = `dashboard-app${activePage === 'chat' ? ' chat-active' : ''}${
    activePage === 'companion' ? ' companion-active' : ''
  }`;

  useLayoutEffect(() => {
    document.body.classList.toggle('chat-active', activePage === 'chat');
    document.body.classList.toggle('companion-active', activePage === 'companion');
    return () => {
      document.body.classList.remove('chat-active', 'companion-active');
    };
  }, [activePage]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => window.handleDashboardFontScaleShortcut?.(event);
    const handleResize = () => {
      window.refreshDashboardFontScaleForViewport?.();
      window.autoResizeCatsMessageInput?.();
    };
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return (
    <div className={appClassName} style={{ '--dashboard-ui-zoom': String(uiZoom) } as React.CSSProperties}>
      <aside className="sidebar" id="dashboard-sidebar-root" data-dashboard-version={version}>
        <DashboardSidebar activePage={activePage} version={version} />
      </aside>
      <DashboardPages activePage={activePage} />
      <div id="floating-pet-root"></div>
    </div>
  );
}

function resolveInitialVersion(root: HTMLElement) {
  const fallbackVersion = root.querySelector('.sidebar-brand-ver')?.textContent?.trim().replace(/^v/, '');
  return fallbackVersion || root.dataset.dashboardVersion || '-';
}

function resolveInitialActivePage(root: HTMLElement) {
  return root.dataset.activePage || 'chat';
}

function applyActivePage(name: string) {
  renderDashboardShell({ activePage: name });
}

function renderDashboardShell(payload: ShellRenderPayload = {}, options: { sync?: boolean } = {}) {
  const root = document.getElementById('dashboard-app-root');
  if (!root) return;
  dashboardShellRoot ||= createRoot(root);
  dashboardShellState = {
    activePage: payload.activePage || dashboardShellState.activePage || 'chat',
    uiZoom: payload.uiZoom || dashboardShellState.uiZoom || 1,
    version: payload.version || dashboardShellState.version || '-',
  };
  const element = <DashboardApp activePage={dashboardShellState.activePage} uiZoom={dashboardShellState.uiZoom} version={dashboardShellState.version} />;
  if (options.sync) {
    flushSync(() => {
      dashboardShellRoot?.render(element);
    });
  } else {
    dashboardShellRoot?.render(element);
  }
  root.dataset.reactShell = 'mounted';
  window.__catscoDashboardShell = { mounted: true, version: dashboardShellState.version };
}

function mountDashboardShell() {
  const root = document.getElementById('dashboard-app-root');
  if (!root) return;
  dashboardShellState = {
    activePage: resolveInitialActivePage(root),
    uiZoom: 1,
    version: resolveInitialVersion(root),
  };
  renderDashboardShell(dashboardShellState, { sync: true });
  window.__catscoApplyActivePage = applyActivePage;
  window.__catscoRenderShell = renderDashboardShell;
  window.__catscoSetDashboardUiZoom = zoom => renderDashboardShell({ uiZoom: Number.isFinite(zoom) ? zoom : 1 });
}

mountDashboardShell();
mountChatPage();
mountServicesPage();
mountPromptsPage();
mountCompanionPage();
mountStorePage();
mountGlobalModals();
