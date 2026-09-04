// ==UserScript==
// @name         UESTC 自动点击下一节
// @namespace    local.uestc.learning-helper
// @version      0.7.1
// @description  视频真实播放结束后，自动进入并尝试播放下一课件。
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
  let navigationPending = false;
  let autoPlayPending = false;
  let manualPlayNeeded = false;
  let autoPlayTimer = null;
  let autoPlayAttemptRunning = false;
  let lastEndedVideo = null;
  let lastEndedSrc = '';
  let statusBadge = null;
  const boundVideos = new WeakSet();
  const videosPlayingWhenHidden = new Set();

  const log = (...args) => console.info(LOG_PREFIX, ...args);

  function updateStatus(message) {
    if (window.top !== window) return;

    if (!statusBadge) {
      statusBadge = document.createElement('button');
      statusBadge.type = 'button';
      statusBadge.title = '点击启用或停用自动下一节';
      Object.assign(statusBadge.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483647',
        padding: '8px 12px',
        border: '0',
        borderRadius: '6px',
        color: '#fff',
        fontSize: '13px',
        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2)'
      });
      statusBadge.addEventListener('click', () => setEnabled(!enabled, true));
      document.body.appendChild(statusBadge);
    }

    statusBadge.textContent = `自动下一节：${message}`;
    statusBadge.style.background = enabled
      ? 'rgba(20, 120, 70, 0.92)'
      : 'rgba(110, 110, 110, 0.92)';
  }

  function setEnabled(value, showAlert = false) {
    enabled = value;
    GM_setValue(ENABLED_KEY, enabled);
    updateStatus(enabled ? '等待视频' : '已停用');
    log(enabled ? '已启用。' : '已停用。');
    if (showAlert) window.alert(`自动下一节：${enabled ? '已启用' : '已停用'}`);
    if (enabled) scanForVideos();
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
    bgKeepPlaying = !bgKeepPlaying;
    GM_setValue(BG_KEEP_PLAYING_KEY, bgKeepPlaying);
    window.alert(`后台保持播放：${bgKeepPlaying ? '已开启' : '已关闭'}`);
    log(bgKeepPlaying ? '后台保持播放已开启。' : '后台保持播放已关闭。');
  });

  if (window.top === window) {
    window.addEventListener('message', (event) => {
      if (event.origin !== location.origin || event.data?.type !== VIDEO_ENDED_MESSAGE) return;
      lastEndedVideo = null;
      lastEndedSrc = event.data?.source || '';
      requestNextLesson();
    });
  }

  installBackgroundKeepPlaying();
  scanForVideos();
  observer.observe(document.documentElement, { childList: true, subtree: true });
  log(enabled ? '脚本已启用。' : '脚本当前为停用状态。');
  log(bgKeepPlaying ? '后台保持播放已开启。' : '后台保持播放已关闭。');
  updateStatus(enabled ? '等待视频' : '已停用');
})();
