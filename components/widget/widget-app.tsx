'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LOADER_SOURCE,
  WIDGET_SOURCE,
  type LoaderToWidgetMessage,
  type WidgetConfig,
  type WidgetFrameState,
  type WidgetToLoaderMessage,
} from '@/lib/widget-protocol';
import { cn } from '@/lib/utils';
import { isRtl, resolveLang, stringsFor } from './i18n';
import { useWidgetSession } from './use-widget-session';
import { Launcher, Panel, Teaser, widgetThemeStyle } from './widget-view';

// Geometry (px). The iframe includes MARGIN around content so shadows are not clipped.
const MARGIN = 20;
const LAUNCHER = 56;
const GAP = 14;
const PANEL_W = 384;
const PANEL_MAX_H = 700;
const EXPANDED_W = 600;
const EXPANDED_MAX_H = 860;
const MOBILE_BREAKPOINT = 640;
const TEASER_DELAY_MS = 3500;

type Viewport = { width: number; height: number };
type Outgoing = WidgetToLoaderMessage extends infer T ? (T extends unknown ? Omit<T, 'source'> : never) : never;

const storageKey = (botKey: string) => `omniai:${botKey}`;
const safeStorage = {
  get(key: string) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    } catch {
      // storage unavailable (privacy mode): session-only
    }
  },
  flag(key: string, value?: boolean) {
    try {
      if (value === undefined) return window.sessionStorage.getItem(key) === '1';
      window.sessionStorage.setItem(key, value ? '1' : '0');
    } catch {
      return false;
    }
    return value;
  },
};

export function WidgetApp({ initialConfig }: { initialConfig: WidgetConfig }) {
  const [standalone, setStandalone] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [teaser, setTeaser] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({ width: 1280, height: 800 });
  const [locale, setLocale] = useState('en');
  const hostOrigin = useRef<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const closingTimer = useRef<ReturnType<typeof setTimeout>>();
  const [panelVisible, setPanelVisible] = useState(false);

  const postToLoader = useCallback((message: Outgoing) => {
    if (window.parent === window) return;
    // Before the handshake only non-sensitive messages are sent, so '*' is acceptable.
    window.parent.postMessage({ source: WIDGET_SOURCE, ...message }, hostOrigin.current ?? '*');
  }, []);

  const restartRef = useRef<() => void>(() => undefined);

  const onToken = useCallback(
    (token: string | null) => {
      tokenRef.current = token;
      if (window.parent === window) safeStorage.set(storageKey(initialConfig.botKey), token);
      else if (hostOrigin.current) postToLoader({ type: 'store', token });
      // A revoked session restarts as a fresh visitor.
      if (token === null) restartRef.current();
    },
    [initialConfig.botKey, postToLoader],
  );

  const session = useWidgetSession({ initialConfig, isOpen: open, onToken });
  const { state } = session;
  const config = state.config;
  const lang = resolveLang(locale, config.defaultLanguage);
  const strings = stringsFor(lang);
  const isMobile = viewport.width < MOBILE_BREAKPOINT;
  const fullscreen = Boolean(standalone) || (open && isMobile);

  const startSession = useCallback(
    (init: { pageUrl: string | null; locale: string }) =>
      session.start({ token: tokenRef.current, hostOrigin: hostOrigin.current, pageUrl: init.pageUrl, locale: init.locale }),
    [session],
  );
  const lastInit = useRef<{ pageUrl: string | null; locale: string }>({ pageUrl: null, locale: 'en' });
  restartRef.current = () => {
    void startSession(lastInit.current);
  };

  // Handshake with the loader (or standalone hosted page).
  useEffect(() => {
    if (window.parent === window) {
      setStandalone(true);
      setOpen(true);
      setPanelVisible(true);
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      tokenRef.current = safeStorage.get(storageKey(initialConfig.botKey));
      lastInit.current = { pageUrl: window.location.href, locale: navigator.language };
      setLocale(navigator.language);
      hostOrigin.current = window.location.origin;
      void startSession(lastInit.current);
      return;
    }
    setStandalone(false);
    const onMessage = (event: MessageEvent<LoaderToWidgetMessage>) => {
      if (event.source !== window.parent || event.data?.source !== LOADER_SOURCE) return;
      const data = event.data;
      if (data.type === 'init') {
        if (hostOrigin.current) return; // init only once
        hostOrigin.current = event.origin; // browser-verified origin of the embedding site
        tokenRef.current = data.token;
        setViewport(data.viewport);
        setLocale(data.locale || 'en');
        lastInit.current = { pageUrl: data.pageUrl, locale: data.locale };
        void startSession(lastInit.current);
      } else if (data.type === 'viewport') {
        setViewport(data.viewport);
      } else if (data.type === 'open') {
        setOpen(true);
      } else if (data.type === 'close') {
        setOpen(false);
      } else if (data.type === 'toggle') {
        setOpen((o) => !o);
      }
    };
    window.addEventListener('message', onMessage);
    postToLoader({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Teaser: the welcome message, once per browser session, if the visitor hasn't chatted.
  useEffect(() => {
    if (standalone || open || state.phase !== 'ready' || state.messages.length > 0) return;
    if (safeStorage.flag(`omniai:teaser:${config.botKey}`)) return;
    const t = setTimeout(() => setTeaser(true), TEASER_DELAY_MS);
    return () => clearTimeout(t);
  }, [standalone, open, state.phase, state.messages.length, config.botKey]);

  const dismissTeaser = useCallback(() => {
    setTeaser(false);
    safeStorage.flag(`omniai:teaser:${config.botKey}`, true);
  }, [config.botKey]);

  // Open/close with a short exit animation before the iframe shrinks.
  useEffect(() => {
    clearTimeout(closingTimer.current);
    if (open) {
      setPanelVisible(true);
      if (teaser) dismissTeaser();
      session.clearUnread();
    } else if (!standalone) {
      closingTimer.current = setTimeout(() => setPanelVisible(false), 180);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) session.clearUnread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, state.unread]);

  // Panel geometry.
  const panelSize = useMemo(() => {
    const maxH = (expanded ? EXPANDED_MAX_H : PANEL_MAX_H) as number;
    const width = Math.min(expanded ? EXPANDED_W : PANEL_W, viewport.width - MARGIN * 2);
    const height = Math.max(360, Math.min(maxH, viewport.height - LAUNCHER - GAP - MARGIN * 2));
    return { width, height };
  }, [expanded, viewport]);

  // Tell the loader how big the iframe must be.
  useEffect(() => {
    if (standalone !== false) return;
    let frame: { state: WidgetFrameState; width: number; height: number };
    if (state.phase === 'blocked' || state.phase === 'idle') frame = { state: 'hidden', width: 0, height: 0 };
    else if (panelVisible && isMobile) frame = { state: 'fullscreen', width: viewport.width, height: viewport.height };
    else if (panelVisible)
      frame = {
        state: expanded ? 'expanded' : 'open',
        width: panelSize.width + MARGIN * 2,
        height: panelSize.height + GAP + LAUNCHER + MARGIN * 2,
      };
    else if (teaser) frame = { state: 'teaser', width: 280 + MARGIN * 2 + 8, height: 120 + GAP + LAUNCHER + MARGIN * 2 };
    else frame = { state: 'closed', width: LAUNCHER + MARGIN * 2, height: LAUNCHER + MARGIN * 2 };
    postToLoader({ type: 'resize', position: config.position, ...frame });
  }, [standalone, state.phase, panelVisible, isMobile, expanded, teaser, panelSize, viewport, config.position, postToLoader]);

  // Escape closes the panel.
  useEffect(() => {
    if (!open || standalone) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, standalone]);

  if (standalone === null || state.phase === 'blocked' || state.phase === 'idle') return null;

  const left = config.position === 'bottom-left';
  const dir = isRtl(lang) ? 'rtl' : 'ltr';
  const panel = (
    <Panel
      dir={dir}
      config={config}
      strings={strings}
      lang={lang}
      conversation={state.conversation}
      messages={state.messages}
      streamingText={state.streaming?.text || null}
      streamingStatus={state.streaming?.status ?? null}
      awaitingReply={state.awaitingReply}
      connection={state.connection}
      expanded={expanded}
      canExpand={!fullscreen}
      fullscreen={fullscreen}
      loading={state.phase === 'loading'}
      error={state.phase === 'error' ? strings.errorGeneric : null}
      onClose={standalone ? undefined : () => setOpen(false)}
      onToggleExpand={() => setExpanded((e) => !e)}
      onSend={session.send}
      onRetry={session.retry}
      onRestart={() => void session.restart().catch(() => undefined)}
      onHandoff={() => void session.handoff().catch(() => undefined)}
      upload={session.upload}
    />
  );

  return (
    <div dir="ltr" lang={lang} style={widgetThemeStyle(config.primaryColor)} className="font-sans antialiased">
      {fullscreen ? (
        panelVisible && <div className={cn('fixed inset-0', !standalone && 'animate-slide-up')}>{panel}</div>
      ) : (
        <div
          className={cn('fixed bottom-0 flex flex-col gap-[14px]', left ? 'left-0 items-start' : 'right-0 items-end')}
          style={{ padding: MARGIN }}
        >
          {panelVisible && (
            <div
              style={{ width: panelSize.width, height: panelSize.height }}
              className={cn(
                'transition-all duration-200 ease-out',
                open ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-[0.98] opacity-0',
                left ? 'origin-bottom-left' : 'origin-bottom-right',
              )}
            >
              {panel}
            </div>
          )}
          {!panelVisible && teaser && (
            <Teaser
              dir={dir}
              config={config}
              strings={strings}
              onOpen={() => {
                dismissTeaser();
                setOpen(true);
              }}
              onDismiss={dismissTeaser}
            />
          )}
          <Launcher open={open} unread={state.unread} onClick={() => setOpen((o) => !o)} strings={strings} />
        </div>
      )}
    </div>
  );
}
