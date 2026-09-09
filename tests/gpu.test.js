'use strict';
/**
 * La política de "no le pelees la GPU al Whisper de las señales".
 *
 * El panel de análisis le pregunta cosas a un modelo mientras la clase se graba,
 * y con el proveedor local eso es la misma GPU que está usando el Whisper que
 * decide dónde arrancan y dónde terminan las tomas. Abstenerse es la decisión
 * tomada; medir al terminar es la otra mitad, sin la cual abstenerse sería
 * perder la medición.
 *
 * **El grupo que más importa es el tercero.** El criterio estaba escrito tres
 * veces con tres redacciones y una de las tres —la cobertura del temario— se
 * había resuelto de otra manera, así que con un Ollama configurado la validación
 * del temario le peleaba la GPU a la clase que estaba validando. Nadie lo
 * decidió: se escribieron en paralelo y ninguna vio a la otra. Lo que fija ese
 * grupo es que el veto viva en el MECANISMO, para que un medidor nuevo lo herede
 * sin tener que acordarse de él, y que ningún módulo que consulte un modelo con
 * la sesión viva pueda saltearlo sin que esto se ponga en rojo.
 *
 * Nada de acá levanta un modelo ni lee los Ajustes de la Mac en que corre: el
 * proveedor se pasa a mano, que es para lo que `conModelo` y `cerrar` lo aceptan.
 */

const fs = require('fs');
const path = require('path');

const gpu = require('../engine/gpu');
const medirToma = require('../engine/medir-toma');

const MOTOR = path.join(__dirname, '..', 'engine');
const BASE = Date.UTC(2026, 8, 8, 13, 0, 0);

/** Una toma cerrada, con lo mínimo que mira el mecanismo. */
function toma(id) {
    return { id, descartada: false, inMs: BASE + id * 60000, outMs: BASE + id * 60000 + 50000, palabras: [] };
}

/**
 * Un medidor recién inventado: no sabe que la regla existe.
 *
 * Es a propósito que sea el más tonto posible. Lo que se prueba es que un
 * medidor que no hace nada por abstenerse se abstenga igual, que es la única
 * forma de que el criterio siga valiendo cuando alguien agregue el tercero.
 */
function medidorNuevo(preguntadas) {
    return {
        clave: 'nuevo',
        medir: () => ({ algo: 1 }),
        conModelo: async ({ toma: t }) => {
            preguntadas.push(t.id);
            return { hallazgos: [] };
        }
    };
}

/** Un cliente de mentira: contesta y ya. Si se lo usa, es que se consultó. */
const CLIENTE = { ask: async () => ({ hallazgos: [] }) };

/** El texto de un módulo del motor. */
function fuente(archivo) {
    return fs.readFileSync(path.join(MOTOR, archivo), 'utf8');
}

/**
 * Los módulos del motor a los que se llega desde uno, siguiendo sus `require`.
 *
 * Es la definición de "esto puede correr con una grabación en curso": lo que
 * `grabacion.js` alcanza es lo que la sesión puede llegar a ejecutar. Una lista
 * escrita a mano se quedaría corta justo cuando aparezca el módulo nuevo, que es
 * el único caso que esto vino a agarrar.
 */
function alcanzablesDesde(entrada) {
    const vistos = new Set();
    const pila = [entrada];
    while (pila.length) {
        const archivo = pila.pop();
        if (vistos.has(archivo) || !fs.existsSync(path.join(MOTOR, archivo))) continue;
        vistos.add(archivo);
        for (const m of fuente(archivo).matchAll(/require\('\.\/([a-z0-9-]+)'\)/g)) {
            pila.push(`${m[1]}.js`);
        }
    }
    return [...vistos].sort();
}

module.exports = async t => {

    t.group('gpu · el criterio, escrito una sola vez');

    t.test('con el modelo local y el Whisper andando, no se consulta', () => {
        gpu.tomar();
        try {
            t.eq(gpu.ocupada(), true);
            t.eq(gpu.sePuedeConsultar('local'), false);
        } finally {
            gpu.soltar();
        }
    });

    t.test('el mismo modelo local, con la grabación terminada, sí', () => {
        // Es lo que hace que abstenerse no sea perder la medición: la consulta se
        // pospone, y este es el estado en el que se paga.
        gpu.soltar();
        t.eq(gpu.sePuedeConsultar('local'), true);
    });

    t.test('contra un proveedor remoto se mide en vivo, siempre', () => {
        // La mitad del criterio que más fácil se pierde. Con la API de Claude o
        // el Cursor CLI el cómputo pasa afuera y la consulta es un viaje de red:
        // apagarlo "por las dudas" dejaría el panel mudo en la única
        // configuración en la que medir no le cuesta nada a la clase.
        gpu.tomar();
        try {
            t.eq(gpu.sePuedeConsultar('anthropic'), true);
            t.eq(gpu.sePuedeConsultar('cursor'), true);
        } finally {
            gpu.soltar();
        }
    });

    t.test('sin saber qué proveedor hay no se abstiene de nada', () => {
        // No poder leer los Ajustes es un problema de otro lado y se dice cuando
        // se arma el cliente. Convertirlo en "no medir" apagaría el panel entero
        // por un error que no tiene nada que ver.
        gpu.tomar();
        try {
            t.eq(gpu.sePuedeConsultar(null), true);
        } finally {
            gpu.soltar();
        }
    });

    t.test('en el cierre la GPU cambia de manos, no queda libre', () => {
        // Las dos preguntas que se hacen acá tienen respuestas distintas en este
        // momento, y por eso el módulo guarda QUIÉN la tiene y no un sí o un no.
        // Cuando se drena la cola de relecturas ya no hay Whisper con el que
        // competir, así que la medición que estuvo esperando toda la clase por fin
        // consulta; pero "Regenerar" levantaría un Whisper nuevo encima de esa
        // medición, y eso sigue estando mal aunque la grabación haya terminado.
        gpu.tomar('cierre');
        try {
            t.eq(gpu.sePuedeConsultar('local'), true, 'la deuda se cobra acá o no se cobra nunca');
            t.eq(gpu.ocupada(), true, 'y sin embargo la máquina está ocupada');
        } finally {
            gpu.soltar();
        }
        t.eq(gpu.ocupada(), false);
    });

    t.test('soltar sin haber tomado no rompe nada', () => {
        // `apagar` y `terminar` pasan los dos por acá, y cerrar la app en medio
        // de un rodaje recorre los dos caminos.
        gpu.soltar();
        gpu.soltar();
        t.eq(gpu.ocupada(), false);
    });

    t.group('gpu · nadie le pregunta a un modelo en vivo sin pasar por la política');

    t.test('hay módulos que revisar', () => {
        // Sin esto, mover `grabacion.js` de carpeta dejaría las dos pruebas de
        // abajo pasando en verde sin mirar un solo archivo.
        const alcanzables = alcanzablesDesde('grabacion.js');
        t.ok(alcanzables.length > 8, `alcanzados ${alcanzables.length} módulos desde grabacion.js`);
        t.ok(alcanzables.includes('medir-toma.js'), 'y entre ellos el mecanismo de medición');
    });

    t.test('todos los que consultan un modelo con la sesión viva consultan el veto', () => {
        // **Esta es la que se rompe con el tercer medidor.** Un bloque nuevo que
        // se arme su propio cliente —que es exactamente lo que hizo la cobertura
        // del temario— aparece acá el día que se escribe, y no el día que alguien
        // se pregunta por qué la clase transcribe peor con el panel abierto.
        const consultan = alcanzablesDesde('grabacion.js').filter(f => fuente(f).includes('ia.armar('));
        t.ok(consultan.length >= 2, `esperaba al menos dos, encontrados ${consultan.join(', ')}`);

        const sinVeto = consultan.filter(f => !/gpu\.(sePuedeConsultar|ocupada)\(/.test(fuente(f)));
        t.deep(sinVeto, [],
            'quien consulte un modelo mientras se graba tiene que preguntarle antes a engine/gpu.js');
    });

    t.test('y el criterio no está escrito dos veces', () => {
        // El bug era ese: tres redacciones del mismo porqué, y una de ellas
        // resolviéndolo distinto. El texto que ve el editor sale de un solo sitio.
        const otros = alcanzablesDesde('grabacion.js')
            .filter(f => f !== 'gpu.js')
            .filter(f => /proveedor\s*===\s*'local'/.test(fuente(f)));
        t.deep(otros, [], 'decidir sobre el proveedor local es de engine/gpu.js y de nadie más');
    });

    t.group('gpu · el veto lo pone el mecanismo, no cada medidor');

    t.test('un medidor recién dado de alta se abstiene sin saber que la regla existe', async () => {
        const preguntadas = [];
        const una = toma(1);
        gpu.tomar();
        try {
            await medirToma.conEstos([medidorNuevo(preguntadas)], async () => {
                await medirToma.conModelo({ toma: una, cliente: CLIENTE, proveedor: 'local' });
            });
        } finally {
            gpu.soltar();
        }
        t.deep(preguntadas, [], 'no se consultó nada');
        t.eq(una.nuevo.ia.estado, 'abstenido');
    });

    t.test('abstenerse no es fallar: tiene su propio estado y dice cuándo sí se mide', async () => {
        // El panel lo dibuja distinto según esto, y tiene que poder: una falla se
        // pinta en ámbar y esto no es una falla, es una decisión de la app.
        const una = toma(1);
        gpu.tomar();
        try {
            await medirToma.conEstos([medidorNuevo([])], async () => {
                await medirToma.conModelo({ toma: una, cliente: CLIENTE, proveedor: 'local' });
            });
        } finally {
            gpu.soltar();
        }
        t.eq(una.nuevo.ia.estado, 'abstenido');
        t.eq(una.nuevo.ia.porque, gpu.PORQUE, 'el porqué sale del único sitio donde está escrito');
        t.ok(/termine la grabación/.test(una.nuevo.ia.porque), 'y promete la medición, no la entierra');
    });

    t.test('con un proveedor remoto el mismo medidor mide en vivo, como hasta ahora', async () => {
        const preguntadas = [];
        const una = toma(1);
        gpu.tomar();
        try {
            await medirToma.conEstos([medidorNuevo(preguntadas)], async () => {
                await medirToma.conModelo({ toma: una, cliente: CLIENTE, proveedor: 'anthropic' });
            });
        } finally {
            gpu.soltar();
        }
        t.deep(preguntadas, [1], 'con el cómputo afuera no hay nada que pelear');
        t.eq(una.nuevo.ia.estado, 'listo');
    });

    t.group('gpu · la deuda se paga cuando la GPU queda libre');

    /** Deja las tomas abstenidas, que es como quedan tras una clase con modelo local. */
    async function grabarAbstenido(tomas) {
        gpu.tomar();
        try {
            for (const una of tomas) {
                await medirToma.conModelo({ toma: una, cliente: CLIENTE, proveedor: 'local' });
            }
        } finally {
            gpu.soltar();
        }
    }

    t.test('al cerrar la sesión se mide lo que se había abstenido', async () => {
        const preguntadas = [];
        const una = toma(1);
        await medirToma.conEstos([medidorNuevo(preguntadas)], async () => {
            await grabarAbstenido([una]);
            t.eq(una.nuevo.ia.estado, 'abstenido', 'durante la clase no se consultó');
            await medirToma.cerrar([una], { cliente: CLIENTE, proveedor: 'anthropic' });
        });
        t.deep(preguntadas, [1], 'y al terminar sí');
        t.eq(una.nuevo.ia.estado, 'listo');
    });

    t.test('se empieza por la más nueva, que es la que el panel muestra', async () => {
        // La misma decisión que ya tomó el carril mientras se graba: lo que tiene
        // algo que decir es la toma de recién. Empezando por la primera, un techo
        // de tiempo se gastaría entero en la toma de hace media hora.
        const preguntadas = [];
        const tomas = [toma(1), toma(2), toma(3)];
        await medirToma.conEstos([medidorNuevo(preguntadas)], async () => {
            await grabarAbstenido(tomas);
            await medirToma.cerrar(tomas, { cliente: CLIENTE, proveedor: 'anthropic' });
        });
        t.deep(preguntadas, [3, 2, 1]);
    });

    t.test('lo que ya estaba medido no se vuelve a pagar', async () => {
        // Con un proveedor remoto nadie se abstuvo, así que cerrar no puede
        // convertirse en una segunda ronda de consultas ya cobradas.
        const preguntadas = [];
        const una = toma(1);
        await medirToma.conEstos([medidorNuevo(preguntadas)], async () => {
            await medirToma.conModelo({ toma: una, cliente: CLIENTE, proveedor: 'anthropic' });
            await medirToma.cerrar([una], { cliente: CLIENTE, proveedor: 'anthropic' });
        });
        t.deep(preguntadas, [1], 'una sola vez');
    });

    t.test('si la GPU no quedó libre no se inventa nada, y queda dicho en pasado', async () => {
        // El texto de la abstención promete que se mide al terminar; sobre una
        // clase terminada esa promesa ya no se puede leer como una espera.
        const preguntadas = [];
        const una = toma(1);
        gpu.tomar();
        try {
            await medirToma.conEstos([medidorNuevo(preguntadas)], async () => {
                await medirToma.conModelo({ toma: una, cliente: CLIENTE, proveedor: 'local' });
                t.eq(await medirToma.cerrar([una], { cliente: CLIENTE, proveedor: 'local' }), true);
            });
        } finally {
            gpu.soltar();
        }
        t.deep(preguntadas, [], 'con el Whisper todavía andando no se consulta ni al cerrar');
        t.eq(una.nuevo.ia.estado, 'abstenido', 'sigue sin ser una falla: no falló nada');
        t.ok(/No se midió/.test(una.nuevo.ia.porque), una.nuevo.ia.porque);
        t.ok(!/Se mide en cuanto termine/.test(una.nuevo.ia.porque),
            'no puede seguir prometiendo una medición que ya no va a pasar');
    });
};
