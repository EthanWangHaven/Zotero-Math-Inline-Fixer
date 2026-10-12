/* global Zotero, Services, Components */
"use strict";

/**
 * Zotero Math Inline Fixer - bootstrap.js
 * Zotero 7/8/9/10 引导脚本。
 * UI 挂载严格等待 Zotero.uiReadyPromise（Awesome GPT 同款模式），
 * 杜绝主窗口 DOM 未就绪导致的一切时序问题。
 */

var MathFixer;
var MathClipFixer;

function log(msg) {
  try {
    Zotero.debug("[MathFixer] " + msg);
  } catch (e) {
    /* ignore */
  }
}

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }, reason) {
  if (typeof Zotero === "undefined") {
    return;
  }
  try {
    Services.scriptloader.loadSubScript(rootURI + "mathfixer.js");
    MathFixer.init({ id, version, rootURI });
  } catch (e) {
    log("startup mathfixer 模块失败: " + (e && e.stack ? e.stack : e));
  }
  try {
    Services.scriptloader.loadSubScript(rootURI + "clipfix.js");
    MathClipFixer.init({ id, version, rootURI });
  } catch (e) {
    log("startup clipfix 模块失败: " + (e && e.stack ? e.stack : e));
  }
  // 等待 Zotero UI 完全就绪后再挂载界面元素（与 Awesome GPT 一致）
  try {
    await Zotero.initializationPromise;
    await Zotero.unlockPromise;
    await Zotero.uiReadyPromise;
  } catch (e) {
    log("等待 uiReady 失败: " + (e && e.stack ? e.stack : e));
  }
  try {
    MathFixer.addToAllWindows();
  } catch (e) {
    log("mathfixer 挂载失败: " + (e && e.stack ? e.stack : e));
  }
  try {
    MathClipFixer.addToAllWindows();
  } catch (e) {
    log("clipfix 挂载失败: " + (e && e.stack ? e.stack : e));
  }
  log("startup 完成（UI 已就绪）v" + version);
}

function onMainWindowLoad({ window }) {
  try {
    MathFixer.addToWindow(window);
  } catch (e) {
    log("onMainWindowLoad mathfixer 失败: " + (e && e.stack ? e.stack : e));
  }
  try {
    MathClipFixer.addToWindow(window);
  } catch (e) {
    log("onMainWindowLoad clipfix 失败: " + (e && e.stack ? e.stack : e));
  }
}

function onMainWindowUnload({ window }) {
  try {
    MathFixer.removeFromWindow(window);
  } catch (e) {
    /* ignore */
  }
  try {
    MathClipFixer.removeFromWindow(window);
  } catch (e) {
    /* ignore */
  }
}

function shutdown({ id, version, rootURI }, reason) {
  try {
    if (reason === APP_SHUTDOWN) {
      return;
    }
    try { MathFixer.removeFromAllWindows(); } catch (e) {}
    try { MathFixer.uninit(); } catch (e) {}
    try { MathClipFixer.removeFromAllWindows(); } catch (e) {}
    try { MathClipFixer.uninit(); } catch (e) {}
    MathFixer = undefined;
    MathClipFixer = undefined;
    log("shutdown 完成");
  } catch (e) {
    log("shutdown 出错: " + (e && e.stack ? e.stack : e));
  }
}
