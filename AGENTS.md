# AGENTS.md — Venta de Cartera (Exitus Credit)

Guía para cualquier persona o agente de IA que trabaje en este repositorio.
Responsable: Daniel Palma Hernández (Dirección de Cobranza · Reportes y minería de datos).

## Qué es

App de escritorio (Python + Tkinter, distribuida como `Venta_Cartera.exe`) con la que los
vendedores arman **propuestas de venta de cartera** y las **apartan** para que nadie más
venda los mismos créditos. Genera el CSV para **Funnel** (Latin-1).

- Carteras: **JyP** (por crédito, `vReference`) y **Grupal** (por grupo completo, `vGroupId`).
- Tipo de venta: JyP, Grupal o Dual.
- Rango permitido: capital objetivo **−$1,000 / +$2,000**.
- Un grupo sólo se puede vender si **todos** sus integrantes están Disponibles.

## Estado de versiones

| Carpeta | Versión | Almacén | Estado |
|---|---|---|---|
| raíz (`venta_cartera.py`) | **v9** | Carpeta compartida de OneDrive | **PRODUCTIVA — no modificar sin aprobación de Daniel** |
| `Pruebas_v10/` | v10 | Supabase (PostgreSQL) | En pruebas |
| `Respaldo_v6/` (fuera de Git) | v6 | Escribía en las bases | Obsoleta |
| `Servicio_Web/` | Web 1.0 | Supabase + Railway | **En construcción: reemplazará a la app de escritorio** |

**Regla #1:** no se cambia la app productiva hasta que la versión nueva esté validada.
Los cambios se prueban en `Pruebas_v10/` (o en una rama), nunca directo en la raíz.

## Servicio Web (`Servicio_Web/`) — dirección del proyecto

- HTML + JavaScript (módulos ES) + supabase-js; sin framework ni compilación. Servidor estático
  `server.js` (Node, sin dependencias) para Railway. Ver `Servicio_Web/README.md`.
- **Arquitectura por módulos — no editar el núcleo para agregar funciones:**
  - `sitio/nucleo/` login, menú, tema (`estilos.css`), utilidades (`ui.js`). Estable.
  - `sitio/modulos/<modulo>/` cada funcionalidad; exporta `{id, titulo, icono, roles, montar(cont, ctx), desmontar?}`.
  - `sitio/modulos/modulos.json` registra el orden del menú (`activo: false` oculta).
  - SQL por módulo en `supabase/modulos/NN_<modulo>.sql`; el núcleo en `supabase/00_nucleo.sql`.
  - Plantilla: `sitio/modulos/_plantilla/`.
- Datos: `cartera_jyp`, `cartera_grupal` (fila original en `datos jsonb`), `propuestas`,
  `propuesta_detalle`, `apartados_activos` (PK `J:<vReference>` / `G:<vGroupId>` = candado), `cargas`, `perfiles`.
- Seguridad: RLS en todas las tablas; escritura sólo por funciones `security definer` que llaman
  `_exigir_activo()` / `es_admin()`. Nunca exponer la contraseña de la base ni la service key en el sitio.
- Usuarios: Supabase Auth (correo + contraseña, registro público desactivado); rol en `perfiles`:
  `vendedor`, `validador`, `auxiliar` (de venta), `admin` (puede todo). Validar con `_exigir_rol(array[...])`.
- **Flujo de venta:** vendedor aparta → `EN REVISIÓN` (Id `VTA-0300`+, secuencia `folio_venta`) →
  validador `quitar_partidas` / `revisar_propuesta` → `APROBADA` o `RECHAZADA` (libera) →
  auxiliar `generar_sub_base` + `layout_propuesta` → `EN VENTA`. Migradas: `APARTADA` / `EN CONFLICTO` con Id `PV-…`.
- Avisos: tabla `notificaciones` + campana del núcleo; desde SQL `perform _notificar(roles[], user, titulo, mensaje, modulo)`.
- Al agregar funciones RPC en Supabase el esquema se recarga solo; en PostgREST local: `notify pgrst, 'reload schema'`.
- Carga mensual y migración: `cargar_supabase.py`.
- Claude Code: `.mcp.json` (se crea desde `mcp_supabase.json`) conecta el MCP de Supabase del proyecto
  `vwlfxkaxiduvolbvdmmg`; autenticar con `claude /mcp`. Skills en `.agents/skills/` (`npx skills add supabase/agent-skills`).
- GitHub: `https://github.com/EXITUS-Mineria/App-Venta` (subir con `SUBIR_A_GITHUB.bat`).

## Archivos

| Archivo | Para qué |
|---|---|
| `venta_cartera.py` | App completa (un solo archivo) |
| `COMPILAR_EXE.bat` | Compila con PyInstaller y actualiza `Venta_Cartera_Instalable/` (sólo reemplaza el EXE) |
| `EJECUTAR_APP.bat` | Corre la app con Python |
| `Plantilla_Propuesta_Anterior.csv` | Plantilla para importar propuestas hechas fuera de la app |
| `Pruebas_v10/configurar_supabase.py` | Crea esquema, usuario limitado, sube bases y migra apartados |
| `Pruebas_v10/PROBAR_APP_V10.bat` | Abre la v10 conectada a Supabase |
| `README_v*.txt`, `INSTRUCCIONES_COMPARTIR.txt` | Notas de cada versión para usuarios |

## Datos (NUNCA van a Git)

- `Base JyP.csv`, `Base Grupal.csv`: insumo mensual, Latin-1. Columnas clave:
  `vReference`, `vGroupId` (Grupal), `Estado`, `Municipio`, `nPendingK` (capital), `Estatus`,
  `iDays` (JyP) / `Diasatraso_hoy` (Grupal, se usa como mora si no hay `iDays`).
  Colonia opcional: `Colonia`, `vColonia`, `Colonia_Cliente` o `Asentamiento`.
- `Estatus`: `Disponible` o `Propuesta/Venta`. Cualquier otro valor = no vendible.
- `Apartados/`, `Liberaciones/`, `Propuestas_Registradas/`, `Bases Sandibel/`: operación diaria.
- `conexion_supabase.ini`: credenciales del usuario `venta_app`.

El `.gitignore` ya excluye todo esto. **No subas datos de clientes ni contraseñas.**

## Cómo funciona el apartado

### v9 (productiva, carpeta OneDrive)
- La app **nunca modifica las bases**. Cada apartado es un **archivo nuevo** en `Apartados/`
  y cada liberación un archivo nuevo en `Liberaciones/` (append-only → sin conflictos de OneDrive).
- Estatus efectivo = Estatus de la base + apartados vigentes − liberados.
- Si dos propuestas toman lo mismo, **gana la más antigua** (`FechaPropuesta` con ms) y la
  otra queda **EN CONFLICTO** (se ve en Bitácora; no se manda a Funnel; se libera).
- Revisa cambios de otros usuarios cada 60 s.
- Migra sola las propuestas de v7/v8 (`Bitacora_Propuestas.csv` + `Propuestas_Registradas/`).

### v10 (pruebas, Supabase)
- Activada sólo si existe `conexion_supabase.ini`; sin él funciona como v9.
- Esquema `venta`: `bases` (CSV gzip + versión, se guardan las 3 últimas), `apartados`, `liberaciones`.
- Apartar = una transacción con `pg_advisory_xact_lock`; si algo ya está apartado no inserta nada.
- Usuario `venta_app`: sólo `select` en bases y `select/insert` en apartados y liberaciones.
  `postgres` sólo se pide al subir bases (nunca se guarda).
- Caché local de bases: `%LOCALAPPDATA%\VentaCartera\cache`.
- Host directo de Supabase es sólo IPv6; en oficina usar **Session pooler** (usuario `venta_app.<proyecto>`).

## Roles

- **Administrador**: usuarios en `ADMINISTRADORES` del código o en `administradores.txt`.
  Puede liberar cualquier propuesta, importar propuestas anteriores y (v10) subir bases.
- **Vendedor**: arma, aparta y libera sólo sus propuestas.

## Convenciones de código

- Un solo archivo `venta_cartera.py`; funciones de datos a nivel módulo (probables sin GUI),
  la GUI en `VentaCarteraApp` y `VentanaBitacora`.
- Interfaz en **español** (respetar Ñ y acentos). Tema Ejecutivo Exitus:
  tinta `#1F2430`, rojo `#B01217`, fondo `#F3F4F6`, bordes `#D9DDE3`, Segoe UI.
  Tamaños en puntos (respeta escala de Windows) con A−/A+.
- Panel izquierdo (parámetros + filtros) y tabla de validación a la derecha a toda la altura.
- CSV para Funnel: Latin-1, columnas de la base + metadatos de propuesta
  (`IdPropuesta`, `UsuarioWindows`, `CapitalSeleccionadoPropuesta`, `ValorVentaPropuesta`, …).
- Ids de propuesta: `PV-AAAAMMDD-HHMMSS-XXXXXX`.
- No introducir dependencias nuevas sin actualizar `requirements.txt` y `COMPILAR_EXE.bat`.

## Probar antes de entregar

1. `python -c "import ast; ast.parse(open('venta_cartera.py', encoding='utf-8').read())"`
2. Con copias de las bases (nunca las productivas): abrir JyP, Grupal y Dual, aplicar filtros,
   Sugerir propuesta, Validar y apartar, liberar, importar anteriores.
3. Simular dos usuarios apartando lo mismo: el segundo debe ser rechazado (v10) o quedar EN CONFLICTO (v9).
4. Confirmar que las bases no cambiaron (hash antes/después).
5. Compilar con `COMPILAR_EXE.bat` y abrir el EXE en un equipo Windows.

## Pendientes conocidos

- Borrar el EXE viejo v8 de la raíz y `dist/` (escribe en las bases y no ve apartados de v9).
- Liberar propuestas EN CONFLICTO: E3AE81, 8BC044, 376E26, C640FC.
- `Base Grupal.csv` trae 262 filas repetidas; las bases no traen columna Colonia.
- Validar v10 en Supabase (checklist en `Pruebas_v10/README_v10.txt`) y cambiar la contraseña de `postgres`.
