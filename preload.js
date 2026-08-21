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
    process: payload => ipcRenderer.invoke('process', payload),
    cancelProcess: () => ipcRenderer.invoke('cancel-process'),
    loadReview: payload => ipcRenderer.invoke('load-review', payload),
    saveReview: payload => ipcRenderer.invoke('save-review', payload),
    waveformWindow: payload => ipcRenderer.invoke('waveform-window', payload),
    audition: payload => ipcRenderer.invoke('audition', payload),
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
    },
    onProcessStage: callback => {
        ipcRenderer.on('process-stage', (_event, payload) => callback(payload));
    },
    onProcessClass: callback => {
        ipcRenderer.on('process-class', (_event, payload) => callback(payload));
    }
});
