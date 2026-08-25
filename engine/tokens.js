'use strict';
/**
 * tokens.js — Cuánto le costó al proveedor pensar una clase.
 *
 * Cada proveedor informa su uso con otro nombre y otra forma —Ollama devuelve
 * `prompt_eval_count`/`eval_count`, Anthropic `usage.input_tokens`, el Cursor
 * CLI `usage.inputTokens` más dos cubetas de caché—, así que el resto del motor
 * no habla ninguno de esos idiomas: los tres traducen a esta forma y acá se
 * suma.
 *
 * Que un proveedor informe o no NO se declara: se mide. `consultas` cuenta
 * cuántas preguntas se hicieron y `conUso` cuántas trajeron números; si la
 * segunda es cero, la interfaz dice que ese proveedor no informa en vez de
 * mostrar un 0 que se lee como "no gastó nada". Con eso, el día que un CLI
 * cambie de versión y deje de traer `usage`, la app se entera sola.
 *
 * Las dos cubetas de caché van aparte y no sumadas a la entrada porque no
 * cuestan lo mismo —leer de caché es una fracción de escribirla—, pero al
 * total sí entran: son tokens que el proveedor procesó. Medido contra el
 * Cursor CLI, el prompt del sistema del propio CLI son ~31k tokens de
 * escritura de caché por consulta, así que ignorarlas mostraría 11 tokens
 * donde de verdad hubo 31.365.
 */

/** Un contador nuevo, en cero y sin saber todavía si el proveedor informa. */
function contador() {
    return {
        consultas: 0,
        conUso: 0,
        entrada: 0,
        salida: 0,
        cacheLectura: 0,
        cacheEscritura: 0
    };
}

function numero(valor) {
    const n = Number(valor);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

/**
 * Anota una consulta. `uso` puede ser null: la consulta se cuenta igual, que es
 * justo lo que permite distinguir "no gastó" de "no informa".
 *
 * @param {object} c contador
 * @param {{entrada?:number, salida?:number, cacheLectura?:number, cacheEscritura?:number}|null} uso
 */
function sumar(c, uso) {
    if (!c) return c;
    c.consultas++;
    if (!uso) return c;
    c.conUso++;
    c.entrada += numero(uso.entrada);
    c.salida += numero(uso.salida);
    c.cacheLectura += numero(uso.cacheLectura);
    c.cacheEscritura += numero(uso.cacheEscritura);
    return c;
}

/** Una copia congelada, para poder restar dos momentos. */
function instantanea(c) {
    return { ...(c || contador()) };
}

/** Lo que se gastó ENTRE dos instantáneas: el uso de una clase dentro de la corrida. */
function diferencia(antes, despues) {
    const a = antes || contador();
    const b = despues || contador();
    return {
        consultas: Math.max(0, b.consultas - a.consultas),
        conUso: Math.max(0, b.conUso - a.conUso),
        entrada: Math.max(0, b.entrada - a.entrada),
        salida: Math.max(0, b.salida - a.salida),
        cacheLectura: Math.max(0, b.cacheLectura - a.cacheLectura),
        cacheEscritura: Math.max(0, b.cacheEscritura - a.cacheEscritura)
    };
}

/**
 * Lo que se muestra.
 *
 * `informa` es lo único que decide si se enseña un número: sin consultas no hay
 * nada que decir, y con consultas pero sin uso el proveedor no lo cuenta.
 */
function totales(c) {
    const x = c || contador();
    const entrada = x.entrada + x.cacheLectura + x.cacheEscritura;
    return {
        consultas: x.consultas,
        informa: x.consultas > 0 && x.conUso > 0,
        // Que informe algunas y otras no es un caso real: una consulta que falla
        // no trae uso. Se dice, para que un número bajo no se lea como barato.
        parcial: x.consultas > 0 && x.conUso > 0 && x.conUso < x.consultas,
        entrada,
        salida: x.salida,
        cacheLectura: x.cacheLectura,
        cacheEscritura: x.cacheEscritura,
        total: entrada + x.salida
    };
}

/** Suma dos contadores (la corrida entera a partir de las clases). */
function juntar(a, b) {
    const x = a || contador();
    const y = b || contador();
    return {
        consultas: x.consultas + y.consultas,
        conUso: x.conUso + y.conUso,
        entrada: x.entrada + y.entrada,
        salida: x.salida + y.salida,
        cacheLectura: x.cacheLectura + y.cacheLectura,
        cacheEscritura: x.cacheEscritura + y.cacheEscritura
    };
}

module.exports = { contador, sumar, instantanea, diferencia, totales, juntar };
