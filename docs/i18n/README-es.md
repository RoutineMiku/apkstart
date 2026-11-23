# Traducir ApkStart (guía en español)

Esta guía explica cómo funciona la traducción, qué archivos se tocan y cómo
comprobar que no rompes nada. Va dirigida a quien quiera añadir o mantener un
idioma; la explicación en chino está en [`docs/I18N.md`](../I18N.md).

## Cómo está montado

El chino sigue siendo el idioma de origen: las cadenas están en el código y
sirven de respaldo. La traducción se aplica **en la capa de presentación**:

| Pieza | Archivo | Qué hace |
|---|---|---|
| Diccionario | `src/i18n/locales/es-ES.json` | Pares `"texto en chino": "traducción"` |
| Motor | `src/i18n/engine.js` | Coincidencia exacta y plantillas con `${marcadores}` |
| Renderer | `src/ui/i18n.js` | Recorre el DOM y observa los cambios de `app.js` |
| Proceso principal | `src/i18n/index.js` | Traduce `dialog.*` y los menús nativos |
| Manual | `docs/USER-MANUAL.es.md` | Genera `src/ui/manual.es.html` |
| Informe | `scripts/i18n-report.js` | Dice cuánto queda sin traducir |

La ventaja: añadir un idioma no toca 2.000 llamadas repartidas por 30 archivos.
Solo se añade un JSON.

## Elegir idioma al ejecutar

```powershell
$env:APKSTART_LOCALE="es"; npm start   # fuerza español
npm start                              # sigue el idioma de Windows
```

Si el sistema está en chino (o no hay diccionario para ese idioma), la app se
comporta exactamente como antes.

## Añadir un idioma

1. Copia el diccionario: `src/i18n/locales/es-ES.json` → `locales/xx-XX.json`.
2. Traduce **solo los valores**. Las claves son el texto chino original: no se tocan.
   - Si la clave lleva `${algo}`, el valor debe conservar ese marcador (se puede
     reordenar dentro de la frase, pero no renombrar ni duplicar).
   - Conserva los espacios de los extremos, los `\n` y las etiquetas HTML.
   - No traduzcas los id de sección del manual (`6-4-adb-未授权-允许-usb-调试`):
     son anclas HTML que enlazan con `src/core/manual.js`.
3. Mira la cobertura: `npm run i18n:report -- --lang xx`.
   Con `-- --missing` obtienes una línea JSON por cadena pendiente.
4. Manual (opcional): traduce `docs/USER-MANUAL.es.md` a
   `docs/USER-MANUAL.xx.md`, añade una entrada `xx` en la tabla `L10N` de
   `docs/build-manual-html.py` y ejecuta
   `python docs/build-manual-html.py --lang xx`.
   Los anclajes se heredan del manual chino, así que `manual.js` no cambia.
5. `npm test` — incluye `test/i18n-test.js`, que verifica:
   - marcadores `${...}` idénticos entre clave y valor,
   - que no quede chino en las traducciones,
   - que todos los idiomas conserven los anclajes del manual y que no haya enlaces internos rotos,
   - que las tres páginas cargan el overlay y que `preload` expone el diccionario.

## Reglas de estilo

- Español de España neutro, tuteo, tono técnico y cercano.
- Interfaz: frases cortas; botones en imperativo ("Instalar", "Reintentar").
- Sin punto final en etiquetas, botones, títulos ni entradas de menú.
- Glosario obligatorio: [`GLOSARIO-es.md`](GLOSARIO-es.md). El mismo término chino
  debe dar siempre el mismo término español, aparezca en el archivo que aparezca.

## Qué no se traduce

- Nombres propios y productos: ApkStart, Android, Windows, adb, QEMU, WHPX,
  HypervisorPlatform, Microsoft Store, GitHub, Gitee, VC++, MSIX, AVD, APK…
- Comandos, rutas, variables de entorno, códigos de error (`0xC0000135`) y
  ejemplos de código.
- Las expresiones regulares de `src/core/*` que analizan la salida de Android
  (`/空间不足|ENOSPC/`, `/允许 USB 调试/`…). Son lógica, no texto: traducirlas
  rompe la detección de errores.

## Límites conocidos del overlay

Quedan en chino hasta que se envuelvan a mano con `i18n.t()`:

- notificaciones del sistema (`notify()` en `main.js`),
- títulos de ventana fijados con `setTitle()`,
- el tooltip del icono de la bandeja (`tray.setToolTip()`),
- registros, informes de diagnóstico y salida de consola (a propósito: son para depurar).

Las traducciones de esos textos ya están en el diccionario; solo falta el envoltorio.

## Flujo de contribución

1. Haz fork y una rama: `git checkout -b i18n/es`.
2. Modifica solo `src/i18n/locales/es-ES.json`, `docs/USER-MANUAL.es.md` y,
   si hace falta, `docs/build-manual-html.py`.
3. `npm test` en verde.
4. Captura de la interfaz en español (útil para la revisión).
5. Pull request con el formato de [CONTRIBUTING.md](../../CONTRIBUTING.md):
   `feat(i18n): añadir traducción al español`.
