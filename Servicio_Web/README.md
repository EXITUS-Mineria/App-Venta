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
│       ├── compradores/       ← catálogo de compradores, accesos al portal y solicitudes de compra
│       ├── portal/            ← PORTAL DEL COMPRADOR (sólo rol comprador; no va en modulos.json)
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
│       ├── 21_almacenamiento.sql ← una sola copia de la cartera (lee BASE_JYP/BASE_GRUPAL)
│       ├── 22_funnel_permisos.sql ← vendedor edita SUS ventas; auxiliar y maestros, todas
│       ├── 23_documentos.sql     ← comprobante de pago y documentos del comprador (Storage privado)
│       ├── 24_envio_comprador.sql ← Excel de la propuesta + avisos Vendida
│       ├── 25_portal_comprador.sql ← portal del comprador, catálogo, solicitudes, publicar propuesta
│       ├── 26_estados_oficiales.sql ← mismo nombre de estado en todas las bases (también en cada carga)
│       ├── 27_portal_seleccion.sql ← el comprador elige con qué créditos se queda; lo demás regresa a disponible
│       ├── 28_colonia.sql        ← la carga toma la columna Colonia cuando las bases la traigan
│       ├── 29_plazos_etapas.sql  ← etapas y plazos (días) que ve el comprador en «Mis compras»
│       ├── …                     ← 30–41: jurídico, restituciones, histórico de ventas, dashboard, duplicadas
│       ├── 42_portal_lealtad_exclusiones.sql ← exclusiones (promesas SIGE, pagos, lista negra) con interruptores;
│                                   portal: interés de otros compradores, ofertas de precio, lealtad, casos de éxito
│       ├── 43_restitucion_en_venta.sql ← restituir en la venta elegida (Ventas duplicadas)
│       └── 44_expediente_venta.sql ← carpeta del cliente (INE, fiscal, domicilio, alta, pago, NDA) y aviso a expedientes
│   └── functions/enviar-propuesta/ ← Edge Function: aviso por correo (Microsoft 365) y Excel interno
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
- Roles: **Vendedor, Validador (maestro), Auxiliar de venta, Control documental, Administrador**.
  Control documental ve todo el Funnel (sus permisos de edición están por definir). El **Validador es el usuario
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
Editan: auxiliar de venta, validador y admin (todas las ventas); cada vendedor, todos los campos de SUS ventas
(las migradas de SharePoint se reconocen por su nombre en «Vendedor»). Control documental: consulta.

**🌐 Portal del comprador** (sección Venta, sólo ventas de la página):
- El vendedor dueño (o auxiliar / maestros) da **Publicar al comprador**: el comprador la ve en su portal con
  los créditos en pantalla (vReference, vGroupId, días de atraso, capital, colonia, C.P., municipio, estado)
  y la **Acepta** o **Rechaza** (con motivo). Se puede publicar aunque siga EN REVISIÓN; el **precio** sólo
  aparece cuando el validador la aprobó. **Retirar del portal** la quita. **⬇ Excel** es descarga interna.
- En el Funnel: 🌐 publicada · 👁 veces que la abrió · 👍 aceptada / 👎 rechazada (con aviso 🔔 al vendedor y validador).
- Si Microsoft 365 está configurado, al publicar le llega un correo con la liga al portal (sin archivo).
- Al marcar **Vendida**, aviso 🔔 al validador, al auxiliar, al vendedor dueño y al comprador.
- Colonia sale vacía mientras BASE_JYP / BASE_GRUPAL no traigan esa columna.

### Portal del comprador
El comprador entra a la misma página con su correo y sólo ve: **🏠 Inicio · 🛒 Solicitar nueva compra ·
📋 Mis propuestas · ✅ Mis compras** (sus documentos, sólo ver, y el avance por etapa con su plazo:
Compra registrada → Creación de información demográfica final 2 días → Petición de expedientes 15 →
Firma de endoso 10 → Creación de guía de entrega 5, donde consulta su número de guía. Ve «día X de N», la
fecha compromiso y si va retrasada. Los plazos se cambian en 🏢 Compradores › ⏱ Plazos).
- En **Mis propuestas** el comprador marca con qué créditos se queda (en Grupal, grupo completo); al aceptar,
  lo que no marcó sale de la propuesta y regresa a la base como disponible, y se recalculan capital y precio.
- **🏢 Compradores** (interno): catálogo (nombre, RFC, contacto, ejecutivo) y los **nombres con que aparece
  en el Funnel**; sus ventas pasadas y nuevas se ligan solas. Editar y **dar acceso al portal**: sólo validador /
  admin (contraseña inicial que se comparte por un medio seguro). Desactivar el comprador apaga sus accesos.
- **Solicitudes**: lo que pide el comprador (estados, municipios, días de atraso, capital, comentarios) llega
  con aviso 🔔 a su ejecutivo y al validador; vendedor / auxiliar la atienden (En proceso / Atendida + folio).
- Seguridad: el rol comprador **no cuenta como usuario interno** (`es_activo()`), así que todas las funciones y
  políticas internas lo rechazan; el portal sólo usa funciones `portal_*` que filtran por su comprador.

**Configurar el correo de aviso (una vez, TI):**
1. Azure › *App registrations* › nueva app → *API permissions* › Microsoft Graph › **Application** › `Mail.Send`
   → *Grant admin consent*. Recomendado: limitarla al buzón remitente con una *Application Access Policy*.
2. *Certificates & secrets* › nuevo *client secret*.
3. Supabase › Edge Functions › **Secrets**: `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`,
   `MS_REMITENTE` (buzón que envía, p. ej. ventas de cartera). No se guardan en el código ni en GitHub.

**Documentos** (en el detalle de cada venta):
- *Importes y estatus › 🧾 Comprobante de pago*: uno o varios (pagos parciales), PDF o foto.
- *📂 Documentos del comprador*: identificación, acta, poderes, contrato… en PDF, fotos o Word.
- Suben y borran quienes editan la venta; todos los usuarios activos los ven (liga temporal de 5 min).
  Máx. 10 MB por archivo; columna **Docs** en la tabla (🧾 = hay comprobante, 📂n = documentos).

### Almacenamiento (mínimo)
- La cartera vive **una sola vez** en `BASE_JYP` / `BASE_GRUPAL`; la página sólo guarda un índice ligero
  para buscar (`cartera_jyp` / `cartera_grupal`). La fila completa se copia únicamente para lo apartado.
- Propuestas liberadas o rechazadas: se borra su copia de filas.
- CSV de propuesta, base final, bitácora y funnel se **generan al presionar el botón** en el navegador;
  no se guardan archivos. Las ventas migradas de SharePoint guardan sólo **ligas** a sus adjuntos.
- Lo único que ocupa Storage son los documentos que suben los usuarios (bucket privado `documentos-venta`);
  las fotos se reducen en el navegador (máx. 1800 px, JPEG) antes de subir.

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
