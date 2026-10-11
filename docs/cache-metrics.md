# Que mide Cache Guardian, y que no

El informe separa deliberadamente **dos clases de metricas** que a menudo se confunden.
Mezclarlas es el error clasico: un prefijo estable no es un cache hit facturado.

## Clase 1 — Estimaciones locales (`source: "local-estimate"`)

Salen de comparar la estructura de la peticion actual con la anterior comparable.

| Metrica | Que es | Que **no** es |
| --- | --- | --- |
| `stablePrefixRatio` | Bloques identicos al inicio, sobre el total | Un cache hit rate |
| `prefixEstimatedTokens` | Tokens estimados del prefijo estable | Tokens que el proveedor reutilizo |
| `totalEstimatedTokens` | Tokens estimados de la peticion | Tokens facturados |
| `hookDurationMs` | Coste propio del hook | Latencia total de la peticion |
| `firstDivergence` / `firstDivergenceGroup` | Primer bloque que cambio, y su grupo | Causa del cambio |

### Sobre `estimateTokens`

`src/fingerprint/blocks.ts` estima tokens como `ceil(caracteres / 4)`. Es una **heuristica**,
no un tokenizer, y el informe la etiqueta siempre como *estimate*. La eleccion es deliberada:
cargar un tokenizer por proveedor y modelo anadiria megabytes de dependencia y una Version que
envejece, a cambio de una precision irrelevante para la pregunta que se responde
("cambia el prefijo?"). Si el SDK llegara a exponer un conteo exacto, seria el campo a usar.

### Como se decide el prefijo

```text
previousBlocks = canonicalFingerprints(previousRequest)
currentBlocks  = canonicalFingerprints(currentRequest)

stablePrefix = 0
for i = 0; i < min(lengths):
    if previousBlocks[i] != currentBlocks[i]: break
    stablePrefix += 1
```

Reglas que hacen que el numero signifique algo:

- Solo se comparan peticiones del **mismo** scope: proyecto, sesion, proveedor, modelo,
  variante y tipo de peticion. Una sesion nunca se compara con otra.
- Un cambio de grupo (`system`, `tools`, `messages`) rompe la coincidencia aunque el digest
  coincidiera. Roles y formatos distintos no se mezclan.
- `firstDivergence === -1` significa coincidencia total. Su presencia en un registro es, ademas,
  la marca de que ese registro **si** fue parte de un par comparable.
- Con cero bloques la proporcion es `undefined`, no `0`: no se presenta un `0%` que parece un
  resultado medido.

### Lo que las huellas si detectan

La serializacion canonica ordena claves de objeto (el orden incidental de un JSON no debe
cambiar el hash) pero **conserva intactos** el orden de los arrays, los espacios, los saltos de
linea, la capitalizacion y el texto Unicode. Normalizar texto fabricaria coincidencias falsas,
porque el proveedor no normaliza.

Consecuencia practica: el plugin detecta que `system` cambia entre peticiones, o que las
definiciones de herramientas se reordenan, sin decidir si eso importa. **Decidirlo excede la
observacion**: el orden de instrucciones puede alterar el comportamiento aunque el contenido
sea identico.

## Clase 2 — Uso real del proveedor (`source: "provider"`)

Proviene del evento `session.usage.updated` y es lo unico que el proveedor reporta:

| Campo | Origen | Naturaleza |
| --- | --- | --- |
| `cacheReadTokens` | `data.tokens.cache.read` | Real, facturado |
| `cacheWriteTokens` | `data.tokens.cache.write` | Real, facturado |
| `inputTokens` | `data.tokens.input` | Real |
| `outputTokens` | `data.tokens.output` | Real |
| `costUsd` | `data.cost` | Real |

Un campo ausente se muestra como `N/A`. Un `0` real (por ejemplo, cache write de 0 en una
peticion de cache caliente) si se muestra como `0`. La distincion importa: `N/A` significa
"no lo sé", `0` significa "lo sé y es cero".

### Los contadores son acumulativos por sesión

Verificado con datos en vivo: dentro de una sesión los valores de `session.usage.updated`
son **monótonos crecientes** (contadores de vida de la sesión, no importes por petición).
Por eso el informe **nunca suma muestras**: el total de una sesión es la lectura más
reciente de cada contador, y el total global es la suma entre sesiones. Sumar las muestras
contaría los mismos tokens una vez por evento (en datos reales, ~33 veces más).

Lo que sí es por petición es la **delta** entre dos muestras consecutivas de la misma
sesión, que el informe muestra como `Median per dispatch`. Una delta negativa (contador
que se reinicia, p. ej. al cambiar de modelo) se descarta, no se acota: distorsionaría la
mediana igual hacia abajo.

Dato real que ilustra el valor de separar ambas clases: mediana por despacho de cache read
109,168 tokens frente a input 761 tokens. El proveedor confirma que casi todo el prompt de
cada petición se sirve desde cache. Ninguna de las dos cifras se deriva de la otra ni de
nuestra estimación local de 12,273 tokens.

## Por que el ahorro estimado es siempre N/A

El informe imprime, siempre, sin excepcion:

```text
Estimated savings in USD: N/A — cache reuse is decided by the provider, not by this plugin
```

El ahorro depende de tres cosas que este plugin no controla ni conoce:

1. **El umbral minimo de cache** del proveedor (si existe, y de cuantos tokens).
2. **La granularidad del bloque de cache.** Nuestra "division en bloques" es una Convencion
   del plugin. La del proveedor es suya y no esta publicada en la API.
3. **La ventana TTL** y la serializacion exacta que el proveedor usa.

Multiplicar un prefijo estimado por una tarifa daria un numero con apariencia de dato y sin
fundamento. La unica cifra de ahorro defendible es `costUsd`, que ya llega calculada por el
proveedor, y comparar entre ejecuciones A/B.

## Limitaciones que el informe asume

- **La serializacion del proveedor no es la nuestra.** Our bloques son una aproximacion
  estructural. El informe la etiqueta como tal y nunca como verdad sobre cache hits.
- **Los hooks tienen orden entre plugins, no una posicion "final".** Si Context Mode u otro
  plugin transforma el contexto despues, lo medido es su salida, no el prompt original.
- **`estimateTokens` no es un tokenizer.** Las cifras de tokens son indicativas.
- **Los payloads enormes se saltan.** Superado `maxRequestBytes` o el presupuesto de tiempo,
  se registra `skipped: oversized_payload` y se sigue. Los ratios de un conjunto recortado no
  son extrapolables al total.
- **No hay atribucion causal.** Una proporcion estable baja dice "aqui hay algo que revisar",
  no "esto te cuesta dinero".

## Recommendations, y su base

Cada recomendacion lleva una linea `basis:` con la cifra que la sostiene. Si no hay pares
comparables, la recomendacion lo dice y no especula. La recomendacion por defecto es
"Not enough comparable pairs yet", porque dos peticiones no demuestran un patron.

## Como comparar A/B de verdad

1. Dos sesiones equivalentes con el mismo proveedor, modelo y tarea.
2. Una con el plugin en `observe`, otra sin el. En `observe` la peticion es identica: hay
   pruebas de igualdad profunda antes/despues del hook.
3. Separar cache **fria** (primera peticion) de **caliente**; mezclarlas inventa resultados.
4. Comparar `costUsd` y `cacheReadTokens` de la clase 2, que son los unicos facturables.
5. Medir el overhead con `hookDurationMs` p50/p95 en la variante con plugin.

La conclusion valida es sobre coste y tokens reales. **Nunca** sobre la proporcion de
prefijos coincidentes.