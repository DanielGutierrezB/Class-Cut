'use strict';
/**
 * estimar.js — Cuánto falta, dicho solo cuando se puede sostener.
 *
 * La regla de todo este archivo es una: **un estimado sale de algo medido en
 * ESTA corrida, o no sale**. Cada función devuelve `null` cuando no tiene con
 * qué, y quien dibuja no muestra nada en vez de poner un número inventado. Un
 * "faltan 4 min" que se estira a cuarenta es peor que no decir nada: la próxima
 * vez ya nadie mira el número, y entonces todo el trabajo de mostrarlo sobró.
 *
 * De dónde sale cada cosa:
 *
 * - **La etapa en curso**, cuando informa porcentaje (transcribir, afinar,
 *   revisar): del propio porcentaje contra lo que va tardando. No hay modelo
 *   escondido, es una regla de tres sobre lo transcurrido.
 * - **La clase en curso** y **las que faltan**: del ritmo medido, o sea de los
 *   milisegundos que tardó cada clase YA terminada por segundo de material.
 *   Es la relación que de verdad se sostiene —transcribir es proporcional a la
 *   duración del audio, y es lo que domina el total—, y se mide en la máquina
 *   del editor con el proveedor que tenga puesto, que es la única forma de que
 *   valga: una constante escrita acá sería mentira en cuanto alguien cambie de
 *   modelo.
 *
 * Y una separación que importa: una clase que reusa su transcript tarda
 * segundos y una desde cero tarda una hora. Promediarlas da un ritmo que no
 * describe a ninguna de las dos, así que las muestras van en dos bolsas y solo
 * se estima con la que corresponde.
 *
 * Nada de acá toca el DOM ni conoce la corrida: entran números, salen números.
 */

/**
 * Cuánto le falta a una etapa que informa porcentaje.
 *
 * @param {number} msTranscurridos lo que lleva ESTA etapa
 * @param {number} percent 0..100
 * @returns {number|null} ms que faltan, o null si todavía no hay de dónde
 */
export function faltaDeEtapa(msTranscurridos, percent) {
    if (!Number.isFinite(msTranscurridos) || msTranscurridos <= 0) return null;
    if (!Number.isFinite(percent)) return null;
    // Por debajo del 3% la regla de tres se dispara: al 1%, un segundo de
    // arranque se proyecta como cien. Se espera a tener algo de recorrido.
    if (percent < 3 || percent >= 100) return null;
    return Math.round(msTranscurridos * (100 - percent) / percent);
}

/**
 * El ritmo medido: milisegundos de proceso por segundo de material.
 *
 * @param {Array<{materialSec:number, ms:number, transcribio:boolean}>} muestras clases ya terminadas
 * @param {boolean} transcribiendo qué bolsa se quiere (desde cero o reusando)
 * @returns {number|null} ms por segundo de material, o null sin muestras útiles
 */
export function ritmo(muestras, transcribiendo) {
    const utiles = (muestras || []).filter(m =>
        m && Boolean(m.transcribio) === Boolean(transcribiendo) &&
        Number.isFinite(m.materialSec) && m.materialSec > 0 &&
        Number.isFinite(m.ms) && m.ms > 0);
    if (!utiles.length) return null;
    // Sobre los totales y no promediando los ritmos de cada clase: así una
    // clase corta —donde el arranque del modelo pesa más que el trabajo— no
    // vale lo mismo que una de una hora.
    const material = utiles.reduce((s, m) => s + m.materialSec, 0);
    const ms = utiles.reduce((s, m) => s + m.ms, 0);
    return ms / material;
}

/**
 * Cuánto le falta a la clase que está corriendo.
 *
 * Con ritmo medido, de ahí. Sin ritmo —la primera clase de la corrida—, lo
 * único honesto es lo que diga la etapa que informa porcentaje, que casi
 * siempre es transcribir y casi siempre es la que se lleva el tiempo.
 *
 * @param {object} p { ritmoMs, materialSec, msTranscurridos, faltaEtapaMs }
 * @returns {number|null}
 */
export function faltaDeClase(p) {
    const { ritmoMs, materialSec, msTranscurridos, faltaEtapaMs } = p || {};
    if (Number.isFinite(ritmoMs) && Number.isFinite(materialSec) && materialSec > 0) {
        const total = ritmoMs * materialSec;
        // Nunca menos que lo que la etapa en curso ya sabe que le falta: si el
        // ritmo se queda corto, la proyección diría "ya termina" con Whisper al
        // 40%. Entre dos medidas, gana la que no promete de más.
        const porRitmo = Math.max(0, total - (msTranscurridos || 0));
        return Number.isFinite(faltaEtapaMs) ? Math.max(porRitmo, faltaEtapaMs) : porRitmo;
    }
    return Number.isFinite(faltaEtapaMs) ? faltaEtapaMs : null;
}

/**
 * Cuánto le falta a la corrida entera: la clase en curso más las que no
 * empezaron, cada una a su ritmo.
 *
 * @param {object} p
 *   faltaClaseMs   lo que le falta a la que corre (puede ser null)
 *   pendientes     [{materialSec, transcribira}] las que todavía no empezaron
 *   ritmoDesdeCero ms por segundo de material transcribiendo
 *   ritmoReusando  ms por segundo de material reusando el transcript
 * @returns {number|null} null si no se puede estimar lo que falta
 */
export function faltaDeCorrida(p) {
    const { faltaClaseMs, pendientes, ritmoDesdeCero, ritmoReusando } = p || {};
    const lista = pendientes || [];

    let suma = 0;
    for (const c of lista) {
        const r = c.transcribira ? ritmoDesdeCero : ritmoReusando;
        // Una sola clase pendiente sin ritmo para su bolsa ya invalida el total:
        // decir "faltan 5 min" cuando falta una clase de una hora sin medir es
        // exactamente el número que hace que nadie vuelva a mirar el cartel.
        if (!Number.isFinite(r) || !Number.isFinite(c.materialSec)) return null;
        suma += r * c.materialSec;
    }

    if (!Number.isFinite(faltaClaseMs)) return lista.length ? suma : null;
    return Math.round(faltaClaseMs + suma);
}
