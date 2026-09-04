// ==UserScript==
// @name         UESTC 自动点击下一节
// @namespace    local.uestc.learning-helper
// @version      0.8.1
// @description  视频真实播放结束后，自动进入并尝试播放下一课件。
// @icon         https://cdn.jsdelivr.net/gh/Grasping-04/uestc-student-auto-next@main/university-of-electronic-science-and-technology-of-china-logo-1024px.png
// @icon64       https://cdn.jsdelivr.net/gh/Grasping-04/uestc-student-auto-next@main/university-of-electronic-science-and-technology-of-china-logo-1024px.png
// @match        https://resource.uestc.edu.cn/*
// @run-at       document-idle
// @license      MIT
// @homepageURL  https://github.com/Grasping-04/uestc-student-auto-next
// @source       https://github.com/Grasping-04/uestc-student-auto-next
// @supportURL   https://github.com/Grasping-04/uestc-student-auto-next/issues
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  'use strict';

  const LOG_PREFIX = '[UESTC Auto Next]';
  const ENABLED_KEY = 'uestc_auto_next_enabled';
  const BG_KEEP_PLAYING_KEY = 'uestc_bg_keep_playing';
  const SPEED_LOCK_KEY = 'uestc_speed_lock';
  const LOCKED_PLAYBACK_RATE = 2;
  const LOGO_URL = 'https://cdn.jsdelivr.net/gh/Grasping-04/uestc-student-auto-next@main/university-of-electronic-science-and-technology-of-china-logo-1024px.png';
  const NAVIGATION_DELAY_MS = 1500;
  const AUTO_PLAY_TIMEOUT_MS = 15000;
  const VIDEO_ENDED_MESSAGE = 'UESTC_AUTO_NEXT_VIDEO_ENDED';

  // 已知“下一节”控件可在这里补充。选择器越具体，优先级越高。
  const NEXT_SELECTORS = [
    '[data-action="next"]',
    '[data-testid="next-lesson"]',
    'button[aria-label="下一节"]',
    'a[aria-label="下一节"]',
    '.next-lesson',
    '.next-section',
    '.next-course',
    '.btn-next'
  ];

  const NEXT_LABELS = new Set([
    '下一节',
    '下一课',
    '下一讲',
    '下一个',
    '播放下一节',
    '进入下一节'
  ]);

  // 课程页没有“下一节”按钮时，从目录中的当前项寻找下一项。
  // 每组选择器只会在它确实包含“当前项”时生效。
  const CURRENT_ITEM_SELECTORS = [
    '.chapter_tree .el-tree-node.is-current',
    '[aria-current="true"]',
    '[aria-current="page"]',
    '.el-tree-node.is-current',
    '[class*="courseware"] .active',
    '[class*="courseWare"] .active',
    '[class*="catalog"] .active',
    '[class*="chapter"] .active',
    '[class*="section"] .active',
    '[class*="lesson"] .active',
    '.is-active',
    '.playing',
    '.current'
  ];

  const CATALOG_ITEM_SELECTORS = [
    '.chapter_tree .el-tree-node',
    '.el-tree-node',
    '[class*="courseware"] [class*="item"]',
    '[class*="courseWare"] [class*="item"]',
    '[class*="catalog"] [class*="item"]',
    '[class*="chapter"] [class*="item"]',
    '[class*="section"] [class*="item"]',
    '[class*="lesson"] [class*="item"]',
    '[role="treeitem"]'
  ];

  let enabled = GM_getValue(ENABLED_KEY, true);
  let bgKeepPlaying = GM_getValue(BG_KEEP_PLAYING_KEY, true);
  let speedLock = GM_getValue(SPEED_LOCK_KEY, true);
  let navigationPending = false;
  let autoPlayPending = false;
  let manualPlayNeeded = false;
  let autoPlayTimer = null;
  let autoPlayAttemptRunning = false;
  let lastEndedVideo = null;
  let lastEndedSrc = '';
  const ui = { root: null, panel: null, statusEl: null, dot: null, toggles: {} };
  const boundVideos = new WeakSet();
  const videosPlayingWhenHidden = new Set();

  const log = (...args) => console.info(LOG_PREFIX, ...args);

  function createToggle(labelText, initialValue, onChange) {
    const row = document.createElement('label');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '9px 0',
      cursor: 'pointer',
      userSelect: 'none'
    });

    const label = document.createElement('span');
    label.textContent = labelText;
    Object.assign(label.style, { fontSize: '13px', color: '#333' });

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = initialValue;
    input.style.cssText = 'display:none';

    const track = document.createElement('span');
    Object.assign(track.style, {
      position: 'relative',
      width: '40px',
      height: '22px',
      borderRadius: '11px',
      background: '#ccc',
      flexShrink: '0',
      transition: 'background .2s ease'
    });

    const thumb = document.createElement('span');
    Object.assign(thumb.style, {
      position: 'absolute',
      top: '2px',
      left: '2px',
      width: '18px',
      height: '18px',
      borderRadius: '50%',
      background: '#fff',
      boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
      transition: 'transform .2s ease'
    });
    track.appendChild(thumb);

    const render = () => {
      track.style.background = input.checked ? '#1e5aa8' : '#ccc';
      thumb.style.transform = input.checked ? 'translateX(18px)' : 'translateX(0)';
    };
    render();

    row.addEventListener('click', () => {
      input.checked = !input.checked;
      render();
      onChange(input.checked);
    });

    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(input);
    return { element: row, set: (value) => { input.checked = value; render(); } };
  }

  function createUI() {
    if (ui.root || window.top !== window) return;

    ui.root = document.createElement('div');
    ui.root.id = 'uestc-auto-next-ui';
    Object.assign(ui.root.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      fontFamily: '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif'
    });

    const badge = document.createElement('button');
    badge.type = 'button';
    Object.assign(badge.style, {
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '44px',
      height: '44px',
      padding: '0',
      borderRadius: '50%',
      background: '#fff',
      border: '0',
      boxShadow: '0 2px 10px rgba(0, 0, 0, 0.25)',
      cursor: 'pointer',
      marginLeft: 'auto',
      transition: 'transform .15s ease'
    });
    badge.addEventListener('mouseenter', () => { badge.style.transform = 'scale(1.06)'; });
    badge.addEventListener('mouseleave', () => { badge.style.transform = 'scale(1)'; });

    const logo = document.createElement('img');
    logo.alt = '';
    logo.src = LOGO_URL;
    Object.assign(logo.style, {
      width: '100%',
      height: '100%',
      borderRadius: '50%',
      objectFit: 'cover',
      display: 'block'
    });
    logo.onerror = () => {
      logo.remove();
      badge.textContent = 'U';
      Object.assign(badge.style, { fontSize: '20px', fontWeight: '700', color: '#1e5aa8' });
    };
    badge.appendChild(logo);

    ui.dot = document.createElement('span');
    Object.assign(ui.dot.style, {
      position: 'absolute',
      top: '0',
      right: '0',
      width: '12px',
      height: '12px',
      borderRadius: '50%',
      border: '2px solid #fff',
      background: '#4caf50'
    });
    badge.appendChild(ui.dot);

    ui.panel = document.createElement('div');
    Object.assign(ui.panel.style, {
      position: 'absolute',
      right: '0',
      bottom: '52px',
      width: '260px',
      background: '#fff',
      borderRadius: '12px',
      boxShadow: '0 8px 30px rgba(0, 0, 0, 0.18)',
      padding: '12px 16px 14px',
      display: 'none'
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      paddingBottom: '10px',
      borderBottom: '1px solid #f0f0f0'
    });

    const headerLogo = document.createElement('img');
    headerLogo.alt = '';
    headerLogo.src = LOGO_URL;
    Object.assign(headerLogo.style, {
      width: '22px',
      height: '22px',
      borderRadius: '50%',
      objectFit: 'cover'
    });
    headerLogo.onerror = () => {
      headerLogo.remove();
      const fallback = document.createElement('span');
      fallback.textContent = 'U';
      Object.assign(fallback.style, { fontSize: '14px', fontWeight: '700', color: '#1e5aa8' });
      header.prepend(fallback);
    };

    const title = document.createElement('span');
    title.textContent = 'UESTC 课程助手';
    Object.assign(title.style, { fontSize: '14px', fontWeight: '600', color: '#1e5aa8' });

    header.appendChild(headerLogo);
    header.appendChild(title);
    ui.panel.appendChild(header);

    ui.toggles[ENABLED_KEY] = createToggle('自动下一节', enabled, (value) => setEnabled(value));
    ui.toggles[BG_KEEP_PLAYING_KEY] = createToggle('后台保持播放', bgKeepPlaying, (value) => setBgKeepPlaying(value));
    ui.toggles[SPEED_LOCK_KEY] = createToggle('锁定二倍速', speedLock, (value) => setSpeedLock(value));
    ui.panel.appendChild(ui.toggles[ENABLED_KEY].element);
    ui.panel.appendChild(ui.toggles[BG_KEEP_PLAYING_KEY].element);
    ui.panel.appendChild(ui.toggles[SPEED_LOCK_KEY].element);

    ui.statusEl = document.createElement('div');
    Object.assign(ui.statusEl.style, {
      marginTop: '4px',
      paddingTop: '10px',
      borderTop: '1px solid #f0f0f0',
      fontSize: '12px',
      color: '#888'
    });
    ui.panel.appendChild(ui.statusEl);

    badge.addEventListener('click', (event) => {
      event.stopPropagation();
      ui.panel.style.display = ui.panel.style.display === 'none' ? 'block' : 'none';
    });

    document.addEventListener('click', () => {
      if (ui.panel) ui.panel.style.display = 'none';
    });

    ui.root.appendChild(badge);
    ui.root.appendChild(ui.panel);
    document.body.appendChild(ui.root);
  }

  function updateStatus(message) {
    createUI();
    if (!ui.statusEl) return;
    ui.statusEl.textContent = `状态：${message}`;
    if (ui.dot) ui.dot.style.background = enabled ? '#4caf50' : '#9e9e9e';
  }

  function setEnabled(value, showAlert = false) {
    enabled = value;
    GM_setValue(ENABLED_KEY, enabled);
    if (ui.toggles[ENABLED_KEY]) ui.toggles[ENABLED_KEY].set(enabled);
    updateStatus(enabled ? '等待视频' : '已停用');
    log(enabled ? '已启用。' : '已停用。');
    if (showAlert) window.alert(`自动下一节：${enabled ? '已启用' : '已停用'}`);
    if (enabled) scanForVideos();
  }

  function setBgKeepPlaying(value) {
    bgKeepPlaying = value;
    GM_setValue(BG_KEEP_PLAYING_KEY, bgKeepPlaying);
    if (ui.toggles[BG_KEEP_PLAYING_KEY]) ui.toggles[BG_KEEP_PLAYING_KEY].set(bgKeepPlaying);
    log(bgKeepPlaying ? '后台保持播放已开启。' : '后台保持播放已关闭。');
  }

  function setSpeedLock(value) {
    speedLock = value;
    GM_setValue(SPEED_LOCK_KEY, speedLock);
    if (ui.toggles[SPEED_LOCK_KEY]) ui.toggles[SPEED_LOCK_KEY].set(speedLock);
    if (speedLock) document.querySelectorAll('video').forEach(enforceSpeedLock);
    log(speedLock ? '锁定二倍速已开启。' : '锁定二倍速已关闭。');
  }

  function enforceSpeedLock(video) {
    if (!speedLock) return;
    if (Math.abs(video.playbackRate - LOCKED_PLAYBACK_RATE) > 0.01) {
      video.playbackRate = LOCKED_PLAYBACK_RATE;
    }
  }

  function installBackgroundKeepPlaying() {
    const originalPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function () {
      if (bgKeepPlaying && document.hidden) {
        log('页面在后台，忽略播放器的暂停请求。');
        return;
      }
      return originalPause.call(this);
    };

    const onBackgroundEvent = (event) => {
      if (!bgKeepPlaying) return;
      if (document.hidden) {
        videosPlayingWhenHidden.clear();
        for (const video of document.querySelectorAll('video')) {
          if (!video.paused && !video.ended) videosPlayingWhenHidden.add(video);
        }
      } else {
        for (const video of [...videosPlayingWhenHidden]) {
          if (!video.ended && video.paused) {
            video.play().catch((error) =>
              console.warn(LOG_PREFIX, '回到前台后自动恢复播放失败。', error)
            );
          }
        }
        videosPlayingWhenHidden.clear();
        if (manualPlayNeeded) {
          const alreadyPlaying = [...document.querySelectorAll('video')].some(
            (video) => !video.paused && !video.ended
          );
          if (alreadyPlaying) {
            manualPlayNeeded = false;
          } else {
            startAutoPlaySearch();
          }
        }
      }
      event.stopImmediatePropagation();
    };

    window.addEventListener('visibilitychange', onBackgroundEvent, true);
    window.addEventListener('blur', onBackgroundEvent, true);
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function isEnabled(element) {
    return !element.matches(':disabled, [disabled], [aria-disabled="true"]');
  }

  function normalizedLabel(element) {
    return (element.getAttribute('aria-label') || element.textContent || '')
      .replace(/\s+/g, '')
      .trim();
  }

  function uniqueElements(elements) {
    return [...new Set(elements)];
  }

  function findNextControl() {
    const selectorMatches = NEXT_SELECTORS.flatMap((selector) =>
      [...document.querySelectorAll(selector)]
    );

    const labelMatches = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter((element) => NEXT_LABELS.has(normalizedLabel(element)));

    return uniqueElements([...selectorMatches, ...labelMatches])
      .find((element) => isVisible(element) && isEnabled(element)) || null;
  }

  function findCurrentCatalogElement() {
    for (const selector of CURRENT_ITEM_SELECTORS) {
      const matches = [...document.querySelectorAll(selector)]
        .filter((element) => isVisible(element));
      if (matches.length === 1) return matches[0];
    }
    return null;
  }

  function clickablePart(element) {
    if (element.matches('a, button, [role="button"], [tabindex]')) return element;
    return [...element.querySelectorAll('a, button, [role="button"], [tabindex]')]
      .find((candidate) => isVisible(candidate) && isEnabled(candidate)) || element;
  }

  function findNextCatalogControl() {
    const current = findCurrentCatalogElement();
    if (!current) return null;

    for (const selector of CATALOG_ITEM_SELECTORS) {
      const items = [...document.querySelectorAll(selector)]
        .filter((element) => isVisible(element));
      const currentIndex = items.findIndex((item) =>
        item === current || item.contains(current) || current.contains(item)
      );

      if (currentIndex < 0) continue;
      for (let index = currentIndex + 1; index < items.length; index += 1) {
        const control = clickablePart(items[index]);
        if (isVisible(control) && isEnabled(control)) return control;
      }
    }

    return null;
  }

  function resourceIdentity(resource) {
    if (!resource) return '';
    return resource.identification || resource.guid_ || resource.id || '';
  }

  function collectCourseResources(nodes, output = []) {
    if (!Array.isArray(nodes)) return output;

    for (const node of nodes) {
      const info = node?.info || node;
      const resourceType = info?.resourse_type;
      const resourceAttribute = info?.resource_attributes;
      const isCourseResource = Boolean(
        info?.chapter_describe &&
        resourceType &&
        resourceType !== 'chapter' &&
        resourceType !== 'homework' &&
        resourceAttribute !== 'homework'
      );

      if (isCourseResource) output.push(info);
      const children = Array.isArray(node?.childInfo) ? node.childInfo : node?.children;
      collectCourseResources(children, output);
    }

    return output;
  }

  function findNextResourceAcrossChapters(appVm, chapterVm) {
    const current = appVm?.selectChapter || chapterVm?.selectChapter;
    const currentIdentity = resourceIdentity(current);
    if (!currentIdentity) return null;

    const candidateTrees = [
      appVm?.treeInfo,
      chapterVm?.treeInfo,
      chapterVm?.chapterList
    ];

    for (const tree of candidateTrees) {
      const resources = collectCourseResources(tree, []);
      const currentIndex = resources.findIndex((resource) =>
        resourceIdentity(resource) === currentIdentity
      );

      if (currentIndex >= 0 && currentIndex < resources.length - 1) {
        return resources[currentIndex + 1];
      }
    }

    return null;
  }

  function goToNextViaPlatformState() {
    const pageWindow = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
    const app = pageWindow.document?.getElementById('app');
    const appVm = app?.__vue__;
    const chapterVm = appVm?.$refs?.chapter;
    const platformNextChapter = appVm?.nextChapter;
    const nextChapter = platformNextChapter || findNextResourceAcrossChapters(appVm, chapterVm);

    if (!nextChapter || typeof chapterVm?.goTo !== 'function') return false;

    // 优先使用平台结果；章节末尾没有结果时，从完整目录寻找下一课件。
    chapterVm.goTo({ info: nextChapter });
    log(
      platformNextChapter ? '已进入下一课件。' : '已跨章节进入下一课件。',
      nextChapter.chapter_name || nextChapter
    );
    return true;
  }

  function stopAutoPlaySearch() {
    if (autoPlayTimer !== null) {
      window.clearInterval(autoPlayTimer);
      autoPlayTimer = null;
    }
    autoPlayAttemptRunning = false;
  }

  function isNewPlayableVideo(video) {
    if (!(video instanceof HTMLVideoElement) || video.ended || video.readyState < 1) return false;
    const sourceChanged = video.currentSrc && video.currentSrc !== lastEndedSrc;
    const reusedAtStart = video === lastEndedVideo && video.currentTime < 1;
    return video !== lastEndedVideo || sourceChanged || reusedAtStart;
  }

  function startAutoPlaySearch() {
    stopAutoPlaySearch();
    autoPlayPending = true;
    manualPlayNeeded = false;
    updateStatus('等待新视频');
    const startedAt = Date.now();

    const attempt = async () => {
      if (!enabled || autoPlayAttemptRunning) return;
      autoPlayAttemptRunning = true;

      try {
        const video = [...document.querySelectorAll('video')].find(isNewPlayableVideo);
        if (!video) {
          if (Date.now() - startedAt >= AUTO_PLAY_TIMEOUT_MS) {
            stopAutoPlaySearch();
            autoPlayPending = false;
            updateStatus('下一项无可播放视频');
            log('进入下一课件后，没有检测到可以播放的新视频。');
          }
          return;
        }

        bindVideo(video);
        if (!video.paused) {
          stopAutoPlaySearch();
          autoPlayPending = false;
          updateStatus('播放中');
          log('下一课件已经开始播放。');
          return;
        }

        try {
          await video.play();
          stopAutoPlaySearch();
          autoPlayPending = false;
          updateStatus('播放中');
          log('已自动开始播放下一课件。', video);
        } catch (error) {
          stopAutoPlaySearch();
          autoPlayPending = false;
          manualPlayNeeded = true;
          updateStatus('请手动播放');
          console.warn(LOG_PREFIX, '浏览器阻止了下一课件自动播放。', error);
        }
      } finally {
        autoPlayAttemptRunning = false;
      }
    };

    autoPlayTimer = window.setInterval(attempt, 350);
    attempt();
  }

  function finishNavigationCooldown() {
    window.setTimeout(() => {
      navigationPending = false;
      scanForVideos();
    }, 3000);
  }

  function requestNextLesson() {
    if (!enabled || navigationPending) return;
    navigationPending = true;
    updateStatus('切换中');

    window.setTimeout(() => {
      if (goToNextViaPlatformState()) {
        startAutoPlaySearch();
        finishNavigationCooldown();
        return;
      }

      const nextControl = findNextControl() || findNextCatalogControl();
      if (!nextControl) {
        log('视频已结束，但没有找到“下一节”按钮或目录中的下一项。');
        navigationPending = false;
        updateStatus('未找到下一课件');
        return;
      }

      log('视频已自然结束，进入下一节。', nextControl);
      nextControl.click();
      startAutoPlaySearch();
      finishNavigationCooldown();
    }, NAVIGATION_DELAY_MS);
  }

  function notifyVideoEnded(video) {
    lastEndedVideo = video || null;
    lastEndedSrc = video?.currentSrc || '';

    if (window.top === window) {
      requestNextLesson();
      return;
    }

    window.top.postMessage({ type: VIDEO_ENDED_MESSAGE, source: lastEndedSrc }, location.origin);
  }

  function bindVideo(video) {
    if (boundVideos.has(video)) return;
    boundVideos.add(video);
    video.addEventListener('ended', () => notifyVideoEnded(video), { passive: true });
    video.addEventListener('ratechange', () => enforceSpeedLock(video), { passive: true });
    video.addEventListener('play', () => enforceSpeedLock(video), { passive: true });
    enforceSpeedLock(video);
    log('已监听课程视频。', video);
    updateStatus(enabled ? '监听中' : '已停用');
  }

  function scanForVideos(root = document) {
    if (root instanceof HTMLVideoElement) bindVideo(root);
    root.querySelectorAll?.('video').forEach(bindVideo);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) scanForVideos(node);
      }
    }
  });

  GM_registerMenuCommand('切换“自然结束后自动下一节”', () => {
    setEnabled(!enabled, true);
  });

  GM_registerMenuCommand('切换“后台保持播放”', () => {
    setBgKeepPlaying(!bgKeepPlaying);
    window.alert(`后台保持播放：${bgKeepPlaying ? '已开启' : '已关闭'}`);
  });

  GM_registerMenuCommand('切换“锁定二倍速”', () => {
    setSpeedLock(!speedLock);
    window.alert(`锁定二倍速：${speedLock ? '已开启' : '已关闭'}`);
  });

  if (window.top === window) {
    window.addEventListener('message', (event) => {
      if (event.origin !== location.origin || event.data?.type !== VIDEO_ENDED_MESSAGE) return;
      lastEndedVideo = null;
      lastEndedSrc = event.data?.source || '';
      requestNextLesson();
    });
  }

  createUI();
  installBackgroundKeepPlaying();
  scanForVideos();
  observer.observe(document.documentElement, { childList: true, subtree: true });
  log(enabled ? '脚本已启用。' : '脚本当前为停用状态。');
  log(bgKeepPlaying ? '后台保持播放已开启。' : '后台保持播放已关闭。');
  log(speedLock ? '锁定二倍速已开启。' : '锁定二倍速已关闭。');
  updateStatus(enabled ? '等待视频' : '已停用');
})();
