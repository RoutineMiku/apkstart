# Glosario y reglas de traducción — ApkStart español (es-ES)

> Tabla de referencia para mantener la terminología estable entre archivos y versiones.
> Si añades un término nuevo, añádelo aquí en el mismo PR.

## Contexto
ApkStart es un "ejecutor de aplicaciones Android para Windows": permite instalar un APK con doble clic y ejecutarlo en una ventana propia, con icono en el escritorio. Por dentro levanta un Android Emulator + QEMU con una imagen de Android 14, usa adb (puerto 5044), instantáneas de arranque rápido, WHPX/HypervisorPlatform para aceleración, y un agente PowerShell dentro del host para gestionar ventanas.

Las cadenas a traducir son textos de interfaz, mensajes de estado, errores, avisos de diagnóstico, títulos de diálogos y entradas de menú de la aplicación.

## Registro y estilo
- Español de España neutro (es-ES), tuteo ("tú"), tono cercano pero técnico.
- UI: frases cortas, en imperativo para botones ("Instalar", "Reintentar", "Abrir ajustes").
- Sin puntos finales en etiquetas, botones, títulos y entradas de menú.
- Mantén las mayúsculas iniciales tal como están; no añadas mayúsculas a sustantivos comunes.
- Nada de anglicismos innecesarios cuando existe término español natural.
- Coherencia: si una cadena se repite en varios archivos, se traduce igual.

## Términos fijos (usar SIEMPRE estas formas)
| 中文 | Español |
|---|---|
| 运行时 | entorno de ejecución |
| 安卓 / Android | Android (nunca "Androide") |
| 镜像 / 系统镜像 | imagen / imagen del sistema |
| 快照 / 快速启动快照 | instantánea / instantánea de arranque rápido |
| 冷启动 | arranque en frío |
| 引导 / 引导中 | arrancar / arrancando |
| 开机 | arranque del sistema |
| 应用 / 安卓应用 | aplicación / aplicación Android |
| 桌面图标 | icono del escritorio |
| 开始菜单 | menú Inicio |
| 快捷方式 | acceso directo |
| 托盘 / 任务栏 | bandeja del sistema / barra de tareas |
| 设置 | Ajustes |
| 诊断与修复 | Diagnóstico y reparación |
| 导出诊断报告 | Exportar informe de diagnóstico |
| 一键完成 | Configuración automática |
| 一键清理 | Limpieza automática |
| 一键修复 | Reparar automáticamente |
| 硬件加速 | aceleración por hardware |
| 软件模拟 | emulación por software |
| 虚拟机 | máquina virtual |
| 显卡 / 核显 / 独显 | tarjeta gráfica / gráfica integrada / gráfica dedicada |
| 驱动 | controlador |
| 数据分区 | partición de datos |
| 存储 / 磁盘 | almacenamiento / disco |
| 共享目录 | carpeta compartida |
| 输入法 / 输入法 APK | método de entrada (IME) / APK del método de entrada |
| 横屏 / 竖屏 | horizontal / vertical |
| 面板方向 | orientación del panel |
| 全屏 / 窗口模式 | pantalla completa / modo ventana |
| 嵌入模式 / 原生窗口 | modo integrado / ventana nativa |
| 容器 | contenedor |
| 外壳 / 壳窗口 / 壳层 | envoltorio / ventana contenedora / capa de escritorio |
| 引擎 | motor |
| 组件 | componente |
| 下载源 | fuente de descarga |
| 升级 / 更新 | actualizar / actualización |
| 卸载 | desinstalar |
| 权限 | permiso |
| 签名 | firma |
| 拆分包 / 分片 APK | paquete dividido / APK dividido |
| 转译层 / 翻译层 | capa de traducción (ARM) |
| 反模拟 / 反调试 | antiemulador / antidepuración |
| 包名 | nombre del paquete |
| 清单 / AndroidManifest.xml | manifiesto |
| 日志 / 运行日志 | registro / registro de ejecución |
| 代理 / 窗口代理 | proxy / proxy de ventanas |
| 提示 | aviso |
| 教程 | guía |
| 处理 | resolver |
| 立即扩容 | Ampliar ahora |
| 重置安卓数据 | Restablecer datos de Android |
| 清空安卓数据 | Borrar datos de Android |
| 重建快捷方式 | Recrear accesos directos |
| 使用手册 | Manual de uso |
| 环境自检 | Autocomprobación del entorno |
| 实验室 | Laboratorio |
| 网络与下载 | Red y descargas |
| 性能与资源 | Rendimiento y recursos |
| 操作与输入 | Controles y entrada |
| 显示与窗口 | Pantalla y ventanas |
| 常用与安装 | General e instalación |
| 集成与文件 | Integración y archivos |
| 更新与关于 | Actualizaciones y acerca de |
| 运行时与环境 | Entorno de ejecución |
| 待机 | En espera |
| 待下载镜像 | Imagen pendiente |
| 需要部署 | Requiere configuración |

## Nombres que NO se traducen
ApkStart, Android, Windows, Google, GitHub, Gitee, Microsoft Store, QEMU, adb, ADB, AVD, APK, APKS, XAPK, ICO, PNG, ZIP, AXML, ARSC, WHPX, HypervisorPlatform, VT-x, AMD-V, SSE4, AVX, VC++, MSIX, NSIS, Electron, PowerShell, cmd, Audiosrv, services.msc, F11, Ctrl+R, Win+R, x64, arm64-v8a, swiftshader, swangle, host, guest, HAXM, AEHD, WSA, MuMu, 夜神 (→ Nox), 蓝叠 (→ BlueStacks), 红果/B站/抖音 (→ nombres de apps chinas: dejar como "Hongguo", "Bilibili", "Douyin"), SQLite, JSON, HTTP, 0xC0000135 y demás códigos.

## Reglas técnicas obligatorias
1. **Placeholders intactos**: `${nombre}`, `${x.y}`, `%s`, `%d`, `{0}` deben aparecer exactamente igual, mismos nombres, misma cantidad. Puedes reordenarlos dentro de la frase si el español lo pide.
2. **HTML**: conserva etiquetas (`<b>`, `<li>`, `<code>`, `<br>`) y sus atributos tal cual; traduce solo el texto visible.
3. **Espacios**: conserva los espacios iniciales/finales exactos de la cadena original.
4. **Saltos de línea**: conserva `\n` en el mismo número.
5. **Puntuación china**: `：`→`:`, `、`→`,`, `（）`→`()`, `「」`→`"…"`, `。`→`.` (solo si la frase lo necesita).
6. **Fragmentos**: algunas cadenas son trozos sueltos de una frase partida por etiquetas o por concatenación (`：`, `，`, `（`, `）`, `」`). Traduce el fragmento de forma que encaje en su contexto (`ctx`), sin inventar contenido.
7. **Comandos, rutas, teclas y ejemplos de código**: no los traduzcas, cópialos literalmente.
8. **Códigos de error** (`0xC0000005`, `HTTP 416`, etc.): se copian literalmente, el texto alrededor se traduce.
9. **Sin caracteres chinos en la salida**, salvo en nombres propios chinos (marcas de apps) y en rutas/comandos que se citan literalmente.
10. **No inventes** información nueva ni añadas explicaciones; traduce lo que hay.

## Formato de salida
Un único archivo JSON por lote, UTF-8, con el mismo `id` y tantas entradas como el lote:

```json
{
  "S0001": "Conectado al entorno de ejecución",
  "S0002": "Instalando ${nombre}…"
}
```

Sin comentarios, sin claves extra, sin texto fuera del JSON.