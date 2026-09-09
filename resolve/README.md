# Class Cut en DaVinci Resolve

Los XML que genera Class Cut se importan en Resolve igual que en Premiere: los
clips caen en su lugar, los marcadores conservan su posición y su comentario, y
el audio entra entero.

Hay una sola cosa que no viaja: **el color de los clips**.

## Por qué

El formato de intercambio (FCP7 XML / xmeml) tiene un elemento `labels` para el
color de cada clip. Class Cut lo escribe —por eso en Premiere cada cámara aparece
con su color— pero **Resolve lo ignora al importar**. Está pedido como mejora en
el foro de Blackmagic y no está implementado, así que no es algo que se pueda
arreglar del lado del archivo.

Las paletas tampoco coinciden: los clips de Resolve son `Apricot, Beige, Blue,
Brown, Chocolate, Green, Lime, Navy, Olive, Orange, Pink, Purple, Tan, Teal,
Violet, Yellow`. "Cerulean" y "Rose", que son los dos primeros colores en
Premiere, en Resolve ni siquiera existen para clips: ahí son colores de marcador.

## La solución

`colorear-clips.py` hace por la API de scripting lo que el XML no puede.

1. Copiá el script a la carpeta de scripts de Resolve:

```bash
cp resolve/colorear-clips.py \
  ~/Library/Application\ Support/Blackmagic\ Design/DaVinci\ Resolve/Fusion/Scripts/Utility/
```

2. Importá el XML de Class Cut y abrí la timeline.
3. **Workspace › Scripts › colorear-clips**.

Tarda un segundo y deja los clips con el equivalente más cercano al color que
tienen en Premiere: la primera cámara en `Blue`, la segunda en `Pink`, y de ahí
en adelante `Orange`, `Green`, `Purple`…

El color se decide por el número con el que el Rodecaster nombra cada archivo
(`1_CAMERA 1.mp4`, `2_CAMERA 2.mp4`), que es el mismo en todas las clases, así
que una cámara tiene su color en el curso entero.

## Marcadores

Los marcadores sí llegan por XML, con el color que el director de contenido les
puso. Resolve los mapea al nombre más cercano de su propia paleta.

## Cuántas pistas de audio vas a ver

Más que grabaciones, y está bien. En este formato una pista de audio lleva **un
canal**, así que una fuente estéreo son dos pistas que el NLE vuelve a juntar al
importar. De las diez grabaciones del Rodecaster hay ocho estéreo y dos mono
(los COMBO, que son micrófonos), o sea dieciocho pistas en el archivo.

Premiere las junta y muestra diez. Resolve no las junta: muestra las dieciocho,
que es lo mismo que hace con cualquier XML exportado desde Premiere. Antes veías
diez porque el XML declaraba una sola pista por grabación —y por eso llegaba
solo el canal izquierdo de cada estéreo, el Live-Mix incluido—. Se ve más
cargado y suena entero, que es el cambio que importa.
