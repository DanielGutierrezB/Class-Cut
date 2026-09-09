'use strict';
/**
 * temario.js — Lo que el CD pidió que la clase cubra, y si se cubrió.
 *
 * El director de contenido entrega una lista de temas antes de grabar: "esto
 * tiene que quedar dicho". Hasta ahora eso vivía en un mail y se comprobaba
 * mirando la clase terminada, que es cuando ya no se puede arreglar. Acá se
 * comprueba MIENTRAS se graba, y por eso lo único que importa de este archivo es
 * que sea rápido de leer en pantalla: los objetivos que faltan son lo que el
 * profesor todavía tiene que decir.
 *
 * **Se mide con un modelo y no buscando palabras**, y esa es la razón de que
 * exista el archivo en vez de un `includes`. Un objetivo como "explicar por qué
 * conviene dar contexto acotado" queda cubierto por "si le das demasiado, el
 * modelo se pierde y toca cosas que nadie le pidió", donde no aparece ni
 * "contexto" ni "acotado". Buscar palabras da la respuesta contraria a la buena
 * justo en los casos que importan. Igual queda el respaldo por palabras
 * (`porPalabras`), pero se muestra diciendo que es una aproximación: es para
 * cuando no hay proveedor, no para ahorrarse la consulta.
 *
 * **Nada de acá decide cuándo se llama al modelo**: eso es `hayQueMedir`, que es
 * una comparación de huellas y se prueba sola. El latido lo pone
 * `grabacion.js`, en el cierre de una toma.
 *
 * Sin estado, sin disco y sin DOM: todo se prueba en `tests/temario.test.js`.
 */

const { norm } = require('./texto');

/**
 * Cuántos objetivos se aceptan de una lista pegada.
 *
 * No es un límite de diseño sino de sensatez: cuarenta objetivos ya no son el
 * temario de una clase, son el del curso, y medir contra ellos deja el panel
 * lleno de rojo que no significa nada. Lo que sobra se corta y se dice.
 */
const MAXIMO = 40;

/** Un objetivo más largo que esto es un párrafo mal partido: se recorta. */
const LARGO_MAXIMO = 300;

/**
 * Lo que se le saca al principio de un renglón para quedarse con el tema.
 *
 * Viñetas de todos los sabores porque lo que llega es un pegado de Notion, de
 * Google Docs o de WhatsApp, y cada uno usa la suya. Los números van con uno o
 * dos dígitos y con punto, paréntesis o guion detrás, que es como se numera un
 * temario; con más dígitos ya no es una numeración —"2024 - el año que…" no es
 * el objetivo 20— y por eso el límite está en dos.
 */
const VINETA = /^\s*(?:[-–—*•·]+\s*|\d{1,2}\s*[.)\-–]\s+|\(\d{1,2}\)\s*|[a-zA-Z]\s*[.)]\s+)/;

/** Un renglón que solo anuncia la lista ("Objetivos de la clase:") no es un tema. */
const ENCABEZADO = /^[^.!?]{0,60}:$/;

/**
 * Con cuánto de sus palabras se da por cubierto un objetivo en el respaldo por
 * palabras. Es a propósito exigente: el respaldo se muestra como aproximación, y
 * una aproximación que dice "cubierto" de más es peor que una que se calla.
 */
const PARECIDO_MINIMO = 0.6;

/** Palabras que están en cualquier frase y no dicen de qué habla un objetivo. */
const VACIAS = new Set(['para', 'como', 'cuando', 'donde', 'sobre', 'entre', 'porque',
    'este', 'esta', 'esto', 'estos', 'estas', 'todo', 'toda', 'todos', 'todas',
    'que', 'del', 'los', 'las', 'una', 'uno', 'con', 'por', 'sus', 'sin', 'mas',
    'debe', 'tiene', 'hacer', 'poder', 'ser', 'estar', 'clase', 'alumno', 'alumnos',
    'explicar', 'mostrar', 'entender', 'ver', 'saber', 'contar']);

const SYSTEM = 'Sos el director de contenido de un curso grabado y estás mirando la clase ' +
    'mientras se graba, con la lista de temas que pediste en la mano. Decís qué quedó dicho ' +
    'y qué falta, sin adornos. Respondés SIEMPRE solo JSON válido, en español.';

const DEFAULTS = {
    // Cuánto se le deja contestar. Cada objetivo son unas cuarenta palabras de
    // respuesta —si está cubierto, en qué toma y una línea de por qué—, así que
    // el techo crece con la lista en vez de ser un número fijo que la corta a
    // la mitad cuando el temario es largo.
    porObjetivo: 90,
    base: 160
};

/* ─── La lista, tal como la pegan ───────────────────────────────────────── */

/**
 * Parte el texto pegado en objetivos.
 *
 * Tolerante a propósito, porque no hay un formato: llega con guiones, con
 * viñetas, numerado, un renglón por tema, o un párrafo entero de corrido. Pedir
 * un formato sería pedirle al CD que reescriba su lista para que la app la
 * entienda, y entonces nadie la pega.
 *
 * El orden es el que trajo la lista y no se toca: el CD la escribió en el orden
 * en que espera que la clase avance, y renumerarla le saca ese dato.
 *
 * @param {string} texto lo pegado, crudo
 * @returns {Array} [{n, texto}] con `n` desde 1
 */
function partir(texto) {
    const crudo = String(texto == null ? '' : texto);
    let renglones = crudo.split(/\r?\n/);

    // Un párrafo de corrido: no hay renglones que partir, así que se parte por
    // lo que sí separa temas dentro de una línea. Las viñetas primero —un `•` no
    // aparece nunca dentro de una palabra—, después el punto y coma, y recién al
    // final el punto. El guion NO entra acá: en una sola línea es tan probable
    // que sea un separador como parte de "spec-driven" o de un rango.
    if (renglones.filter(r => r.trim()).length === 1) {
        const linea = renglones.find(r => r.trim()) || '';
        for (const corte of [/\s*[•·]\s*/, /\s*;\s*/, /(?<=[.!?])\s+/]) {
            const partes = linea.split(corte).filter(p => p.trim());
            if (partes.length > 1) { renglones = partes; break; }
        }
    }

    const limpios = [];
    const vistos = new Set();

    for (const renglon of renglones) {
        const sinVineta = renglon.replace(VINETA, '').trim();
        if (!sinVineta) continue;
        // El punto final de un tema no es parte del tema.
        const tema = sinVineta.replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim();
        if (!tema) continue;
        if (ENCABEZADO.test(sinVineta)) continue;

        // Lo mismo dos veces es un pegado con la lista repetida, no dos
        // objetivos: medir el segundo cuesta lo mismo y no dice nada nuevo.
        const clave = norm(tema);
        if (!clave || vistos.has(clave)) continue;
        vistos.add(clave);

        limpios.push(tema.slice(0, LARGO_MAXIMO));
        if (limpios.length >= MAXIMO) break;
    }

    return limpios.map((tema, i) => ({ n: i + 1, texto: tema }));
}

/* ─── Cuándo medir ──────────────────────────────────────────────────────── */

/**
 * Las tomas que cuentan para la cobertura: las que quedan y ya se cerraron.
 *
 * Una descartada no cuenta —es justo lo que significa descartarla— y la abierta
 * tampoco: su texto es el del ciclo liviano, que es el descartable, y va a
 * cambiar entero cuando la toma cierre y se relea con el modelo grande. Medir
 * contra él sería medir contra un texto que no va a existir.
 */
function tomasQueCuentan(tomas) {
    return (tomas || []).filter(t =>
        t && !t.descartada && t.outMs != null && (t.palabras || []).length);
}

/**
 * La huella de lo que hay para medir. Si no cambió, la medición sigue valiendo.
 *
 * Lleva el largo del texto de cada toma y no solo su id porque una toma cerrada
 * cambia dos veces más: cuando se la relee con el modelo grande y cuando se le
 * mueve un borde. Con solo los ids, la primera medición se hacía contra el texto
 * descartable del ciclo liviano y no se rehacía nunca.
 *
 * Y lleva los objetivos porque cambiar la lista invalida la medición entera:
 * pegar una lista nueva tiene que volver a medir aunque no haya tomas nuevas.
 */
function huella(objetivos, tomas) {
    const temas = (objetivos || []).map(o => norm(o.texto)).join('|');
    const dichas = tomasQueCuentan(tomas)
        .map(t => `${t.id}:${t.palabras.length}`)
        .join(',');
    return `${temas}##${dichas}`;
}

/**
 * ¿Hace falta llamar al modelo ahora?
 *
 * **El latido es el cierre de una toma, no la palabra.** El usuario pidió que se
 * validara "constantemente", y una consulta por palabra transcripta es una
 * consulta cada trescientos milisegundos. Al cerrar una toma, en cambio, hay
 * texto NUEVO, ESTABLE —lo acaba de releer el modelo grande— y con sentido
 * completo, que es lo único contra lo que se puede decidir si un tema quedó
 * dicho. Entre toma y toma la respuesta no puede cambiar, así que consultar de
 * nuevo sería pagar por la misma respuesta.
 *
 * Esto decide CADA CUÁNTO se puede preguntar; si en este momento se puede
 * preguntar, no. Eso es de `engine/gpu.js` y lo consulta `atenderTemario`: bajar
 * la frecuencia fue durante un tiempo la respuesta de este archivo a la GPU
 * ocupada por Whisper, y era la respuesta equivocada —menos seguido sigue siendo
 * pelearla—.
 *
 * `midiendo` es lo que protege de las llamadas encimadas: si mientras se mide se
 * cierra otra toma, esta contesta que no y quien llama vuelve a preguntar al
 * terminar, con la huella ya movida (ver `atenderTemario` en `grabacion.js`).
 *
 * @param {object} params { objetivos, tomas, cobertura, midiendo }
 */
function hayQueMedir(params) {
    const p = params || {};
    if (p.midiendo) return false;
    if (!(p.objetivos || []).length) return false;
    // Sin ninguna toma cerrada no hay nada que leer: la respuesta es "no se
    // cubrió nada" y sale de contar, no de preguntar.
    if (!tomasQueCuentan(p.tomas).length) return false;
    const ahora = huella(p.objetivos, p.tomas);
    return !p.cobertura || p.cobertura.huella !== ahora;
}

/* ─── Lo que se le pregunta al modelo ───────────────────────────────────── */

function textoDeToma(toma) {
    return (toma.palabras || []).map(w => w.texto).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * El prompt: los objetivos numerados y lo que se dijo, por toma.
 *
 * **Se le pide la TOMA y no un sí o un no**, y es lo que convierte el panel en
 * algo accionable: "el objetivo 3 quedó cubierto en la toma 7" se puede ir a
 * mirar, y si la toma 7 después se descarta, se sabe qué se perdió. Un semáforo
 * sin la toma obliga a buscar a mano en veinte transcripciones cuál era.
 *
 * Va la clase entera y no las últimas tomas: un objetivo puede haber quedado
 * cubierto en la primera toma, y preguntando solo por lo último la cobertura se
 * borraría sola a medida que la clase avanza. Son unas pocas miles de palabras,
 * que entran de sobra en cualquiera de los tres proveedores.
 */
function armarPrompt(objetivos, tomas) {
    const cuentan = tomasQueCuentan(tomas);
    const temas = objetivos.map(o => `[${o.n}] ${o.texto}`).join('\n');
    const dicho = cuentan.map(t => `TOMA ${t.id}: ${textoDeToma(t)}`).join('\n\n');

    return `Esta clase se está grabando AHORA. Estos son los temas que pediste que cubra:

OBJETIVOS:
${temas}

Y esto es todo lo que el profesor dijo hasta este momento, toma por toma. Las tomas descartadas ya no están en la lista:

${dicho}

Para cada objetivo decidí si YA quedó cubierto por lo que se dijo, y en qué toma.

Cubierto quiere decir que el alumno que vea la clase se va a llevar ese tema explicado, aunque el profesor no haya usado las mismas palabras del objetivo: lo que se compara son las ideas, no las palabras. Mencionarlo al pasar o prometer que se va a ver más adelante NO es cubrirlo.

Si un objetivo no está cubierto, ponelo en false: lo que falta es la información que hace falta, y decir que está cubierto cuando no lo está deja al profesor terminando la clase sin ese tema.

Usá solo los números de toma que aparecen arriba. Contestá por TODOS los ${objetivos.length} objetivos.

Responde solo JSON:
{"objetivos": [{"n": <número del objetivo>, "cubierto": <true|false>, "toma": <número de la toma donde quedó dicho, o null si no está cubierto>, "porque": "<en qué quedó dicho, o qué falta, en una frase corta>"}]}`;
}

/* ─── Lo que vuelve, validado ───────────────────────────────────────────── */

/**
 * Valida la respuesta del modelo contra los objetivos y las tomas que existen.
 *
 * Es la parte que no se puede saltear: el proveedor puede ser un modelo local de
 * cuatro mil millones de parámetros, y devuelve objetivos que no están en la
 * lista, tomas que no existen y `cubierto` como la cadena "sí". El panel corre
 * en medio de una grabación y no puede romperse por eso.
 *
 * **Lo que no se entiende se cuenta como NO cubierto**, nunca al revés. Un falso
 * "falta" cuesta una mirada al transcript; un falso "cubierto" cuesta que la
 * clase termine sin el tema, que es lo que esto vino a evitar. Por lo mismo, una
 * toma inventada no tira la cobertura del objetivo: se deja cubierto sin toma,
 * porque el modelo puede haber leído bien y numerado mal.
 *
 * @returns {Array|null} los objetivos medidos, o null si no llegó ni uno válido
 */
function validar(bruto, objetivos, tomas) {
    const lista = objetivos || [];
    if (!lista.length) return null;

    const crudos = bruto && Array.isArray(bruto.objetivos) ? bruto.objetivos : [];
    const idsDeToma = new Set(tomasQueCuentan(tomas).map(t => t.id));
    const porNumero = new Map();

    for (const item of crudos) {
        if (!item || typeof item !== 'object') continue;
        const n = parseInt(item.n, 10);
        if (!lista.some(o => o.n === n) || porNumero.has(n)) continue;

        // Solo el booleano de verdad. Un modelo chico contesta "sí", "true" o 1,
        // y `Boolean("no")` es `true`: aceptar cualquier cosa verdadera daba
        // objetivos cubiertos porque el modelo había escrito que no lo estaban.
        const cubierto = item.cubierto === true;
        const toma = parseInt(item.toma, 10);
        porNumero.set(n, {
            cubierto,
            toma: cubierto && idsDeToma.has(toma) ? toma : null,
            porque: String(item.porque == null ? '' : item.porque).trim().slice(0, 240) || null
        });
    }

    if (!porNumero.size) return null;

    // Los objetivos que el modelo no contestó quedan sin cubrir y sin motivo: no
    // se puede inventar el dato y tampoco esconder el objetivo.
    return lista.map(o => {
        const medido = porNumero.get(o.n) || { cubierto: false, toma: null, porque: null };
        return { n: o.n, texto: o.texto, ...medido };
    });
}

/** El resumen que la pantalla dibuja, con la cuenta ya hecha. */
function armarCobertura(medidos, como, extra) {
    const cubiertos = medidos.filter(o => o.cubierto).length;
    return {
        como,
        medidoEn: new Date().toISOString(),
        cubiertos,
        faltan: medidos.length - cubiertos,
        objetivos: medidos,
        ...(extra || {})
    };
}

/* ─── El respaldo, cuando no hay modelo ─────────────────────────────────── */

/** Las palabras de un objetivo que de verdad dicen de qué habla. */
function palabrasClave(texto) {
    return new Set(String(texto).split(/\s+/)
        .map(norm)
        .filter(p => p.length >= 4 && !VACIAS.has(p)));
}

/**
 * Cobertura por coincidencia de palabras, para cuando no hay proveedor.
 *
 * No es lo mismo que medir y no pretende serlo: un objetivo cubierto con otras
 * palabras acá sale como faltante. Existe porque la alternativa —el panel en
 * blanco— deja al editor sin nada, y porque una lista de "estas palabras no
 * aparecieron nunca" sigue siendo útil. Quien la dibuja tiene que decir en
 * pantalla que es una aproximación (`como: 'palabras'`).
 */
function porPalabras(objetivos, tomas) {
    const cuentan = tomasQueCuentan(tomas);
    const dichoPorToma = cuentan.map(t => ({
        id: t.id,
        palabras: new Set(textoDeToma(t).split(/\s+/).map(norm).filter(Boolean))
    }));

    const medidos = (objetivos || []).map(o => {
        const clave = palabrasClave(o.texto);
        if (!clave.size) return { n: o.n, texto: o.texto, cubierto: false, toma: null, porque: null };

        let mejor = { parte: 0, toma: null };
        for (const toma of dichoPorToma) {
            let juntas = 0;
            for (const p of clave) if (toma.palabras.has(p)) juntas++;
            const parte = juntas / clave.size;
            if (parte > mejor.parte) mejor = { parte, toma: toma.id };
        }

        const cubierto = mejor.parte >= PARECIDO_MINIMO;
        return {
            n: o.n,
            texto: o.texto,
            cubierto,
            toma: cubierto ? mejor.toma : null,
            porque: cubierto
                ? `Aparecen ${Math.round(mejor.parte * 100)}% de sus palabras en la toma ${mejor.toma}.`
                : 'No aparecen sus palabras en lo que se dijo.'
        };
    });

    return armarCobertura(medidos, 'palabras');
}

/* ─── La medición ───────────────────────────────────────────────────────── */

/**
 * Mide la cobertura del temario contra lo grabado hasta ahora.
 *
 * No lanza nunca: la medición corre en medio de una grabación y su fallo no
 * puede llevarse por delante la sesión. Contesta `{cobertura}` o `{error}`, y el
 * error se dice en pantalla tal cual — decir "no se pudo medir" es mejor que
 * dibujar un porcentaje que nadie calculó.
 *
 * @param {object} params { objetivos, tomas, ai, signal }
 * @returns {Promise<{cobertura?:object, error?:string}>}
 */
async function medir(params) {
    const p = params || {};
    const objetivos = p.objetivos || [];
    const marca = huella(objetivos, p.tomas);

    if (!objetivos.length) return { error: 'No hay objetivos contra los que medir.' };
    if (!tomasQueCuentan(p.tomas).length) return { error: 'Todavía no hay ninguna toma cerrada.' };

    if (!p.ai) {
        return {
            error: 'No hay un modelo disponible para medir la cobertura.',
            cobertura: { ...porPalabras(objetivos, p.tomas), huella: marca }
        };
    }

    const respuesta = await p.ai.ask({
        system: SYSTEM,
        prompt: armarPrompt(objetivos, p.tomas),
        numPredict: DEFAULTS.base + objetivos.length * DEFAULTS.porObjetivo,
        signal: p.signal
    });

    if (respuesta && respuesta.error) return { error: respuesta.error };

    const medidos = validar(respuesta, objetivos, p.tomas);
    if (!medidos) return { error: 'El modelo contestó algo que no se pudo leer.' };

    return {
        cobertura: {
            ...armarCobertura(medidos, 'ia', { modelo: p.ai.model || null }),
            huella: marca
        }
    };
}

module.exports = {
    partir,
    huella,
    hayQueMedir,
    tomasQueCuentan,
    armarPrompt,
    validar,
    porPalabras,
    medir,
    SYSTEM,
    MAXIMO,
    LARGO_MAXIMO,
    PARECIDO_MINIMO,
    DEFAULTS
};
