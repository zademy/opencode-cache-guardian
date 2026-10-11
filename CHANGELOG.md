# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado segun [SemVer](https://semver.org/lang/es/).

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