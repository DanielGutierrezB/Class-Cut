'use strict';
/**
 * regenerar.js — Que el XML de cada clase diga lo último que se escribió.
 *
 * Los comentarios y las notas se guardan al instante, pero al XML llegan solo
 * cuando la clase se exporta, y exportar pasaba únicamente por «Guardar y
 * regenerar» estando en ella. Quien comenta en la clase 3, sigue a la 7 y
 * guarda ahí, deja el XML de la 3 sin sus comentarios y sin ninguna señal de
 * que falta algo: en Premiere aparecen los de la 7 y nada más. Es una pérdida
 * silenciosa de trabajo de una persona, que es lo peor que puede pasar acá.
 *
 * Así que guardar deja al día todas las que lo necesiten. Reexportar no
 * recalcula nada —reconstruye el plan y reescribe el XML, milisegundos por
 * clase—, pero hacerlo con todas a ciegas escribe en la carpeta del cliente sin
 * poder decir qué cambió. Por eso se mide: la fecha del archivo de notas contra
 * la del XML exportado. Si se escribió después de la última exportación, esa
 * clase está atrasada; si no, no se toca y se dice que no se tocó.
 *
 * Se compara con el XML y no con `procesadaEn` del archivo de la clase: esa
 * fecha es de cuándo se procesó, y `estado-clase.actualizar` —el que corre al
 * guardar una nota— no la mueve. El XML es el archivo que el editor importa, así
 * que su fecha es la única que contesta «¿lo que voy a abrir en Premiere tiene
 * esto?».
 *
 * Lo que se reexporta sale del plan GUARDADO de cada clase, nunca del alineado:
 * los bordes que el editor movió viven en el plan y el alineado sigue teniendo
 * lo que calculó la herramienta. Reexportar desde el alineado le devolvería a la
 * clase los cortes automáticos y se llevaría el trabajo de revisión, que es
 * justo lo contrario de lo que esto viene a hacer.
 */

const fs = require('fs');

const workspace = require('./workspace');
const estadoClase = require('./estado-clase');
const review = require('./review');

/** Cuándo se escribió un archivo, o null si no está. */
function fechaDe(archivo) {
    try {
        return Math.round(fs.statSync(archivo).mtimeMs);
    } catch (e) {
        return null;
    }
}

/**
 * ¿Hay de qué reexportar esta clase?
 *
 * El alineado es lo que hace falta para reconstruir el corte. Puede estar en el
 * Backup de esta raíz o venir dentro de la carpeta de la clase, que es lo que
 * sobrevive a entrar por otra carpeta. Lo segundo cuesta medio mega de JSON, así
 * que solo se pregunta cuando el Backup no contesta.
 */
function hayTrabajo(root, cls) {
    if (fs.existsSync(workspace.artifact(root, cls.sequenceName, 'align'))) return true;
    const guardado = estadoClase.leer(cls.folder);
    if (!guardado || !guardado.trabajo || !guardado.trabajo.align) return false;
    return estadoClase.vigente(guardado, cls).vale;
}

/**
 * Lo que el disco dice de una clase.
 * @param {object} params { root, cls }
 * @returns {{hayTrabajo: boolean, exportadoEn: number|null, escritoEn: number|null}}
 */
function senales(params) {
    const { root, cls } = params;
    const secuencia = cls && cls.sequenceName;
    if (!root || !secuencia) return { hayTrabajo: false, exportadoEn: null, escritoEn: null };
    return {
        hayTrabajo: hayTrabajo(root, cls),
        exportadoEn: fechaDe(workspace.finalXml(root, secuencia)),
        escritoEn: fechaDe(workspace.artifact(root, secuencia, 'notas'))
    };
}

/**
 * Con esas señales, ¿hay que reexportar?
 *
 * Pura a propósito: es la decisión que va a escribir en la carpeta del cliente,
 * y una función que solo mira números se puede probar entera sin tocar el disco.
 *
 * @returns {{regenerar: boolean, porque: string}}
 */
function decidir(senal) {
    if (!senal || !senal.hayTrabajo) return { regenerar: false, porque: 'sin-trabajo' };
    // Hay trabajo hecho y ningún XML en esta carpeta: la clase se procesó
    // entrando por otra y acá todavía no hay nada que importar.
    if (senal.exportadoEn == null) return { regenerar: true, porque: 'sin-xml' };
    if (senal.escritoEn != null && senal.escritoEn > senal.exportadoEn) {
        return { regenerar: true, porque: 'escrito-despues' };
    }
    return { regenerar: false, porque: 'al-dia' };
}

/** Por qué, dicho para el editor. */
function texto(porque) {
    switch (porque) {
        case 'sin-trabajo': return 'Esta clase todavía no se procesó.';
        case 'sin-xml': return 'Está procesada pero no tiene XML en esta carpeta.';
        case 'escrito-despues': return 'Escribiste algo después de la última exportación.';
        case 'al-dia': return 'El XML ya tiene todo lo que escribiste.';
        default: throw new Error(`No sé qué decir de «${porque}».`);
    }
}

/**
 * De las clases que se le pasen, las que hay que reexportar.
 *
 * Cada clase lleva su propia raíz, así que la lista puede cruzar carpetas y cada
 * XML se mide contra el `The Cutter` que le corresponde.
 *
 * @param {object} params { clases }
 */
function pendientes(params) {
    const salida = [];
    for (const cls of (params && params.clases) || []) {
        const decision = decidir(senales({ root: cls.root, cls }));
        if (!decision.regenerar) continue;
        salida.push({
            id: cls.id,
            classNumber: cls.classNumber,
            sequenceName: cls.sequenceName,
            porque: decision.porque,
            motivo: texto(decision.porque)
        });
    }
    return salida;
}

/**
 * Un segmento del plan guardado, en la forma en que el visor manda lo que el
 * editor tocó.
 *
 * Reexportar no es un camino aparte: es guardar sin cambios nuevos. Que pase por
 * el mismo `saveReview` es lo que garantiza que una clase reexportada de fondo
 * salga igual que si el editor hubiera entrado a apretar el botón.
 */
function comoLoDejoElEditor(segment) {
    return {
        blockIndex: segment.blockIndex,
        sourceStartSec: segment.sourceStartSec,
        sourceEndSec: segment.sourceEndSec,
        view: segment.view,
        keep: segment.keep,
        disabledReason: segment.disabledReason || '',
        // Un bloque que ya estaba en confianza alta lo estaba porque alguien lo
        // miró: reexportar no puede devolverlo a "para revisar".
        reviewed: segment.confidence === 'alta'
    };
}

/**
 * Reexporta una clase dejándole los bordes como están.
 * @param {object} cls la clase con su raíz (`cls.root`)
 */
function unaClase(cls) {
    const root = cls && cls.root;
    const secuencia = cls && cls.sequenceName;
    if (!root || !secuencia) return { ok: false, error: 'La clase no tiene raíz ni secuencia.' };

    // Si el Backup de esta raíz está vacío, se le devuelve a la clase lo que
    // trae guardado — lo mismo que hace el visor al abrirla. Sin esto no habría
    // alineado del que reconstruir el corte.
    if (!fs.existsSync(workspace.artifact(root, secuencia, 'align'))) {
        estadoClase.hidratar({ root, cls });
    }

    const plan = workspace.readJson(workspace.artifact(root, secuencia, 'cutplan'));
    const res = review.saveReview({
        root,
        cls,
        // Sin plan guardado no hay decisiones del editor que preservar: sale el
        // corte del alineado, que es exactamente lo que había en disco.
        segments: plan ? plan.segments.map(comoLoDejoElEditor) : [],
        viewMap: plan ? plan.viewMap : null
    });
    if (!res.ok) return res;

    // El XML acaba de cambiar: el archivo que viaja con la carpeta tiene que
    // quedar con este plan y no con el de antes.
    estadoClase.actualizar({ root, cls, claves: ['cutplan'] });
    return res;
}

/**
 * Reexporta varias y cuenta qué pasó con cada una.
 *
 * Una que falle no puede frenar a las demás: son clases independientes y dejar
 * las otras atrasadas por un XML que no se pudo escribir no arregla nada.
 *
 * @param {object} params { clases }
 * @returns {{hechas: object[], fallas: object[]}}
 */
function varias(params) {
    const hechas = [];
    const fallas = [];
    for (const cls of (params && params.clases) || []) {
        const res = unaClase(cls);
        if (res.ok) hechas.push({ id: cls.id, classNumber: cls.classNumber, exported: res.exported });
        else fallas.push({ id: cls.id, classNumber: cls.classNumber, error: res.error });
    }
    return { hechas, fallas };
}

module.exports = { senales, decidir, texto, pendientes, unaClase, varias, comoLoDejoElEditor };
