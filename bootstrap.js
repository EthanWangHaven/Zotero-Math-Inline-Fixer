/* global Zotero, Services, Components */
"use strict";

/**
 * Zotero Math Inline Fixer - bootstrap.js
 * Zotero 7/8/9/10 引导脚本。
 */

var MathFixer;

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
  try {
    if (typeof Zotero === "undefined") {
      return;
    }
    Services.scriptloader.loadSubScript(rootURI + "mathfixer.js");
    MathFixer.init({ id, version, rootURI });
    MathFixer.addToAllWindows();
    log("startup 完成 id=" + id + " version=" + version);
  } catch (e) {
    log("startup 出错: " + (e && e.message ? e.message : e));
  }
}

function onMainWindowLoad({ window }) {
  MathFixer.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  MathFixer.removeFromWindow(window);
}

function shutdown({ id, version, rootURI }, reason) {
  try {
    if (reason === APP_SHUTDOWN) {
      return;
    }
    MathFixer.removeFromAllWindows();
    MathFixer.uninit();
    MathFixer = undefined;
    log("shutdown 完成");
  } catch (e) {
    log("shutdown 出错: " + (e && e.message ? e.message : e));
  }
}