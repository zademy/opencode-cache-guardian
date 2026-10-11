# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado segun [SemVer](https://semver.org/lang/es/).

## [0.2.0] - 2026-10-11

### Anadido

- **Plugin TUI companero** `cache-guardian.status` (`tui/`): indicador en el pie de la
  sesion con el acumulado de tokens leidos del cache (`cg cache read 24.4M`), en vivo
  desde `session.usage.updated`. Instalable por symlink del directorio; el TUI no
  descubre ficheros sueltos. Sin datos no muestra nada, no un cero.
- Guarda de carga en el proceso servidor: recorre el mismo directorio pero no tiene
  `ctx.ui`, asi que el plugin se vuelve no-op alla.

### Limitacion descubierta y documentada

- El host resuelve a su copia solo `effect` y `@opencode/plugin` (verificado en
  `packages/plugin/src/runtime-modules.ts`: `runtimePackages = ["effect",
  "@opencode/plugin"]`). Importar `@opentui/solid` desde un plugin de terceros
  instala una segunda instancia de `@opentui/core` y rompe con "OPENTUI_FORCE_UNICODE
  is already registered with different configuration". El indicador renderiza cadenas
  planas — los hijos de texto en TSX son cadenas, el renderer ya las pinta — y queda a
  la espera de que el host provea `@opentui`.
## [0.1.2] - 2026-10-11

Semantica de los contadores del proveedor verificada contra el fuente de OpenCode V2
(packages/core/src/session/usage.ts y projector.ts), no solo contra datos observados.

### Corregido

- Etiquetas honestas en el bloque de uso del proveedor:
  - `Provider input tokens (non-cached)`: el campo `input` del evento es la entrada NO
    servida desde cache (`nonCachedInputTokens`), no la total. La peticion real es
    aproximadamente input + cacheRead + cacheWrite.
  - `Provider usage samples: N (one per completed model step)`: el evento se publica en
    Step.Ended/Step.Failed, asi que hay exactamente uno por despacho completado.
  - `Median per dispatch: cache read X / fresh input Y`.

### Anadido

- Linea `Coverage: N usage event(s) for M observed request(s)`. Cuando N < M hay
  despachos que no produjeron uso (fallos, errores). En los datos reales: 112/148.
- Documentada la limitacion estructural mas importante encontrada hasta ahora: el
  proveedor ve ~9x mas entrada por despacho (~111k tokens: 863 frescos + ~110k de cache)
  que lo que el hook `context` expone (~12,273 tokens estimados). La metrica local
  describe solo el payload visible en el hook; las cifras del proveedor describen la
  peticion completa. Ambas se muestran, separadas, y ninguna se deriva de la otra.

## [0.1.1] - 2026-10-11

Corregido a partir de datos reales de una sesión en vivo (114 observaciones, 79 muestras
de uso): los contadores del proveedor son acumulativos por sesión, no valores por
petición.

### Corregido

- **totalUsage sumaba muestras acumulativas y sobrecontaba ~33x.** Los contadores de
  `session.usage.updated` son monótonos dentro de una sesión; el total correcto por
  sesión es la lectura más reciente, sumada entre sesiones. Fixture de regresión con los
  números reales de la sesión en vivo.
- Un campo que la muestra más reciente no lleva cae ahora a la muestra más reciente que sí
  lo lleve, en lugar de perderse.

### Añadido

- usageDeltas: mediana por despacho de cache read / input / output, como delta entre
  muestras consecutivas de la misma sesión. Las deltas negativas (reinicio de contador)
  se descartan. Línea nueva en el informe: `Median per dispatch`.
- Línea `Identical consecutive requests` en el bloque local. En la sesión real de
  referencia fue 99/100 pares comparables: el contexto se reenvía igual y el proveedor lo
  sirve desde cache (109,168 tokens leídos de cache por despacho frente a 761 de entrada
  nueva).

## [0.1.0] - 2026-10-11

Primera version. Plugin para OpenCode V2 `2.0.26`.

### Anadido

- **Modo `observe`** (por defecto): calcula huellas de un solo sentido de `system`, `tools` y
  `messages` en cada peticion y mide el prefijo estable entre peticiones comparables. No
  modifica el prompt.
- **Serializacion canonica**: ordena claves de objeto, conserva el orden de arrays y el texto
  byte a byte. Resuelve referencias circulares, `Map`/`Set`/`Date`/`RegExp`, binarios y
  profundidad excesiva sin lanzar.
- **`SHA-256` y `HMAC-SHA256`**. La clave HMAC se genera por proceso y no se persiste.
- **Huellas por parte**: un bloque por parte, con `system`, herramientas (ordenadas por nombre)
  y `messages` en orden. Las partes multimedia se reducen a un descriptor; los bytes nunca se
  hashean ni se almacenan.
- **Uso real del proveedor** via `session.usage.updated`: `cache.read`, `cache.write`, tokens
  de entrada y salida, y coste.
- **Persistencia oficial** en `ctx.storage`, con prefijo `cache-guardian/v1/`, retencion por
  antiguedad y por cantidad. Sin rutas codificadas: multiplataforma por construccion.
- **Comandos** `cache_guardian_report`, `cache_guardian_doctor` y `cache_guardian_reset`
  (este ultimo exige `--confirm`).
- **Informes que separan** estimaciones locales de metricas facturadas, e imprimen `N/A`
  cuando un dato no existe. El ahorro estimado en dolares es siempre `N/A`.
- **`privacy.storeContent` cableado a `false`**, sin forma de activarlo.
- **Limites**: presupuesto de CPU por peticion y tope de payload, con `skipped` explicito
  cuando se supera cualquiera de los dos.
- 120 pruebas: unitarias de huella, configuracion, metricas, almacenamiento e informes, e
  integración sobre un harness de `Plugin.Context`, incluida igualdad profunda del payload
  antes y despues de cada hook.
- CI en `ubuntu-latest`, `macos-latest` y `windows-latest`.

### No implementado, y por que

- **Modo `safe`.** No se encontro ninguna transformacion semanticamente demostrable que no
  reordenara texto libre. Se acepta el esquema y se comporta como `observe`.
- **Modo `experimental`.** Reservado; no hay codigo activo.
- **`storage.storeContent`.** Cableado a `false`.

### Notas

- El orden real de ejecucion de hooks frente a otros plugins no pudo verificarse de forma no
  interactiva. Ver `docs/v2-compatibility.md`.
- `estimateTokens` usa `chars / 4`. Es una heuristica etiquetada como tal, no un tokenizer.