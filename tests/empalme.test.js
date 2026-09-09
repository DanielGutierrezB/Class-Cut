'use strict';
/**
 * Si la toma que cerró pega con la anterior (`engine/empalme.js`).
 *
 * Lo que importa acá son cuatro cosas, y las cuatro son la diferencia entre una
 * función que sirve y una que molesta:
 *
 * 1. Que lo que se puede resolver sin modelo se resuelva sin modelo. Una consulta
 *    por cada toma que cierra sería veinte por clase para que el modelo conteste
 *    que no hay nada, y esto se apagaría en Ajustes a la semana.
 * 2. Que la sugerencia se pueda EJECUTAR. Si "Ajustar corte" tiene que
 *    interpretar prosa, no hay botón: lo que sale de acá es el mismo cambio que
 *    la pantalla manda cuando alguien arrastra la línea roja.
 * 3. Que lo que devuelve el modelo no entre sin pasar por la aduana. Una cita
 *    inventada mueve el corte de una clase de verdad a un lugar donde no se dijo
 *    nada de lo que dice que se dijo.
 * 4. Que descartar valga: que la sugerencia no vuelva en el próximo repintado y
 *    que no se pague dos veces por lo mismo.
 *
 * Nada de acá toca la red. Las respuestas del modelo se inyectan, que es para lo
 * que `medirToma.conModelo` acepta un cliente puesto a mano.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const empalme = require('../engine/empalme');
const repeticiones = require('../engine/repeticiones');
const vivo = require('../engine/notas-vivo');
const notasXml = require('../engine/notas-xml');
const medirToma = require('../engine/medir-toma');
const grabacion = require('../engine/grabacion');
const rodecaster = require('../engine/rodecaster-xml');

const BASE = Date.UTC(2026, 8, 8, 13, 0, 0);

/** Al ritmo del curso: 168 palabras por minuto son unos 350 ms cada una. */
const RITMO_MS = 350;

/**
 * Una toma con lo que dijo, repartido a ritmo de clase.
 *
 * El texto se escribe de corrido y los tiempos salen del ritmo: escribirlos a
 * mano no diría nada y obligaría a rehacer la cuenta para leer la prueba. Lo que
 * sí hay que poder controlar es CUÁNDO empieza, porque el empalme es entre dos.
 */
function toma(id, desdeMs, texto, extra) {
    const palabras = texto.trim().split(/\s+/).filter(Boolean)
        .map((p, i) => ({ t: desdeMs + i * RITMO_MS, texto: p }));
    return {
        id,
        vista: 'PV',
        comentario: '',
        cuenta: '3, 2, 1.',
        descartada: false,
        cerradaSola: false,
        inMs: desdeMs,
        outMs: palabras[palabras.length - 1].t + RITMO_MS,
        palabras,
        antes: [],
        despues: [],
        comentarios: [],
        ...(extra || {})
    };
}

/* El caso de verdad, y el que motivó todo esto: el profesor cierra explicando el
 * pool de conexiones y al retomar vuelve a decir la última frase para agarrar
 * impulso. Casi con las mismas palabras, que es lo que la regla puede agarrar.
 *
 * La última frase arranca donde termina la anterior —con el punto puesto— y eso
 * no es un detalle del texto de prueba: es el caso. Lo que el profesor vuelve a
 * decir es la frase con la que venía, así que recortarla deja la toma anterior
 * terminando en un punto. Cuando no hay punto donde cortar, la sugerencia no
 * sale, y eso tiene su propia prueba más abajo. */
const DIJO = `Bueno, entonces lo que hicimos hasta acá fue levantar el servidor y dejarlo
    escuchando en el puerto tres mil. La conexión a la base de datos no se abre en cada
    consulta, sino que hay un pool que las reparte.`;

const REPITE = `La conexión a la base de datos no se abre en cada consulta, hay un pool que las
    va repartiendo. Y ese pool tiene un tamaño que se configura.`;

/* La misma idea con otras palabras: la regla no alinea nada y el parecido sí lo
 * ve. Es el único caso que tiene que costar una consulta. */
const PARAFRASEA = `Cada consulta no se arma su propia conexión: el pool tiene unas cuantas
    abiertas y las va prestando. Y ese pool tiene un tamaño configurable.`;

/* Y una toma que habla de otra cosa: ni la regla ni el listón la miran. */
const OTRA_COSA = `Vamos a hablar ahora de los índices, que es otra cosa completamente distinta
    y tiene que ver con cómo la base encuentra las filas sin leerse la tabla entera.`;

function par(segundo, primero) {
    const una = toma(1, BASE + 10000, primero || DIJO);
    const dos = toma(2, BASE + 130000, segundo);
    return [una, dos];
}

/** Un cliente de mentira: contesta lo que se le diga, sin red y sin proveedor. */
function clienteQueDice(respuesta) {
    return { ask: async () => respuesta };
}

/**
 * Dónde arranca, dentro de la cola, la última frase de una toma.
 *
 * Es lo que un modelo bien contestado señala, y por eso las pruebas lo calculan
 * en vez de escribir un número: si el texto de arriba cambia, la prueba sigue
 * apuntando a la frase y no a la palabra que quedó en esa posición.
 */
function arranqueDeLaUltimaFrase(toma) {
    const cola = empalme.colaDe(toma);
    for (let i = cola.length - 1; i > 0; i--) {
        if (/[.!?]$/.test(cola[i - 1].texto)) return i;
    }
    return 0;
}

module.exports = t => {

    t.group('empalme · lo que se resuelve sin modelo');

    t.test('la retoma casi literal la agarra la regla, y no cuesta una consulta', async () => {
        // Es la mitad del diseño: el caso más frecuente —el profesor repite la
        // última frase para arrancar— comparte tokens de sobra, así que lo
        // resuelve el mismo `solapeEntre` que ya usa el motor de post. Pagar por
        // esto sería pagar por lo que ya se sabe.
        const [una, dos] = par(REPITE);
        const regla = empalme.porRegla(una, dos);
        t.ok(regla, 'la regla sola encuentra dónde arranca lo repetido');

        let pedidas = 0;
        await medirToma.conEstos([empalme.medidor], async () => {
            await medirToma.conModelo({
                toma: dos,
                tomas: [una, dos],
                cliente: { ask: async () => { pedidas++; return {}; } },
                proveedor: 'cursor'
            });
        });
        t.eq(pedidas, 0, 'lo que la regla resolvió gratis no se pregunta');

        const vista = empalme.paraLaPantalla(dos, [una, dos]);
        t.eq(vista.sugerencia.origen, 'regla');
        t.eq(vista.estado, 'listo');
    });

    t.test('dos tomas que no repiten nada no dan sugerencia ni consulta', async () => {
        const [una, dos] = par(OTRA_COSA);
        t.ok(empalme.parecidoDeLosBordes(una, dos) < empalme.PARECIDO_PARA_PREGUNTAR,
            'ni siquiera llegan al listón');

        let pedidas = 0;
        await medirToma.conEstos([empalme.medidor], async () => {
            await medirToma.conModelo({
                toma: dos,
                tomas: [una, dos],
                cliente: { ask: async () => { pedidas++; return {}; } },
                proveedor: 'cursor'
            });
        });
        t.eq(pedidas, 0);
        t.eq(empalme.paraLaPantalla(dos, [una, dos]).sugerencia, null);
    });

    t.test('la paráfrasis pasa el listón pero la regla no la ve: eso es del modelo', () => {
        // El reparto entero en una prueba. Decir lo mismo con otras palabras no
        // comparte tokens que alinear —por eso `solapeEntre` no encuentra nada—
        // pero sí comparte las palabras con contenido, que es lo que la cuenta
        // gratis mide. Ahí, y solo ahí, vale una consulta.
        const [una, dos] = par(PARAFRASEA);
        t.eq(empalme.porRegla(una, dos), null, 'la regla no alinea una paráfrasis');
        t.ok(empalme.parecidoDeLosBordes(una, dos) >= empalme.PARECIDO_PARA_PREGUNTAR,
            'y sin embargo los dos bordes dicen lo mismo');
    });

    t.test('el criterio es el de repeticiones.js, no uno nuevo', () => {
        // Lo peor que podía salir de esto era un segundo detector de
        // repeticiones con otro criterio: dos respuestas distintas a la misma
        // pregunta según en qué pantalla se la haga. Los números que deciden
        // salen de allá, donde están medidos sobre las trece clases del curso.
        t.eq(empalme.PARECIDO_PARA_PREGUNTAR, repeticiones.DEFAULTS.parecidoMinimo);
        t.eq(empalme.MINIMO_RECORTE_MS, repeticiones.DEFAULTS.minimoRecorteSec * 1000);
        t.eq(empalme.MINIMO_QUEDA_MS, repeticiones.DEFAULTS.minimoQueQuedaSec * 1000);
        t.eq(empalme.CABEZA_PALABRAS, repeticiones.DEFAULTS.palabrasDeCabeza);
    });

    t.group('empalme · la sugerencia tiene que poder ejecutarse');

    t.test('el corte cae en la hora exacta de una palabra que la toma dijo', () => {
        // No es un detalle de precisión: `repartir` decide de qué lado queda cada
        // palabra comparando contra el borde, así que un milisegundo de deriva
        // deja la palabra del corte del lado equivocado. Y un borde que no es
        // ninguna palabra no se puede subrayar ni explicar.
        const [una, dos] = par(REPITE);
        const { ajuste } = empalme.paraLaPantalla(dos, [una, dos]).sugerencia;
        t.ok(una.palabras.some(w => w.t === ajuste.paredMs),
            'el paredMs es la hora de una palabra de la toma anterior');
        t.eq(ajuste.tipo, 'borde');
        t.eq(ajuste.borde, 'out');
        t.eq(ajuste.toma, una.id, 'se mueve el OUT de la ANTERIOR, no el de esta');
    });

    t.test('el tramo que se subraya va en tiempos de palabra, no en índices', () => {
        // El resto de la app ubica todo por la hora de cada palabra —los
        // comentarios, los marcadores, los bordes— y un índice de caracteres se
        // rompe apenas la toma se relee con el modelo grande y el texto cambia.
        const [una, dos] = par(REPITE);
        const { enLaAnterior, enEsta } = empalme.paraLaPantalla(dos, [una, dos]).sugerencia;
        t.eq(enLaAnterior.toma, una.id);
        t.ok(una.palabras.some(w => w.t === enLaAnterior.desdeMs));
        t.ok(enLaAnterior.hastaMs <= una.outMs);
        t.ok(enLaAnterior.texto.includes('conexión'), `subrayado: ${enLaAnterior.texto}`);
        t.eq(enEsta.toma, dos.id, 'y también dónde se vuelve a decir');
        t.eq(enEsta.desdeMs, dos.palabras[0].t);
    });

    t.test('el ajuste es un cambio que la app ya sabe aplicar', () => {
        // La garantía entera: no hay un segundo camino de escritura. Lo que sale
        // de acá lo entiende `vivo.aplicar`, igual que arrastrar la línea roja.
        const [una, dos] = par(REPITE);
        const { ajuste } = empalme.paraLaPantalla(dos, [una, dos]).sugerencia;
        const antes = una.outMs;
        vivo.aplicar(una, ajuste);
        t.eq(una.outMs, ajuste.paredMs);
        t.ok(una.outMs < antes);
        t.eq(una.despues.length, ajuste.palabras, 'lo recortado pasa a la orilla: no se pierde');
    });

    t.test('un corte que dejaría a la anterior sin toma no se ofrece', () => {
        // Si al recortar no queda bloque, no le sobraba la cola: era toda ella la
        // toma que no salió. Descartarla es un gesto de una persona, no de un
        // botón que apareció solo. Es el mismo mínimo de `repeticiones.js`.
        const [una, dos] = par(REPITE);
        const casiElPrincipio = una.palabras[2].t;
        t.ok(casiElPrincipio - una.inMs < empalme.MINIMO_QUEDA_MS);
        t.eq(empalme.armarSugerencia(una, dos, casiElPrincipio, 'modelo', 'porque sí'), null);
    });

    t.test('un corte que no quita casi nada tampoco', () => {
        const [una, dos] = par(REPITE);
        const casiElFinal = una.palabras[una.palabras.length - 2].t;
        t.eq(empalme.armarSugerencia(una, dos, casiElFinal, 'modelo', 'porque sí'), null);
    });

    t.test('y un corte más atrás de la cola que se miró, tampoco', () => {
        // El techo de lo que un botón puede proponer. Un candidato de hace un
        // minuto no es una retoma; proponer que se corte medio minuto de clase es
        // más de lo que una sugerencia automática puede pedir mientras se graba.
        const [una, dos] = par(REPITE);
        const lejos = una.palabras[1].t;
        t.ok(lejos < empalme.colaDe(una)[0].t);
        t.eq(empalme.armarSugerencia(una, dos, lejos, 'modelo', 'porque sí'), null);
    });

    t.test('un corte señalado a mitad de frase se lleva al arranque de la frase', () => {
        // Es el caso que trajo la corrida real: el modelo acierta qué se repite y
        // señala unas palabras tarde, adentro de la frase. Cortar ahí dejaría la
        // toma anterior terminando en "la base de datos", así que el corte se
        // corre al principio de la frase que parte por la mitad. Adónde se puede
        // cortar es del texto, no del modelo.
        const [una, dos] = par(REPITE);
        const cola = empalme.colaDe(una);
        const tarde = cola.find(w => w.texto === 'abre');
        t.ok(tarde, 'la palabra elegida está en la cola que se mira');

        const s = empalme.armarSugerencia(una, dos, tarde.t, 'modelo', 'porque sí');
        t.ok(s, 'la sugerencia sale igual');
        t.eq(s.ajuste.paredMs, cola[arranqueDeLaUltimaFrase(una)].t,
            'y el corte quedó donde abre la frase, no donde señaló el modelo');
        t.ok(s.enLaAnterior.texto.startsWith('La conexión'),
            'así que lo que se subraya es la frase entera');
    });

    t.test('lo que se corre nunca se pasa de la cola que se miró', () => {
        // El piso del corrimiento. Retraer sin piso propondría cortar sobre
        // palabras que el modelo no vio, que es opinar por él.
        const [una, dos] = par(REPITE);
        const cola = empalme.colaDe(una);
        const s = empalme.armarSugerencia(una, dos, cola[1].t, 'modelo', 'porque sí');
        if (s) t.ok(s.ajuste.paredMs >= cola[0].t, 'el corte no se fue de la cola');
        else t.ok(true, 'o no hay sugerencia, que también es quedarse adentro');
    });

    t.test('sin ninguna frase que abrir, el corte colgando no se ofrece', () => {
        // Cuando no hay puntuación donde retraerse, el corrimiento no tiene nada
        // que hacer y queda la última puerta: sacarle la repetición no sirve si
        // el precio es que la toma anterior termine a mitad de idea. Ese final es
        // el que después reancla el bloque en post. Es el mismo reparo que
        // `repeticiones.aplicarRecorte` hace antes de aceptar un recorte.
        // Cierra con el punto puesto —así que no venía colgando ya— pero es una
        // sola frase larguísima: adentro de la cola no hay dónde retraerse.
        const sinPuntos = `Bueno entonces lo que hicimos hasta acá fue levantar el servidor y
            dejarlo escuchando en el puerto tres mil y la conexión a la base de datos no se abre
            en cada consulta sino que hay un pool que las reparte.`;
        const [una, dos] = par(REPITE, sinPuntos);
        const cola = empalme.colaDe(una);
        t.eq(arranqueDeLaUltimaFrase(una), 0, 'no hay ninguna frase que cierre en la cola');
        t.eq(empalme.armarSugerencia(una, dos, cola[10].t, 'modelo', 'porque sí'), null);
    });

    t.test('una toma que ya venía colgando no se queda sin arreglo por eso', () => {
        // Si el profesor cortó donde le salió, la toma anterior ya terminaba a
        // mitad de frase antes de que nadie toque nada. Mirar el estado final a
        // secas la dejaría sin sugerencia para siempre; lo que se compara es si
        // el corte EMPEORA el final, igual que en `repeticiones.js`.
        const [una, dos] = par(REPITE, DIJO.replace(/\.\s*$/, ' y'));
        const cola = empalme.colaDe(una);
        t.ok(empalme.armarSugerencia(una, dos, cola[arranqueDeLaUltimaFrase(una)].t,
            'modelo', 'porque sí'));
    });

    t.group('empalme · la aduana de lo que contesta el modelo');

    t.test('una cita que la toma no dijo se tira', () => {
        // Es la defensa que decide si esto se puede tener prendido: sin ancla
        // verificable, un modelo que alucina una repetición manda a cortar una
        // clase de verdad en un lugar donde no se dijo nada de eso.
        const [una] = par(PARAFRASEA);
        t.eq(empalme.validar({
            repite: true, desde: 3,
            cita: 'y por eso el garbage collector se pone a trabajar',
            porque: 'Lo dice dos veces.'
        }, una), null);
    });

    t.test('una cita que sí se dijo pasa, y el corte sale de ella', () => {
        const [una] = par(PARAFRASEA);
        const cola = empalme.colaDe(una);
        const leido = empalme.validar({
            repite: true, desde: 4,
            cita: empalme.colaDe(una).slice(6).map(w => w.texto).join(' '),
            porque: 'Vuelve a explicar el pool.'
        }, una);
        t.ok(leido);
        t.eq(leido.paredMs, cola[6].t, 'manda la cita, no el número que vino al lado');
    });

    t.test('la cita manda sobre el número, porque la cita se puede comprobar', () => {
        // Contar renglones no es lo que mejor hace un modelo; copiar un texto que
        // tiene delante, sí. El número es un dato que puede escribir mal sin
        // darse cuenta, y la cita es texto que tiene que estar en la toma.
        const [una] = par(PARAFRASEA);
        const cola = empalme.colaDe(una);
        const leido = empalme.validar({
            repite: true, desde: 0,
            cita: cola.slice(8).map(w => w.texto).join(' '),
            porque: 'Se repite.'
        }, una);
        t.eq(leido.paredMs, cola[8].t, 'el corte sale de donde está la cita');
    });

    t.test('sin un porqué que mostrar no hay sugerencia', () => {
        // El botón pediría aceptar a ciegas. Es lo mismo que hace `lengua.validar`
        // con su `detalle`.
        const [una] = par(PARAFRASEA);
        t.eq(empalme.validar({
            repite: true, desde: 5, cita: empalme.colaDe(una).slice(5).map(w => w.texto).join(' ')
        }, una), null);
    });

    t.test('un "no repite" es una respuesta, no una falla', () => {
        const [una] = par(OTRA_COSA);
        t.eq(empalme.validar({ repite: false }, una), null);
    });

    t.test('una respuesta vacía, nula o rara no explota', () => {
        // De acá no puede salir una excepción: es una grabación en curso.
        const [una] = par(PARAFRASEA);
        t.eq(empalme.validar(null, una), null);
        t.eq(empalme.validar({}, una), null);
        t.eq(empalme.validar({ repite: true }, una), null);
        t.eq(empalme.validar({ repite: 'sí', cita: 'x', porque: 'y' }, una), null);
        t.eq(empalme.validar({ repite: true, desde: 'tres', cita: 3, porque: {} }, una), null);
    });

    t.test('la consulta lleva la cola numerada y el arranque de la nueva', () => {
        const [una, dos] = par(PARAFRASEA);
        const p = empalme.prompt(una, dos);
        t.ok(p.includes('0\t'), 'las palabras de la cola van numeradas');
        t.ok(p.includes('JSON'));
        t.ok(p.includes('Cada consulta'), 'y el arranque de la toma nueva');
        t.ok(p.includes(empalme.colaDe(una)[0].texto));
    });

    t.test('lo que contesta el modelo llega hasta la pantalla como sugerencia', async () => {
        const [una, dos] = par(PARAFRASEA);
        const cola = empalme.colaDe(una);
        const arranca = arranqueDeLaUltimaFrase(una);
        await medirToma.conEstos([empalme.medidor], async () => {
            await medirToma.conModelo({
                toma: dos,
                tomas: [una, dos],
                proveedor: 'cursor',
                cliente: clienteQueDice({
                    repite: true, desde: arranca,
                    cita: cola.slice(arranca).map(w => w.texto).join(' '),
                    porque: 'La toma nueva vuelve a explicar el pool.'
                })
            });
        });
        t.eq(dos.empalme.ia.estado, 'listo');
        const vista = empalme.paraLaPantalla(dos, [una, dos]);
        t.eq(vista.sugerencia.origen, 'modelo');
        t.eq(vista.sugerencia.porque, 'La toma nueva vuelve a explicar el pool.');
        t.eq(vista.sugerencia.ajuste.paredMs, cola[arranca].t);
    });

    t.group('empalme · los bordes que se pasan por alto');

    t.test('la primera toma no tiene anterior, y eso no cuesta una consulta', async () => {
        const [una, dos] = par(REPITE);
        t.eq(empalme.anterior([una, dos], una), null);
        t.eq(empalme.paraLaPantalla(una, [una, dos]), null);
        t.eq(empalme.medir(una, { tomas: [una, dos] }), null);

        let pedidas = 0;
        await medirToma.conEstos([empalme.medidor], async () => {
            await medirToma.conModelo({
                toma: una, tomas: [una, dos], proveedor: 'cursor',
                cliente: { ask: async () => { pedidas++; return {}; } }
            });
        });
        t.eq(pedidas, 0);
    });

    t.test('la que pega es la anterior QUE QUEDA, no la anterior de la lista', () => {
        // Una toma descartada no llega al XML, así que el empalme que va a oír el
        // alumno es con la de más atrás. Validar contra material que nadie va a
        // ver sería avisar de una repetición que no existe.
        const una = toma(1, BASE + 10000, DIJO);
        const dos = toma(2, BASE + 130000, OTRA_COSA, { descartada: true });
        const tres = toma(3, BASE + 250000, REPITE);
        t.eq(empalme.anterior([una, dos, tres], tres).id, 1);
        t.ok(empalme.paraLaPantalla(tres, [una, dos, tres]).sugerencia,
            'y contra esa sí hay repetición');
    });

    t.test('descartar una toma del medio deja sin usar lo que el modelo ya había dicho', () => {
        // La sugerencia guardada hablaba de un par que ya no existe. No se
        // muestra: lo que se pagó fue una respuesta sobre otra pregunta. La regla
        // sí se rehace contra el par nuevo, y eso es gratis.
        const una = toma(1, BASE + 10000, OTRA_COSA);
        const dos = toma(2, BASE + 130000, DIJO);
        const tres = toma(3, BASE + 250000, PARAFRASEA);
        tres.empalme = {
            ia: {
                estado: 'listo', porque: '', hallazgos: [{
                    contra: 2, origen: 'modelo',
                    paredMs: empalme.colaDe(dos)[arranqueDeLaUltimaFrase(dos)].t,
                    porque: 'Repite el pool.'
                }]
            }
        };
        t.ok(empalme.paraLaPantalla(tres, [una, dos, tres]).sugerencia, 'con el par de entonces sí');

        dos.descartada = true;
        const vista = empalme.paraLaPantalla(tres, [una, dos, tres]);
        t.eq(vista.contra, 1, 'ahora pega con otra');
        t.eq(vista.sugerencia, null, 'y la respuesta guardada no habla de ese par');
    });

    t.test('mover un borde deja sin efecto la sugerencia que señalaba esa palabra', () => {
        // Aceptar un ajuste cambia el texto de la toma anterior, y con él la
        // sugerencia de al lado. Se rehace en cada lectura justamente por esto:
        // una guardada seguiría ofreciendo un corte en una palabra que ya no está
        // en la toma.
        const [una, dos] = par(REPITE);
        const antes = empalme.paraLaPantalla(dos, [una, dos]).sugerencia;
        t.ok(antes);

        vivo.aplicar(una, antes.ajuste);
        const despues = empalme.paraLaPantalla(dos, [una, dos]);
        t.eq(despues.sugerencia, null, 'ya no hay nada que recortar: la repetición se fue');
    });

    t.test('la toma abierta no se mide: su texto todavía es el descartable', () => {
        // Se rehace entero cuando cierra, con el modelo grande. Medir el empalme
        // sobre el texto del ciclo liviano sería medir al transcriptor barato, y
        // el aviso cambiaría solo cuando la toma cierre sin que nadie hiciera nada.
        const [una, dos] = par(REPITE);
        dos.outMs = null;
        t.eq(empalme.paraLaPantalla(dos, [una, dos]), null);
        t.eq(empalme.medir(dos, { tomas: [una, dos] }), null);
    });

    t.test('una toma descartada no muestra empalme', () => {
        const [una, dos] = par(REPITE);
        dos.descartada = true;
        t.eq(empalme.paraLaPantalla(dos, [una, dos]), null);
    });

    t.test('sin proveedor no aparece, en vez de romperse', async () => {
        // Y lo que la regla ve gratis se sigue viendo: no hace falta proveedor
        // para el caso más frecuente.
        const [una, dos] = par(PARAFRASEA);
        await medirToma.conEstos([empalme.medidor], async () => {
            await medirToma.conModelo({ toma: dos, tomas: [una, dos], cliente: null });
        });
        t.eq(dos.empalme.ia.estado, 'sin-modelo');
        t.eq(empalme.paraLaPantalla(dos, [una, dos]).sugerencia, null);
        t.eq(empalme.paraLaPantalla(dos, [una, dos]).estado, 'sin-modelo');
    });

    t.test('una consulta caída deja dicho que no se pudo y no tumba nada', async () => {
        const [una, dos] = par(PARAFRASEA);
        await medirToma.conEstos([empalme.medidor], async () => {
            await medirToma.conModelo({
                toma: dos, tomas: [una, dos], proveedor: 'cursor',
                cliente: clienteQueDice({ error: 'se cayó la red' })
            });
        });
        t.eq(dos.empalme.ia.estado, 'falla');
        t.eq(empalme.paraLaPantalla(dos, [una, dos]).porque, 'se cayó la red');
    });

    t.test('sin las demás tomas al lado, el medidor no inventa nada', () => {
        // `medir` se llama también desde pruebas y arneses que solo tienen la
        // toma. Sin la lista no hay par, y no hay par es no hay medida.
        const [, dos] = par(REPITE);
        t.eq(empalme.medir(dos), null);
        t.eq(empalme.medir(dos, {}), null);
    });

    t.group('empalme · aceptar y descartar sobre una clase de verdad');

    /** La clase de dos tomas, con la repetición puesta, escrita en el disco. */
    function claseConRepeticion() {
        const [una, dos] = par(REPITE);
        return {
            secuencia: '01_curso_2026-09-08_13-00-00',
            clase: 1, parte: 1, curso: 'curso',
            ceroMs: BASE,
            claqueta: null,
            sesiones: [],
            tomas: [una, dos]
        };
    }

    function escribirClase(dir, estado) {
        const json = path.join(dir, '01_curso_2026-09-08_13-00-00_notas-en-vivo.json');
        fs.writeFileSync(json, JSON.stringify(notasXml.sidecar(estado)));
        return { json, xml: path.join(dir, '01_curso_2026-09-08_13-00-00.xml') };
    }

    t.test('"Ajustar corte" mueve el borde y reescribe el XML, por el camino de siempre', () => {
        // El punto de todo esto. La sugerencia no se aplica con un canal propio:
        // es el mismo `{tipo:'borde'}` que ya escribe el sidecar y el XML en el
        // mismo gesto, así que lo que se ve en pantalla y lo que abre Premiere son
        // lo mismo sin que nadie tenga que acordarse de guardar.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-empalme-'));
        try {
            const { json, xml } = escribirClase(dir, claseConRepeticion());
            const leer = () => JSON.parse(fs.readFileSync(json, 'utf8')).tomas;

            const guardadas = leer();
            const vista = empalme.paraLaPantalla(guardadas[1], guardadas);
            t.ok(vista.sugerencia, 'la clase leída del disco muestra la sugerencia igual');

            const antesMs = guardadas[0].outMs;
            grabacion.editarGrabada(json, vista.sugerencia.ajuste);

            const tomas = leer();
            t.eq(tomas[0].outMs, vista.sugerencia.ajuste.paredMs, 'el OUT quedó donde decía');
            t.ok(!tomas[0].palabras.some(w => w.texto === 'reparte.'),
                'lo repetido salió de la toma');
            t.eq(tomas[0].despues[0].t, vista.sugerencia.enLaAnterior.desdeMs,
                'y pasó a la orilla, que es de donde se vuelve si el editor se arrepiente');

            const escrito = fs.readFileSync(xml, 'utf8');
            t.ok(escrito.includes('OUT: '), 'el XML se reescribió en el acto');
            const bloque = rodecaster.parseFile(xml).blocks.filter(b => b.complete)[0];
            t.near(bloque.endSec, (tomas[0].outMs - BASE) / 1000, 0.05,
                'y el bloque de Premiere termina donde quedó el borde');
            t.ok(bloque.endSec < (antesMs - BASE) / 1000, 'o sea antes que donde terminaba');

            t.eq(empalme.paraLaPantalla(tomas[1], tomas).sugerencia, null,
                'y la sugerencia no vuelve: ya no hay nada repetido');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('"Descartar ajuste" deja constancia en el archivo, y la sugerencia no vuelve', () => {
        // Sin constancia, la sugerencia reaparecería en el próximo repintado y le
        // preguntaría lo mismo cada tres segundos, que es cómo un aviso se vuelve
        // ruido y se apaga.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-empalme-no-'));
        try {
            const { json, xml } = escribirClase(dir, claseConRepeticion());
            const leer = () => JSON.parse(fs.readFileSync(json, 'utf8')).tomas;

            const antes = leer();
            const vista = empalme.paraLaPantalla(antes[1], antes);
            grabacion.editarGrabada(json, vista.sugerencia.descartar);

            const tomas = leer();
            t.deep(tomas[1].empalme.descartado.contra, 1, 'queda escrito contra qué toma se descartó');
            t.eq(tomas[0].outMs, antes[0].outMs, 'y no se movió ningún borde');

            const despues = empalme.paraLaPantalla(tomas[1], tomas);
            t.eq(despues.sugerencia, null);
            t.eq(despues.estado, 'descartado');
            t.ok(fs.existsSync(xml), 'el XML se reescribió igual, sin cambios de fondo');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('un empalme descartado no vuelve a costar una consulta', async () => {
        // La otra mitad de dejar constancia: si se vuelve a cerrar esa toma —o si
        // la clase se relee entera con "Regenerar"— la pregunta ya está contestada
        // por una persona, y volver a pagarla sería cobrar dos veces lo mismo.
        const [una, dos] = par(PARAFRASEA);
        vivo.aplicar(dos, { tipo: 'descartar-ajuste', contra: una.id });

        let pedidas = 0;
        await medirToma.conEstos([empalme.medidor], async () => {
            await medirToma.conModelo({
                toma: dos, tomas: [una, dos], proveedor: 'cursor',
                cliente: { ask: async () => { pedidas++; return {}; } }
            });
        });
        t.eq(pedidas, 0);
    });

    t.test('el descarte vale para el empalme que se miró, no para siempre', () => {
        // Un booleano diría "esta toma no molesta más", y deja de ser cierto en
        // cuanto cambia con quién empalma: si alguien descarta la del medio, la
        // que pega es otra y la pregunta es otra.
        const una = toma(1, BASE + 10000, DIJO);
        const dos = toma(2, BASE + 130000, OTRA_COSA);
        const tres = toma(3, BASE + 250000, REPITE);
        vivo.aplicar(tres, { tipo: 'descartar-ajuste', contra: 2 });
        t.eq(empalme.paraLaPantalla(tres, [una, dos, tres]).estado, 'descartado');

        dos.descartada = true;
        const vista = empalme.paraLaPantalla(tres, [una, dos, tres]);
        t.eq(vista.contra, 1);
        t.ok(vista.sugerencia, 'el empalme nuevo se mira de nuevo');
    });

    t.group('empalme · lo que queda guardado');

    t.test('al sidecar va lo que se pagó y lo que decidió el editor, no la sugerencia', () => {
        // La sugerencia se rehace al leer, igual que `repiteA`: si estuviera
        // guardada, una clase vieja seguiría ofreciendo un corte en una palabra
        // que un borde movido dejó afuera de la toma.
        const [una, dos] = par(PARAFRASEA);
        dos.empalme = {
            det: { version: 1, contra: 1, parecido: 0.83, porRegla: null },
            ia: { estado: 'listo', porque: '', hallazgos: [{ contra: 1, origen: 'modelo', paredMs: 1, porque: 'x' }] },
            descartado: { contra: 1, ms: BASE }
        };
        const leido = JSON.parse(JSON.stringify(notasXml.sidecar({
            secuencia: 'x', ceroMs: BASE, tomas: [una, dos]
        })));
        t.eq(leido.tomas[1].empalme.ia.hallazgos.length, 1, 'lo que contestó el modelo se guarda');
        t.eq(leido.tomas[1].empalme.descartado.contra, 1, 'y el descarte del editor también');
        t.eq(leido.tomas[0].empalme, null, 'la toma sin empalme guarda null, no nada');
        t.eq(leido.tomas[1].empalme.sugerencia, undefined, 'la sugerencia no se guarda');
    });

    t.test('el medidor deja su apunte en la toma cuando la clase corre', () => {
        const [una, dos] = par(REPITE);
        const det = empalme.medir(dos, { tomas: [una, dos] });
        t.eq(det.contra, 1);
        t.ok(det.parecido > 0.5);
        t.ok(det.porRegla, 'y queda dicho que lo resolvió la regla, o sea que no costó nada');
    });
};
