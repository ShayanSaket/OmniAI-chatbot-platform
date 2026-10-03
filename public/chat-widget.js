/*! OmniAI chat widget loader
 *
 *   <script src="https://YOUR-DOMAIN/chat-widget.js" data-bot-id="bot_xxx" async></script>
 *
 * Injects one sandbox-friendly iframe that hosts the chat UI, so the widget can neither
 * be styled by nor interfere with the host page. Public API:
 *   window.OmniAI.open() / close() / toggle() / destroy()
 */
(function () {
  'use strict';

  var script =
    document.currentScript ||
    document.querySelector('script[data-bot-id][src*="chat-widget.js"]');
  if (!script) return;
  var botKey = script.getAttribute('data-bot-id');
  if (!botKey || !/^bot_[A-Za-z0-9_-]{8,64}$/.test(botKey)) {
    if (window.console) console.warn('[OmniAI] Missing or invalid data-bot-id on the widget script tag.');
    return;
  }
  if (window.OmniAI && window.OmniAI.__loaded) return;

  var widgetOrigin = new URL(script.src, window.location.href).origin;
  var storageKey = 'omniai:' + botKey;
  var MOBILE = 640;
  var iframe = null;
  var ready = false;
  var queue = [];
  var lastState = 'hidden';
  var savedOverflow = null;

  function read() {
    try { return window.localStorage.getItem(storageKey); } catch (e) { return null; }
  }
  function write(value) {
    try {
      if (value) window.localStorage.setItem(storageKey, value);
      else window.localStorage.removeItem(storageKey);
    } catch (e) { /* storage blocked: session-only */ }
  }
  function viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  function post(message) {
    if (!iframe || !iframe.contentWindow) return;
    message.source = 'omniai-loader';
    if (!ready) { queue.push(message); return; }
    iframe.contentWindow.postMessage(message, widgetOrigin);
  }

  function setStyles(el, styles) {
    for (var key in styles) if (Object.prototype.hasOwnProperty.call(styles, key)) el.style.setProperty(key, styles[key], 'important');
  }

  function lockScroll(lock) {
    var root = document.documentElement;
    if (lock && savedOverflow === null) {
      savedOverflow = root.style.overflow;
      root.style.overflow = 'hidden';
    } else if (!lock && savedOverflow !== null) {
      root.style.overflow = savedOverflow;
      savedOverflow = null;
    }
  }

  function applyFrame(data) {
    lastState = data.state;
    var left = data.position === 'bottom-left';
    var base = {
      position: 'fixed',
      border: '0',
      background: 'transparent',
      'color-scheme': 'light',
      'z-index': '2147483000',
      'max-width': '100vw',
      'max-height': '100vh',
      margin: '0',
      padding: '0',
    };
    if (data.state === 'hidden') {
      setStyles(iframe, Object.assign(base, { width: '0', height: '0', bottom: '0', right: '0', opacity: '0', 'pointer-events': 'none' }));
      lockScroll(false);
      return;
    }
    if (data.state === 'fullscreen') {
      setStyles(iframe, Object.assign(base, { top: '0', left: '0', right: '0', bottom: '0', width: '100%', height: '100%', opacity: '1', 'pointer-events': 'auto' }));
      lockScroll(window.innerWidth < MOBILE);
      return;
    }
    iframe.style.removeProperty('top');
    iframe.style.removeProperty(left ? 'right' : 'left');
    var styles = Object.assign(base, {
      bottom: '0',
      width: Math.ceil(data.width) + 'px',
      height: Math.ceil(data.height) + 'px',
      opacity: '1',
      'pointer-events': 'auto',
    });
    styles[left ? 'left' : 'right'] = '0';
    setStyles(iframe, styles);
    lockScroll(false);
  }

  function onMessage(event) {
    if (!iframe || event.source !== iframe.contentWindow || event.origin !== widgetOrigin) return;
    var data = event.data;
    if (!data || data.source !== 'omniai-widget') return;
    if (data.type === 'ready') {
      ready = true;
      iframe.contentWindow.postMessage(
        {
          source: 'omniai-loader',
          type: 'init',
          token: read(),
          pageUrl: window.location.href,
          pageTitle: document.title,
          locale: (navigator.languages && navigator.languages[0]) || navigator.language || 'en',
          viewport: viewport(),
        },
        widgetOrigin
      );
      while (queue.length) iframe.contentWindow.postMessage(queue.shift(), widgetOrigin);
    } else if (data.type === 'resize') {
      applyFrame(data);
    } else if (data.type === 'store') {
      write(typeof data.token === 'string' ? data.token : null);
    }
  }

  var resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { post({ type: 'viewport', viewport: viewport() }); }, 100);
  }

  function mount() {
    if (iframe) return;
    iframe = document.createElement('iframe');
    iframe.src = widgetOrigin + '/widget/' + encodeURIComponent(botKey);
    iframe.title = 'Chat';
    iframe.setAttribute('aria-label', 'Chat');
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    applyFrame({ state: 'hidden' });
    window.addEventListener('message', onMessage);
    window.addEventListener('resize', onResize);
    document.body.appendChild(iframe);
  }

  function destroy() {
    window.removeEventListener('message', onMessage);
    window.removeEventListener('resize', onResize);
    lockScroll(false);
    if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
    iframe = null;
    ready = false;
    queue = [];
    window.OmniAI = undefined;
  }

  window.OmniAI = {
    __loaded: true,
    open: function () { post({ type: 'open' }); },
    close: function () { post({ type: 'close' }); },
    toggle: function () { post({ type: 'toggle' }); },
    destroy: destroy,
    get state() { return lastState; },
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
