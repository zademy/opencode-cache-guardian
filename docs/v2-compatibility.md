# Compatibilidad con OpenCode V2

Documento generado durante la Fase 1 (discovery) de `OPENCODE_CACHE_GUARDIAN_V2_SPEC.md`.
Todo lo de aqui se verifico leyendo los `.d.ts` del paquete instalado, no de memoria ni de blogs.

## Version verificada

| Componente | Version |
| --- | --- |
| Binario `opencode` | `2.0.26` |
| `@opencode/plugin` (npm `latest`) | `2.0.26` |
| `@opencode/ai`, `@opencode/schema`, `@opencode/client` | `2.0.26` |

La version del SDK coincide con la del binario. `@opencode/plugin` es aqui una `peerDependency`,
de modo que el plugin se enlaza contra los tipos que el host realmente usa.

## Forma del plugin

V2 **no** devuelve `{ tools, hooks }` como hacia V1. Exporta por defecto un objeto `{ id, setup }`:

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "cache-guardian",
  async setup(ctx) {
    await ctx.session.hook("context", (event) => {
      // modo observe: nunca asignar a event.system / event.messages / event.tools
    })
    return async () => { /* cleanup */ }
  },
})
```

`Plugin` se exporta como **espacio de nombres**, no como tipo. Por eso el codigo usa
`type Context = Plugin.Context` y no `import type { Context } from "@opencode/plugin"`,
que no compila.

## Contrato de `Context` (verbatim de `dist/promise/plugin.d.ts`)

Campos que este plugin usa:

- `app`: `{ name, version, channel }` — se usa para la cabecera del informe.
- `location`: `Location.Info` — ver seccion de privacidad.
- `options`: `Readonly<Record<string, any>>` — configuracion cruda del usuario.
- `session`: `SessionDomain`, que anade `hook: ModelHooks<SessionHooks>`.
- `storage`: `StorageDomain` — almacenamiento local durable y oficial.
- `command`: `CommandDomain`, con `transform(cb)` y `reload()`.
- `event`: `EventDomain`, es decir `subscribe(): AsyncIterable<V2Event>`.

## Hooks de sesion

`ModelHooks<SessionHooks>` devuelve `Promise<Registration>` con `dispose()`. Como el payload
lleva `model`, admite `{ providerID?: string }` para acotar el hook a un proveedor.

Los cuatro payloads observados, textuales de `dist/promise/session.d.ts`:

```ts
export interface SessionRequest {
  readonly sessionID: Session.ID
  readonly model: Model.Ref
  system: Array<SystemPart>
  messages: Array<Message>
  options: SessionRequestOptions
}

export interface SessionContext extends SessionRequest {
  readonly agent: Agent.ID
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>
}

export interface SessionCompaction extends SessionContext { result?: SessionCompactionResult }
export interface SessionGenerate extends SessionContext {}
export interface SessionTitle extends SessionRequest { result?: string }
```

**Esto es lo que hace posible el modo observe sin riesgo.** Los unicos campos mutables son
`system`, `messages`, `tools`, `options`, `result` y `prompt`. `sessionID`, `model` y `agent`
son `readonly`. El plugin nunca asigna a ninguno de los mutables.

`SessionRequestKind` del propio SDK es `"primary" | "compaction" | "title" | "generate"`,
y este plugin reutiliza esa union en `src/metrics/observation.ts`.

El SDK tambien expone `prompt`, `model.request`, `http.request`, `http.response` y `retry`.
Este plugin **no** usa `prompt` (admision de mensajes, no preparacion de contexto) ni los
hooks de HTTP: no aportan observabilidad del prompt sin tocar informacion sensible.

## Orden real de hooks

Un registro posterior ve los cambios de uno anterior, pero **no existe** un hook universal
"ultimo antes del proveedor". El plugin registra `context`, `compaction`, `generate` y `title`,
y etiqueta cada observacion con su propio tipo. Si otro plugin (Context Mode, por ejemplo)
transforma el contexto en un hook posterior, lo que Cache Guardian mide ya es esa version
transformada; esa limitacion se documenta en `docs/cache-metrics.md`.

> Verificacion en un host vivo: **no concluyente**. Ver la seccion final de este documento.

## Almacenamiento

`ctx.storage` es la API oficial y multiplataforma:

```ts
interface StorageDomain {
  get(key: string): Promise<Schema.Json | undefined>
  set(key: string, value: Schema.Json): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: readonly { key: string; value: Schema.Json }[]
    next?: string
  }>
}
```

Se usa con prefijo `cache-guardian/v1/` y paginacion via `scan`. No hay rutas codificadas,
asi que Windows, macOS y Linux funcionan sin configuracion adicional.

`src/storage/store.ts` declara `StorageLike` como alias de `Plugin.Context["storage"]` para
que el tipo de los tests no pueda divergir del SDK.

## Comandos

```ts
interface CommandDomain extends Pick<CommandApi, "list"> {
  transform(callback: (editor: { add(definition: CommandDefinition): void }) => void): Promise<Registration>
  reload(): Promise<void>
}

interface CommandDefinition {
  name: string
  description?: string
  execute(input: { sessionID; prompt; delivery }): Promise<void>
}
```

**Limitacion real y relevante:** `execute` devuelve `Promise<void>`. V2 no ofrece un canal de
retorno para texto, asi que los tres comandos escriben en `process.stdout.write`.

`Registration` no se exporta desde la raiz de `@opencode/plugin`; el plugin declara la
interfaz localmente para poder disponer los comandos en el cleanup.

## Metricas reales del proveedor

La API publica **si** expone uso de cache. `session.usage.updated` es un evento de `V2Event`
(`@opencode/client/dist/promise/generated/types.d.ts`):

```ts
type SessionUsageUpdated = {
  id: string
  created: number
  type: "session.usage.updated"
  location?: LocationRef
  data: { sessionID: string; cost: MoneyUSD; tokens: TokenUsage.Info }
}
```

Y `@opencode/schema/token-usage.d.ts`:

```ts
Info: {
  input: number; output: number; reasoning: number
  cache: { read: number; write: number }
}
```

Asi que `cache.read` y `cache.write` son cifras reales del proveedor, no estimaciones.
El plugin las captura con un bucle desligado `for await (const e of ctx.event.subscribe())`.

Si la forma del evento deriva, `parseUsageEvent` devuelve `undefined`. **Nunca fabrica ceros**:
un campo ausente se reporta como `N/A`, no como `0`.

Nota de nomenclatura: en V2 no existe `message.updated`; los eventos se renombraron
(`session.step.ended`, `session.compaction.started`, ...).

## Privacidad: identificadores de scope

`Location.Info` expone `directory` y `project { id, directory, canonical }`. El plugin usa
`String(ctx.location.project.id)` como `projectKey`:

- es opaco, no una ruta;
- sobrevive a mover o renombrar el repositorio;
- una ruta absoluta nunca llega a los logs ni a los informes.

El identificador de sesion es el prefijo de 16 hex del digest del id real, generado con la
misma clave HMAC que los bloques. El id de sesion en claro no se persiste.

## Partes de mensaje

`@opencode/ai` define `MessageRole = "system" | "user" | "assistant" | "tool"` y tipos de
parte `text`, `media`, `json`, `error`, `content`, `tool-call`, `tool-result`, `reasoning`,
`compaction`, `effort`.

Las partes multimedia (`bytes`, `base64`) **nunca** entran en un digest: se reducen a
`media:<tipoDeFuente>:<mediaType>` con longitud 0. Los bytes de imagen no se copian al
almacenamiento ni se hashean.

## Carga de plugins locales

Un plugin de un solo archivo en `~/.config/opencode/plugins/*.ts` se descubre solo. La clave
`plugin` de `opencode.json`, en cambio, resuelve especificadores de npm; una ruta local ahi se
ignora en silencio. Por eso la guia de instalacion ofrece ambas vias: `plugins` con ruta, o
un shim de un archivo en el directorio de plugins del usuario.

## Verificacion en un host vivo: verificada

El plugin se cargo y se ejecuto contra OpenCode `2.0.26` real, midiendo una sesion de
agente en vivo. Lo observado:

-- **Carga**: `opencode plugin list --builtin` muestra
  `cache-guardian  local  ~/.config/opencode/plugins/cache-guardian.ts`.
-- **Los hooks disparan y los datos persisten**: 34 observaciones y 18 muestras de uso
  escritas en `ctx.storage`.
-- **Uso real del proveedor capturado**: `cacheReadTokens: 21958529` frente a
  `inputTokens: 1178097`. La reutilizacion de cache es real y se observa.
-- **Separacion de `requestKind`**: aparecen `primary` y `title` como valores distintos. El
  hook `title` no se dispara en doble junto a `context`; cada uno se registra y se etiqueta
  por separado.
-- **Latencia y privacidad se sostienen**: `hookDurationMs` de 0 o 1 ms; `projectKey` es un
  identificador opaco de 40 hex, no una ruta; solo se guardan digests.

### La trampa que hizo parecer que no cargaba

`opencode plugin list` **consulta el servicio en segundo plano que ya estaba corriendo**,
arrancado antes de que existiera el shim. Sin `--builtin` no recarga nada, asi que el plugin
nuevo no aparece. `--builtin` si carga los plugins en el proceso actual.

Aun asi, `--standalone` es un flag **global** y `opencode plugin list` lo rechaza con
`Unrecognized flag`. No es la via para forzar una carga limpia.

### Lo que sigue sin verificar

El registro de los tres comandos de barra (`/cache_guardian_report`, `_doctor`, `_reset`) en
una sesion interactiva. `opencode run` **no** resuelve comandos de barra, y el endpoint de
API que los lista no se localizo. Es una comprobacion de una linea para el usuario: escribir
`/cache_guardian_doctor` en una sesion.

### Inspeccionar los datos a mano

`ctx.storage` no guarda la clave tal cual: el servidor la_namespace como
`plugin:<hex-utf16-del-plugin-id>:<clave>`, en la tabla `kv` de
`opencode debug paths` -> base de datos.

```bash
sqlite3 "$(opencode debug paths | awk '/db/{print $3}')" \
  "select value from kv where key like '%cache-guardian%' order by time_updated desc limit 1;"
```

Ojo: el `db` que devuelve ese comando es la base de OpenCode, no la de Cache Guardian.
Cache Guardian no crea ninguna base propia; usa `ctx.storage`.

`scripts/verify-opencode.sh` sigue siendo util: instala el shim, indica los pasos y limpia
al terminar.