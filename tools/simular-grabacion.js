'use strict';
/**
 * simular-grabacion.js — Pasarle una clase ya grabada a la toma de notas en vivo.
 *
 *   node tools/simular-grabacion.js --wav=<Live-Mix.wav> [--minutos=8] [--clase=2] [--detalle]
 *
 * Es la única forma de probar esta herramienta sin un Rodecaster enchufado y sin
 * ponerse a contar "3, 2, 1" delante del micrófono. Lee el Live-Mix de una clase
 * de verdad, se lo mete al motor pedazo por pedazo como si estuviera entrando
 * ahora, y al final compara el XML que salió contra el que escribió el director
 * de contenido ese día — que es la respuesta correcta.
 *
 * **Por qué funciona aunque vaya cien veces más rápido.** Los tiempos no salen
 * de `Date.now()` sino de la posición en el audio: `grabacion.pcm` le da a cada
 * pedazo la hora que le toca por cuánto audio hay escrito antes, y `oir.escuchar`
 * convierte los tiempos de Whisper igual. Así, cuarenta minutos de clase se
 * pasan en unos minutos de reloj y las horas del día que salen son las que
 * habrían salido en vivo.
 *
 * Lo que NO prueba: que el micrófono se abra, que el dispositivo no se caiga y
 * que la pantalla dibuje. Eso es de la ventana.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const paths = require('../engine/paths');
const grabacion = require('../engine/grabacion');
const vivo = require('../engine/notas-vivo');
const rodecaster = require('../engine/rodecaster-xml');
const { arg, horaDelDia: hhmmss, mmss } = require('./lib/cli');

/** El mismo tamaño de pedazo que manda el capturador de la ventana. */
const MUESTRAS_POR_PEDAZO = 4096;
const TASA = 48000;

/** El WAV, pasado a 16 bits mono a la tasa que declara la captura. */
function aPcm(wav, segundos) {
    const ffmpeg = paths.ffmpeg();
    if (!ffmpeg.path) throw new Error('Falta ffmpeg.');
    const destino = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sim-')), 'in.raw');
    const args = ['-v', 'error', '-y', '-i', wav];
    if (segundos) args.push('-t', String(segundos));
    args.push('-ar', String(TASA), '-ac', '1', '-f', 's16le', destino);
    const r = spawnSync(ffmpeg.path, args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg falló: ${r.stderr}`);
    return destino;
}

/** Los bloques del XML que escribió el CD ese día: la respuesta correcta. */
function referencia(wavPath) {
    // El XML vive dos carpetas arriba del Live-Mix (`<clase>/Audio/Live-Mix.wav`).
    const dirClase = path.dirname(path.dirname(wavPath));
    const xml = fs.readdirSync(dirClase).find(n => n.toLowerCase().endsWith('.xml'));
    if (!xml) return null;
    const leido = rodecaster.parseFile(path.join(dirClase, xml));
    if (!leido.ok) return null;
    return {
        archivo: xml,
        clap: leido.clap ? leido.clap.seconds : null,
        bloques: leido.blocks.filter(b => b.complete).map(b => ({
            desde: b.startSec, hasta: b.endSec, vista: b.view
        }))
    };
}

/**
 * Cuánto se parecen dos listas de bloques.
 *
 * Se empareja por cercanía del arranque y no por posición en la lista: si la
 * herramienta se pierde una toma, comparar el tercero con el tercero haría que
 * todo lo de atrás pareciera mal cuando en realidad está corrido uno.
 */
function comparar(salieron, esperados, ceroSec) {
    const filas = [];
    const libres = salieron.map((b, i) => ({ ...b, i, usado: false }));

    for (const esperado of esperados) {
        let mejor = null;
        for (const cand of libres) {
            if (cand.usado) continue;
            const dist = Math.abs((cand.desde - ceroSec) - esperado.desde);
            if (!mejor || dist < mejor.dist) mejor = { cand, dist };
        }
        if (mejor && mejor.dist < 30) {
            mejor.cand.usado = true;
            filas.push({
                esperado,
                salio: mejor.cand,
                dIn: (mejor.cand.desde - ceroSec) - esperado.desde,
                dOut: (mejor.cand.hasta - ceroSec) - esperado.hasta
            });
        } else {
            filas.push({ esperado, salio: null, dIn: null, dOut: null });
        }
    }
    const sobrantes = libres.filter(c => !c.usado);
    return { filas, sobrantes };
}

async function main() {
    const wav = arg('wav');
    if (!wav) {
        console.error('Falta --wav=<ruta al Live-Mix.wav>');
        process.exit(1);
    }
    const minutos = Number(arg('minutos', '8'));
    const clase = Number(arg('clase', '1'));
    const dir = arg('dir', fs.mkdtempSync(path.join(os.tmpdir(), 'cc-notas-vivo-')));
    const detalle = process.argv.includes('--detalle');

    console.log(`Audio:   ${wav}`);
    console.log(`Minutos: ${minutos}`);
    console.log(`Salida:  ${dir}\n`);

    console.log('Convirtiendo el audio…');
    const raw = aPcm(wav, minutos * 60);
    const pcm = fs.readFileSync(raw);
    const totalMuestras = Math.floor(pcm.byteLength / 2);
    console.log(`  ${mmss(totalMuestras / TASA)} de audio, ${totalMuestras.toLocaleString('es')} muestras\n`);

    const eventos = [];
    const estado = grabacion.iniciar({
        dir,
        clase,
        curso: 'simulacion',
        sampleRate: TASA,
        canales: 1,
        sinReloj: true,
        avisar: aviso => {
            if (aviso.oyendo !== undefined) {
                // Con `--detalle` se ve qué oyó cada pasada del ciclo de señales.
                // Es lo que hace falta para entender una toma que no se abrió:
                // sin esto, "faltan dos tomas" no dice si el problema es que no se
                // oyó el conteo o que se oyó y no se reconoció.
                if (detalle) console.log(`\n  oyendo: ${aviso.oyendo || '(nada)'}`);
            }
            if (aviso.tipo === 'golpe') eventos.push(`golpe a las ${hhmmss(aviso.ms)}`);
            if (aviso.tipo === 'error') eventos.push(`ERROR: ${aviso.mensaje}`);
            for (const ev of aviso.eventos || []) {
                eventos.push(`toma ${ev.toma} ${ev.tipo}${ev.por ? ` (${ev.por})` : ''}`);
                if (detalle) console.log(`     → toma ${ev.toma} ${ev.tipo}${ev.por ? ` (${ev.por})` : ''}`);
            }
        }
    });
    const ceroSec = estado.ceroMs / 1000;

    // De a pedazos, empujando el ciclo de señales cada vez que hay bastante audio
    // nuevo: es lo que el reloj haría en vivo cada tres segundos.
    const bytesPorPedazo = MUESTRAS_POR_PEDAZO * 2;
    const pedazosPorCiclo = Math.round(grabacion.CICLO_MS / 1000 * TASA / MUESTRAS_POR_PEDAZO);
    let pedazos = 0;
    const arranque = Date.now();

    for (let off = 0; off < pcm.byteLength; off += bytesPorPedazo) {
        grabacion.pcm(pcm.subarray(off, Math.min(off + bytesPorPedazo, pcm.byteLength)));
        pedazos++;
        if (pedazos % pedazosPorCiclo === 0) {
            await grabacion.buscarSenales();
            const hecho = off / pcm.byteLength;
            const ahora = grabacion.resumen();
            if (!detalle) process.stdout.write(
                `\r  ${(hecho * 100).toFixed(0)}% · ${mmss(off / 2 / TASA)} de audio · ` +
                `${ahora.tomas.length} tomas · ${Math.round((Date.now() - arranque) / 1000)}s de reloj   `);
        }
    }
    await grabacion.buscarSenales();
    process.stdout.write('\n\n');

    // Como en vivo: cierra la toma abierta y la relee con el modelo grande antes
    // de soltar la sesión, así que el texto de la última toma es el bueno.
    const final = await grabacion.terminar();
    fs.rmSync(path.dirname(raw), { recursive: true, force: true });

    console.log('Lo que pasó:');
    for (const ev of eventos) console.log(`  ${ev}`);
    if (!eventos.length) console.log('  (nada: ni un golpe ni una señal)');

    console.log(`\nClaqueta: ${final.claqueta
        ? `${hhmmss(final.claqueta.ms)} · ${final.claqueta.confirmada ? 'confirmada' : 'SIN confirmar'} · «${final.claqueta.frase}»`
        : 'no se encontró'}`);

    console.log(`\nTomas (${final.tomas.length}):`);
    for (const t of final.tomas) {
        const dur = t.outMs ? (t.outMs - t.inMs) / 1000 : 0;
        console.log(`  ${t.id}. ${hhmmss(t.inMs)} → ${t.outMs ? hhmmss(t.outMs) : '—'} (${mmss(dur)}) ` +
            `${t.vista}${t.descartada ? ' [descartada]' : ''}${t.cerradaSola ? ' [cerrada sola]' : ''}`);
        console.log(`     conteo: «${t.cuenta}»`);
        const texto = (t.palabras || []).map(w => w.texto).join(' ');
        console.log(`     ${texto.slice(0, 150)}${texto.length > 150 ? '…' : ''}`);
    }

    // ── Contra lo que escribió el CD ese día ──
    const ref = referencia(wav);
    if (!ref) {
        console.log('\nSin XML del CD al lado del audio: no hay con qué comparar.');
    } else {
        console.log(`\nContra ${ref.archivo}:`);
        const dentro = ref.bloques.filter(b => b.desde < minutos * 60);
        const salieron = vivo.tomasQueQuedan({ tomas: final.tomas })
            .map(t => ({ desde: t.inMs / 1000, hasta: t.outMs / 1000, vista: t.vista }));

        if (ref.clap != null && final.claqueta) {
            console.log(`  claqueta: el CD la puso en ${mmss(ref.clap)}, ` +
                `acá cayó en ${mmss(final.claqueta.ms / 1000 - ceroSec)}`);
        }

        const { filas, sobrantes } = comparar(salieron, dentro, ceroSec);
        for (const f of filas) {
            if (!f.salio) {
                console.log(`  ✗ ${mmss(f.esperado.desde)} → ${mmss(f.esperado.hasta)} ${f.esperado.vista}: no se abrió`);
                continue;
            }
            const signo = n => `${n >= 0 ? '+' : ''}${n.toFixed(1)}s`;
            console.log(`  ✓ ${mmss(f.esperado.desde)} → ${mmss(f.esperado.hasta)} ${f.esperado.vista}` +
                `   IN ${signo(f.dIn)}   OUT ${signo(f.dOut)}`);
        }
        for (const s of sobrantes) {
            console.log(`  + toma de más en ${mmss(s.desde - ceroSec)} → ${mmss(s.hasta - ceroSec)}`);
        }

        const acertadas = filas.filter(f => f.salio).length;
        console.log(`\n  ${acertadas} de ${dentro.length} bloques encontrados` +
            `${sobrantes.length ? `, ${sobrantes.length} de más` : ''}`);
    }

    console.log(`\nEl XML quedó en ${final.archivos.xml}`);
}

main().catch(err => {
    console.error(err.stack);
    process.exit(1);
});
