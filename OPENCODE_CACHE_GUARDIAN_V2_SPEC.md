# OpenCode Cache Guardian — Especificación de implementación V2

> **Instrucción para el agente:** implementa el plugin funcional, sus pruebas y documentación. No te detengas en una propuesta arquitectónica. Investiga primero el SDK V2 realmente instalado y ajusta la implementación a sus tipos públicos. El comportamiento predeterminado debe ser **observe** y **cero mutaciones del prompt**.

## 1. Objetivo

Construir `opencode-cache-guardian`, un plugin **local-first, determinista y multiplataforma** (Windows/macOS/Linux) para medir y, únicamente si es seguro, mejorar la **reutilización del prompt cache del proveedor** en OpenCode V2.

El usuario ya utiliza:

- **Context Mode**: gestión, recuperación y reducción de contexto.
- **Ponytail**: instrucciones/skill de calidad y simplicidad.
- **Hashline**: lectura y edición con anclas precisas.
- **RTK**: reducción/estructuración de output de CLI.
- **Open Guard / Tool Guardian**: análisis de decisiones, redundancias y acciones riesgosas.
- **Error Explainer**: interpretación de fallos.
- Potencial **Encoding Guard** para ISO-8859-1/Windows-1252.

No duplicar ninguna de esas responsabilidades. Este plugin **no** debe comprimir, resumir, limpiar, reemplazar ni inyectar contexto. Su primera misión es responder de forma fiable: «¿están cambiando entre solicitudes partes del prompt que podrían permanecer estables?».

### Garantías

1. **Sin llamadas adicionales a modelos**. Ningún LLM, embedding, servidor externo ni API adicional para optimizar.
2. **Sin alterar la semántica por defecto**. `observe` solo calcula huellas y estadísticas; no cambia `system`, `messages`, `tools` ni opciones del modelo.
3. **Seguridad antes que ahorro**. No reorganizar bloques por el simple hecho de parecer estables.
4. **Medición honesta**. Distinguir coincidencia local de prefijos de *cache hits facturados* por el proveedor; nunca confundir ambos.
5. **Aislamiento** de proyectos/sesiones/proveedores/modelos/agentes; sin almacenar prompts, código fuente, secretos ni contenidos textuales por defecto.
6. **Tolerancia a fallos**. Un error del plugin nunca debe romper una solicitud legítima en modo `observe`; degradar elegantemente.
7. **Compatibilidad V2 real**. No utilizar hooks V1 ni APIs internas/experimentales sin aceptación explícita.

## 2. Referencias oficiales para verificar antes de escribir código

- Plugin V2: https://dev.opencode.ai/v2/docs/build/plugins/
- Migración V1→V2: https://dev.opencode.ai/v2/docs/build/plugins/migrate-v1
- Configuración V2: verificar sección `plugins` en la documentación anterior.
- Consultar los tipos del paquete V2 `@opencode/plugin` de la versión instalada.

**IMPORTANTE:** en la documentación V2 la importación ilustrada es:

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "cache-guardian",
  async setup(ctx) {
    await ctx.session.hook("context", (event) => {
      // MODO OBSERVE: nunca modificar event.
    })
  },
})
```

Este bloque es orientativo, **no** implementación suficiente. Confirmar los tipos exactos y cómo registrar/disponer hooks. Para llamadas auxiliares considerar `compaction`, `generate`, `title` por separado solo si procede. **No** confundir `prompt` (admisión de mensajes) con `context` (antes del modelo).

Las modificaciones V2 a `event.system`, `event.messages` o `event.tools` son posibles, pero en este proyecto quedan prohibidas por defecto. El hook de `model.request`/HTTP solo deberá usarse si se valida que proporciona observabilidad útil sin acceder ni modificar información sensible.

## 3. Primer diagnóstico obligatorio del agente

1. Identificar versión exacta de OpenCode V2 y paquete plugin.
2. Leer los tipos reales de `SessionContextHook`, `SystemPart`, `Message`, `TokenUsage`, registro de eventos, `ctx.storage`, `ctx.command`/herramientas y métricas disponibles.
3. Verificar qué datos de uso/caché ofrece la API pública (cache reads/writes, input tokens, coste, latencia). **Si no existen, informar que no están disponibles y no inventarlos.**
4. Verificar el orden real de hooks con Context Mode y otros plugins en una instancia de prueba. Un registro posterior ve cambios anteriores, pero no asumir que existe un hook universal «último antes del proveedor».
5. Documentar limitaciones de OpenCode V2, compatibilidad exacta y decisiones de implementación.
6. No afirmar que controlar los headers de HTTP activa mágicamente prompt caching; no establecer headers de caché sin documentación específica del proveedor.

## 4. Tres modos

### `observe` (obligatorio, **default**)

- Observar solicitudes antes de cada despacho del modelo.
- Calcular huellas **no reversibles** de bloques y secuencias, excluyendo contenido sensible de los logs.
- Medir estabilidad entre peticiones comparables.
- Mantener métricas locales con retención configurable.
- Generar recomendaciones **sin alterar el prompt**.
- Latencia del hook registrada; no pasar por un servicio remoto.

### `safe` (opcional, después de pruebas)

- Prohibido reorganizar, borrar, reescribir o deduplicar `messages`, pares tool-call/result, instrucciones de seguridad, instrucciones de sistema de otros plugins y esquemas de herramientas.
- Únicamente permitir transformaciones **explícitamente autorizadas y semánticamente equivalentes**, verificables automáticamente. Si V2 no ofrece ningún conjunto de modificaciones inequívocamente seguras, implementar `safe` como `observe` + recomendaciones. Esto es un resultado aceptable.
- No mover texto libre de `system` arbitrariamente; el orden puede alterar comportamiento, incluso si el contenido es idéntico.
- Antes/después de cada transformación, comprobar invariantes estructurales y restaurar el original si falla cualquier validación.
- Exigir opción de activación explícita, flags por proyecto y modo dry-run.

### `experimental` (no implementar como funcionalidad activa en MVP)

- Reservar para investigación en una rama/entorno aislado; no habilitar en producción.
- Nunca seleccionar por defecto tras actualizar.

## 5. Modelo de datos y fingerprinting

Una observación lógica debe incluir:

```ts
interface CacheObservation {
  time: number;
  projectKey: string;        // pseudónimo/no ruta absoluta en logs
  sessionKey: string;        // pseudónimo
  provider: string;
  model: string;
  variant?: string;
  agent?: string;
  requestKind: "primary" | "compaction" | "generate" | "title" | "unknown";
  blockCount: number;
  prefixBlockCount: number;
  prefixEstimatedTokens?: number;
  totalEstimatedTokens?: number;
  stablePrefixRatio?: number; // métrica local, NO hit rate del proveedor
  hookDurationMs: number;
  source: "local-estimate";
}
```

Puedes mejorar este modelo según los tipos públicos disponibles.

Reglas:

- Calcular SHA-256 (o equivalente criptográfico) sobre **serialización canónica** del contenido observado, preservando el orden semántico. Incluir papel/rol, tipo de parte, nombre de herramienta y esquema cuando corresponda.
- Evitar comparar cadenas JSON cuyo orden incidental de claves vuelva inestables los hashes; normalizar claves de objetos estructurados sin reordenar arrays.
- **No normalizar espacios, saltos, capitalización, ni texto Unicode** si el proveedor no lo hace: normalizar puede fabricar coincidencias falsas.
- Separar fingerprints de `system`, `messages` y `tools`; registrar también el prefijo agregado tal como se observe.
- El orden/serialización del proveedor puede ser distinto de la representación del SDK: **etiquetar la medición como aproximación local**, no como verdad sobre cache hits reales.
- Emparejar observaciones únicamente dentro del mismo proveedor, modelo, variante y tipo de solicitud, y preferentemente del mismo proyecto/sesión o scope de configuración.
- Tratar contenidos multimodales de forma segura: metadatos/identificadores estables si están permitidos; jamás copiar blobs o imágenes al almacenamiento.
- Usar hash con clave local opcional (HMAC) para resistir ataques de diccionario sobre cadenas conocidas; documentar la protección y rotación de clave.
- Manejar contenido no serializable, referencias circulares, tipos desconocidos y payloads grandes sin fallar la petición.
- No retener hashes de secretos de alta sensibilidad si se identifican por el contrato del SDK; ser conservador con métricas agregadas.

## 6. Algoritmo para identificar prefijos reutilizables

No se pretende reconstruir exactamente la serialización interna del proveedor. Se pretende un **indicador de estabilidad estructural**.

```text
previousBlocks = canonicalFingerprints(previousRequest)
currentBlocks  = canonicalFingerprints(currentRequest)

stablePrefix = 0
for i = 0; i < min(lengths):
    if previousBlocks[i] != currentBlocks[i]: break
    stablePrefix += 1

report(stablePrefix, totalBlocks, estimatedTokenLengths)
```

- No combinar bloques cuyos roles o formatos difieran.
- Comparar solo peticiones compatibles.
- Calcular estabilidad de prefijo sin asumir que todos los proveedores hacen caching sobre los mismos límites mínimos o TTL.
- Registrar si la primera divergencia aparece en `system`, definiciones de herramientas o contexto variable, **sin registrar contenido de ese bloque**.
- Si la solicitud o metadata no es observable, omitir con motivo explícito.
- Preferir métricas basadas en conteos exactos **si el SDK los proporciona**; en caso contrario, ofrecer estimaciones marcadas como tales, con tokenizer específico del proveedor/modelo si hay uno local y disponible. No usar `string.length` como cantidad exacta de tokens.

## 7. Métricas y costes: dos clases separadas

### 7.1 Métricas observables locales

- Conteo de peticiones estudiadas.
- Bloques estables / bloques totales.
- Prefijo estable en bloques y estimación de tokens.
- Distribución de primera divergencia.
- Latencia añadida por hook p50/p95.
- Peticiones omitidas y causas.
- Frecuencia de cambios de `system`/`tools`/`messages`.

### 7.2 Métricas **reales** del proveedor (solo si disponibles)

- Tokens de caché leídos/escritos, conforme a definiciones del proveedor.
- Tokens de entrada sin caché.
- Coste reportado o calculable con tarifas **configuradas explícitamente y fechadas**.
- Cache hit rate **real** solo con denominador definido y campos suficientemente fiables.
- Distinguir tokens cacheados, tokens facturados, descuentos y diferencias de latencia.

Si no hay acceso a uso real, mostrar por ejemplo:

```text
Provider cache read tokens: N/A — not exposed by current API
Estimated stable prefix: 8,400 tokens (local estimate)
Estimated savings in USD: N/A — insufficient billing data
```

**Nunca** anunciar «ahorro de X%» sobre una cifra que solo mide prefijos coincidentes. El caching lo determina el proveedor, no Cache Guardian.

## 8. Compatibilidad explícita con el stack del usuario

### Context Mode

- No competir en compactación, RAG, indexación, búsqueda ni filtrado.
- No rehacer outputs ni resumir contexto.
- En modo `observe`, observar lo que realmente queda en el hook de contexto en la posición actual.
- Registrar orden de hooks conocido; exponer limitación si otro plugin transforma contexto después.

### Ponytail

- No reordenar, reemplazar, simplificar ni borrar sus instrucciones.
- No inferir prioridades de un bloque por su nombre.

### Hashline

- No reordenar herramientas, reemplazar sus definiciones, ni afectar anclas `N:hh`.
- No modificar el contenido de tool calls ni resultados.

### RTK

- No comprimir de nuevo resultados de CLI.
- No interferir con comandos shell.

### Open Guard / Tool Guardian

- No interceptar ni duplicar reglas de seguridad, deduplicación o ejecución de herramientas.

### Error Explainer

- No deduplicar errores, diagnósticos o mensajes; considerarlos dinámicos.

### Encoding Guard

- No leer ni reescribir bytes de archivos; no cambiar archivos ISO-8859-1, Windows-1252 ni CRLF/BOM.

### Degradación

- Ningún otro plugin necesita conocer la existencia de Cache Guardian.
- Sin depender de nombres de plugin ni de sus APIs internas.
- Si detectar procedencia exacta de bloques es imposible, mostrar `source: unknown` en lugar de adivinar.

## 9. Configuración propuesta

Usar `ctx.options` en la forma oficial de V2 si está disponible; validar esquema con tipos y tests. **El siguiente JSON es propuesta de nuestro plugin, no claves nativas de OpenCode**:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugins/cache-guardian",
      "options": {
        "mode": "observe",
        "enabled": true,
        "privacy": { "storeContent": false, "hashing": "hmac-sha256" },
        "metrics": { "enabled": true, "retentionDays": 14, "maxObservations": 10000 },
        "limits": { "maxProcessingMs": 40, "maxRequestBytes": 2000000 },
        "report": { "includeProviderUsage": true },
        "safe": { "dryRun": true, "allowMutations": false }
      }
    }
  ]
}
```

Valores orientativos; elegir límites razonables y no prometer un timeout duro sin capacidad real de interrupción. Añadir configuración mediante variables de entorno si es útil, sin exponer secretos.

## 10. Reporte y comandos

Proponer un comando de OpenCode V2 o herramienta de consulta, usando únicamente el mecanismo registrado/documentado:

- `cache_guardian_report` (read-only): estado por sesión, proyecto, proveedor/modelo y ventanas temporales.
- `cache_guardian_doctor` (read-only): comprobar versión SDK, modo, hooks, compatibilidad y fuentes de métricas.
- `cache_guardian_reset` (acción explícita): limpiar telemetría local del plugin, con confirmación si la API lo permite.

No afirmar que `/cache report` existe automáticamente. Si V2 permite registrar comandos, implementar vía API oficial; si no, herramienta equivalente y documentar invocación.

Ejemplo:

```text
Cache Guardian | observe | OpenCode V2
Requests observed: 84
Comparable pairs: 61
Median local stable prefix: 72% (blocks)
Provider cache reads: unavailable
USD savings: unavailable
Hook overhead p95: 2.7ms (example only)
Changed block group first: messages in 71% of comparable pairs
No prompts or source code stored.
```

No guardar ni publicar ejemplos fabricados como métricas reales.

## 11. Arquitectura propuesta

```text
opencode-cache-guardian/
├── src/
│   ├── index.ts
│   ├── opencode/
│   │   ├── hooks.ts
│   │   ├── reporting.ts
│   │   └── version-capabilities.ts
│   ├── fingerprint/
│   │   ├── canonicalize.ts
│   │   ├── hash.ts
│   │   ├── blocks.ts
│   │   └── prefix.ts
│   ├── metrics/
│   │   ├── observation.ts
│   │   ├── aggregation.ts
│   │   ├── provider-usage.ts
│   │   └── costs.ts
│   ├── storage/
│   │   ├── store.ts
│   │   └── retention.ts
│   ├── policy/
│   │   ├── modes.ts
│   │   └── invariants.ts
│   └── config/
│       ├── schema.ts
│       └── defaults.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── README.md
├── CHANGELOG.md
├── LICENSE
├── package.json
└── tsconfig.json
```

Simplificar si conviene, pero separar claramente el SDK V2, algoritmo determinista, persistencia y reporting.

## 12. Persistencia, privacidad y plataformas

- Preferir almacenamiento oficial `ctx.storage` si soporta consultas y retención requeridas; si no, persistencia local segura (por ejemplo SQLite solo si se justifica) con rutas multiplataforma.
- No usar rutas Unix codificadas en duro. Usar APIs de rutas del runtime y scopes de proyecto.
- No recolectar prompts completos, contenido de archivos, tokens secretos, endpoints privados, argumentos de herramientas ni bodies HTTP.
- No enviar telemetría a terceros.
- No mostrar rutas completas a repositorios en informes compartidos por defecto.
- Respetar límites de almacenamiento y podar por tiempo/cantidad.
- Evitar bloqueo de archivos y corrupción por acceso concurrente.
- Tratar metadatos de tokens/costes como información local.
- Validar ausencia de escritura de datos sensibles por inspección de archivos de telemetría.

## 13. Rendimiento

- Algoritmo determinista, sin red y sin LLM.
- Optimizar hashing incremental si aporta beneficios reales.
- No serializar repetidamente payloads gigantes si puede acotarse sin mentir sobre la cobertura.
- Si se supera límite, registrar `skipped: oversized_payload` y continuar sin bloquear.
- Medir p50/p95/p99 de latencia del propio plugin.
- No leer el repositorio ni recorrer archivos para construir métricas de caché.
- El modo `observe` no debe causar un efecto secundario visible en el contexto o herramientas.

## 14. Pruebas obligatorias

### Unidad

- Hashes iguales para estructuras equivalentes con claves JSON en distinto orden.
- Hashes diferentes si cambia un carácter, orden de array, rol, llamada de herramienta o schema.
- Unicode, acentos, emojis, CRLF, cadenas vacías y contenido grande.
- Primera divergencia al comienzo/medio/final.
- Comparación cero bloques / una solicitud / cambio de modelo/variante.
- Datos desconocidos/multimodales no producen crash.
- Se maneja la ausencia de métricas reales sin inventar ahorro.
- Reglas `observe` nunca mutan `event`.

### Integración V2

- El plugin carga mediante `Plugin.define` en la versión oficial instalada.
- La solicitud con plugin en `observe` coincide con la solicitud sin plugin en todos los campos observables de `system`, `messages`, `tools` y `options` (deep equality).
- Context Mode, Ponytail y Hashline siguen funcionando si están instalados.
- Registrar solicitud `context` durante el loop del agente y no etiquetar `compaction`/`title` incorrectamente.
- Comprobar manejo de excepciones del almacenamiento y ejecución concurrente.
- Comprobar limpieza de registros de hooks al descargar el plugin si aplica.
- Verificar Windows/macOS/Linux al menos con una matriz CI por sistema operativo.

### Privacidad

- Incluir fixture con token falso y ruta privada; demostrar que no se guardan en claro en logs o métricas.
- No almacenar plaintext del system prompt ni del historial.

### Calidad y benchmark A/B

- Baseline A: OpenCode V2 sin Cache Guardian.
- Variante B: OpenCode V2 + Cache Guardian (`observe`).
- Mantener mismo proveedor/modelo/tarea y documentar caché fría/caliente.
- Medir overhead y métricas reales cuando estén disponibles.
- **No concluir mejora de coste con estimaciones locales de prefijos.**
- Para el futuro `safe`, añadir pruebas de equivalencia y tareas funcionales; si empeora calidad, desactivar.

## 15. Fases de entrega

### Fase 1 — Discovery (obligatoria)

Identificar API V2 real, métricas oficiales y límites. Escribir hallazgos en `docs/v2-compatibility.md`.

### Fase 2 — Core determinista

Implementar serialización canónica, hashing, comparación de prefijos, separación de scopes y tests.

### Fase 3 — Hook observe

Instalar hook `ctx.session.hook("context", ...)`, evaluar captura de otros tipos de solicitud solo si es necesaria, y garantizar inmutabilidad.

### Fase 4 — Persistencia y reporte

Almacenamiento local privado, agregaciones, retención, herramientas de consulta y `doctor`.

### Fase 5 — Integración y benchmarks

Pruebas con plugins del stack, compatibilidad multiplataforma y reporte A/B.

### Fase 6 — Modo safe (solo si se demuestra viable)

Diseñar transformaciones limitadas y opt-in **sin reordenar instrucciones de texto libre**. Si no existe ninguna transformación semánticamente demostrable, documentarlo y no introducir cambios riesgosos.

## 16. Criterios de aceptación / Definition of Done

- [ ] Proyecto TypeScript instalable como plugin **OpenCode V2**, no V1.
- [ ] Compila y pasan typecheck, lint y tests.
- [ ] Modo `observe` activado por defecto.
- [ ] **Cero cambios** en prompts, tools, roles, opciones y resultados del modelo en `observe`.
- [ ] Cero llamadas LLM, embeddings o red por parte del optimizador.
- [ ] Fingerprints locales comparables por modelo/proveedor/agente/proyecto.
- [ ] Informe diferencia estimaciones de estabilidad y estadísticas reales del proveedor.
- [ ] Sin métricas reales, presenta `N/A`, no porcentajes ficticios de ahorro.
- [ ] Sin almacenamiento de texto confidencial.
- [ ] Latencia y límites medidos, sin bloquear tareas legítimas.
- [ ] Compatible en pruebas con Context Mode, Ponytail, Hashline y RTK; sin reescribir comportamiento de otros plugins.
- [ ] Windows/macOS/Linux soportados y CI configurado.
- [ ] README con instalación local V2, configuración, privacidad, ejemplos, limitaciones y guía de comparación A/B.
- [ ] Documentada la versión real del SDK y la forma de obtener/desconocer cache usage.
- [ ] No se activa ninguna optimización semánticamente riesgosa por defecto.

## 17. Entregables

1. Código fuente del plugin publicable (sin URL inventada).
2. `package.json`, scripts `test`, `typecheck`, `lint`, `build`.
3. Tests unitarios e integración real V2.
4. README en español (y opcionalmente inglés).
5. `docs/v2-compatibility.md` y `docs/cache-metrics.md`.
6. Ejemplo probado de `opencode.jsonc` V2.
7. Reporte final del agente: features implementadas, comandos ejecutados, pruebas realizadas, restricciones, métricas observadas y funcionalidades diferidas.

## 18. Instrucción final para OpenCode

**Construye el plugin, no solo lo diseñes.** Empieza inspeccionando el proyecto y el SDK V2 instalado; sigue las fases; implementa el MVP `observe` completo; ejecuta verificaciones y corrige fallos. Si no puedes obtener campos de cache billing desde la API pública, documenta la limitación y continúa con métricas locales honestas. No copies APIs V1. No modifiques archivos de los plugins existentes ni conviertas el optimizador en otro Context Mode. Prioriza precisión, privacidad, compatibilidad y coste medible sobre promesas de ahorro.
