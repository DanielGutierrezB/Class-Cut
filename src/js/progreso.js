'use strict';
/**
 * progreso.js — Cuánto va de la corrida, de 0 a 1.
 *
 * Antes esto era una tira de nueve pastillas de dos letras (`Re Tr Al Af…`) y
 * no comunicaba nada: nadie puede saber que `Rp` es "arreglando lo que no
 * cierra". Lo que hace falta es una barra normal y un renglón que diga qué está
 * pasando, y eso obliga a contestar la pregunta que las pastillas esquivaban:
 * **cuánto vale cada etapa**.
 *
 * Medido sobre seis clases de entre 17 y 35 minutos (Whisper local + Cursor
 * CLI), sumando 884,9 s de proceso sobre 7953 s de material:
 *
 *     transcribir  234,2 s   26,5%
 *     afinar       188,0 s   21,3%
 *     revisar      366,8 s   41,5%
 *     repasar       94,8 s   10,7%
 *     las otras      0,3 s    0,0%
 *
 * O sea que cuatro etapas son el 100% del tiempo y las otras cinco, juntas, no
 * llegan al 0,05%. Una barra repartida en novenos saltaría cinco novenos en un
 * pestañeo y después se quedaría clavada minutos: exactamente la sensación de
 * colgado que hay que sacar. Por eso se reparte por costo.
 *
 * Seis clases y no una porque cada etapa varía muchísimo entre clases: afinar
 * fue de 7,7 s a 116,3 s, y revisar de 12,6 s a 100,3 s. Con una sola medición
 * la tabla habría quedado pegada a esa clase.
 *
 * Nada de acá toca el DOM.
 */

/** El orden real del pipeline (`engine/pipeline.js`, STAGES). */
export const ORDEN = ['reusar', 'transcribir', 'alinear', 'afinar', 'despegar', 'revisar', 'repasar', 'cortar', 'exportar'];

/**
 * Cuánto cuesta cada etapa, en unidades relativas. Salen de la medición de
 * arriba, redondeadas: la precisión acá es falsa, lo que importa es el orden de
 * magnitud entre "esto tarda minutos" y "esto no se ve".
 *
 * Las baratas no van en cero: una etapa sin peso no mueve NADA la barra al
 * pasarla, y aunque duren 20 ms conviene que se vea el pasito. Con este piso,
 * las cinco rápidas juntas mueven la barra un 1,5%.
 */
export const COSTO = {
    reusar: 0.3,
    transcribir: 26,
    alinear: 0.3,
    afinar: 21,
    despegar: 0.3,
    revisar: 42,
    // Arreglar lo que no cierra corrió largo en una de las seis clases: 94,8 s
    // contra 7 ms en las otras cinco. Es la etapa más caprichosa que hay —sólo
    // trabaja si el modelo encontró algo que se puede arreglar solo, y entonces
    // vuelve a leer la clase entera, que cuesta como leerla la primera vez—,
    // así que el 11% no es "lo que suele tardar" sino lo que le tocó del total.
    // Se le deja ese lugar a propósito: con el 0,3% que le daba la primera
    // medición, la barra llegaba al 100% y se quedaba ahí dos minutos y medio
    // con el proceso todavía andando.
    repasar: 11,
    cortar: 0.3,
    exportar: 0.3
};

/**
 * Milisegundos por segundo de material, para saber cuánto va a tardar algo
 * ANTES de haber medido nada en esta máquina.
 *
 * 884,9 s de proceso sobre 7953 s de material, en las mismas seis clases. Es
 * semilla y nada más —depende del modelo de Whisper, del proveedor de criterio
 * y de la máquina—, así que en cuanto la corrida termina una clase se usa lo
 * medido. La misma clase de 17 minutos tardó 102 s una vez y 186 s otra, con
 * todo igual salvo cuánto tardó en contestar el proveedor: por eso esto sirve
 * para que la barra tenga con qué avanzar en la primera clase, y el "faltan ~X
 * min" NO lo usa, porque ahí sería una mentira con cara de dato.
 */
export const RITMO_SEMILLA = { desdeCero: 111 };

/**
 * Cuánto más barata es una clase que reusa su transcript.
 *
 * Sale de la tabla en vez de ser otra constante, para que las dos no puedan
 * separarse: reusar es exactamente ahorrarse la transcripción. Está nombrado
 * porque es fácil suponer que reusar es gratis, y no lo es ni de lejos — al
 * modelo hay que consultarlo igual, y eso es casi las tres cuartas partes.
 */
export const FACTOR_REUSO = 1 - COSTO.transcribir / Object.values(COSTO).reduce((s, v) => s + v, 0);

/**
 * Hasta dónde puede llegar una clase que todavía está trabajando.
 *
 * Ninguna estimación puede decir "terminó": eso lo dice el motor y nada más.
 * Sin este techo, una etapa que tarda mucho más de lo previsto —repasar, que
 * puede pasar de 7 ms a un minuto y medio— empuja la cuenta hasta el 100% y la
 * barra se queda llena mientras el proceso sigue, que es la única forma de que
 * una barra de progreso quede peor que no tenerla.
 */
export const TECHO = 0.99;

/** Pasa {etapa: loQueSea} a fracciones que suman 1. */
function normalizar(valores) {
    const total = ORDEN.reduce((s, e) => s + Math.max(0, valores[e] || 0), 0);
    if (!total) return Object.fromEntries(ORDEN.map(e => [e, 1 / ORDEN.length]));
    return Object.fromEntries(ORDEN.map(e => [e, Math.max(0, valores[e] || 0) / total]));
}

/**
 * Los pesos de una clase, sumando 1.
 *
 * Lo medido no PISA la tabla: se mezcla con ella contándola como una clase más.
 * Reemplazarla directamente parece lo correcto y salió mal en una corrida de
 * verdad: la primera clase no necesitó arreglar nada, repasar midió 7 ms, y con
 * eso la etapa quedó valiendo cero para la segunda — que sí tuvo que arreglar y
 * se tomó 92 segundos con la barra clavada, porque no le quedaba lugar por
 * dónde avanzar. Hay etapas que o no corren o cuestan un minuto, y una sola
 * medición no distingue "es barata" de "esta vez no le tocó". Mezclando, la
 * tabla pierde influencia a medida que hay clases medidas, que es lo que se
 * quería, pero ninguna etapa se queda sin lugar por una sola muestra.
 *
 * @param {boolean} transcribe si esta clase va a pasar por Whisper
 * @param {object} [medidos] {etapa: msTotales} de clases ya terminadas del
 *   MISMO tipo de trabajo
 * @param {number} [clasesMedidas] cuántas clases hay detrás de `medidos`
 */
export function pesos(transcribe, medidos, clasesMedidas) {
    const semilla = normalizar(COSTO);
    const n = Math.max(0, clasesMedidas || 0);
    const hayMedidos = n > 0 && Boolean(medidos) && ORDEN.some(e => medidos[e] > 0);

    const medido = hayMedidos ? normalizar(medidos) : null;
    const crudos = {};
    for (const etapa of ORDEN) {
        const share = medido
            ? (semilla[etapa] + medido[etapa] * n) / (1 + n)
            : semilla[etapa];
        crudos[etapa] = etapa === 'transcribir' && !transcribe ? 0 : share;
    }
    return normalizar(crudos);
}

/**
 * Cuánto va de una etapa que no informa porcentaje, de 0 a 1.
 *
 * Hace falta porque la etapa MÁS CARA es justo la más callada: leer la clase
 * entera se llevó hasta 113 segundos y, cuando el proveedor tiene contexto
 * grande, el guion entra en una sola llamada y avisa una vez sola, al final.
 * Con eso la barra se congelaría dos minutos en el 41% de la corrida — el mismo
 * defecto que se está arreglando, movido de lugar.
 *
 * La curva es lineal hasta 0,9 mientras la etapa dure lo esperado, y de ahí en
 * más se acerca a 1 sin llegar nunca. Que nunca llegue es a propósito: la barra
 * no puede decir que una etapa terminó antes de que el motor lo diga. Y que
 * nunca se detenga también: mientras siga moviéndose, sigue diciendo la verdad
 * —"esto está vivo"— aunque la estimación esté errada al doble.
 */
export function avance(ms, esperadoMs) {
    if (!Number.isFinite(ms) || !Number.isFinite(esperadoMs) || esperadoMs <= 0) return 0;
    const t = Math.max(0, ms) / esperadoMs;
    if (t <= 1) return 0.9 * t;
    // El techo es porque la exponencial, en coma flotante, llega a 1 exacto
    // pasado un factor 40 de error — y ahí la barra estaría afirmando que la
    // etapa terminó. Mejor quedarse pegado a un pelo del borde.
    return Math.min(0.999, 1 - 0.1 * Math.exp(-(t - 1)));
}

/**
 * Qué fracción de una clase va, de 0 a 1.
 *
 * Las etapas anteriores cuentan enteras por su posición en el orden y no por
 * haber avisado que terminaron: hay etapas que no corren nunca —sin transcript
 * no hay nada que afinar ni que leer— y esperarlas dejaría la barra corta hasta
 * un salto final. Con la posición, saltearse una la da por cumplida al pasarla,
 * que es lo que de verdad pasó.
 *
 * @param {object} p { etapa, percent, msDesdeAviso, esperadoClaseMs, transcribe, medidos, clasesMedidas }
 */
export function fraccionDeClase(p) {
    const { etapa, percent, msDesdeAviso, esperadoClaseMs, transcribe, medidos, clasesMedidas } = p || {};
    const indice = ORDEN.indexOf(etapa);
    if (indice === -1) return 0;

    const w = pesos(transcribe, medidos, clasesMedidas);
    let antes = 0;
    for (let i = 0; i < indice; i++) antes += w[ORDEN[i]];

    // El último aviso es el piso, y desde ahí sigue el reloj sobre lo que le
    // queda a la etapa. No el mayor de los dos: afinar informa cada 20% pero de
    // a tirones —dos avisos juntos y después dieciséis segundos de nada—, y
    // comparándolos el reloj tardaba todo ese rato en alcanzar al aviso viejo,
    // con la barra quieta mientras tanto. Arrancando desde el aviso, cada dato
    // real corrige la posición y el reloj se encarga del silencio que sigue.
    const porAviso = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) / 100 : 0;
    const esperadoEtapa = Number.isFinite(esperadoClaseMs) ? esperadoClaseMs * w[etapa] : null;
    const restante = esperadoEtapa == null ? null : esperadoEtapa * (1 - porAviso);
    const dentro = porAviso + (1 - porAviso) * avance(msDesdeAviso, restante);

    return Math.min(TECHO, antes + w[etapa] * dentro);
}

/**
 * Cuánto se espera que tarde una clase, en milisegundos.
 *
 * Con ritmo medido en esta corrida, del ritmo. Sin él, de la semilla: es una
 * aproximación, pero es la que le permite a la barra moverse durante la PRIMERA
 * clase, que es cuando no hay absolutamente nada medido y es cuando más se
 * mira.
 */
export function esperadoDeClase(materialSec, transcribe, ritmoMs) {
    const material = Number.isFinite(materialSec) && materialSec > 0 ? materialSec : 0;
    if (!material) return null;
    const porSegundo = Number.isFinite(ritmoMs) && ritmoMs > 0
        ? ritmoMs
        : RITMO_SEMILLA.desdeCero * (transcribe ? 1 : FACTOR_REUSO);
    return material * porSegundo;
}

/**
 * Cuánto pesa una clase dentro de la corrida, para repartir la barra.
 *
 * Es el mismo esperado, con piso: una clase sin duración conocida no puede
 * valer cero, o desaparecería de la barra y terminarla no la movería nada.
 */
export function costoDeClase(materialSec, transcribe, ritmoMs) {
    return esperadoDeClase(materialSec, transcribe, ritmoMs) || 1000;
}

/**
 * Qué fracción de la corrida entera va, de 0 a 1.
 *
 * Se pondera por costo y no por cantidad de clases: con doce clases que reusan
 * y una que se transcribe entera, "1 de 13" no describe en absoluto cuánto
 * falta.
 *
 * @param {Array<{estado:string, costo:number, fraccion:number}>} filas
 */
export function fraccionDeCorrida(filas) {
    const lista = filas || [];
    const total = lista.reduce((s, f) => s + (f.costo || 0), 0);
    if (!total) return 0;

    const hecho = lista.reduce((s, f) => {
        if (f.estado === 'listo') return s + f.costo;
        if (f.estado === 'trabajando') return s + f.costo * Math.min(1, Math.max(0, f.fraccion || 0));
        return s;
    }, 0);
    return Math.min(1, hecho / total);
}

/**
 * Los milisegundos medidos por etapa, juntando varias clases.
 *
 * Es lo que le permite a `pesos` dejar de creerle a la tabla. Se suman los
 * totales en vez de promediar por clase para que una clase larga pese lo que
 * pesa.
 *
 * @param {Array<Array<{etapa:string, ms:number}>>} etapasPorClase
 */
export function medir(etapasPorClase) {
    const suma = {};
    for (const etapas of etapasPorClase || []) {
        for (const e of etapas || []) {
            if (!ORDEN.includes(e.etapa)) continue;
            suma[e.etapa] = (suma[e.etapa] || 0) + (e.ms || 0);
        }
    }
    return suma;
}
