# AGENTS.md

## Propósito

Este proyecto es una extensión Chrome Manifest V3 para SmartOLT, versión `3.0.8`.

La extensión captura y procesa exportaciones CSV generadas por SmartOLT, calcula estadísticas por caja/ODB, genera texto para Telegram y permite consultar datos ópticos de una ficha de cliente.

La extensión existente debe preservarse. No debe reconstruirse desde cero ni reemplazarse por una implementación nueva.

Todo cambio debe estar relacionado con una solicitud concreta. No realizar cambios de código, configuración o estructura simplemente porque parezcan mejoras.

## Alcance De Trabajo

- Trabajar únicamente dentro de la raíz del proyecto actual.
- No tocar archivos fuera de la raíz del proyecto.
- No utilizar carpetas de versiones originales como fuente de escritura.
- No modificar carpetas de versiones originales.
- No sobrescribir cambios realizados por el usuario.
- Mantener la compatibilidad con las funcionalidades existentes salvo que el objetivo solicitado indique expresamente lo contrario.
- No inventar funcionalidades.
- No eliminar ni simplificar funcionalidades existentes.
- Si existe incertidumbre sobre una regla de negocio, detenerse y consultarla en lugar de inferirla.

## Proceso De Trabajo

Mantener separadas estas etapas:

1. Análisis.
2. Propuesta.
3. Autorización.
4. Implementación.
5. Verificación.

Analizar, investigar, revisar o proponer una solución no implica autorización para modificar archivos.

Antes de modificar:

- Analizar el impacto del cambio.
- Identificar los archivos que serían modificados.
- Explicar qué archivos se modificarían y por qué.
- Confirmar que el cambio responde a una solicitud concreta.
- Revisar las dependencias afectadas.
- Consultar cualquier regla de negocio ambigua.

Cuando exista autorización:

- Realizar únicamente el cambio mínimo necesario.
- No corregir problemas secundarios.
- No realizar refactors no solicitados.
- No cambiar reglas de negocio no relacionadas.
- No modificar archivos no necesarios para el objetivo.

Después de modificar:

- Mostrar claramente qué archivos cambiaron.
- Revisar el diff.
- Verificar que no se modificaron archivos no relacionados.
- Ejecutar las verificaciones correspondientes.
- Informar cualquier limitación o prueba no realizada.

No ejecutar operaciones destructivas o irreversibles sin autorización explícita.

## Arquitectura

La extensión está compuesta por:

- `manifest.json`: configuración, permisos, popup, service worker e iconos.
- `background.js`: captura automática de exportaciones CSV desde SmartOLT.
- `shared.js`: lógica común de parsing, análisis, promedios, estados y reportes.
- `popup.js`: lógica de interfaz, acciones manuales, consulta de clientes y copiado.
- `popup.html`: estructura del popup.
- `popup.css`: estilos, estados visuales y temas especiales.
- `icons/`: iconos utilizados por Chrome.

`shared.js` se carga antes que `popup.js` y expone la API global `SmartOLTShared`.

No convertir `shared.js` en módulo ES sin una solicitud explícita y sin revisar simultáneamente todos sus consumidores.

## Responsabilidad De Los Archivos

### `manifest.json`

Debe conservar:

- `manifest_version: 3`.
- `popup.html` como popup.
- `background.js` como service worker.
- Los iconos declarados.
- Los permisos necesarios para descargas, almacenamiento y scripting.
- Los `host_permissions` necesarios para SmartOLT y archivos locales.

La versión actual declarada es `3.0.8`.

### `background.js`

Debe limitarse a:

- Escuchar descargas generadas por SmartOLT.
- Validar URLs compatibles con SmartOLT.
- Intentar cancelar la descarga física de forma best-effort.
- Recuperar el CSV con las credenciales de sesión.
- Procesar el CSV mediante `SmartOLTShared.analyzeCSV`.
- Guardar el resultado en `chrome.storage.session`.

No debe:

- Iniciar exportaciones automáticamente.
- Hacer clicks en SmartOLT.
- Consultar endpoints internos de SmartOLT.
- Consultar ONUs individuales.
- Borrar archivos del disco del usuario.
- Procesar descargas que no correspondan a SmartOLT.

### `shared.js`

Debe contener la lógica común y sin efectos de interfaz:

- Parsing y validación del CSV.
- Conversión de señales.
- Consolidación de registros.
- Agrupación por caja.
- Cálculo de promedios.
- Clasificación de estados.
- Generación del reporte de Telegram.
- Evaluación óptica del cliente.
- Mensajes motivacionales.
- Funciones de fecha, footer y temas.

No debe acceder al DOM ni realizar llamadas de red.

### `popup.js`

Debe encargarse de:

- Leer `chrome.storage.session`.
- Renderizar los estados del popup.
- Procesar cargas manuales de CSV.
- Detectar CSV descargados localmente.
- Copiar reportes.
- Descargar el CSV crudo.
- Consultar la ficha activa del cliente.
- Habilitar o deshabilitar acciones según la URL activa.
- Gestionar footer, temas y easter egg.

No introducir consultas automáticas a SmartOLT al abrir el popup sin autorización explícita.

### `popup.html`

Debe conservar:

- La carga de `shared.js` antes de `popup.js`.
- Los identificadores utilizados por `popup.js`.
- Las pantallas de estado, error y captura.
- Los botones y controles existentes.
- La estructura del footer y firma.

Cambiar IDs o el orden de los scripts requiere revisar todos los selectores y dependencias de `popup.js`.

### `popup.css`

Debe conservar:

- Los estilos funcionales de estados.
- Las reglas específicas para elementos con `[hidden]`.
- Los temas especiales existentes.
- La distinción visual entre botones habilitados y deshabilitados.

Al agregar `display: flex` o `display: block` a elementos que pueden ocultarse, debe verificarse que `[hidden]` siga funcionando correctamente.

## Flujo Principal De Datos

El flujo automático es:

1. El usuario exporta un CSV desde SmartOLT.
2. Chrome notifica la descarga.
3. `background.js` valida la URL.
4. Se intenta cancelar la descarga física.
5. Se recupera el CSV mediante `fetch` con credenciales incluidas.
6. Se obtiene el nombre del archivo.
7. Se valida y procesa el CSV.
8. Se aplica el límite de ONUs.
9. Se consolidan los registros.
10. Se calculan estadísticas y texto de Telegram.
11. Se guarda el estado en `chrome.storage.session`.
12. `popup.js` lee y muestra el estado.

Un CSV nuevo reemplaza el estado anterior.

El CSV crudo debe conservarse sin reserializar porque la función de descarga depende de devolver el contenido original.

## Procesamiento Del CSV

Las columnas requeridas son:

- `Name`
- `ODB (Splitter)`
- `ODB Port`
- `Status`
- `Last status change`
- `Signal 1310`
- `Signal 1490`

`SN` es opcional.

El parser debe seguir soportando:

- Comillas.
- Comas dentro de campos.
- Comillas escapadas.
- Saltos de línea Windows y Unix.
- BOM UTF-8.

Los encabezados se comparan ignorando mayúsculas/minúsculas y espacios externos.

Los valores vacíos o `"-"` de señal se representan como `null`.

Las filas completamente vacías se ignoran.

Los códigos de error existentes deben mantenerse:

- `EMPTY`
- `NO_ROWS`
- `NOT_SMARTOLT`
- `MISSING_COLUMNS`
- `PARSE_ERROR`
- `OVER_LIMIT`

El límite de ONUs se verifica antes de la consolidación por serial.

## Límite De ONUs Por PON

La constante actual es:

```js
MAX_ONUS = 128
```

Reglas actuales:

- 128 filas válidas son aceptadas.
- 129 filas válidas generan `OVER_LIMIT`.
- Los duplicados cuentan antes de la deduplicación.
- El CSV se considera correspondiente a un único PON.
- El nombre del archivo puede aportar información de OLT, Board y Port únicamente para el mensaje visual del límite.

Modificar este límite o el momento en que se aplica requiere autorización explícita.

## Agrupación Por Caja

La caja proviene de `ODB (Splitter)`.

Cuando está vacía, se utiliza:

```text
(sin caja)
```

Las cajas se ordenan con comparación natural. Debe preservarse el orden numérico de nombres como `PZA-9` y `PZA-10`.

Todas las cajas deben procesarse, incluso las que no tienen clientes Online.

Los puertos ocupados:

- Se obtienen de `ODB Port`.
- Solo consideran valores numéricos mayores que cero.
- Se eliminan duplicados.
- Se ordenan numéricamente.
- No se calculan huecos ni capacidad teórica.

Los clientes sin puerto se cuentan por registro cuando el puerto está vacío, no es numérico o es menor o igual que cero.

## Promedios Y Evaluación Óptica

La correspondencia de señales es:

- `Signal 1490`: OP ONU, Rx ONU.
- `Signal 1310`: OP OLT, Rx OLT.

Solo los registros con estado exactamente `Online` participan en los promedios.

Para cada señal:

1. Se filtran valores válidos.
2. Se ordenan de mayor a menor.
3. Se toman las tres mejores señales.
4. Se calcula el promedio.

En dBm, un valor menos negativo es mejor.

Las constantes actuales son:

```js
TOP_N_SIGNAL = 3
OPTICAL_TOLERANCE_DB = 1
APPROVAL_TOLERANCE_DB = 0.05
```

Reglas:

- Un cliente igual o mejor que el promedio aprueba.
- Un cliente peor puede estar hasta `1.05 dB` por debajo y seguir aprobando.
- Una diferencia superior a `1.05 dB` reprueba.
- La falta de datos produce un resultado no evaluable.
- La evaluación global requiere que ONU y OLT sean evaluables.
- La advertencia de mejora calcula el exceso sobre `1.00 dB`, no sobre `1.05 dB`.

Los mensajes motivacionales:

- Solo aparecen si ONU y OLT están aprobadas.
- Comparan la OP ONU del cliente.
- Usan únicamente las ONUs Online de la misma caja.
- Son categorías excluyentes.

## Estados

### `Online`

- Participa en promedios.
- Incrementa el contador Online.
- Participa en la evaluación de señales.

### `LOS`

- Se reconoce ignorando mayúsculas/minúsculas.
- Usa icono `🔴`.
- Puede aparecer como `LOS` o `LOS/Power fail` según la combinación de estados.

### `Power fail`

- Se reconoce ignorando mayúsculas/minúsculas.
- Usa icono `⚫`.
- Puede combinarse con LOS.

### `Offline` Y `Disabled`

En el informe completo por caja se consideran parte de la rama problemática de Power fail.

No deben convertirse automáticamente en categorías independientes sin autorización explícita.

### Estados Vacíos O Desconocidos

- Todo estado distinto de `Online` incrementa `offlineCount`.
- Un estado vacío no participa en promedios.
- Los registros sin estado deben conservarse y mostrarse como inconsistencias.
- Los estados desconocidos pueden no aparecer en el resumen problemático.

## Duplicados

La consolidación se realiza por `SN` normalizado:

- Se eliminan espacios externos.
- Se convierten los valores a mayúsculas.
- Registros sin `SN` no se fusionan.

Si hay varios registros con el mismo serial:

- Si al menos uno tiene estado, se selecciona el más completo entre esos registros.
- Si ninguno tiene estado, se selecciona el más completo y se conserva el estado vacío.
- En caso de empate, gana el primer registro.

La completitud considera:

- Estado.
- Caja.
- Puerto.
- Señal 1310.
- Señal 1490.
- Nombre.

No deduplicar antes del límite sin autorización explícita, porque cambiaría el comportamiento actual.

## Consulta De Clientes

La consulta solo debe habilitarse para URLs con formato:

```text
https://<subdominio>.smartolt.com/onu/view/<id>
```

La extracción se realiza mediante `chrome.scripting.executeScript`.

El extractor:

- Solo lee el DOM.
- No realiza `fetch`.
- No llama APIs.
- No hace clicks.
- Obtiene nombre, caja/NAP, serial y señales.

La caja y el puerto deben extraerse desde una etiqueta `NAP (Divisor)` con formato equivalente a:

```text
Caja (Port N)
```

El campo general `Puerto` de la ficha no debe utilizarse como sustituto.

La señal preferida se obtiene de `#signal_wrapper`:

- Primer valor: OP ONU.
- Segundo valor: OP OLT.

Se mantiene el reintento temporal de lectura y los respaldos de etiquetas existentes.

La identificación del registro CSV debe seguir este orden:

1. Serial.
2. Caja y puerto exactos.

Cuando se encuentra el registro:

- Se crean copias en memoria.
- Se reemplazan las señales por los valores actuales.
- Se excluye el cliente del promedio de referencia.
- No se modifica el CSV original.
- No se modifica `chrome.storage.session`.

Los avisos internos, como falta de coincidencia de caja, deben mantenerse separados del texto copiado.

## Formato De Telegram

El reporte se genera por caja con este orden:

1. Nombre de caja.
2. Promedio.
3. Puertos ocupados.
4. Clientes sin puerto.
5. Cantidad Online.
6. Resumen problemático.
7. Detalle de ONUs afectadas.
8. ONUs sin estado.
9. Separador entre cajas.

El separador tiene 29 guiones y solo aparece entre bloques.

El detalle mantiene el estado real del CSV y utiliza el formato general:

```text
🔴/⚫ P<puerto> | <estado> | <nombre> | <fecha>
```

Las fechas del CSV se presentan como `DD/MM HH:mm`.

La fecha del archivo procesado se agrega una sola vez al inicio:

```text
📅 Datos del: DD/MM/AA HH:mm
```

No agregar advertencias de interfaz al texto copiado sin autorización explícita.

## Permisos De Chrome

Permisos actuales:

- `downloads`: escuchar, cancelar y consultar descargas.
- `storage`: utilizar `chrome.storage.session` y escuchar cambios.
- `scripting`: inyectar el extractor de datos de cliente.

Host permissions actuales:

- `*://*.smartolt.com/*`: acceso a SmartOLT.
- `file:///*`: lectura de CSV locales durante la autodetección.

Cualquier cambio de permisos requiere revisar sus efectos sobre la seguridad, privacidad y flujo de datos.

No agregar permisos nuevos para solucionar problemas puntuales sin autorización explícita.

## Funcionalidades Sensibles

Las siguientes dependencias pueden romperse con cambios aparentemente pequeños:

- La ruta `/export_download/file/`.
- La sesión autenticada del navegador.
- El uso de `credentials: "include"`.
- La estructura y nombres de columnas del CSV.
- La disponibilidad de `#signal_wrapper`.
- Las etiquetas del DOM de la ficha de cliente.
- El formato `NAP (Divisor): Caja (Port N)`.
- La URL `/onu/view/<id>`.
- Las comparaciones textuales de estados.
- La deduplicación por columna `SN`.
- La aplicación del límite antes de la deduplicación.
- El uso de `chrome.storage.session`.
- La lectura de archivos `file://`.
- La disponibilidad del archivo descargado.
- El mecanismo de cancelación de descargas.
- El fallback de copiado mediante `document.execCommand`.
- El cierre automático del popup al perder foco.
- Las reglas CSS específicas para `[hidden]`.
- El orden de carga de `shared.js` y `popup.js`.
- La exposición global `self.SmartOLTShared`.

## Observaciones Técnicas No Normativas

Las siguientes observaciones describen el estado actual, pero no deben interpretarse automáticamente como errores ni como autorización para corregirlos:

- `buildTelegramText` incluye `Offline` y `Disabled` dentro de la clasificación problemática.
- `buildLosPowerFailReport` reconoce únicamente `LOS` y `Power fail`.
- La deduplicación ocurre después de evaluar el límite de filas.
- El estado `offlineCount` incluye cualquier valor distinto de `Online`.
- El promedio de ONU y el promedio de OLT pueden tener datos disponibles de forma independiente.
- La cancelación de una descarga es best-effort y puede no impedir que el archivo quede en disco.
- El estado almacenado se pierde al cerrar completamente Chrome.
- La consulta de cliente ajusta datos en memoria, pero no modifica el CSV almacenado.

Estas observaciones no deben convertirse en cambios obligatorios sin una solicitud concreta y autorización explícita.

## Metodología De Cambios Segura

Antes de modificar archivos:

1. Analizar el objetivo concreto.
2. Revisar el estado actual del proyecto.
3. Identificar dependencias directas e indirectas.
4. Analizar el impacto funcional, visual, de permisos y de datos.
5. Enumerar los archivos que se modificarían.
6. Explicar por qué se modificaría cada archivo.
7. Consultar cualquier ambigüedad de negocio.
8. Obtener autorización explícita para implementar.

Cuando el usuario solo solicita analizar, investigar, revisar o proponer:

- No modificar archivos.
- No crear archivos.
- No eliminar archivos.
- No asumir autorización implícita.
- Separar claramente observaciones, propuesta y cambios reales.

Cuando exista autorización:

- Modificar solo los archivos necesarios.
- Realizar el cambio mínimo.
- Mantener interfaces y formatos existentes.
- No corregir problemas secundarios.
- No realizar refactors no solicitados.
- No cambiar configuración o estructura sin relación directa con la solicitud.
- No tocar archivos fuera de la raíz del proyecto.
- No utilizar carpetas de versiones originales como fuente de escritura.

Después de modificar:

- Informar claramente los archivos modificados.
- Revisar el diff.
- Confirmar que el diff solo contiene cambios relacionados.
- Verificar sintaxis, carga y comportamiento afectado.
- Informar qué verificaciones se ejecutaron.
- Informar cualquier prueba que no haya sido posible realizar.

## Reglas Para Git

Git debe utilizarse como mecanismo de trazabilidad y recuperación, no como autorización implícita para modificar el proyecto.

- No interpretar la existencia de un repositorio Git como permiso para modificar archivos.
- No ejecutar `git add`, `commit`, `reset`, `checkout`, `push` o `pull` salvo solicitud explícita.
- No inicializar Git si el repositorio ya existe.
- No modificar la configuración global de Git.
- No eliminar ni sobrescribir cambios del usuario.
- No ejecutar `git reset --hard`, `git checkout --` ni otras operaciones destructivas sin autorización explícita.
- No alterar commits existentes ni hacer `amend` salvo solicitud explícita.
- Revisar el estado y el diff antes de preparar o confirmar cambios cuando corresponda.
- No incluir secretos, credenciales ni archivos locales accidentales.
- Mantener commits pequeños y descriptivos.
- No crear commits vacíos.
- No usar Git para justificar cambios no solicitados.
- No considerar el staging como autorización para modificar archivos adicionales.

## Pruebas Y Verificación

No asumir la existencia de una suite automatizada si no está presente en el proyecto.

Como mínimo, verificar según el cambio:

- Que `manifest.json` siga siendo JSON válido.
- Que `shared.js` cargue sin errores y exponga `SmartOLTShared`.
- Que `popup.html` cargue `shared.js` antes que `popup.js`.
- Que `background.js` pueda cargar `shared.js`.
- Que el parser siga aceptando las columnas requeridas.
- Que el límite de 128 filas siga funcionando.
- Que la deduplicación por `SN` conserve las reglas actuales.
- Que los promedios sigan usando las tres mejores señales Online.
- Que ONU y OLT sigan evaluándose separadamente.
- Que los estados mantengan sus agrupaciones actuales.
- Que el texto de Telegram conserve el orden y formato.
- Que el botón de cliente solo se habilite en fichas válidas.
- Que la consulta no realice llamadas de red adicionales.
- Que el CSV crudo pueda volver a descargarse.
- Que los elementos ocultos sigan respetando `[hidden]`.
- Que los permisos declarados coincidan con las APIs utilizadas.

Las pruebas no deben depender de datos reales de clientes ni exponer información sensible.

## Autorización Explícita Requerida

Se debe pedir autorización antes de:

- Cambiar el límite de `128` ONUs por PON.
- Cambiar la forma o el momento de aplicar ese límite.
- Cambiar columnas requeridas del CSV.
- Cambiar la semántica de `SN` o de la deduplicación.
- Cambiar la correspondencia entre señales 1490/1310 y ONU/OLT.
- Cambiar los umbrales ópticos.
- Cambiar la dirección de comparación de valores dBm.
- Cambiar la clasificación de estados.
- Separar `Offline` o `Disabled` en nuevas categorías.
- Cambiar el formato de Telegram.
- Cambiar la información del texto copiado.
- Cambiar el origen de caja o puerto en la consulta de cliente.
- Agregar consultas a APIs o endpoints de SmartOLT.
- Introducir consultas automáticas a SmartOLT al abrir el popup.
- Iniciar exportaciones automáticamente.
- Cambiar el almacenamiento de sesión por almacenamiento persistente.
- Agregar o eliminar permisos de Chrome.
- Cambiar `host_permissions`.
- Cambiar el orden de carga de scripts.
- Convertir `shared.js` en módulo.
- Eliminar funcionalidades manuales.
- Eliminar temas, footer o easter egg.
- Cambiar el comportamiento de cancelación de descargas.
- Cambiar el nombre o estructura de los elementos requeridos por `popup.js`.
- Modificar archivos binarios de `icons/`.
- Crear, modificar o eliminar `AGENTS.md`.
- Realizar operaciones destructivas de Git.
- Crear, modificar o reescribir commits existentes.
