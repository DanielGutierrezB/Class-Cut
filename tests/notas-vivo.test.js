'use strict';
/**
 * Las notas de rodaje tomadas en vivo.
 *
 * La prueba que de verdad importa es la última: el XML que escribe esta
 * herramienta se le da al parser que ya existe (`rodecaster-xml`) y se mira si
 * salen los bloques que se esperaban. Cualquier convención que se rompa —el par
 * por duración, el separador del comentario, la claqueta por su texto— aparece
 * ahí y no en producción.
 */

const vivo = require('../engine/notas-vivo');
const notasXml = require('../engine/notas-xml');
const grabacion = require('../engine/grabacion');
const ajustes = require('../engine/ajustes');
const rodecaster = require('../engine/rodecaster-xml');
const workspace = require('../engine/workspace');
const os = require('os');
const path = require('path');
const fs = require('fs');

/** Palabras con hora del día, escritas cómodo: "texto@segundo". */
function hablar(base, lista) {
    return lista.map(item => {
        const [texto, seg] = item.split('@');
        return { t: base + Math.round(Number(seg) * 1000), texto };
    });
}

module.exports = t => {
    const BASE = Date.UTC(2026, 8, 4, 15, 0, 0);

    t.group('notas en vivo · las señales del profesor');

    t.test('el conteo abre, y la señal no queda adentro', () => {
        const p = hablar(BASE, ['3,@0', '2,@0.4', '1.@0.8', 'Hoy@1.5', 'vamos@1.8']);
        const s = vivo.senales(p);
        t.eq(s.length, 1);
        t.eq(s[0].tipo, 'abre');
        t.eq(s[0].desde, 0);
        t.eq(s[0].hasta, 2, 'la señal termina en el "1.", así que el IN va después');
    });

    t.test('el "Ok" de adelante es parte de la señal', () => {
        // Aparece así en el curso real: "Ok, 3 2 1.". Si el Ok quedara adentro de
        // la toma, la clase abriría diciendo "ok".
        const p = hablar(BASE, ['Ok,@0', '3@0.3', '2@0.6', '1.@0.9', 'Entonces@1.6']);
        const s = vivo.senales(p);
        t.eq(s.length, 1);
        t.eq(s[0].desde, 0, 'arranca en el Ok');
        t.eq(s[0].hasta, 3);
    });

    t.test('un número suelto no es un conteo', () => {
        // "…tenemos 3 opciones" no puede abrir una toma.
        const p = hablar(BASE, ['tenemos@0', '3@0.5', 'opciones@1']);
        t.eq(vivo.senales(p).length, 0);
    });

    t.test('contar hacia ARRIBA no es una cuenta de rodaje', () => {
        // Lo encontró una prueba: con la regla de "dos números seguidos", decir
        // "uno, dos, tres" en medio de la clase abría una toma. Una cuenta de
        // rodaje va hacia abajo y termina en uno.
        t.eq(vivo.senales(hablar(BASE, ['uno@0', 'dos@0.4', 'tres@0.8'])).length, 0);
        t.eq(vivo.senales(hablar(BASE, ['tenemos@0', 'uno@0.4', 'dos@0.8', 'casos@1.2'])).length, 0);
    });

    t.test('el falso arranque igual cuenta, porque pasa de verdad', () => {
        // Está escrito así en un XML del curso: "3 2 3 2 1.". No baja monótona,
        // pero termina en uno y es una cuenta.
        const p = hablar(BASE, ['3@0', '2@0.3', '3@0.6', '2@0.9', '1.@1.2', 'Listo@2']);
        const s = vivo.senales(p);
        t.eq(s.length, 1);
        t.eq(s[0].hasta, 4, 'la señal se come los cinco números');
    });

    t.test('la cuenta termina en el primer uno y no se come la clase', () => {
        // Lo encontró otra prueba: si la clase arranca con "uno de los
        // problemas…", la palabra "uno" es número y la señal se la llevaba.
        const p = hablar(BASE, ['3,@0', '2,@0.3', '1.@0.6', 'Uno@1.2', 'de@1.5', 'los@1.8']);
        const s = vivo.senales(p);
        t.eq(s.length, 1);
        t.eq(s[0].hasta, 2, 'la señal termina en el "1.", y "Uno" es clase');
    });

    t.test('"Retomamos" abre', () => {
        const p = hablar(BASE, ['Retomamos.@0', 'Como@1', 'decía@1.3']);
        const s = vivo.senales(p);
        t.eq(s.length, 1);
        t.eq(s[0].por, 'retomamos');
    });

    t.test('"Pausa" cierra solo si atrás viene silencio', () => {
        // Es lo que separa la señal de la palabra: el profesor para de hablar.
        const conSilencio = hablar(BASE, ['listo.@0', 'Pausa.@0.5', 'Bueno@4']);
        t.eq(vivo.senales(conSilencio).length, 1);
        t.eq(vivo.senales(conSilencio)[0].tipo, 'cierra');

        const enElMedio = hablar(BASE, ['hacemos@0', 'una@0.3', 'pausa@0.6', 'en@0.9', 'el@1.1']);
        t.eq(vivo.senales(enElMedio).length, 0, '"pausa" dicho al pasar no cierra nada');
    });

    t.test('la última palabra de la tirada queda para el silencio que venga', () => {
        // Sin nada detrás no se puede saber si paró: se le da por cerrada, porque
        // el hueco hasta la palabra siguiente es infinito.
        const p = hablar(BASE, ['bueno,@0', 'pausa.@0.4']);
        t.eq(vivo.senales(p).length, 1);
    });

    t.group('notas en vivo · las tomas se abren y se cierran solas');

    /** Un estado recién iniciado, sin tomas: el mismo con el que arranca la sesión. */
    function vacio() {
        return vivo.estadoNuevo({ ceroMs: BASE });
    }

    t.test('el conteo abre y la clase empieza DESPUÉS del conteo', () => {
        const e = vacio();
        vivo.aplicarSenales(e, hablar(BASE, ['3,@10', '2,@10.4', '1.@10.8', 'Hoy@11.5', 'vamos@11.9']));
        t.eq(e.tomas.length, 1);
        t.eq(e.tomas[0].inMs, BASE + 11500, 'el IN cae en "Hoy", no en el "3,"');
        t.eq(e.tomas[0].cuenta, '3, 2, 1.', 'el conteo queda guardado para el comentario');
        t.deep(e.tomas[0].palabras.map(w => w.texto), ['Hoy', 'vamos']);
    });

    t.test('"Pausa" cierra y el OUT queda antes de la señal', () => {
        const e = vacio();
        vivo.aplicarSenales(e, hablar(BASE, ['3,@10', '2,@10.3', '1.@10.6', 'Hola@11', 'gente@11.4']));
        vivo.aplicarSenales(e, hablar(BASE, ['listo.@20', 'Pausa.@20.5', 'Che@25']));
        const toma = e.tomas[0];
        t.eq(toma.outMs != null, true);
        t.eq(toma.outMs <= BASE + 20500, true, 'no incluye la palabra "Pausa"');
        t.deep(toma.palabras.map(w => w.texto), ['Hola', 'gente', 'listo.']);
    });

    t.test('la señal no queda nunca adentro del texto', () => {
        // Es lo mismo que hace el motor en post: ni el conteo ni "Pausa" son
        // clase, y si quedaran, el alumno oiría al profesor contando.
        const e = vacio();
        vivo.aplicarSenales(e, hablar(BASE, ['3,@1', '2,@1.3', '1.@1.6', 'Hola@2', 'Pausa.@3', 'X@8']));
        const dichas = e.tomas[0].palabras.map(w => w.texto);
        t.eq(dichas.includes('3,'), false);
        t.eq(dichas.includes('Pausa.'), false);
    });

    t.test('abrir con una toma abierta cierra la anterior y lo dice', () => {
        // Pasa cuando el profesor se olvida de decir "Pausa". El parser en post
        // avisaría `bloque_sin_out`; acá se resuelve antes de escribir el XML.
        const e = vacio();
        vivo.aplicarSenales(e, hablar(BASE, ['3,@1', '2,@1.3', '1.@1.6', 'Una@2', 'cosa@2.4']));
        const ev = vivo.aplicarSenales(e, hablar(BASE, ['3,@10', '2,@10.3', '1.@10.6', 'Otra@11']));
        t.eq(e.tomas.length, 2);
        t.eq(e.tomas[0].outMs, BASE + 2400, 'se cerró en su última palabra');
        t.eq(e.tomas[0].cerradaSola, true);
        t.eq(ev.some(x => x.tipo === 'cerrada-sola'), true, 'y queda avisado');
    });

    t.test('una toma se cierra en el FINAL de su última palabra, se cierre como se cierre', () => {
        // Cuatro sitios cierran tomas y hacían la cuenta cada uno a su manera: la
        // que se cerraba sola usaba el arranque de la palabra, y el XML dejaba la
        // última palabra afuera del bloque. Ahora es una sola función.
        const toma = { palabras: [{ t: BASE + 1000, hasta: BASE + 1400, texto: 'chau' }] };
        t.eq(vivo.finDeToma(toma, BASE + 9000), BASE + 1400, 'el final, no el arranque');
        t.eq(vivo.finDeToma({ palabras: [{ t: BASE + 1000, texto: 'chau' }] }, 0), BASE + 1000,
            'sin final conocido, el arranque');
        t.eq(vivo.finDeToma({ palabras: [] }, BASE + 9000), BASE + 9000, 'sin palabras, donde diga quien llama');

        // Y la que se cierra sola lo usa igual que las demás.
        const e = vacio();
        vivo.aplicarSenales(e, [
            ...hablar(BASE, ['3,@1', '2,@1.3', '1.@1.6']),
            { t: BASE + 2000, hasta: BASE + 2600, texto: 'Una' }
        ]);
        vivo.aplicarSenales(e, hablar(BASE, ['3,@10', '2,@10.3', '1.@10.6', 'Otra@11']));
        t.eq(e.tomas[0].outMs, BASE + 2600);
    });

    t.test('lo que se dice sin toma abierta no se guarda en ninguna', () => {
        // La charla entre tomas no es de nadie: guardarla en la toma anterior
        // metería la conversación con el director adentro de la clase.
        const e = vacio();
        vivo.aplicarSenales(e, hablar(BASE, ['che@1', 'como@1.3', 'va@1.6']));
        t.eq(e.tomas.length, 0);
    });

    t.test('mover el OUT a una palabra, que es cómo se retoma de verdad', () => {
        const e = vacio();
        vivo.aplicarSenales(e, hablar(BASE, ['3,@1', '2,@1.3', '1.@1.6', 'Hola@2', 'gente@3', 'buenas@4']));
        const toma = e.tomas[0];
        t.eq(vivo.moverBorde(toma, 'out', BASE + 3000), true);
        t.eq(toma.outMs, BASE + 3000);
    });

    t.test('un borde no puede cruzar al otro', () => {
        // Un bloque invertido no es un bloque: el plan de cortes lo descartaría
        // o, peor, lo tomaría con duración negativa.
        const e = vacio();
        vivo.aplicarSenales(e, hablar(BASE, ['3,@1', '2,@1.3', '1.@1.6', 'Hola@2', 'gente@3']));
        const toma = e.tomas[0];
        toma.outMs = BASE + 3000;
        t.eq(vivo.moverBorde(toma, 'out', BASE + 1000), false, 'el OUT no puede ir antes del IN');
        t.eq(vivo.moverBorde(toma, 'in', BASE + 5000), false, 'ni el IN después del OUT');
        t.eq(toma.outMs, BASE + 3000, 'y nada cambió');
    });

    t.group('notas en vivo · las tomas que repiten a otra');

    /** Una toma con solo lo que mira `repeticiones`. */
    function conTexto(id, texto) {
        return {
            id,
            palabras: texto.split(' ').map((w, i) => ({ t: BASE + i * 400, texto: w }))
        };
    }

    // Los tres intentos del mismo arranque, copiados de lo que Whisper escribió
    // sobre la clase 2 del curso. Ninguno empieza igual que otro: el conteo le
    // deja pegado un "1." o un "Uno," delante y a veces se come una palabra.
    const INTENTOS = [
        '1. Quiero que hagas un ejercicio mental. Piensa en el último prompt',
        'que hagas un ejercicio piensa en el prom que utilizaste en la última',
        'Uno, quiero que hagas un ejercicio. Piensa en el PROM que utilizaste'
    ];
    // Y un arranque del mismo profesor, en la misma clase, de otro tema.
    const OTRO_TEMA = 'Peor aún, ¿qué sucede si algún desarrollador se va del equipo?';

    t.test('el ensayo repetido queda marcado, no descartado', () => {
        // En la clase 2 el profesor arrancó así siete veces y el director de
        // contenido se quedó con una. Descartar sigue siendo del editor; esto le
        // dice cuáles mirar.
        const tomas = [
            conTexto(1, INTENTOS[0]),
            conTexto(2, INTENTOS[1]),
            conTexto(3, OTRO_TEMA)
        ];
        const repite = vivo.repeticiones(tomas);
        t.eq(repite.has(1), false, 'la primera no repite a nadie');
        t.eq(repite.get(2), 1, 'la segunda es el mismo arranque');
        t.eq(repite.has(3), false, 'y una toma de otro tema no');
        t.eq('repiteA' in tomas[1], false, 'y no se escribe nada sobre las tomas');
    });

    t.test('los tres intentos de verdad se reconocen entre sí', () => {
        const tomas = INTENTOS.map((texto, i) => conTexto(i + 1, texto));
        const repite = vivo.repeticiones(tomas);
        // Todos al primero y no en cadena: si el tercero apuntara al segundo,
        // habría que seguir el hilo para llegar al original.
        t.deep(tomas.map(x => repite.get(x.id) || null), [null, 1, 1]);
    });

    t.test('la puntuación y los acentos no cuentan', () => {
        // Whisper no escribe dos veces igual la misma frase: en la clase 2 salió
        // "3, 2, 1." y "Tres, dos, uno." para el mismo conteo.
        const tomas = [
            conTexto(1, 'Piensa en el prompt que utilizaste en la ultima'),
            conTexto(2, '¡Piensa! en él, prómpt, que utilizaste en la última')
        ];
        t.eq(vivo.repeticiones(tomas).get(2), 1);
    });

    t.test('una toma corta no se compara con nada', () => {
        // Con dos o tres palabras cualquier cosa se parece a cualquier cosa, y
        // marcar "repite" donde no se sabe es peor que no marcar.
        const tomas = [conTexto(1, 'Bueno listo ya'), conTexto(2, 'Bueno listo ya')];
        t.eq(vivo.repeticiones(tomas).size, 0);
    });

    t.group('notas en vivo · cuál claqueta queda');

    const golpe = (seg, extra) => ({ ms: BASE + seg * 1000, frase: '', confirmada: false, origen: 'golpe', ...extra });

    t.test('el primer golpe se queda aunque vengan otros sin confirmar', () => {
        // Con la regla contraria, cada portazo corría la claqueta: en la clase 2
        // el aplauso de los 11 s había quedado a las 3:27 para el minuto tres.
        const primera = golpe(11);
        t.eq(vivo.elegirClaqueta(null, primera), primera, 'sin nada, el primero');
        t.eq(vivo.elegirClaqueta(primera, golpe(40)), primera, 'un portazo después no lo mueve');
    });

    t.test('una confirmada le gana a una que no lo está, venga cuando venga', () => {
        const portazo = golpe(11);
        const aplauso = golpe(19, { frase: 'Claqueta 7, clase 7', confirmada: true });
        t.eq(vivo.elegirClaqueta(portazo, aplauso), aplauso);
    });

    t.test('una confirmada no se mueve', () => {
        const aplauso = golpe(19, { frase: 'Claqueta 7, clase 7', confirmada: true });
        t.eq(vivo.elegirClaqueta(aplauso, golpe(40, { frase: 'clase 8', confirmada: true })), aplauso,
            'ni por otra confirmada: se aplaude una vez');
        t.eq(vivo.elegirClaqueta(aplauso, golpe(40)), aplauso);
        t.eq(vivo.elegirClaqueta(aplauso, null), aplauso, 'y sin lectura nueva, sigue');
    });

    t.group('notas en vivo · de la hora del día a los cuadros');

    t.test('el cero es "Iniciar grabación", no la claqueta', () => {
        // Con el cero en la claqueta, el desfase que calcula `align.js` sería
        // "cuánto tardó el profesor en aplaudir" y pasaría su tope de 60 s.
        t.eq(notasXml.aCuadros(BASE + 2000, BASE, 30), 60);
        t.eq(notasXml.aCuadros(BASE, BASE, 30), 0);
    });

    t.test('lo dicho antes de arrancar no se va a cuadros negativos', () => {
        // El parser lee un marcador sin posición y lo descarta.
        t.eq(notasXml.aCuadros(BASE - 5000, BASE, 30), 0);
    });

    t.group('notas en vivo · lo que se escribe y lo que no');

    /** Un estado como el que deja una sesión de grabación. */
    function sesion() {
        return {
            secuencia: '06_2609_curso-prueba-1785289335_108079',
            clase: 6,
            fps: 30,
            ceroMs: BASE,
            claqueta: { ms: BASE + 2000, frase: 'Clase 6' },
            tomas: [
                {
                    id: 1, vista: 'PV', comentario: 'Mirar el arranque',
                    cuenta: '3, 2, 1.',
                    inMs: BASE + 10000, outMs: BASE + 25000,
                    palabras: hablar(BASE + 10000, ['Hoy@0', 'vamos@0.4', 'a@0.7', 'ver@0.9', 'Power@1.3', 'Query@1.7', 'desde@2.1', 'cero@2.5', 'porque@3', 'importa@3.4'])
                },
                {
                    id: 2, vista: 'R', comentario: '', cuenta: 'Retomamos',
                    inMs: BASE + 30000, outMs: BASE + 40000,
                    descartada: true,
                    palabras: hablar(BASE + 30000, ['Esta@0', 'salio@0.4', 'mal@0.8'])
                },
                {
                    id: 3, vista: 'R', comentario: '', cuenta: '3, 2, 1.',
                    inMs: BASE + 45000, outMs: BASE + 60000,
                    palabras: hablar(BASE + 45000, ['Ahora@0', 'si@0.4', 'cargamos@0.8', 'la@1.2', 'tabla@1.5'])
                }
            ]
        };
    }

    t.test('la toma descartada no llega al XML', () => {
        // Es el sentido de descartarla: el profesor repitió y esa no va.
        const quedan = vivo.tomasQueQuedan(sesion());
        t.deep(quedan.map(x => x.id), [1, 3]);
    });

    t.test('una toma sin cerrar tampoco', () => {
        // El parser la aceptaría avisando `bloque_sin_out`, pero acá todavía se
        // puede cerrar a mano: mejor no escribirla que dejarle trabajo al editor.
        const e = sesion();
        e.tomas.push({ id: 4, vista: 'PV', inMs: BASE + 70000, outMs: null, palabras: [] });
        t.deep(vivo.tomasQueQuedan(e).map(x => x.id), [1, 3]);
    });

    t.test('el par es entrada larga y salida sin duración', () => {
        // Es lo ÚNICO que mira el parser para saber cuál es cuál. Al revés,
        // partiría cada bloque en dos.
        const m = notasXml.marcadores(sesion()).filter(x => x.nombre !== 'K' && x.nombre !== 'Nota');
        const entradas = m.filter(x => x.out > x.in);
        const salidas = m.filter(x => x.out === x.in);
        t.eq(entradas.length, 2);
        t.eq(salidas.length, 2);
        t.eq(entradas[0].out - entradas[0].in, notasXml.CUADROS_DEL_MARCADOR_IN);
    });

    t.test('la claqueta son dos marcadores en el mismo cuadro', () => {
        const m = notasXml.marcadores(sesion()).filter(x => x.nombre === 'K');
        t.eq(m.length, 2);
        t.eq(m[0].in, m[1].in);
        t.eq(m[0].in, 60, 'dos segundos después del cero');
        t.eq(/Clapperboard/.test(m[0].comentario), true, 'el parser la reconoce por el texto');
    });

    t.test('el comentario de entrada lleva la nota, el separador y lo que se dijo', () => {
        const m = notasXml.marcadores(sesion());
        const entrada = m.find(x => x.out > x.in && x.nombre === 'PV');
        const leido = rodecaster.parseInComment(entrada.comentario);
        t.eq(leido.note, 'Mirar el arranque');
        t.eq(leido.hasCount, true, 'el conteo tiene que llegar escrito');
        t.eq(leido.cue.startsWith('Hoy vamos a ver'), true);
    });

    t.test('una toma SIN nota también deja el conteo donde el parser lo busca', () => {
        // Es el caso normal —la mayoría de las tomas no llevan nota— y era el que
        // estaba roto: el comentario queda " - 3, 2, 1. …" y recortarlo se llevaba
        // el espacio del separador. Sin separador, el parser mete el conteo dentro
        // del cue y el motor de cortes se queda sin saber dónde arranca la clase.
        // Lo encontró la simulación: once tomas seguidas con `hasCount` en falso.
        const m = notasXml.marcadores(sesion());
        const entrada = m.find(x => x.out > x.in && x.nombre === 'R');
        t.eq(entrada.comentario.startsWith(' - '), true,
            `el separador tiene que sobrevivir: ${JSON.stringify(entrada.comentario.slice(0, 12))}`);
        const leido = rodecaster.parseInComment(entrada.comentario);
        t.eq(leido.hasCount, true);
        t.eq(leido.note, '');
        t.eq(leido.cue.startsWith('Ahora si'), true, `cue: ${JSON.stringify(leido.cue)}`);
    });

    t.test('el comentario de salida son las últimas palabras dichas', () => {
        const m = notasXml.marcadores(sesion());
        const salida = m.find(x => x.out === x.in && x.nombre === 'PV');
        const leido = rodecaster.parseOutComment(salida.comentario);
        t.eq(leido.hadPrefix, true);
        t.eq(leido.cue.endsWith('porque importa'), true);
    });

    t.test('el color es el que escribe la herramienta del CD', () => {
        // Si acá se inventara otro, el mismo tipo de toma llegaría de un color
        // distinto según quién tomó las notas.
        t.eq(notasXml.colorDeVista('PV'), 4281740498);
        t.eq(notasXml.colorDeVista('R'), 4280578025);
    });

    t.test('un comentario sobre el texto va blanco y abarca la selección', () => {
        const e = sesion();
        e.tomas[0].comentarios = [{
            desdeMs: BASE + 11000, hastaMs: BASE + 13000, comentario: 'revisar esto'
        }];
        const nota = notasXml.marcadores(e).find(x => x.nombre === 'Nota');
        t.eq(nota.color, notasXml.BLANCO);
        t.eq(nota.in, 330);
        t.eq(nota.out, 390, 'dura lo que duraba la selección');
    });

    t.group('notas en vivo · el XML entra por donde entra el del CD');

    t.test('el parser saca los bloques que se escribieron', () => {
        // La prueba de verdad: se escribe el XML y se lo lee con el mismo parser
        // que usa el pipeline. Si alguna convención se rompió, se ve acá.
        const e = sesion();
        const xml = notasXml.xmlDeNotas(e);
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-notas-')), 'n.xml');
        fs.writeFileSync(file, xml);

        const leido = rodecaster.parseFile(file);
        t.eq(leido.ok, true, leido.error || '');
        t.eq(leido.sequenceName, e.secuencia);
        t.eq(leido.timebase, 30);
        t.eq(Boolean(leido.clap), true, 'la claqueta se reconoció');
        t.eq(leido.clap.seconds, 2);

        const bloques = leido.blocks.filter(b => b.complete);
        t.eq(bloques.length, 2, 'las dos tomas que quedaron');
        t.near(bloques[0].startSec, 10, 0.05);
        t.near(bloques[0].endSec, 25, 0.05);
        t.eq(bloques[0].view, 'PV');
        t.eq(bloques[0].note, 'Mirar el arranque');
        t.near(bloques[1].startSec, 45, 0.05);
        t.eq(bloques[1].view, 'R');

        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });

    t.test('sin claqueta el XML sigue siendo legible', () => {
        // Pasa si el aplauso no se oyó: el pipeline avisa `sin_claqueta` y alinea
        // solo con el audio, que es lo que ya hacía antes de esta herramienta.
        const e = sesion();
        e.claqueta = null;
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-notas-')), 'n.xml');
        fs.writeFileSync(file, notasXml.xmlDeNotas(e));
        const leido = rodecaster.parseFile(file);
        t.eq(leido.ok, true);
        t.eq(leido.clap, null);
        t.eq(leido.blocks.filter(b => b.complete).length, 2);
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });

    t.test('sin cero no se escribe ningún marcador', () => {
        // Antes de apretar "Iniciar" no hay a qué referir los cuadros, y escribir
        // marcadores en el cuadro 0 pondría la clase entera al principio.
        const e = sesion();
        e.ceroMs = null;
        t.eq(notasXml.marcadores(e).length, 0);
    });

    t.group('notas en vivo · el XML dice de dónde salió');

    t.test('lleva la firma y el parser la reconoce', () => {
        const xml = notasXml.xmlDeNotas(sesion());
        t.eq(xml.includes(notasXml.FIRMA), true);
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-notas-')), 'n.xml');
        fs.writeFileSync(file, xml);
        t.eq(rodecaster.parseFile(file).deNotasEnVivo, true);
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });

    t.test('un XML del CD no la lleva', () => {
        // La firma no puede aparecer sola: si apareciera, una clase con notas
        // escritas a mano se saltaría la confirmación del desfase, que existe
        // justo para atrapar marcadores mal puestos.
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cd-')), 'n.xml');
        fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
<sequence id="sequence-1">
    <duration>216000</duration>
    <rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
    <name>07_2609_curso-1785289335_108079</name>
    <media><video></video></media>
    <marker><comment> - Clapperboard</comment><name>K</name><in>60</in><out>60</out></marker>
    <marker><comment>OUT: Clapperboard</comment><name>K</name><in>60</in><out>60</out></marker>
</sequence>
</xmeml>`);
        const leido = rodecaster.parseFile(file);
        t.eq(leido.ok, true);
        t.eq(leido.deNotasEnVivo, false);
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });

    t.group('notas en vivo · el archivo con la hora del día');

    t.test('lleva la hora de cada palabra y de cada borde', () => {
        // Es lo que hace imposible solapar dos tomas: el reloj de pared no
        // depende de cuándo se empezó a escuchar ni de si se paró en el medio.
        const s = notasXml.sidecar(sesion());
        t.eq(s.tomas.length, 3, 'las descartadas también se guardan, para poder volver');
        t.eq(s.tomas[0].inISO, new Date(BASE + 10000).toISOString());
        t.eq(s.tomas[0].palabras.length, 10);
        t.eq(typeof s.tomas[0].palabras[0].t, 'number');
        t.eq(s.ceroISO, new Date(BASE).toISOString());
    });

    t.group('notas en vivo · las orillas de una toma');

    /** Una palabra por segundo desde `desdeMs`, para poder contar de un vistazo. */
    const palabras = (desdeMs, cuantas) => Array.from({ length: cuantas },
        (_x, i) => ({ t: desdeMs + i * 1000, texto: `p${i}` }));

    t.test('lo de antes y lo de después quedan aparte, y el OUT es exclusivo', () => {
        // La toma se lee más ancha de lo que es, para poder mover un borde viendo
        // la frase que quedó afuera. Lo que se guarda como `palabras` tiene que
        // seguir siendo exactamente lo de adentro: es lo que va al XML.
        const toma = { inMs: BASE + 5000, outMs: BASE + 10000 };
        const r = vivo.repartir(palabras(BASE, 15), toma);

        t.deep(r.antes.map(w => w.t - BASE), [0, 1000, 2000, 3000, 4000]);
        t.deep(r.palabras.map(w => w.t - BASE), [5000, 6000, 7000, 8000, 9000]);
        t.deep(r.despues.map(w => w.t - BASE), [10000, 11000, 12000, 13000, 14000],
            'la palabra que empieza justo en el OUT ya no es de la toma');
    });

    t.test('una toma sin nada alrededor no inventa orillas', () => {
        const toma = { inMs: BASE, outMs: BASE + 3000 };
        const r = vivo.repartir(palabras(BASE, 3), toma);
        t.deep(r.antes, []);
        t.deep(r.despues, []);
        t.eq(r.palabras.length, 3);
    });

    t.test('sin palabras no se cae', () => {
        const r = vivo.repartir(null, { inMs: BASE, outMs: BASE + 1000 });
        t.deep([r.antes, r.palabras, r.despues], [[], [], []]);
    });

    t.test('las orillas se guardan al lado del XML, con su hora', () => {
        // Para que mover un borde en una clase ya grabada siga siendo mirar el
        // texto, sin tener que releer el audio para saber qué hay del otro lado.
        const estado = sesion();
        estado.tomas[0].antes = palabras(BASE + 5000, 2);
        estado.tomas[0].despues = palabras(BASE + 30000, 2);
        const s = notasXml.sidecar(estado);
        t.deep(s.tomas[0].antes.map(w => w.texto), ['p0', 'p1']);
        t.deep(Object.keys(s.tomas[0].despues[0]), ['t', 'texto'], 'solo la hora y lo que se dijo');
        t.deep(s.tomas[1].antes, [], 'una toma sin orillas guarda listas vacías, no nada');
    });

    t.group('notas en vivo · las clases ya grabadas de una carpeta');

    t.test('se listan desde el disco, de la más nueva a la más vieja', () => {
        // La lista es la carpeta: terminar una clase no la saca de la pantalla, y
        // la de ayer aparece igual que la de hace un minuto.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-grabadas-'));
        try {
            const vieja = { ...sesion(), secuencia: '01_2609_curso-1', ceroMs: BASE };
            const nueva = { ...sesion(), secuencia: '02_2609_curso-2', clase: 2, ceroMs: BASE + 3600000 };
            fs.writeFileSync(path.join(dir, '01_2609_curso-1_notas-en-vivo.json'), JSON.stringify(notasXml.sidecar(vieja)));
            fs.writeFileSync(path.join(dir, '02_2609_curso-2_notas-en-vivo.json'), JSON.stringify(notasXml.sidecar(nueva)));
            // Lo que también hay en una carpeta de notas y no es una clase.
            fs.writeFileSync(path.join(dir, '02_2609_curso-2.xml'), '<xmeml/>');
            fs.writeFileSync(path.join(dir, 'roto_notas-en-vivo.json'), '{ a medio escribir');

            const lista = grabacion.listar([dir]);
            t.deep(lista.map(c => c.clase), [2, 6], 'la más nueva primero');
            t.eq(lista[0].tomas.length, 3);
            t.eq(lista[0].carpeta, dir, 'cada clase dice de qué carpeta salió, que es la que eligió el editor');
            t.eq(lista[0].archivos.xml, path.join(dir, 'xml', '02_2609_curso-2.xml'),
                'el XML se deduce del nombre del archivo, en el piso donde quedó');
            t.deep(grabacion.listar([path.join(dir, 'no-existe'), dir]).map(c => c.clase), [2, 6],
                'una carpeta que no está no tiene clases, y no tumba a las demás');
            t.deep(grabacion.listar([]), []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('volver a usar un número abre una parte nueva, contando en el disco', () => {
        // Una clase se puede grabar en dos tandas, y cada tanda es su propia
        // grabación. Se cuenta contra el disco y no contra lo que la pantalla
        // tenga en la mano: su lista puede estar vieja, y dos grabaciones con el
        // mismo nombre se pisarían el archivo.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-partes-'));
        try {
            const escribir = nombre => fs.writeFileSync(
                path.join(dir, `${nombre}_notas-en-vivo.json`),
                JSON.stringify(notasXml.sidecar({ ...sesion(), secuencia: nombre, clase: 1 })));

            t.eq(grabacion.parteQueSigue(dir, 1), 1, 'la primera vez es la parte 1');
            escribir('01_curso_2026-09-08_13-00-00');
            t.eq(grabacion.parteQueSigue(dir, 1), 2);
            escribir('01_p2_curso_2026-09-08_15-00-00');
            t.eq(grabacion.parteQueSigue(dir, 1), 3);
            t.eq(grabacion.parteQueSigue(dir, 2), 1, 'otra clase arranca de nuevo');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.group('notas en vivo · cambiar una clase que ya terminó');

    t.test('el comentario entra y el XML se reescribe en el acto', () => {
        // Es el punto de todo esto: quien revisa el guion entero, con la clase ya
        // cerrada, no tiene que acordarse después de regenerar nada. Un
        // comentario que se queda en la pantalla no llega a Premiere.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-comentar-'));
        try {
            const json = path.join(dir, '01_curso_2026-09-08_13-00-00_notas-en-vivo.json');
            const xml = path.join(dir, '01_curso_2026-09-08_13-00-00.xml');
            fs.writeFileSync(json, JSON.stringify(notasXml.sidecar(sesion())));

            const toma = JSON.parse(fs.readFileSync(json, 'utf8')).tomas[0];
            grabacion.editarGrabada(json, {
                tipo: 'comentar', toma: toma.id,
                desdeMs: toma.inMs, hastaMs: toma.inMs + 2000,
                texto: 'lo que se dijo', comentario: 'Cortar antes de esto'
            });

            const despues = JSON.parse(fs.readFileSync(json, 'utf8'));
            t.eq(despues.tomas[0].comentarios.length, 1);
            t.eq(despues.tomas[0].comentarios[0].comentario, 'Cortar antes de esto');
            t.ok(fs.readFileSync(xml, 'utf8').includes('Cortar antes de esto'),
                'y está en el XML, que es lo que abre Premiere');

            grabacion.editarGrabada(json, { tipo: 'borrar-comentario', toma: toma.id, indice: 0 });
            t.eq(JSON.parse(fs.readFileSync(json, 'utf8')).tomas[0].comentarios.length, 0);
            t.ok(!fs.readFileSync(xml, 'utf8').includes('Cortar antes de esto'));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('la vista, la nota y el descarte también, que no releen nada', () => {
        // Que una toma iba en S, o que sobra, se ve mirando el guion entero: o
        // sea, con la clase ya cerrada. Cerrarla no puede ser el momento en que
        // eso deja de poderse arreglar, porque no cuesta más que escribir un campo.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-editar-'));
        try {
            const json = path.join(dir, '01_curso_2026-09-08_13-00-00_notas-en-vivo.json');
            const xml = path.join(dir, '01_curso_2026-09-08_13-00-00.xml');
            fs.writeFileSync(json, JSON.stringify(notasXml.sidecar(sesion())));
            const leer = () => JSON.parse(fs.readFileSync(json, 'utf8'));
            const id = leer().tomas[0].id;

            grabacion.editarGrabada(json, { tipo: 'vista', toma: id, vista: 'S' });
            t.eq(leer().tomas[0].vista, 'S');
            t.ok(fs.readFileSync(xml, 'utf8').includes('<name>S</name>'), 'y va al marcador');

            grabacion.editarGrabada(json, { tipo: 'nota', toma: id, texto: 'Cortar antes de esto' });
            t.eq(leer().tomas[0].comentario, 'Cortar antes de esto');
            t.ok(fs.readFileSync(xml, 'utf8').includes('Cortar antes de esto'));

            grabacion.editarGrabada(json, { tipo: 'descartar', toma: id, descartada: true });
            t.ok(leer().tomas[0].descartada);
            t.ok(!fs.readFileSync(xml, 'utf8').includes('Cortar antes de esto'),
                'una toma descartada se va del XML entera');

            grabacion.editarGrabada(json, { tipo: 'descartar', toma: id, descartada: false });
            t.ok(fs.readFileSync(xml, 'utf8').includes('Cortar antes de esto'), 'y vuelve');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.group('notas en vivo · mover un borde de una clase ya grabada');

    /**
     * La misma clase, pero con las orillas que deja una grabación de verdad.
     *
     * Sin ellas no hay nada que repartir: son el texto de más que se leyó a cada
     * lado de la toma, y es lo único que hace que correr un borde después no
     * necesite volver a oír el audio.
     */
    function conOrillas() {
        const e = sesion();
        // La toma 1 va de los 10 s a los 25 s, y dijo diez palabras entre los
        // 10 s y los 13,4 s.
        e.tomas[0].antes = hablar(BASE, ['esperen@4', 'un@5', 'segundo@6', 'listo@7']);
        e.tomas[0].despues = hablar(BASE, ['Pausa@25', 'che@30', 'cortamos@34']);
        return e;
    }

    /** Los dos archivos de una clase escritos en un directorio de prueba. */
    function escribirClase(dir, estado) {
        const json = path.join(dir, '01_curso_2026-09-08_13-00-00_notas-en-vivo.json');
        fs.writeFileSync(json, JSON.stringify(notasXml.sidecar(estado)));
        return { json, xml: path.join(dir, '01_curso_2026-09-08_13-00-00.xml') };
    }

    t.test('correr el OUT reparte de nuevo las palabras que ya estaban', () => {
        // Es el corazón de todo esto: lo que se guardó al lado del XML es un rango
        // MÁS ANCHO que la toma, así que mover el borde adentro de ese rango es
        // volver a repartir las mismas palabras. No se relee nada y sale al
        // instante, con la clase cerrada igual que con la clase abierta.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-borde-out-'));
        try {
            const { json, xml } = escribirClase(dir, conOrillas());
            const leer = () => JSON.parse(fs.readFileSync(json, 'utf8')).tomas[0];
            const id = leer().id;

            grabacion.editarGrabada(json, { tipo: 'borde', toma: id, borde: 'out', paredMs: BASE + 13000 });

            const toma = leer();
            t.eq(toma.outMs, BASE + 13000);
            t.deep(toma.palabras.map(w => w.texto),
                ['Hoy', 'vamos', 'a', 'ver', 'Power', 'Query', 'desde', 'cero']);
            t.deep(toma.despues.slice(0, 2).map(w => w.texto), ['porque', 'importa'],
                'lo que salió de la toma pasa a la orilla: no se pierde, se puede volver');
            t.deep(toma.antes.map(w => w.texto), ['esperen', 'un', 'segundo', 'listo'],
                'y la orilla del otro lado queda como estaba');

            const escrito = fs.readFileSync(xml, 'utf8');
            t.ok(escrito.includes('OUT: Hoy vamos a ver Power Query desde cero'),
                'el cue de salida es el texto nuevo, que es lo que `align.js` busca en el Live-Mix');
            const bloque = rodecaster.parseFile(xml).blocks.filter(b => b.complete)[0];
            t.near(bloque.endSec, 13, 0.05, 'y el bloque termina donde quedó el borde');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('correr el IN mete en la toma lo que estaba en la orilla', () => {
        // El caso de verdad: el conteo se comió la primera frase y eso se ve
        // leyendo el guion, o sea con la clase ya cerrada.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-borde-in-'));
        try {
            const { json, xml } = escribirClase(dir, conOrillas());
            const leer = () => JSON.parse(fs.readFileSync(json, 'utf8')).tomas[0];
            const id = leer().id;

            grabacion.editarGrabada(json, { tipo: 'borde', toma: id, borde: 'in', paredMs: BASE + 5000 });

            const toma = leer();
            t.eq(toma.inMs, BASE + 5000);
            t.deep(toma.antes.map(w => w.texto), ['esperen']);
            t.deep(toma.palabras.slice(0, 4).map(w => w.texto), ['un', 'segundo', 'listo', 'Hoy']);
            t.eq(toma.palabras.length, 13);
            t.deep(Object.keys(toma.antes[0]), ['t', 'texto'],
                'y el archivo sigue guardando solo la hora y lo que se dijo');
            t.eq(toma.inISO, new Date(BASE + 5000).toISOString(), 'con la hora del día al día');

            const bloque = rodecaster.parseFile(xml).blocks.filter(b => b.complete)[0];
            t.near(bloque.startSec, 5, 0.05);
            t.eq(bloque.cueIn.startsWith('un segundo listo Hoy'), true, `cue: ${JSON.stringify(bloque.cueIn)}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('un borde más allá de lo guardado no se escribe a ciegas', () => {
        // Ahí no hay texto que respalde el borde. Escribirlo igual dejaría el
        // transcript y el cue diciendo lo de antes mientras el marcador dice otra
        // cosa, que es peor que no dejarlo: el cue es lo que reancla el bloque en
        // post. Para ir más lejos hay que volver a oír, y eso es "Regenerar".
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-borde-lejos-'));
        try {
            const { json } = escribirClase(dir, conOrillas());
            const leer = () => JSON.parse(fs.readFileSync(json, 'utf8')).tomas[0];
            const id = leer().id;
            const falla = cambio => {
                try { grabacion.editarGrabada(json, cambio); return ''; } catch (e) { return e.message; }
            };

            t.ok(/Regenerar/.test(falla({ tipo: 'borde', toma: id, borde: 'out', paredMs: BASE + 60000 })),
                'y el mensaje dice cómo seguir, no solo que no');
            t.ok(/Regenerar/.test(falla({ tipo: 'borde', toma: id, borde: 'in', paredMs: BASE })));
            t.eq(leer().outMs, BASE + 25000, 'nada se movió');
            t.eq(leer().inMs, BASE + 10000);

            // Una toma sin orillas —de un archivo escrito antes de que existieran—
            // se sigue pudiendo recortar por dentro, que es lo que su texto sostiene.
            const viejo = escribirClase(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-borde-viejo-')), sesion());
            grabacion.editarGrabada(viejo.json, { tipo: 'borde', toma: id, borde: 'out', paredMs: BASE + 12000 });
            t.eq(JSON.parse(fs.readFileSync(viejo.json, 'utf8')).tomas[0].outMs, BASE + 12000);
            fs.rmSync(path.dirname(viejo.json), { recursive: true, force: true });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('un borde que cruza al otro no explota: se queda donde estaba', () => {
        // Es un arrastre que se pasó, no un error de quien llama. La línea vuelve
        // a su sitio sola al repintar, igual que en la clase que se está grabando.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-borde-cruce-'));
        try {
            const { json } = escribirClase(dir, conOrillas());
            const id = JSON.parse(fs.readFileSync(json, 'utf8')).tomas[0].id;

            grabacion.editarGrabada(json, { tipo: 'borde', toma: id, borde: 'in', paredMs: BASE + 25000 });

            const toma = JSON.parse(fs.readFileSync(json, 'utf8')).tomas[0];
            t.eq(toma.inMs, BASE + 10000, 'el IN no se fue más allá del OUT');
            t.eq(toma.palabras.length, 10, 'ni se repartió nada');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('lo único que sigue afuera es reabrir, y dice qué hacer en su lugar', () => {
        // Reabrir es dejar la toma sin OUT para que el ciclo de señales le siga
        // metiendo palabras. Con la clase cerrada no hay ciclo, y una toma sin OUT
        // no llega al XML: el gesto la haría desaparecer, que es lo último que
        // espera quien lo pide. Lo que quiere decir es "que termine más adelante",
        // y eso ahora es arrastrar el OUT.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-editar-no-'));
        try {
            const { json } = escribirClase(dir, conOrillas());
            const id = JSON.parse(fs.readFileSync(json, 'utf8')).tomas[0].id;
            const falla = cambio => {
                try { grabacion.editarGrabada(json, cambio); return ''; } catch (e) { return e.message; }
            };

            t.ok(/línea roja/.test(falla({ tipo: 'reabrir', toma: id })));
            t.eq(JSON.parse(fs.readFileSync(json, 'utf8')).tomas[0].outMs, BASE + 25000,
                'y la toma sigue teniendo su OUT');
            t.ok(/inventado/.test(falla({ tipo: 'inventado', toma: id })), 'un tipo que no existe explota');
            t.ok(falla({ tipo: 'comentar', toma: 9999 }) !== '', 'y una toma que no existe tampoco');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('la carpeta en uso siempre está en la lista de carpetas, y primera', () => {
        // Es lo que hace que "elegir carpeta" sea guardar una sola clave, y que
        // quitar una carpeta de la lista no pueda dejar la activa afuera.
        const a = ajustes.sanear({ notasDir: '/cursos/b', notasDirs: ['/cursos/a', '/cursos/b', '/cursos/a'] });
        t.deep(a.notasDirs, ['/cursos/b', '/cursos/a']);
        t.deep(ajustes.sanear({ notasDir: '/cursos/b', notasDirs: [] }).notasDirs, ['/cursos/b']);
        t.deep(ajustes.sanear({ notasDirs: ['/cursos/a'] }).notasDirs, ['/cursos/a'], 'sin activa, quedan las recordadas');
        t.deep(ajustes.sanear({}).notasDirs, []);
    });

    t.group('notas en vivo · la forma de la carpeta');

    /** Una carpeta de notas de las de antes: todo suelto en la raíz. */
    function carpetaPlana(nombre, clases) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-${nombre}-`));
        fs.mkdirSync(path.join(dir, 'audio'));
        for (const [i, secuencia] of clases.entries()) {
            const estado = { ...sesion(), secuencia, clase: i + 1, ceroMs: BASE + i * 3600000 };
            estado.sesiones = [{ id: 1, archivo: path.join(dir, 'audio', `${secuencia}-1.wav`) }];
            fs.writeFileSync(path.join(dir, `${secuencia}_notas-en-vivo.json`),
                JSON.stringify(notasXml.sidecar(estado)));
            fs.writeFileSync(path.join(dir, `${secuencia}.xml`), notasXml.xmlDeNotas(estado));
            fs.writeFileSync(path.join(dir, 'audio', `${secuencia}-1.wav`), 'RIFF');
        }
        return dir;
    }

    t.test('una grabación nueva cae en xml/, con el audio y los datos abajo', () => {
        // El pedido del editor: en la raíz solo lo que él va a abrir. Con trece
        // clases, trece XML sueltos más trece JSON más el audio era un despelote.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-forma-'));
        try {
            const estado = grabacion.iniciar({ dir, clase: 4, curso: 'el-curso', sinReloj: true });
            grabacion.apagar();

            const suyos = workspace.notasArchivos(dir, estado.secuencia);
            t.ok(fs.existsSync(suyos.xml), 'el XML queda suelto dentro de xml/');
            t.eq(path.dirname(suyos.xml), path.join(dir, 'xml'));
            t.ok(fs.existsSync(suyos.json), 'y el archivo con la hora del día en xml/Datos');
            t.eq(path.dirname(suyos.json), path.join(dir, 'xml', 'Datos'));
            t.ok(fs.existsSync(path.join(dir, 'xml', 'Audio')), 'el WAV en xml/Audio');
            t.deep(fs.readdirSync(dir), ['xml'], 'y en la raíz no queda nada más');
        } finally {
            grabacion.apagar();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('una clase de las de antes se muda sola y no desaparece de la lista', () => {
        // Lo único que no se negocia. La lista de grabadas se arma leyendo el
        // disco, así que cambiar dónde se escribe sin mover lo que ya está haría
        // que las clases del editor parecieran borradas.
        const dir = carpetaPlana('muda', ['01_curso_2026-09-08_13-00-00', '02_curso_2026-09-08_15-00-00']);
        try {
            const lista = grabacion.listar([dir]);
            t.deep(lista.map(c => c.clase), [2, 1], 'las dos siguen ahí');
            t.eq(lista[0].carpeta, dir, 'y siguen siendo de la carpeta que eligió el editor');

            t.deep(fs.readdirSync(dir), ['xml'], 'la raíz quedó limpia');
            t.deep(fs.readdirSync(path.join(dir, 'xml')).sort(),
                ['01_curso_2026-09-08_13-00-00.xml', '02_curso_2026-09-08_15-00-00.xml', 'Audio', 'Datos']);
            t.eq(fs.readdirSync(path.join(dir, 'xml', 'Audio')).length, 2, 'el audio también bajó');
            t.eq(fs.readdirSync(path.join(dir, 'xml', 'Datos')).length, 2);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('y después de mudarse se sigue pudiendo editar, con su XML al lado', () => {
        // Mudarla no sirve de nada si el gesto que importa —cambiar una vista,
        // comentar una toma— deja de encontrar sus archivos.
        const dir = carpetaPlana('muda-editar', ['01_curso_2026-09-08_13-00-00']);
        try {
            const clase = grabacion.listar([dir])[0];
            const id = clase.tomas[0].id;
            grabacion.editarGrabada(clase.archivos.json,
                { tipo: 'nota', toma: id, texto: 'Cortar antes de esto' });

            t.eq(JSON.parse(fs.readFileSync(clase.archivos.json, 'utf8')).tomas[0].comentario,
                'Cortar antes de esto');
            t.ok(fs.readFileSync(clase.archivos.xml, 'utf8').includes('Cortar antes de esto'),
                'y el XML reescrito quedó donde la lista dice que está');
            t.deep(fs.readdirSync(dir), ['xml'], 'sin dejar nada suelto de vuelta en la raíz');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('lo que la mudanza no pudo mover se sigue viendo, y una sola vez', () => {
        // Una carpeta de solo lectura, un archivo abierto por otro programa, un
        // choque de nombres: la mudanza no pisa nada y deja lo que no pudo. Esa
        // clase tiene que seguir apareciendo, que es todo el punto de mirar
        // también la raíz.
        const dir = carpetaPlana('choque', ['01_curso_2026-09-08_13-00-00']);
        try {
            // El mismo nombre ya ocupado abajo: la de la raíz no se puede mudar.
            const ocupado = workspace.notasArchivos(dir, '01_curso_2026-09-08_13-00-00');
            fs.mkdirSync(path.dirname(ocupado.json), { recursive: true });
            fs.writeFileSync(ocupado.json, JSON.stringify(notasXml.sidecar(
                { ...sesion(), secuencia: '01_curso_2026-09-08_13-00-00', clase: 1, ceroMs: BASE })));

            const lista = grabacion.listar([dir]);
            t.eq(lista.length, 1, 'la misma clase en los dos pisos se muestra una vez');
            t.eq(lista[0].archivos.json, ocupado.json, 'y gana la de adentro, que es la que se reescribe');
            t.ok(fs.existsSync(path.join(dir, '01_curso_2026-09-08_13-00-00_notas-en-vivo.json')),
                'la de la raíz sigue donde estaba: no se pisa nada del editor');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('una clase que quedó en la raíz se edita en la raíz', () => {
        // No se la muda de contrabando en un gesto que se pidió para cambiar una
        // vista. Y sus dos archivos tienen que seguir encontrándose entre ellos.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-plana-'));
        try {
            const json = path.join(dir, '01_curso_2026-09-08_13-00-00_notas-en-vivo.json');
            fs.writeFileSync(json, JSON.stringify(notasXml.sidecar(sesion())));
            const id = JSON.parse(fs.readFileSync(json, 'utf8')).tomas[0].id;

            grabacion.editarGrabada(json, { tipo: 'nota', toma: id, texto: 'Cortar antes de esto' });
            const xml = path.join(dir, '01_curso_2026-09-08_13-00-00.xml');
            t.ok(fs.readFileSync(xml, 'utf8').includes('Cortar antes de esto'),
                'el XML se reescribe al lado del sidecar, no un piso abajo');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('mudar dos veces no mueve nada la segunda', () => {
        // Pasa en cada listado, así que tiene que ser barata y no tener nada que
        // hacer cuando ya está hecho.
        const dir = carpetaPlana('dos-veces', ['01_curso_2026-09-08_13-00-00']);
        try {
            t.deep(workspace.migrarNotas(dir), { clases: 1, audios: 1 });
            t.deep(workspace.migrarNotas(dir), { clases: 0, audios: 0 });
            t.deep(workspace.migrarNotas(path.join(dir, 'no-existe')), { clases: 0, audios: 0 },
                'y una carpeta que no está no explota');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    t.test('el sidecar sabe dónde está el resto de su clase, en los dos pisos', () => {
        // De este archivo cuelga todo lo demás: es lo único que recibe el puente
        // para abrir, regenerar o editar una clase ya grabada.
        const nueva = workspace.notasDeClase('/cursos/taller/xml/Datos/01_c_2026-09-08_13-00-00_notas-en-vivo.json');
        t.eq(nueva.base, '/cursos/taller');
        t.eq(nueva.xml, '/cursos/taller/xml/01_c_2026-09-08_13-00-00.xml');
        t.deep(nueva.audios, ['/cursos/taller/xml/Audio', '/cursos/taller/audio']);

        const vieja = workspace.notasDeClase('/cursos/taller/01_c_2026-09-08_13-00-00_notas-en-vivo.json');
        t.eq(vieja.base, '/cursos/taller');
        t.eq(vieja.xml, '/cursos/taller/01_c_2026-09-08_13-00-00.xml');
    });

};
