/* global Zotero, Services, Components */
"use strict";

/**
 * Better Notes Editor Probe - bootstrap.js
 *
 * Zotero 7/8/9/10 引导脚本。
 * 只负责插件生命周期：startup / onMainWindowLoad / onMainWindowUnload / shutdown。
 * 实际逻辑在 probe.js 中。
 */

var EditorProbe;

function log(msg) {
  Zotero.debug("[EditorProbe] " + msg);
}

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }, reason) {
  try {
    // 只在主进程初始化一次
    if (typeof Zotero === "undefined") {
      return;
    }
    Services.scriptloader.loadSubScript(rootURI + "probe.js");
    EditorProbe.init({ id, version, rootURI });
    EditorProbe.addToAllWindows();
    log("startup 完成, id=" + id + ", version=" + version);
  } catch (e) {
    log("startup 出错: " + (e && e.message ? e.message : e));
  }
}

function onMainWindowLoad({ window }) {
  EditorProbe.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  EditorProbe.removeFromWindow(window);
}

function shutdown({ id, version, rootURI }, reason) {
  try {
    if (reason === APP_SHUTDOWN) {
      return;
    }
    EditorProbe.removeFromAllWindows();
    EditorProbe.uninit();
    EditorProbe = undefined;
    log("shutdown 完成");
  } catch (e) {
    log("shutdown 出错: " + (e && e.message ? e.message : e));
  }
}