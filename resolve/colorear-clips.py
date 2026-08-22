#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
colorear-clips.py — Le pone a cada clip de la timeline el color de su fuente.

Por qué existe: el color de clip NO viaja en el XML. El formato de FCP7 tiene un
elemento `labels` y Class Cut lo escribe —Premiere lo lee y pinta cada cámara de
su color—, pero Resolve lo ignora al importar. Está pedido como mejora en el foro
de Blackmagic y sigue sin implementarse, así que del lado de Resolve la única vía
es la API de scripting.

Cómo usarlo:
  1. Copiar este archivo a
     ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/
  2. Importar el XML de Class Cut y abrir la timeline.
  3. Workspace › Scripts › colorear-clips

El color se decide por el número con el que el Rodecaster nombra cada fuente
(`1_CAMERA 1.mp4`, `2_CAMERA 2.mp4`), que es el mismo en todas las clases: así la
cámara 1 tiene el mismo color en el curso entero, igual que en Premiere.
"""

import re
import sys

# Mismo orden que las etiquetas del XML (Cerulean, Rose, Mango, Forest...), con
# el equivalente más cercano de la paleta de clips de Resolve, que es otra y no
# tiene ni "Cerulean" ni "Rose".
PALETA = ["Blue", "Pink", "Orange", "Green", "Purple", "Violet", "Teal", "Tan"]

PREFIJO = re.compile(r"^(\d{1,3})[_\s-]")


def indice_de_fuente(nombre, vistos):
    """El número que el Rodecaster le puso al archivo; si no tiene, el orden de aparición."""
    match = PREFIJO.match(nombre or "")
    if match:
        return int(match.group(1)) - 1
    if nombre not in vistos:
        vistos[nombre] = len(vistos)
    return vistos[nombre]


def nombre_del_clip(item):
    try:
        media = item.GetMediaPoolItem()
        if media:
            archivo = media.GetClipProperty("File Name")
            if archivo:
                return archivo
    except Exception:
        pass
    try:
        return item.GetName()
    except Exception:
        return ""


def main():
    try:
        import DaVinciResolveScript as dvr
        resolve = dvr.scriptapp("Resolve")
    except ImportError:
        resolve = globals().get("resolve")

    if not resolve:
        print("No encuentro Resolve. Corré esto desde Workspace › Scripts, no desde la terminal.")
        return 1

    proyecto = resolve.GetProjectManager().GetCurrentProject()
    if not proyecto:
        print("No hay ningún proyecto abierto.")
        return 1

    timeline = proyecto.GetCurrentTimeline()
    if not timeline:
        print("No hay ninguna timeline abierta.")
        return 1

    vistos = {}
    pintados = 0
    por_color = {}

    for pista in range(1, timeline.GetTrackCount("video") + 1):
        for item in timeline.GetItemListInTrack("video", pista) or []:
            nombre = nombre_del_clip(item)
            color = PALETA[indice_de_fuente(nombre, vistos) % len(PALETA)]
            try:
                if item.SetClipColor(color):
                    pintados += 1
                    por_color[color] = por_color.get(color, 0) + 1
            except Exception as error:
                print("No pude pintar %s: %s" % (nombre, error))

    if not pintados:
        print("No había clips de video en la timeline.")
        return 0

    detalle = ", ".join("%s: %d" % (c, n) for c, n in sorted(por_color.items()))
    print("Listo: %d clips pintados (%s)." % (pintados, detalle))
    return 0


if __name__ == "__main__":
    sys.exit(main())
