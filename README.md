# Cache Guardian

Plugin para **OpenCode V2** que mide si el prompt cache del proveedor se esta reutilizando
como uno esperaria, y dice la verdad sobre lo que mide.

No comprime. No resume. No reordena. No toca el prompt.

## Que hace y que no

**Hace**

- Calcular huellas de un solo sentido (`SHA-256` o `HMAC-SHA256`) de cada bloque de
  `system`, `tools` y `messages` en cada peticion, antes de enviarla al proveedor.
- Comparar peticiones consecutivas del mismo scope y medir **cuanta parte del prefijo no
  cambio**, y en que bloque cambio por primera vez.
- Recoger el uso real de cache que reporta el proveedor (`cache.read` / `cache.write`) y el
  coste, mediante el evento `session.usage.updated`.
- Informar de ambos, claramente separados.

**No hace**

- No modifica `system`, `messages`, `tools` ni `options`. En `observe` el plugin es
  inmutable por construccion: hay pruebas de igualdad profunda antes y despues de cada hook.
- No hace llamadas a modelos, embeddings ni red. Es determinista y local.
- No comprime contexto ni compete con Context Mode.
- No almacena prompts, codigo, secretos ni rutas absolutas.
- No anuncia ahorro en dolares. Ver [docs/cache-metrics.md](docs/cache-metrics.md).

## Instalacion

Requiere OpenCode `2.0.26` o superior.

```bash
git clone https://github.com/zademy/opencode-cache-guardian
cd opencode-cache-guardian
bun install
bun run build
```

### Opcion A — ruta local en `opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/ruta/absoluta/a/opencode-cache-guardian",
      "options": { "mode": "observe" }
    }
  ]
}
```

O en `.opencode/plugins/cache-guardian/index.ts`, que se descubre solo:

```ts
export { default } from "../../../opencode-cache-guardian/dist/index.js"
```

### Opcion B — shim en el directorio de plugins

La clave `plugin` de `opencode.json` resuelve especificadores de npm; una ruta local ahi se
ignora en silencio en algunas versiones. Si tu configuracion no carga el plugin, escribe un
archivo unico en el directorio que OpenCode si descubre:

```bash
cat > ~/.config/opencode/plugins/cache-guardian.ts <<'EOF'
export { default } from "/ruta/absoluta/a/opencode-cache-guardian/dist/index.js"
EOF
```

### Comprobacion

En una sesion interactiva:

```
/cache_guardian_doctor
/cache_guardian_report
```

## Comandos

| Comando | Que hace |
| --- | --- |
| `/cache_guardian_report` | Informe: prefijos estables, uso real del proveedor, por scope |
| `/cache_guardian_doctor` | Version del SDK, hooks registrados, fuentes de metricas |
| `/cache_guardian_reset` | Borra la telemetria local. Requiere `--confirm` |

V2 no ofrece canal de retorno en los comandos (`execute` devuelve `Promise<void>`), asi que
la salida va a `stdout`.

## Configuracion

Ver [examples/opencode.jsonc](examples/opencode.jsonc). Todos los valores tienen un defecto
razonable y un valor invalido degrada al defecto en lugar de fallar.

| Opcion | Defecto | Que hace |
| --- | --- | --- |
| `mode` | `observe` | Modo de operacion |
| `enabled` | `true` | Si el plugin hace algo |
| `privacy.hashing` | `sha256` | `sha256` o `hmac-sha256` |
| `metrics.enabled` | `true` | Persistir telemetria |
| `metrics.retentionDays` | `14` | Retencion por antiguedad |
| `metrics.maxObservations` | `10000` | Tope por cantidad |
| `limits.maxProcessingMs` | `40` | Presupuesto de CPU por peticion |
| `limits.maxRequestBytes` | `2000000` | Tope de payload analizado |
| `report.includeProviderUsage` | `true` | Incluir metricas reales |
| `safe.dryRun` | `true` | Modo seguro sin escribir |
| `safe.allowMutations` | `false` | Mutaciones (ver Limitaciones) |

## Privacidad

- Se almacena **solo** digests de un sentido, longitudes y etiquetas. Nunca texto.
- `privacy.storeContent` esta cableado a `false` y **no** se puede activar desde la
  configuracion.
- Las partes multimedia se reducen a `media:<tipo>:<mediaType>`. Los bytes de imagen no se
  hashean ni se copian.
- `projectKey` es el identificador opaco del proyecto, no su ruta. `sessionKey` es un prefijo
  del digest del id de sesion. El id real no se persiste.
- La telemetria no sale del equipo. No hay red en el plugin.
- Las claves de almacenamiento viven bajo `cache-guardian/v1/` en el almacenamiento oficial de
  OpenCode, que respeta el aislamiento por proyecto.

### Sobre HMAC

Con `hmac-sha256`, un atacante sin la clave no puede confirmar que un texto conocido esta
presente probando digests. La clave se genera **por proceso** y no se persiste, asi que:

- los digests no son comparables entre reinicios (cada proceso empieza con un prefijo vacio);
- rotar es automatico: basta con reiniciar OpenCode.

Es el intercambio consciente: proteccion contra diccionario a cambio de historial no
persistente. Los conteos agregados siguen siendo validos; la comparacion de prefijos solo
funciona dentro de una misma ejecucion.

## Compatibilidad

El plugin no depende del nombre ni de la API interna de ningun otro plugin, y no requiere
que ninguno sepa que existe:

| Otro plugin | Relacion |
| --- | --- |
| Context Mode | No compite. Se observa lo que queda en el hook en su posicion actual |
| Ponytail | No reordena ni reescribe sus instrucciones |
| Hashline | No toca herramientas ni el formato de anclas `N:hh` |
| RTK | No vuelve a comprimir salidas de CLI |
| Tool Guardian | No intercepta ni duplica reglas de seguridad |
| Error Explainer | No deduplica errores; se tratan como dinamicos |
| Encoding Guard | No lee ni reescribe bytes de archivos |

## Limitaciones

Dichas sin adornos:

1. **`safe` y `experimental` no hacen nada.** El esquema los acepta, pero se comportan
   exactamente como `observe`. No se encontro ninguna transformacion semanticamente
   demostrable que no reordenara texto libre, y reordenar puede cambiar el comportamiento
   aunque el contenido sea identico. Es un resultado aceptable de la especificacion, no un
   olvido: la alternativa era un flag `allowMutations` que no honrara su nombre.
2. **El orden real de hooks no pudo verificarse en un host vivo.** OpenCode ignora
   `XDG_CONFIG_HOME` y su salida de `plugin list` es inestable. Ver
   [docs/v2-compatibility.md](docs/v2-compatibility.md).
3. **Los tokens son una estimacion.** `chars / 4`, etiquetado como tal.
4. **La division en bloques es nuestra, no del proveedor.** Es un indicador estructural.
5. **Sin metrics reales, el informe dice `N/A`.** No rellena huecos.
6. **Los payloads que superan el limite se saltan** y se cuentan como `Skipped`.

## Comparacion A/B

1. Mismo proveedor, modelo y tarea; una sesion con el plugin, otra sin.
2. Separa cache **fria** de **caliente**. Mezclarlas inventa resultados.
3. Compara `costUsd` y `cacheReadTokens`, que son los unicos facturables.
4. Mide el overhead con `hookDurationMs` p50/p95.

En `observe` la peticion es identica con y sin plugin, asi que un A/B de calidad no debería
diferir. Si lo hace, es un bug de este plugin.

## Desarrollo

```bash
bun install
bun run typecheck
bun run lint
bun test
bun run build
```

CI corre typecheck, lint y tests en `ubuntu-latest`, `macos-latest` y `windows-latest`.
El plugin no usa rutas Unix codificadas: la persistencia va por `ctx.storage`.

## Documentacion

- [docs/v2-compatibility.md](docs/v2-compatibility.md) — el contrato del SDK verificado.
- [docs/cache-metrics.md](docs/cache-metrics.md) — que significa cada numero.
- [CHANGELOG.md](CHANGELOG.md)

## Licencia

MIT. Ver [LICENSE](LICENSE).