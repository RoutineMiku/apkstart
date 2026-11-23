# Manual de uso y solución de problemas de ApkStart

> Versión: v0.6.4 · Plataforma: Windows 10/11 x64 · Actualización: 2026-11-22
>
> ApkStart es un ejecutor de aplicaciones Android en Windows: **hace que las aplicaciones Android se instalen como software nativo de Windows, aparezcan en el escritorio y funcionen con doble clic.**
> Este manual te enseña primero cómo usarlo y después da soluciones que puedes seguir al pie de la letra según el «síntoma». Todos los pasos corresponden a botones y menús que existen realmente en el programa.

---

## Índice

1. [ApkStart en 30 segundos](#1-apkstart-en-30-segundos)
2. [Instalación y primer arranque](#2-instalación-y-primer-arranque)
3. [Uso diario](#3-uso-diario)
4. [Entender los tres conceptos básicos (la clave para leer los errores)](#4-entender-los-tres-conceptos-básicos-la-clave-para-leer-los-errores)
5. [Si tienes un problema, haz esto primero: comprobación del equipo y detección automática](#5-si-tienes-un-problema-haz-esto-primero-comprobación-del-equipo-y-detección-automática)
6. [Soluciones a problemas frecuentes](#6-soluciones-a-problemas-frecuentes)
   - [6.1 Aviso «aceleración por hardware no habilitada» / arranque muy lento](#61-aviso-aceleración-por-hardware-no-habilitada--arranque-muy-lento)
   - [6.2 Fallo de instalación (INSTALL_FAILED_*)](#62-fallo-de-instalación-install_failed_)
   - [6.3 La imagen del sistema no tiene capa de traducción ARM / las aplicaciones ARM no se instalan o se cierran](#63-la-imagen-del-sistema-no-tiene-capa-de-traducción-arm--las-aplicaciones-arm-no-se-instalan-o-se-cierran)
   - [6.4 adb sin autorizar (permitir depuración USB)](#64-adb-sin-autorizar-permitir-depuración-usb)
   - [6.5 El icono no responde al doble clic / se queda cargando / aparece una ventana con botón de rotación](#65-el-icono-no-responde-al-doble-clic--se-queda-cargando--aparece-una-ventana-con-botón-de-rotación)
   - [6.6 Tabla rápida de otros problemas de arranque](#66-tabla-rápida-de-otros-problemas-de-arranque)
   - [6.7 La aplicación no tiene sonido / suena muy bajo](#67-la-aplicación-no-tiene-sonido--suena-muy-bajo)
   - [6.8 Fallo de arranque en la versión de Store / 0xC0000135 (fallo al cargar DLL)](#68-fallo-de-arranque-en-la-versión-de-store--0xc0000135-fallo-al-cargar-dll)
   - [6.9 La aplicación no usa el micrófono / no se pueden hacer llamadas ni grabar voz](#69-la-aplicación-no-usa-el-micrófono--no-se-pueden-hacer-llamadas-ni-grabar-voz)
   - [6.10 Renderizado con gráfica dedicada / integrada (preferencia de tarjeta gráfica)](#610-renderizado-con-gráfica-dedicada--integrada-preferencia-de-tarjeta-gráfica)
7. [Referencia de línea de comandos](#7-referencia-de-línea-de-comandos)
8. [Datos y directorios](#8-datos-y-directorios)
9. [Obtener ayuda y comentarios](#9-obtener-ayuda-y-comentarios)

---

## 1. ApkStart en 30 segundos

```
Icono del escritorio (icono real de la aplicación .lnk)
      │ doble clic
      ▼
ApkStart.exe --launch <nombre del paquete>
      │ ¿entorno de ejecución de Android apagado? → se inicia solo (emulador Android 14, incluido en el paquete o descargado la primera vez)
      ▼
Abre la aplicación por el punto de entrada que resuelve el sistema (no la Activity principal escrita a fuego en el APK)
      ▼
Ventana del emulador = ventana de la aplicación (título, icono, proporción vertical, pantalla completa centrada)
```

**Sus características**

- 🖱️ **Doble clic en un .apk para instalar**: una vez registrada la asociación de archivos en el Explorador, doble clic en el APK → análisis automático → instalación → creación del icono del escritorio.
- 🧩 **Un icono del escritorio por aplicación**: el icono se extrae del interior del APK sin conexión; doble clic en el icono = entrar directamente en la aplicación.
- 🪟 **La aplicación es una ventana**: renderizado nativo, ocupa toda la altura de la pantalla y se centra; en modo ventana se puede arrastrar y redimensionar, y cada aplicación recuerda su tamaño por separado.
- 🔍 **Windows la puede encontrar**: acceso directo doble, en el escritorio y en el menú Inicio (`Programas\ApkStart\`).
- 📁 **Datos compartidos**: sincronización bidireccional entre `%USERPROFILE%\ApkStartShared` y `/sdcard/ApkStartShared` dentro de Android.
- 🪶 **Entorno de ejecución propio**: no depende de ningún emulador instalado en tu equipo, como MuMu / LDPlayer / WSA.

> Nota: este proyecto está en una fase temprana, lo mantiene el autor en su tiempo libre, es de código abierto, gratuito y sin publicidad. Es normal encontrarse con problemas; para eso está este manual.

---

## 2. Instalación y primer arranque

### 2.1 Elige la versión que te conviene

Los dos orígenes tienen el mismo contenido; desde China se recomienda Gitee:

- GitHub: `github.com/RoutineMiku/apkstart/releases`
- Gitee: `gitee.com/daily-miku/apkstart/releases` (la conexión directa desde China es mucho más rápida)

| Formato | Nombre del archivo | Cuándo elegirlo |
|---|---|---|
| **Versión de Store** | `ApkStart_<versión en cuatro partes>_x64.msix` | Se instala desde Microsoft Store. Incluye el entorno de ejecución completo; tras instalar no necesita conexión y las actualizaciones las gestiona la Store |
| **Versión portátil completa** | `ApkStart-v*-win64-full.zip` (unos 830 MB, ~1,3 GB descomprimido) | No quieres instalar ni esperar una descarga: se descomprime y se usa, el entorno de ejecución va entero en el paquete |
| **Versión instalable** | `ApkStart-v*-Setup.exe` (unos 1,3 GB) | Quieres accesos directos en el escritorio y el menú Inicio, y una entrada de desinstalación |
| **Versión portátil ligera** | `ApkStart-v*-win64-portable.zip` (96 MiB, ~227 MB descomprimido) | Solo quieres probarlo primero: el entorno de ejecución se descarga en el primer arranque |

> ⚠️ **Usa siempre la última versión (actualmente 0.6.4)**. Las versiones antiguas (0.5.x y anteriores) o no incluyen el entorno de ejecución y en cada arranque lo buscan o descargan (1,5 GB), o usan por defecto la ventana integrada; esa es justo la causa típica de «va muy lento, no abre, sale una ventana con botón de rotación». Si actualizas desde una versión antigua, comprueba que el icono del escritorio apunta al directorio del programa nuevo.

### 2.2 Qué ocurre en el primer arranque

1. **(solo la versión ligera) Descarga del entorno de ejecución**: adb, Android Emulator y la imagen del sistema Android 14; con la fuente oficial se han medido más de 10 MB/s, con descarga en 8 hilos por bloques y reanudación. Las versiones completa y de Store se saltan este paso.
2. **Primera descompresión de la imagen**: la imagen xz se descomprime en `%APPDATA%\apkstart\system-images` (unos 20 segundos, solo una vez).
3. **Primera creación de `/data`**: ApkStart genera sus propios datos de usuario ext4 con cifrado y etiquetas SELinux (en la imagen oficial solo hay un marcador de 1 MB).
4. **Arranque automático del sistema**: a partir de ahí, abrir una aplicación se reduce a un `am start`; el arranque en frío tarda unos 23 segundos y, si acierta con la instantánea, unos 10.

> Que el primer arranque sea lento es normal, es un "coste único". Después entrarás en segundos.

---

## 3. Uso diario

### 3.1 Instalar aplicaciones

Elige uno de los tres métodos:

- **Doble clic en el archivo APK** (antes registra la asociación: Ajustes → Integración del sistema → Asociar archivos .apk);
- En la ventana principal, elige «Instalar aplicación»;
- Línea de comandos: `ApkStart.exe <ruta\a.apk>`.

Admite paquetes divididos `.apks` / `.xapk` (usa `install-multiple` automáticamente). Al terminar se crean automáticamente los accesos directos del escritorio y del menú Inicio.

### 3.2 Abrir aplicaciones

Haz doble clic en el icono del escritorio. Todas las aplicaciones comparten el mismo entorno de ejecución, así que **la segunda aplicación arranca casi al instante**.

### 3.3 Ventanas y pantalla

| Acción | Cómo |
|---|---|
| Alternar pantalla completa / ventana | `F11` o el menú del botón derecho en la bandeja del sistema. La pantalla completa solo amplía la ventana, no cambia la proporción de la imagen |
| Girar horizontal/vertical | `Ctrl+Alt+R` (global) o el botón de rotación de la barra de título; la orientación se recuerda para esa aplicación |
| Pantalla completa automática | Ajustes → Pantalla y ventanas → Pantalla completa automática (funciona mejor junto con "Forzar orientación") |
| Forzar horizontal/vertical | Ajustes → Pantalla y ventanas → Orientación de pantalla |

> Solo se reinicia el entorno de ejecución en el caso en que "la orientación del panel y la de la aplicación no coinciden" (unos 40 segundos, la barra de título avisa); las aplicaciones con la misma orientación entran después en segundos.

### 3.4 Atajos de teclado

| Tecla | Función |
|---|---|
| `F11` | Alternar pantalla completa / modo ventana |
| `Ctrl+Alt+R` | Girar la aplicación actual entre horizontal y vertical |
| `Ctrl+R` | Rotar dentro de la ventana contenedora (en modo ventana nativa usa `Ctrl+Alt+R`) |

### 3.5 Archivos compartidos (Windows ↔ Android)

El `%USERPROFILE%\ApkStartShared` del equipo y `/sdcard/ApkStartShared` dentro de Android se sincronizan en ambos sentidos en segundos.
Dónde: Ajustes → Integración y archivos → Archivos compartidos (puedes "Sincronizar ahora" o "Abrir carpeta").

### 3.6 Navegación por los Ajustes

Desde la 0.6.0 se divide en ocho categorías, con un cuadro de búsqueda arriba (escribe palabras clave como "horizontal", "memoria" o "proxy" y busca en todas las categorías):

| Categoría | Contenido principal |
|---|---|
| General e instalación | Entorno de ejecución, Configuración automática, inicio automático con el sistema, uso de disco y limpieza |
| Pantalla y ventanas | Modo de visualización, pantalla completa automática, orientación de pantalla, diseño de tableta, modo de alojamiento de la ventana |
| Controles y entrada | Asignación de botones del ratón, mapeo de teclado |
| Rendimiento y recursos | Política de recursos, preferencia de tarjeta gráfica (dedicada/integrada), micrófono, calidad de imagen, partición de datos, idioma del sistema, instantáneas, precalentamiento del arranque |
| Red y descargas | Actualizaciones y fuentes de descarga, espejos de aceleración, número de hilos de descarga |
| Diagnóstico y reparación | Comprobación del equipo, controladores/parches de compatibilidad, detección automática |
| Integración y archivos | Escritorio y aplicaciones, archivos compartidos, integración del sistema |
| Actualizaciones y acerca de | Actualizaciones del software, Acerca de |
| Laboratorio | Varias ventanas nativas de Windows con varias instancias (experimental), número de aplicaciones retenidas en segundo plano |

> **Laboratorio · Varias instancias (experimental)**: al activarlo, una aplicación nueva ya no cierra a la anterior; varias aplicaciones pueden quedar en segundo plano, volver a ellas cuando quieras y conservar la sesión iniciada. Como el entorno de ejecución de Android solo tiene una ventana de emulador, en cada momento sigue habiendo una sola aplicación visible en primer plano; no son ventanas realmente en paralelo. Activarlo aumenta el consumo de memoria. Está desactivado por defecto; si buscas estabilidad, ignóralo.

### 3.7 Actualizaciones en línea

Ajustes → Actualizaciones y acerca de → Buscar actualizaciones, o clic derecho en la bandeja del sistema → Buscar actualizaciones. La cadena de actualización mide en el momento y elige la fuente más rápida (GitHub / Gitee / espejo), descarga en bloques en paralelo y cambia de fuente automáticamente si falla. Actualizar no hace perder el entorno de ejecución, las aplicaciones instaladas ni las instantáneas.

Las versiones portátiles nuevas admiten **actualizaciones incrementales**: en cada publicación se publica además un «manifiesto de código» y un paquete pequeño que solo contiene el código del programa (unos pocos MB, frente a los aproximadamente 100 MB del paquete completo). Si la versión de tu envoltorio Electron no ha cambiado, la actualización descarga solo ese paquete pequeño, verifica archivo por archivo y sustituye el código del programa en unos segundos; si el envoltorio ha cambiado, falta el manifiesto o falla cualquier verificación, se vuelve automáticamente a la descarga del paquete completo, así que la actualización no puede dejar el programa inservible. La versión de Store la sigue actualizando Microsoft Store.

> Nota: solo pasan por la actualización incremental quienes instalan la versión portátil desde GitHub / Gitee con «Buscar actualizaciones»; lo instalado desde Microsoft Store usa el canal de la Store. La actualización incremental no afecta a las aplicaciones instaladas, los datos de Android, el entorno de ejecución ni las instantáneas.

---

## 4. Entender los tres conceptos básicos (la clave para leer los errores)

La raíz de la mayoría de los problemas "raros" está en una de estas tres cosas. Dedica un minuto a entenderlas y el diagnóstico posterior irá sobre ruedas.

### 4.1 Entorno de ejecución / imagen del sistema

ApkStart no emula un "Android vacío", sino que carga una **imagen del sistema Android 14 completa** como base.
La 0.6.3 tiene **una única imagen genérica** (Google Play x86_64) y con ella funcionan tanto las aplicaciones x86 como las ARM; ya no se divide en dos juegos, "imagen AOSP / imagen de compatibilidad", como las versiones antiguas.

- Imagen ausente / dañada / incompatible con los datos de usuario antiguos → fallo del arranque del sistema, bloqueo durante el arranque o reinicios repetidos.
- Los datos de usuario (`/data`) son una capa diferencial fina; la imagen del sistema se comparte una sola vez en todo el equipo.

### 4.2 Aceleración por hardware

Para que el emulador vaya rápido hace falta aceleración de virtualización de la CPU. En Windows solo hay dos caminos:

| Método | Qué es | Quién necesita administrador | ¿Hay que reiniciar al instalar? |
|---|---|---|---|
| **WHPX** | Función integrada de Windows "Plataforma de hipervisor de Windows" (HypervisorPlatform) | Al activar esta función | Sí |
| **AEHD** | Controlador de kernel propio de Google | Al instalar el controlador | No |

**También funciona sin aceleración** (emulación por software pura, TCG), solo que el arranque del sistema tarda varios minutos y la imagen pierde fotogramas con facilidad; eso es "lentitud", no "fallo de arranque". ApkStart retrocede automáticamente y reintenta con hasta 4 combinaciones de parámetros siguiendo el orden "backend de renderizado → método de aceleración → memoria/arranque en frío".

> No confundas **VirtualMachinePlatform** (la que usa WSL2) con el interruptor de aceleración. El emulador necesita **HypervisorPlatform**. Si solo activas la primera, `emulator -accel-check` seguirá diciendo que no está disponible.

### 4.3 Capa de traducción ARM

La gran mayoría de las aplicaciones Android chinas solo ofrecen **bibliotecas nativas ARM** (arm64-v8a / armeabi-v7a), mientras que la imagen del sistema es **x86_64**: hace falta una "capa de traducción" que convierta las instrucciones ARM para la CPU x86. La imagen genérica de la 0.6.3 incluye la nueva capa de traducción `ndk_translation`, así que instalar aplicaciones ARM normalmente no requiere ningún ajuste.

- La primera vez que aparece una aplicación ARM, si el componente de traducción aún no está listo, ApkStart completa la imagen de compatibilidad y reinicia el entorno de ejecución para reintentar (ver 6.3).
- Las imágenes antiguas (API 30) tienen problemas de compatibilidad con la nueva capa de traducción (por ejemplo, las aplicaciones de ByteDance provocan un SIGABRT con `DoBadTrampoline`); la imagen Android 14 ya lo corrige.

---

## 5. Si tienes un problema, haz esto primero: comprobación del equipo y detección automática

Antes de rebuscar en este manual, deja que el programa haga su propia comprobación: la mayoría de los problemas los puede corregir solo.

### 5.1 Comprobación del equipo · Configuración automática

Dónde: Ajustes → Diagnóstico y reparación → **Iniciar comprobación**

- Qué comprueba: si la virtualización de la CPU (VT-x/SVM) está activada, si Hyper-V/la plataforma de hipervisor está disponible, tarjeta gráfica/memoria de vídeo/controlador, memoria, versión del sistema, `emulator -accel-check` y el controlador AEHD.
- Pulsa «**Aplicar configuración recomendada**» para escribir automáticamente valores seguros: memoria / número de núcleos / resolución de renderizado / calidad de imagen / forzar emulación por software cuando no hay aceleración; se guardan como un perfil de este equipo que se aplicará solo en adelante.
- Niveles del resultado: `ok` (correcto) / `warn` (funciona pero conviene optimizar) / `bad` (sin resolverlo no arranca). Cada uno tiene color y explicación.

Solo hay dos cosas que debes hacer tú mismo:
- **Virtualización en la BIOS**: reinicia y entra en la BIOS → activa Intel VT-x / AMD SVM → Enabled (esto el programa no puede hacerlo por ti).
- **Funciones de Windows / controlador de aceleración**: ver 6.1.

### 5.2 Detección automática (depuración automática)

Dónde: Ajustes → Diagnóstico y reparación → «Detección automática · Diagnóstico inteligente»

En segundo plano revisa el equipo cada 10 minutos, agrupa los problemas en seis categorías y cada uno se puede **resolver con un clic** (reiniciar el entorno de ejecución, limpiar bloqueos, cerrar procesos huérfanos, invalidar instantáneas, liberar disco, restablecer la red de Android…); al terminar vuelve a comprobar de forma automática:

| Categoría | Problemas que cubre |
|---|---|
| Entorno de ejecución | La causa real del último fallo de arranque, bloqueo durante el arranque, archivos de bloqueo residuales, procesos de emulador huérfanos, instantáneas vacías, ausencia de aceleración por hardware |
| Conexión del dispositivo | adb sin autorizar, offline, entorno de ejecución activo pero adb no ve el dispositivo |
| Almacenamiento | Espacio libre en disco, configuración de la partición de datos que no coincide con la realidad, carpeta compartida sin permiso de escritura |
| Ajustes | Orientación de pantalla en conflicto con el panel físico, pantalla completa automática que no surte efecto en ventana independiente |
| Red/registro | Sin red en el lado Android, fuente de descarga inaccesible, errores del registro reciente |

> Dos principios: un fallo de sondeo no se trata como problema (si no se puede obtener el estado se informa de "no lo sé", nunca se inventa); un mismo problema antiguo no vuelve a molestar.

### 5.3 Exportar informe de diagnóstico

Dónde: Ajustes → Diagnóstico y reparación → **Exportar informe de diagnóstico** (o el botón con el mismo nombre en la página de integración del sistema)

El informe es texto plano e incluye la configuración del equipo, los parámetros de arranque elegidos automáticamente, los registros y las conclusiones del diagnóstico. Adjúntalo al informar de un problema: acelera mucho la localización.

### 5.4 Manual de uso integrado y guías automáticas

Desde la 0.6.3 este manual está **integrado en el programa**: se abre directamente con el botón «?» de la barra de título de la ventana principal o con «Abrir manual de uso» en Ajustes → Acerca de, y permite buscar, desplazarse e imprimir o guardar en PDF. Al abrirlo se coloca automáticamente en el capítulo relacionado con el fallo actual.

La detección y la reparación automáticas también te acercan la guía:

- Cuando la detección automática encuentra un problema, a la derecha de la entrada hay un botón «Guía» que abre directamente el capítulo correspondiente;
- En problemas como aceleración por hardware, fallo de instalación, capa de traducción ARM, autorización de adb o falta de sonido, **si la reparación automática falla se abre sola la guía correspondiente**; no hace falta venir a buscarla aquí;
- Una misma guía se abre automáticamente una sola vez por sesión, así que no te interrumpe una y otra vez.

> Para abrirla a mano: botón `?` de la barra de título. Si quieres desactivar temporalmente la apertura automática, desactiva las notificaciones en los ajustes de detección automática; la guía seguirá disponible desde el botón «Guía» de cada problema.

---

## 6. Soluciones a problemas frecuentes

### 6.1 Aviso «aceleración por hardware no habilitada» / arranque muy lento

**Síntoma**: en Ajustes/Diagnóstico aparece "ahora mismo no hay aceleración por hardware" o "aceleración por hardware no disponible"; el arranque del sistema tarda varios minutos y la imagen pierde fotogramas.

**Antes de nada**: normalmente esto es "lentitud", no "no abre". ApkStart ya retrocede a la emulación por software. Solo necesitas activar la aceleración si quieres fluidez.

**Según tu versión:**

- **Versión instalable / portátil**: Ajustes → Diagnóstico y reparación → Comprobación del equipo → busca «Aceleración por hardware no habilitada» → pulsa **Reparar**. Aparecerá un UAC una vez y se activará WHPX automáticamente; si no se puede activar (el sistema no lo admite o has dicho que no), se instalará en su lugar el controlador AEHD.
- **Versión de Microsoft Store (MSIX)**: las aplicaciones de la Store **no pueden elevar privilegios por sí mismas**; al pulsar «Reparar» se abre el diálogo «Activar o desactivar las características de Windows»:
  1. Marca **«Plataforma de hipervisor de Windows» (HypervisorPlatform)**;
  2. Acepta y **reinicia el equipo** una vez.

  También puedes ejecutarlo en **PowerShell como administrador**:

  ```powershell
  dism /online /enable-feature /featurename:HypervisorPlatform /all /norestart
  dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
  ```

> Dos trampas: ① no actives solo VirtualMachinePlatform, esa no es la aceleración que necesita el emulador; ② si VT-x/SVM no está activado en la BIOS, actívalo primero entrando en la BIOS como se explica en 5.1, porque de lo contrario activar la función del sistema no sirve de nada.
> Si el controlador de la tarjeta gráfica tiene más de 3 años, actualízalo desde la web del fabricante; eso sí, ApkStart no instala controladores automáticamente (instalar el equivocado es peor). Algunas tarjetas gráficas antiguas o gráficas integradas necesitan un parche de compatibilidad; consulta Ajustes → Diagnóstico y reparación → Controladores · Parches de compatibilidad.

---

### 6.2 Fallo de instalación (INSTALL_FAILED_*)

**Síntoma**: al instalar una aplicación sale un error; el texto suele empezar por "Fallo de instalación:" y termina con un código de error `INSTALL_*`.

ApkStart traduce al chino el error original en inglés. Consulta la tabla:

| Código de error | Significado | Qué hacer |
|---|---|---|
| `INSTALL_FAILED_NO_MATCHING_ABIS` | La aplicación solo ofrece bibliotecas ARM y la imagen actual no tiene capa de traducción ARM | **Normalmente se resuelve solo**: ApkStart cambia a la imagen de compatibilidad y reintenta. Detalles en [6.3](#63-la-imagen-del-sistema-no-tiene-capa-de-traducción-arm--las-aplicaciones-arm-no-se-instalan-o-se-cierran) |
| `INSTALL_FAILED_OLDER_SDK` | La aplicación exige una versión de Android más alta | Haría falta una imagen del sistema más nueva; la actual es Android 14 (API 34), así que apenas se da |
| `INSTALL_PARSE_FAILED_NO_CERTIFICATES` | El APK no tiene una firma válida | El APK está dañado o no es un paquete oficial; consigue de nuevo el paquete |
| `INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES` / `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | La firma no coincide con la de la versión instalada | Desinstala la versión antigua y vuelve a instalar |
| `INSTALL_FAILED_VERSION_DOWNGRADE` | En el dispositivo ya hay una versión más alta | No se puede sobrescribir con una inferior; instala una versión más alta o desinstala antes |
| `INSTALL_FAILED_INSUFFICIENT_STORAGE` | No hay espacio en disco para el entorno de ejecución | Libera disco o cambia el directorio de datos del entorno a un disco con espacio (Ajustes → Integración del sistema) |
| `INSTALL_FAILED_INVALID_APK` | APK dañado/incompleto | Puede que la descarga no terminara; descárgalo de nuevo |
| `INSTALL_FAILED_INVALID_URI` | La ruta del APK contiene caracteres especiales o chinos | Mueve el APK a una ruta solo con caracteres ingleses y vuelve a instalar |
| `INSTALL_FAILED_ALREADY_EXISTS` | Ya existe una aplicación con el mismo nombre y distinta firma | Desinstálala primero |
| `INSTALL_FAILED_DEPRECATED_SDK_VERSION` | Aplicación pensada para un Android muy antiguo | **Se resuelve solo**: ApkStart reintenta con el parámetro oficial de omisión |
| `INSTALL_FAILED_TEST_ONLY` | Paquete solo para pruebas | **Se resuelve solo**: reintenta añadiendo el parámetro de paquete de prueba |
| `INSTALL_FAILED_MISSING_SHARED_LIBRARY` | Falta una característica del dispositivo o una biblioteca del fabricante de la que depende | La aplicación depende de un entorno de fabricante concreto que el emulador no puede ofrecer |
| `INSTALL_FAILED_USER_RESTRICTION` | El sistema restringe la instalación | Reinicia el entorno de ejecución y reintenta |
| `INSTALL_FAILED_CONFLICTING_PROVIDER` | Conflicto de ContentProvider con una aplicación existente | Desinstala la aplicación en conflicto |
| `INSTALL_FAILED_INTERNAL_ERROR` | Error interno del sistema (casi siempre falta de espacio o arranque sin terminar) | Reinicia el entorno de ejecución y reintenta cuando el sistema haya terminado de arrancar |

> Si el error es un texto en inglés que no está en la tabla, exporta el informe de diagnóstico como se indica en 5.3 y envíalo.

---

### 6.3 La imagen del sistema no tiene capa de traducción ARM / las aplicaciones ARM no se instalan o se cierran

**Síntoma**: al instalar aparece `INSTALL_FAILED_NO_MATCHING_ABIS` y el texto dice "la aplicación solo ofrece bibliotecas nativas ARM… la imagen del sistema actual no tiene capa de traducción ARM"; o la aplicación se instala pero se cierra nada más arrancar y en el registro aparecen `DoBadTrampoline`, `libndk_translation`, `UnsatisfiedLinkError`, `...so not found`.

**Cómo funciona**: la 0.6.3 usa **una imagen genérica de Android 14** que da soporte a x86 y ARM a la vez, con la capa de traducción ya incluida. Las versiones antiguas necesitaban cambiar de imagen a mano; ese interruptor «Imagen genérica de compatibilidad (gestión automática)» ahora **solo existe por compatibilidad con configuraciones antiguas y en condiciones normales no hay que tocarlo**.

**Qué hace ApkStart automáticamente:**

1. Si al instalar sale `NO_MATCHING_ABIS`, cambia a la imagen de compatibilidad → reinicia el entorno de ejecución → vuelve a cargar las aplicaciones instaladas desde las copias locales de los APK → reinstala (ver en el registro "Cambiando a la imagen de compatibilidad y reiniciando el entorno de ejecución…").
2. Si la aplicación se cierra al arrancar y el registro apunta claramente a la capa de traducción ARM (por ejemplo `DoBadTrampoline`), cambia automáticamente a la imagen de compatibilidad de Android 14 y reintenta (registro "Se ha detectado un fallo de la capa de traducción ARM; cambiando automáticamente a la imagen de compatibilidad…").

**Qué tienes que hacer tú:**

- **Ten paciencia**: cambiar de imagen reinicia el entorno de ejecución, tarda entre 40 segundos y 1 minuto, y durante ese tiempo puede aparecer una ventana de aviso.
- **Comprueba que la imagen esté lista**: Ajustes → General e instalación → Entorno de ejecución, mira el estado de «Imagen genérica de compatibilidad (gestión automática)»; si pone que no está descargada, pulsa «Descargar imagen de compatibilidad» (unos 1,5 GB) y, al terminar, **reinicia el entorno de ejecución** para que surta efecto.
- **Sigue cerrándose**: unas pocas aplicaciones llevan detección antiemulador más profunda (verifican sensores reales, banda base, etc.) y no pueden funcionar en un emulador; en esos casos se muestra una explicación en chino y es una limitación, no un fallo.

**¿Qué pasa si ves un «Fallo de instalación» en rojo y el texto dice «reintentando tras cambiar automáticamente a la imagen de compatibilidad»?**

Es un error de visualización de las versiones antiguas: el archivo de imagen está en el disco, pero al reutilizarlo con un entorno de ejecución antiguo sin la capa de traducción activada, el reintento con cambio de imagen se omitía y se informaba directamente del fallo, mientras el texto seguía diciendo "reintentando". **No estás usando el código más reciente: actualiza a la última compilación 0.6.4** (la versión a la que corresponde este manual ya lo corrige: antes de instalar se sondea la capacidad real de traducción del entorno de ejecución actual y no solo si el archivo de imagen está presente; `NO_MATCHING_ABIS` siempre provoca cambio de imagen + reinicio + borrado de la instantánea antigua + reinstalación; si vuelve a fallar, se dice con claridad y ya no se afirma falsamente que "se está reintentando"). Después de actualizar, instala otra vez.

> Comprobado en pruebas: Hongguo (com.phoenix.read, solo arm64-v8a) se instala con normalidad con la imagen Android 14 y la nueva capa de traducción, entra en el flujo de recomendaciones y reproduce vídeo. En el entorno de ejecución actual `ro.product.cpu.abilist` = `x86_64,arm64-v8a`, con la capa de traducción ya activa.

---

### 6.4 adb sin autorizar (permitir depuración USB)

**Síntoma**: el diagnóstico indica "adb sin autorizar" o "autorización de depuración de Android sin completar", `adb devices` muestra `unauthorized` y la aplicación no arranca nunca.

**Qué hacer (en orden):**

1. Mira si hay una ventana del emulador mostrando el diálogo **«¿Permitir depuración USB?»**: ve a esa ventana, pulsa **Permitir** y marca **«Permitir siempre desde este equipo»**; después no volverá a preguntar.
2. Si la ventana no responde o no aparece nunca: Ajustes → Entorno de ejecución → **Restablecer datos de Android / Borrar datos de Android** y vuelve a intentarlo (se borran las aplicaciones instaladas, pero los archivos APK siguen ahí y se reinstalan solos; el sistema en sí no se toca).

> ⚠️ **No borres nunca `%USERPROFILE%\.android\adbkey`**. En las pruebas resulta contraproducente: Android solo escribe una clave pública nueva cuando el archivo `adb_keys` no existe; si cambias la clave privada, la clave pública antigua guardada en el sistema sigue vigente y, al no coincidir, la autorización fallará siempre.

> Para comprobarlo desde la línea de comandos: el servicio adb de ApkStart escucha en el **puerto dedicado 5044** (totalmente separado de tu 5037):
> ```powershell
> $env:ANDROID_ADB_SERVER_PORT = 5044
> adb devices    # deberías ver emulator-5554
> ```
> No hagas `adb connect` a mano al puerto 5555: la imagen de Play muestra "¿Permitir depuración USB?" encima de la aplicación y parece que el programa se ha roto.

---

### 6.5 El icono no responde al doble clic / se queda cargando / aparece una ventana con botón de rotación

Casi todos estos problemas apuntan al **punto de entrada de ejecución o a la captura de la ventana**. Comprueba en este orden.

**① Confirma que usas la versión nueva del programa**

- Mira el principio del registro `%APPDATA%\ApkStart\logs\app.log`: debe poner `start v0.6.4`. Si pone `v0.5.x`, los iconos del escritorio o del menú Inicio apuntan al directorio de la versión antigua.
- Las versiones antiguas (0.5.x) no incluyen el entorno de ejecución y usan la ventana integrada por defecto → "muy lento + ventana contenedora con botón de rotación". Pasa a la 0.6.4 y apunta los accesos directos al `ApkStart.exe` nuevo.

**② Ten expectativas realistas sobre el tiempo de arranque**

Un arranque en frío de unos 23~48 segundos y un reinicio por cambio de orientación de unos 50 segundos están dentro de lo normal. Durante ese tiempo parece que el icono "no responde", pero está arrancando en segundo plano. **No hagas clic varias veces seguidas**: los clics repetidos hacen que la segunda instancia se quede con el emulador y que el cierre de la primera se lleve por delante el emulador, provocando el fallo (la 0.6.3 ya añadió la protección `owner.pid`, pero la espera en cola sigue pareciendo que no responde). Haz clic una vez y espera a que arranque.

**③ La ventana nativa no se captura → se vuelve a la ventana integrada con botón de rotación**

Si en el registro aparecen `attach failed` o `emu:0`, el proxy de ventanas no ha encontrado la ventana del emulador y el programa vuelve al modo integrado (la ventana contenedora con barra de título y botón de rotación que ves).
- Se da sobre todo al arrancar desde una unión de directorios o una ruta no estándar; la 0.6.3 ya hace que el proxy resuelva la ruta real antes de comparar. Si sigue ocurriendo, envía el registro.

**④ Restablecer datos de Android (último recurso)**

Ajustes → General e instalación → **Restablecer datos de Android** (pide confirmación). Borra las aplicaciones instaladas y sus datos, pero conserva el sistema; la lista de aplicaciones se mantiene y se reinstalan al abrirlas. Sirve para los casos de "no abre" causados por una partición de datos dañada o por que `/data` no se monta.

---

### 6.6 Tabla rápida de otros problemas de arranque

ApkStart **ya resuelve solo** la mayoría de estos errores del entorno de ejecución; la tabla explica qué hace y qué puedes hacer tú. Si la resolución automática no funciona, exporta el informe de diagnóstico como se indica en 5.3.

| Título del diagnóstico | Resolución automática | Qué puedes hacer tú |
|---|---|---|
| Aceleración por hardware no disponible | Retrocede a emulación por software | Activa la aceleración como se explica en 6.1 |
| Fallo al asignar memoria | Reduce la memoria y el número de núcleos | Cierra los programas que consumen memoria |
| Puerto del emulador ocupado | Cambia automáticamente a un puerto libre | Cierra los demás emuladores (Nox/MuMu/BlueStacks) o reinicia |
| Archivos de bloqueo residuales / "Running multiple emulators with the same AVD" | Limpia automáticamente el bloqueo del AVD y reintenta | Comprueba que ningún otro emulador usa el mismo entorno de ejecución |
| Imagen del sistema ausente/dañada/incompatible con los datos antiguos | Rearranca con datos de usuario limpios | Ajustes → Entorno de ejecución, borra la imagen y vuelve a descargarla |
| Instantánea de arranque rápido dañada | Descarta la instantánea antigua y hace arranque en frío | Se reconstruye al salir correctamente la próxima vez; o desactiva las instantáneas |
| Componentes del entorno de ejecución borrados / falta la biblioteca en tiempo de ejecución de VC++ | — | Añade ApkStart a la lista blanca del antivirus y vuelve a descomprimir; instala las bibliotecas en tiempo de ejecución VC++ 2015-2022 de Microsoft |
| Espacio en disco insuficiente | — | Cambia el directorio del entorno de ejecución a un disco con espacio; desactiva las instantáneas o reduce la partición de datos |
| La ruta contiene caracteres chinos o especiales | Pasa automáticamente a una ruta corta | Mueve ApkStart a un directorio solo con caracteres ingleses (por ejemplo `C:\ApkStart`) |
| A la CPU le falta un conjunto de instrucciones (AVX/SSE4) | — | Suele ser solo un aviso y el sistema arranca igual; si no, usa un equipo que admita VT-x/AVX o el motor antiguo |
| El entorno de ejecución actual no acepta ese modo de GPU | Vuelve a elegir un modo de GPU válido según la versión del motor | — |
| Error de tarjeta gráfica o desconocido | Reintenta automáticamente con varias combinaciones de parámetros | Actualiza el controlador de la tarjeta gráfica; o escribe un parche de compatibilidad; si sigue igual, exporta el informe de diagnóstico |

**El icono del escritorio se muestra como el icono de ApkStart / icono en blanco**: Ajustes → Integración del sistema → **Recrear accesos directos** (reescribe los accesos directos del escritorio y del menú Inicio según la lista actual de aplicaciones y arregla también el icono y la identidad en la barra de tareas). Si un acceso directo se ha movido y su ruta ya no vale, también hay que recrearlos.

---

### 6.7 La aplicación no tiene sonido / suena muy bajo

**Síntoma**: los vídeos y los avisos sonoros de la aplicación Android no suenan nada; o los demás programas de Windows suenan y solo las aplicaciones que corren en ApkStart no.

**Primero distingue**: si el sistema entero está sin sonido, resuelve primero el audio de Windows; sigue los pasos de abajo solo si lo único mudo son las aplicaciones de ApkStart.

1. **Volumen y dispositivo de salida de Windows**: pulsa el icono de volumen de la barra de tareas y comprueba que no está silenciado, que el volumen no es 0 y que el dispositivo de salida es el auricular o altavoz que estás usando. Abre el «Mezclador de volumen» y mira si la línea de ApkStart o del entorno de ejecución de Android está silenciada por separado o bajada a 0.
2. **Volumen dentro de la aplicación**: algunas aplicaciones ponen el volumen multimedia a 0 la primera vez que entras; súbelo en los ajustes de la propia aplicación o con las teclas de volumen del lado Android. Bilibili/Douyin y similares pueden además haber desactivado el sonido de reproducción automática dentro de la aplicación.
3. **Interruptor de sonido de ApkStart**: Ajustes → Rendimiento y recursos → **Sonido de Android** debe estar marcado. La detección automática comprueba esta opción; si está desactivada, lo indica en «Ajustes → Diagnóstico y reparación» y basta pulsar «Resolver» para activarla. **Tras cambiarlo hay que reiniciar el entorno de ejecución de Android** (solo se arranca con `-no-audio` cuando están desactivados tanto el sonido como el micrófono; cambiarlo en caliente no hace que suene al momento).
4. **Servicio de audio de Windows**: pulsa `Win+R`, escribe `services.msc`, busca **Windows Audio** y comprueba que el estado es «En ejecución» y el tipo de inicio «Automático». Si está deshabilitado, inícialo con el botón derecho; la detección automática de la 0.6.3 también lo detecta y avisa. En PowerShell como administrador puedes ejecutar `net start Audiosrv`.
5. **Auriculares Bluetooth / varios dispositivos de salida**: al pasar a unos auriculares Bluetooth, Windows a veces no traslada los programas que ya estaban en marcha. Desconecta y vuelve a conectar los auriculares, o reinicia el entorno de ejecución de Android.
6. **Sigue sin sonido**: usa «Ajustes → Diagnóstico y reparación → Exportar informe de diagnóstico» y envíalo; el informe incluye el estado del interruptor de sonido y del servicio de audio, así que permite saber si el problema es de configuración, del servicio del sistema o de la propia aplicación.

> Cuando la reparación automática falla, el programa abre esta sección solo. Si has desactivado las notificaciones de la detección automática, también puedes entrar a mano desde el botón «Guía» de la entrada del problema o desde el `?` de la barra de título.

---

### 6.8 Fallo de arranque en la versión de Store / 0xC0000135 (fallo al cargar DLL)

**Síntoma**: al abrir la aplicación se queda cargando o se cierra directamente, y en el informe de diagnóstico aparece el código de salida `0xC0000135` (decimal `3221225781`). Es habitual en la versión **instalada desde Microsoft Store**.

**Antes de nada, corrige un diagnóstico equivocado habitual**: `0xC0000135` solo significa «alguna DLL no se ha cargado», **no equivale** a que falte la biblioteca de VC++ ni a que el antivirus haya borrado archivos. Detrás del mismo código de salida hay tres causas posibles; no reinstales una y otra vez pensando solo en la primera:

1. **Limitación de rutas de la versión de Store (MSIX)**: la versión de Store se instala en el directorio de solo lectura `C:\Program Files\WindowsApps\...`. Cuando el entorno de ejecución de Android lanza desde ahí subprocesos como `qemu`, esos subprocesos buscan las DLL por rutas relativas y la redirección de rutas o el aislamiento de entorno del contenedor puede cortarlo; al no encontrar las dependencias, salen con `0xC0000135`. Es un problema exclusivo de la versión de Store y no se arregla reinstalando VC++.
2. **Falta de verdad la biblioteca de VC++**: el entorno de ejecución de Android (Qt6 / qemu) depende de Microsoft VC++ 2015-2022 (x64). Si en Ajustes → Diagnóstico y reparación se indica claramente «Falta la biblioteca en tiempo de ejecución VC++ (x64)», es porque **se ha comprobado que el archivo dll no existe**, y puedes pulsar «Resolver» para instalarlo.
3. **El antivirus ha puesto en cuarentena archivos del entorno de ejecución**: si las dll del directorio del entorno se ponen en cuarentena o se borran, también aparece este código. Añade a la lista blanca del antivirus el directorio de instalación de ApkStart y el directorio de datos del entorno de ejecución, y vuelve a instalar.

**Comprueba en este orden:**

1. **Mira si el diagnóstico dice de verdad que falta VC++**: si en Ajustes aparece la entrada «Falta la biblioteca en tiempo de ejecución VC++ (x64)», pulsa su reparación con un clic. Reinicia el equipo tras instalarla y vuelve a probar. **No** reinstales solo porque el código de salida sea `0xC0000135`: confirma antes que esa entrada aparece de verdad.
2. **Si no aparece lo de VC++ y sigue fallando → casi seguro que es el problema de rutas de la versión de Store**: hoy es la causa más probable. Prueba por orden:
   - cierra ApkStart del todo (icono de la bandeja del sistema → Salir) y vuelve a abrirlo;
   - revisa el «Acceso controlado a carpetas / Protección contra ransomware» del antivirus, añade ApkStart a la lista blanca y reinicia;
   - si aun así no va, usa la **versión portátil** (la `ApkStart-win64-portable` de Releases en los repositorios de GitHub / Gitee) en un directorio solo con caracteres ingleses (por ejemplo `C:\ApkStart`); la versión portátil no se instala en WindowsApps, así que esquiva esta limitación.
3. **Si quieres el nombre exacto de la DLL que falla** (avanzado): lo más útil al informar de un problema es decir al desarrollador qué dll falta. En el Visor de eventos → Registros de Windows → Aplicación, busca el `Application Error` de ApkStart / emulator y mira el campo `FaultingModuleName`; o usa «Ajustes → Diagnóstico y reparación → Exportar informe de diagnóstico» y adjunta el informe.
4. **Qué hacer si adb también se cae**: si en el registro de eventos aparece además un `adb.exe` con `0xC0000409`, es un problema distinto e independiente (conexión del dispositivo anómala) y no la causa directa del cierre del emulator; resuelve primero el arranque con los puntos 1-3 y menciona aparte el problema de adb al enviar el informe.

> Esta sección se abre sola: cuando un fallo de arranque o de reparación se clasifica como problema de DLL, el programa abre directamente este punto. También puedes entrar cuando quieras desde el botón «Guía» de la entrada de detección automática o desde el `?` de la barra de título.

---

### 6.9 La aplicación no usa el micrófono / no se pueden hacer llamadas ni grabar voz

**Síntoma**: los mensajes de voz, las llamadas, la grabación o la voz del escaneo de la aplicación dejan de funcionar y aparece «No hay micrófono / dispositivo de grabación no disponible».

1. **Interruptor de micrófono de ApkStart**: Ajustes → Rendimiento y recursos → **Entrada de micrófono** debe estar marcada. Viene activada por defecto; si se ha desactivado, la detección automática lo indica en «Ajustes → Diagnóstico y reparación» con «La entrada de micrófono está desactivada en los ajustes»; pulsa «Resolver» para activarla y reiniciar el entorno de ejecución. **Tras cambiarlo hay que reiniciar el entorno de ejecución de Android** (el interruptor decide si el emulador expone un dispositivo de grabación a Android).
2. **Permisos de micrófono de Windows**: en `Configuración → Privacidad y seguridad → Micrófono`, comprueba que están activados «Permitir que las aplicaciones accedan al micrófono» y «Permitir que las aplicaciones de escritorio accedan al micrófono»; Android corre dentro de una aplicación de escritorio, así que sin esta opción no hay micrófono a nivel de sistema.
3. **Comprueba que Windows puede grabar**: graba un momento con la «Grabadora de voz» del sistema y confirma que el micrófono y el dispositivo de entrada (micrófono de los auriculares / de la webcam / independiente) funcionan y no están silenciados.
4. **Elige bien el dispositivo de entrada**: si tienes varios micrófonos conectados, en «Configuración de sonido → Entrada» de Windows establece como predeterminado el que quieras usar; el emulador usa el dispositivo de entrada predeterminado del sistema.
5. **Relación entre sonido y micrófono**: el emulador solo apaga por completo el subsistema de audio para ahorrar CPU cuando **están desactivados** «Sonido de Android» y «Entrada de micrófono»; con uno de los dos activo, el otro funciona con normalidad.

> Cuando el micrófono está desactivado, la aplicación solo «no encuentra dispositivo de grabación» y no da un error claro. La detección automática se encarga de avisarte; también puedes entrar en esta sección desde el `?` de la barra de título.

---

### 6.10 Renderizado con gráfica dedicada / integrada (preferencia de tarjeta gráfica)

**Síntoma**: el equipo tiene gráfica dedicada, pero la imagen de la aplicación va a tirones y pierde fotogramas; o el portátil se calienta y gasta mucha batería y quieres usar la gráfica integrada para ahorrar.

La imagen de Android de ApkStart usa `-gpu host` para el renderizado por hardware y llama de verdad a la tarjeta gráfica del equipo. Desde la 0.6.4, todas las tarjetas (NVIDIA / AMD / Intel) usan host de forma preferente por defecto; ya no se rebajan sin más a renderizado por software las AMD/Intel como hacían las versiones antiguas, lo que equivalía a renunciar a la tarjeta gráfica. Si host falla en este equipo, se degrada automáticamente al backend de software sin afectar al uso.

**Cómo indicar qué tarjeta usar**: cuando el equipo tiene gráfica dedicada e integrada, Windows a veces asigna el emulador a la integrada. En Ajustes → Rendimiento y recursos → **Preferencia de tarjeta gráfica** puedes indicarlo:

| Opción | Cuándo conviene |
|---|---|
| Predeterminado del sistema (recomendado) | Deja que Windows elija según la alimentación y la carga; en la mayoría de equipos es lo más cómodo |
| Gráfica dedicada preferente | Juegos, vídeo, cuando necesitas muchos fotogramas por segundo; gasta y calienta más |
| Gráfica integrada preferente | Aplicaciones ligeras, dejarlas en segundo plano, ahorro en portátiles; rinde algo menos |

- Esta opción se aplica al proceso del emulador mediante las «Preferencias de rendimiento gráfico» de Windows (UserGpuPreferences) y **solo funciona en Windows 10 1803 o posterior**; en sistemas antiguos se ignora sin afectar al arranque.
- Surte efecto en el **siguiente arranque del entorno de ejecución de Android**; la página de ajustes indica si ya está aplicada.
- Con controladores AMD antiguos, host falla de vez en cuando: actualiza el controlador de la tarjeta gráfica; si sigue igual, en «Ajustes → Diagnóstico y reparación → Controladores · Parches de compatibilidad» puedes activar el parche de ejemplo swangle para gráficas integradas AMD que incluye el programa, y fijar el renderizado a un backend más estable.

---

## 7. Referencia de línea de comandos

```
ApkStart.exe                                abre la ventana principal
ApkStart.exe <ruta\a.apk>                   instala un APK
ApkStart.exe --launch <nombre del paquete>  inicia la aplicación directamente (es lo que usan los accesos directos del escritorio)
```

---

## 8. Datos y directorios

| Uso | Ubicación |
|---|---|
| Entorno de ejecución (adb / emulator / imagen) | Incluido en el paquete, o `%APPDATA%\apkstart\runtime` (versión ligera) |
| Imagen del sistema descomprimida | `%APPDATA%\apkstart\system-images` |
| AVD / aplicaciones instaladas / instantáneas | `%APPDATA%\apkstart\avd` |
| Iconos de las aplicaciones | `%APPDATA%\apkstart\icons\<nombre del paquete>.ico` |
| Ajustes y lista de aplicaciones | `%APPDATA%\ApkStart\settings.json` / `apps.json` |
| Registro de ejecución / informe de diagnóstico | `%APPDATA%\ApkStart\logs\` |
| Carpeta compartida Windows ↔ Android | `%USERPROFILE%\ApkStartShared` ↔ `/sdcard/ApkStartShared` |

> «Restablecer datos de Android» solo borra la capa de datos de usuario; la imagen del sistema y los archivos APK se conservan. Actualizar las aplicaciones no hace perder el entorno de ejecución, las aplicaciones instaladas ni las instantáneas.
>
> Conviene dejar espacio suficiente en el disco C: la imagen descomprimida, la partición de datos y las instantáneas pueden sumar varios GB. La falta de espacio provoca fallos de Installing/arranque del sistema.

---

## 9. Obtener ayuda y comentarios

Al informar de un problema, adjunta estas tres cosas: aceleran mucho la localización:

1. **Informe de diagnóstico**: Ajustes → Diagnóstico y reparación → Exportar informe de diagnóstico;
2. **Las últimas 20 líneas de app.log**: `%APPDATA%\ApkStart\logs\app.log`;
3. **Tu versión y formato**: por ejemplo "versión de Store 0.6.4" o "versión portátil completa 0.6.4".

- GitHub: <https://github.com/RoutineMiku/apkstart> (Issues / Releases)
- Gitee: <https://gitee.com/daily-miku/apkstart>

---

*Este manual corresponde a la v0.6.4 y se actualiza con cada versión. Si algún texto de la interfaz difiere ligeramente de lo aquí indicado, prevalece lo que muestra el programa.*
