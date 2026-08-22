'use strict';
/**
 * Lo que la ventana sabe entre vistas: qué carpeta se escaneó, qué clase está
 * abierta y a dónde fue a parar lo exportado.
 *
 * Vive aparte para que las vistas no tengan que importarse entre ellas solo para
 * leer el escaneo.
 */

export const state = {
    scan: null,
    openId: null,
    scanning: false,
    outputDir: null,
    reviewFirst: null
};

export function findClass(id) {
    return state.scan ? state.scan.classes.find(c => c.id === id) : null;
}
