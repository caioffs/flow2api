/* Shared application chrome: one header and one tab bar for every page.
 *
 * Pages opt in with `<body data-page="manage|test|extensions">` plus an empty
 * `<div id="app-shell"></div>` as the first child of <body>. Keeping the shell
 * in one file means the navigation cannot drift between pages again.
 */
(() => {
  'use strict';

  const TABS = [
    { key: 'tokens', source: 'Token 管理' },
    { key: 'settings', source: '系统配置' },
    { key: 'logs', source: '请求日志' },
    { key: 'test', source: '测试页面', href: '/test' },
    { key: 'extensions', source: '浏览器扩展', href: '/extensions' },
  ];

  const MANAGE_TABS = new Set(['tokens', 'settings', 'logs']);
  let active = 'tokens';

  function t(source) {
    try {
      return window.I18n ? window.I18n.t(source) : source;
    } catch (_) {
      return source;
    }
  }

  function currentPage() {
    return document.body.dataset.page || 'manage';
  }

  function initialActive() {
    const page = currentPage();
    if (page === 'test' || page === 'extensions') return page;
    const requested = new URLSearchParams(window.location.search).get('tab');
    return MANAGE_TABS.has(requested) ? requested : 'tokens';
  }

  function goToManageTab(key) {
    if (currentPage() === 'manage' && typeof window.switchTab === 'function') {
      window.switchTab(key);
      return;
    }
    window.location.href = `/manage?tab=${key}`;
  }

  async function doLogout() {
    if (typeof window.logout === 'function') {
      window.logout();
      return;
    }
    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { ...(window.I18n ? I18n.headers() : {}) },
      });
    } catch (_) {
      /* The redirect below is what matters. */
    }
    window.location.href = '/login';
  }

  function buildSelect() {
    const select = document.createElement('select');
    select.setAttribute('data-language-select', '');
    select.setAttribute('aria-label', t('界面语言'));
    [['zh-CN', '中文'], ['en', 'English'], ['pt-BR', 'Português']].forEach(
      ([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
      }
    );
    select.value = document.documentElement.lang || 'zh-CN';
    select.addEventListener('change', (event) => {
      if (window.I18n) window.I18n.setLanguage(event.target.value);
    });
    return select;
  }

  function buildIconLink({ href, title, label, html, onClick }) {
    const element = document.createElement(href ? 'a' : 'button');
    element.className = 'shell-icon';
    element.title = title;
    if (href) {
      element.href = href;
      element.target = '_blank';
      element.rel = 'noopener noreferrer';
    } else {
      element.type = 'button';
    }
    if (onClick) element.addEventListener('click', onClick);
    element.innerHTML = html;
    if (label) {
      const span = document.createElement('span');
      span.textContent = label;
      element.appendChild(span);
    }
    return element;
  }

  function render() {
    const host = document.getElementById('app-shell');
    if (!host) return;

    active = active || initialActive();
    host.innerHTML = '';

    const bar = document.createElement('header');
    bar.className = 'shell-bar';

    const inner = document.createElement('div');
    inner.className = 'shell-inner';

    const brand = document.createElement('a');
    brand.className = 'shell-brand';
    brand.href = '/manage';
    brand.textContent = 'Flow2API';
    brand.title = t('管理后台');
    inner.appendChild(brand);

    const nav = document.createElement('nav');
    nav.className = 'shell-nav';
    nav.setAttribute('aria-label', t('管理后台'));
    TABS.forEach((tab) => {
      const item = document.createElement('a');
      item.className = 'shell-tab';
      item.dataset.tab = tab.key;
      item.href = tab.href || `/manage?tab=${tab.key}`;
      item.textContent = t(tab.source);
      if (tab.key === active) item.classList.add('is-active');
      if (!tab.href && currentPage() === 'manage') {
        item.addEventListener('click', (event) => {
          event.preventDefault();
          goToManageTab(tab.key);
        });
      }
      nav.appendChild(item);
    });
    inner.appendChild(nav);

    const actions = document.createElement('div');
    actions.className = 'shell-actions';
    actions.appendChild(buildSelect());

    actions.appendChild(
      buildIconLink({
        href: 'https://github.com/TheSmallHanCat/flow2api',
        title: t('GitHub 仓库'),
        html:
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
          '<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>' +
          '</svg>',
      })
    );

    actions.appendChild(
      buildIconLink({
        title: t('退出'),
        label: t('退出'),
        onClick: doLogout,
        html:
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
          '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>' +
          '<polyline points="16 17 21 12 16 7"/>' +
          '<line x1="21" y1="12" x2="9" y2="12"/>' +
          '</svg>',
      })
    );

    inner.appendChild(actions);
    bar.appendChild(inner);
    host.appendChild(bar);

    if (window.I18n && I18n.ready) {
      I18n.ready.then(() => {
        const select = host.querySelector('[data-language-select]');
        if (select) select.value = document.documentElement.lang;
      });
    }
  }

  window.Shell = {
    setActive(key) {
      if (!key) return;
      active = key;
      document.querySelectorAll('.shell-tab').forEach((tab) => {
        tab.classList.toggle('is-active', tab.dataset.tab === key);
      });
      if (currentPage() === 'manage' && MANAGE_TABS.has(key)) {
        const url = new URL(window.location.href);
        url.searchParams.set('tab', key);
        window.history.replaceState(null, '', url);
      }
    },
    render,
  };

  function boot() {
    active = initialActive();
    render();
    window.addEventListener('languagechange', () => {
      render();
      window.Shell.setActive(active);
    });
    if (window.I18n && I18n.ready) {
      I18n.ready.then(() => {
        render();
        window.Shell.setActive(active);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
