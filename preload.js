'use strict';
/**
 * preload.js — La única puerta entre la ventana y el sistema.
 *
 * La ventana no tiene Node: pide cosas por acá y el proceso principal decide. La
 * ruta de una carpeta arrastrada se obtiene con `webUtils.getPathForFile`, porque
 * desde Electron 32 el `File.path` de siempre ya no existe y el drop quedaba sin
 * ruta y sin error.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('cc', {
    appInfo: () => ipcRenderer.invoke('app-info'),
    doctor: () => ipcRenderer.invoke('doctor'),
    pickFolder: () => ipcRenderer.invoke('pick-folder'),
    scan: folder => ipcRenderer.invoke('scan', folder),
    reveal: target => ipcRenderer.invoke('reveal', target),
    openPath: target => ipcRenderer.invoke('open-path', target),

    pathForFile: file => {
        try {
            return webUtils.getPathForFile(file);
        } catch (e) {
            return file && file.path ? file.path : null;
        }
    },

    onScanFound: callback => {
        ipcRenderer.on('scan-found', (_event, payload) => callback(payload));
    },
    onScanProgress: callback => {
        ipcRenderer.on('scan-progress', (_event, payload) => callback(payload));
    }
});
