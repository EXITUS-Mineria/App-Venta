# Venta de Cartera · Servicio Web

Página web (HTML + JavaScript) con base de datos en **Supabase** y publicada en **Railway**.
Reemplaza a la app de escritorio cuando esté validada; hasta entonces la v9 sigue en producción.

```
Servicio_Web/
├── sitio/                     ← lo que ve el usuario
│   ├── index.html
│   ├── config.js              ← ÚNICO archivo a editar al instalar (URL y anon key)
│   ├── nucleo/                ← login, menú, tema, utilidades (no se toca)
│   └── modulos/
│       ├── modulos.json       ← lista de módulos del menú
│       ├── venta/             ← Armar propuesta + Bitácora + layout Funnel
│       ├── funnel/            ← avance de cada venta (réplica de la lista SharePoint VENTAS DE CARTERA)
│       ├── propuesta_ia/      ← estado + municipio + monto → propuesta al instante
│       ├── restituciones/     ← cambiar crédito/grupo vendido por otro similar (±$5,000)
│       ├── revision/          ← (validador) revisar, quitar partidas, aprobar/rechazar
│       ├── subbases/          ← (auxiliar de venta) generar la sub base para Funnel
│       ├── usuarios/          ← (admin) roles y altas
│       ├── cargas/            ← (admin) bases cargadas
│       └── _plantilla/        ← copia esto para crear un módulo nuevo
├── supabase/
│   ├── 00_nucleo.sql          ← usuarios, roles y notificaciones (campana)
│   └── modulos/
│       ├── 10_venta.sql       ← cartera, propuestas VTA-####, apartar, revisión, sub base
│       ├── 11_carga_desde_tablas.sql ← carga la cartera desde BASE_JYP / BASE_GRUPAL
│       ├── 12_rendimiento.sql ← columnas normalizadas e índices (búsqueda < 1 s)
│       ├── 13_datos_aparte.sql← la fila original de cada crédito en tabla aparte
│       ├── 14_vista_usuarios.sql ← vista usuarios_app (consulta en Supabase, sin contraseñas)
│       ├── 15_restituciones.sql  ← restituciones, folio RST-####, créditos bloqueados
│       ├── 16_complementar.sql   ← agregar cartera a una venta existente (ventas parciales)
│       ├── 17_seguimiento.sql    ← historial de cada propuesta, CSV de propuesta, base final al dueño
│       ├── 18_comprador.sql      ← nombre del comprador (obligatorio al apartar)
│       ├── 19_funnel.sql         ← funnel de ventas (MD, control documental, jurídico, cierre, ticket, guía)
│       ├── 20_funnel_migracion.sql ← campos de la migración SharePoint (mes, ligas, adjuntos)
│       └── 21_almacenamiento.sql ← una sola copia de la cartera (lee BASE_JYP/BASE_GRUPAL)
├── cargar_supabase.py         ← aplica SQL, sube bases, migra apartados, da admin
├── CARGAR_SUPABASE.bat
├── server.js / package.json   ← servidor para Railway (sin dependencias)
└── README.md
```

## Flujo de venta

| Paso | Quién | Qué hace | Estatus | Aviso (🔔) a |
|---|---|---|---|---|
| 1 | Vendedor | Arma la propuesta y la aparta. Se le asigna **VTA-0300, VTA-0301…** | EN REVISIÓN | Validadores y admins |
| 2 | Validador | Revisa; puede **quitar partidas** (regresan a Disponible) | EN REVISIÓN | — |
| 3a | Validador | **Aprueba** | APROBADA | Auxiliares, admins y el vendedor |
| 3b | Validador | **Rechaza** con motivo; todo regresa a Disponible | RECHAZADA | El vendedor |
| 4 | Auxiliar de venta | **Genera la sub base** (layout Funnel Latin-1 `VTA-####.csv`) | EN VENTA | El vendedor |

- El vendedor ya **no** descarga el layout; sólo el auxiliar (y validador/admin) desde Sub bases o Bitácora.
- El vendedor puede liberar su propuesta mientras está EN REVISIÓN; después, sólo un administrador.
- Las propuestas migradas de la app de escritorio conservan su Id `PV-…` y estatus APARTADA / EN CONFLICTO.
- Roles: **Vendedor, Validador (maestro), Auxiliar de venta, Administrador**. El **Validador es el usuario
  maestro**: igual que el Administrador ve todos los módulos, puede todo y **da de alta usuarios** y cambia
  contraseñas desde el módulo **Usuarios** (sin entrar a Supabase).
- La campana revisa avisos cada minuto y al cambiar de pantalla.

### Propuesta IA
Estado + municipio (o todos) + monto → arma la propuesta dentro del rango probando varios criterios
(mayor mora, mayor capital…). «Otra opción» cambia de criterio. Un clic la aparta y la manda a revisión.

### Restituciones (motivos: Defunción, Liquidado, Venta duplicada, Incidencia en el expediente)
1. Se escribe la vReference o el grupo; se valida en las bases y que esté vendido/en propuesta
   (la vReference de un integrante restituye su grupo completo).
2. Sugiere reemplazos disponibles del mismo tipo con capital ±$5,000 (los más cercanos primero).
3. Al aplicar: folio **RST-####**; el reemplazo entra a la misma propuesta (si se vendió antes de la
   página se crea una propuesta RST-#### APROBADA); el original queda **bloqueado** para siempre;
   se avisa al validador y al auxiliar (regenerar sub base).

### Complementar una venta (ventas parciales)
Bitácora › **➕ Complementar** abre Armar propuesta en modo complemento: lo que selecciones se agrega a
esa venta (sin regla de rango). Si estaba APROBADA o EN VENTA regresa a EN REVISIÓN.

### Funnel de ventas
Réplica de la lista SharePoint «VENTAS DE CARTERA». Cada VTA-#### entra sola al apartar (Propuesta) y se
sincroniza con la propuesta (comprador, capital, monto; Cancelada si se libera/rechaza). Etapas:
1 Propuesta → 2 MD → 3 Control documental → 4 Jurídico → 5 Cierre → ✔ Cerrada. ⏰ = fecha límite vencida.
Editan: auxiliar de venta y maestros (todo); el vendedor dueño, la sección Venta y ligas.

### Almacenamiento (mínimo)
- La cartera vive **una sola vez** en `BASE_JYP` / `BASE_GRUPAL`; la página sólo guarda un índice ligero
  para buscar (`cartera_jyp` / `cartera_grupal`). La fila completa se copia únicamente para lo apartado.
- Propuestas liberadas o rechazadas: se borra su copia de filas.
- CSV de propuesta, base final, bitácora y funnel se **generan al presionar el botón** en el navegador;
  no se guardan archivos. Las ventas migradas de SharePoint guardan sólo **ligas** a sus adjuntos.

## Instalación (una vez)

1. `sitio/config.js` ya tiene *Project URL* y *anon key* (Supabase › Project Settings › API).
2. **Supabase › Authentication › Sign In / Providers**: desactiva *Allow new users to sign up*
   (sólo entran los usuarios que el Validador o Administrador den de alta).
3. Los usuarios se dan de alta desde la página (módulo **Usuarios**, con un Validador o Administrador).
   El primero se crea en **Supabase › Authentication › Users › Add user** (marca *Auto Confirm User*)
   y se le pone rol validador/admin.
4. Doble clic en **`CARGAR_SUPABASE.bat`** (necesita Python). Usa el host y usuario de
   **Connect › Session pooler**. Responde:
   - 1) Aplicar SQL → **s**
   - 2) Subir bases → **s** (toma `Base JyP.csv` y `Base Grupal.csv` de la carpeta de arriba)
   - 3) Migrar propuestas de la app de escritorio → **s** (sólo la primera vez / al salir a producción)
   - 4) Tu correo → te vuelve **administrador**
5. **Railway**: *New Project › Deploy from GitHub repo* (carpeta raíz `Servicio_Web`) o, con la CLI,
   desde esta carpeta: `railway login`, `railway init`, `railway up`. Railway detecta `package.json`
   y corre `npm start`. En *Settings › Networking › Generate Domain* obtienes la dirección https.
6. **Supabase › Authentication › URL Configuration**: pon la dirección de Railway en *Site URL*
   (para que funcione "¿Olvidaste tu contraseña?").

## Cada mes (actualizar la cartera)

Los apartados vigentes se conservan con cualquiera de las dos formas:

- **Desde Supabase (sin Python):** en *Table Editor* reemplaza el contenido de `BASE_JYP` y
  `BASE_GRUPAL` (Import data from CSV) y luego en *SQL Editor* ejecuta
  `select public.cargar_cartera_desde_tablas();`
- **Desde tu equipo:** `CARGAR_SUPABASE.bat` → opción 2 (sube `Base JyP.csv` y `Base Grupal.csv` a
  BASE_JYP / BASE_GRUPAL y arma la cartera; no hace copias).

> Estado actual (13/11/2026): tablas creadas en Supabase y cartera cargada desde BASE_JYP (18,265)
> y BASE_GRUPAL (84,233). `sitio/config.js` ya trae la URL y la anon key del proyecto.

## Agregar una funcionalidad nueva (sin tocar lo existente)

1. Copia `sitio/modulos/_plantilla` a `sitio/modulos/mi_modulo` y edítalo
   (id, título, ícono, roles y lo que dibuja en `montar`).
2. Agrega una línea en `sitio/modulos/modulos.json`.
3. Si necesita datos nuevos: crea `supabase/modulos/20_mi_modulo.sql` (tablas con RLS y funciones
   `security definer` que llamen `public._exigir_activo()`), y córrelo con `CARGAR_SUPABASE.bat` › 1.
4. Publica de nuevo en Railway.

## Seguridad

- Nadie lee ni escribe tablas directo: todo pasa por funciones SQL que validan sesión y rol.
- Apartar es una transacción con candado: dos vendedores no pueden tomar el mismo crédito/grupo.
- Sólo el dueño de una propuesta o un administrador la pueden liberar.
- La *anon key* es pública por diseño; la contraseña de la base **nunca** va en el sitio.
