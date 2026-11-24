// Pruebas de integración de los módulos: se montan con el kit de interfaz real
// (nucleo/ui.js) y un cliente Supabase falso, y se verifica el DOM resultante.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ctxMontaje, esperar } from "./ayuda.mjs";

const cont = () => {
  const d = document.createElement("div");
  document.body.append(d);
  return d;
};
const visibles = (c) => [...c.querySelectorAll("tr")].filter((tr) => !tr.closest("thead"));
const fila = (c, texto) => visibles(c).find((tr) => tr.textContent.includes(texto));

// ---------- Armar propuesta ----------
test("Armar propuesta: arma JyP + Grupal, filtra por estado y calcula KPIs", async () => {
  const geo = [
    { estado: "JALISCO", municipio: "GUADALAJARA", registros: 3 },
    { estado: "JALISCO", municipio: "ZAPOPAN", registros: 2 },
    { estado: "CDMX", municipio: "IZTAPALAPA", registros: 5 },
  ];
  const ctx = await ctxMontaje({
    rpc: (fn, args) => {
      if (fn === "catalogo_geo") return geo;
      if (fn === "buscar_jyp") return [
        { vreference: "V1", estado: "JALISCO", municipio: "GUADALAJARA", colonia: "C", dias: 10, npendingk: 1000 },
        { vreference: "V2", estado: "JALISCO", municipio: "ZAPOPAN", colonia: "D", dias: 20, npendingk: 2000 },
      ];
      if (fn === "buscar_grupos") return [
        { vgroupid: "G1", integrantes: 3, estados: "JALISCO", municipios: "GUADALAJARA", colonias: "C", dias_promedio: 15, capital: 5000, disponible: true },
        { vgroupid: "G2", integrantes: 2, estados: "CDMX", municipios: "IZTAPALAPA", colonias: "E", dias_promedio: 5, capital: 3000, disponible: false },
      ].filter((g) => !args?.p_estados || args.p_estados.includes(g.estados));
      return null;
    },
  });
  const c = cont();
  const mod = (await import("../modulos/venta/venta.js")).default;
  await mod.montar(c, ctx);

  // La lista de estados se pinta desde catalogo_geo
  const estados = [...c.querySelectorAll(".lista-cas label")].map((l) => l.textContent);
  assert.ok(estados.some((t) => t.includes("JALISCO") && t.includes("5")));
  assert.ok(estados.some((t) => t.includes("CDMX")));

  // Tipo Dual: se muestran créditos JyP y grupos
  [...c.querySelectorAll(".segmentado button")].find((b) => b.textContent === "Dual").click();
  await esperar(5);

  // Elegir "JALISCO" y aplicar filtros
  const jalisco = [...c.querySelectorAll(".lista-cas label")].find((l) => l.textContent.includes("JALISCO"));
  jalisco.querySelector("input").click();
  const aplicar = [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Aplicar filtros"));
  aplicar.click();
  await esperar(10);

  const filas = visibles(c);
  assert.ok(filas.some((tr) => tr.textContent.includes("V1")));
  assert.ok(filas.some((tr) => tr.textContent.includes("G1")));
  // G2 es de CDMX: el filtro por JALISCO lo excluye
  assert.ok(!filas.some((tr) => tr.textContent.includes("G2")));

  // KPI de disponibles: 2 créditos + 1 grupo = 3
  const kpis = [...c.querySelectorAll(".kpi")].map((k) => k.textContent);
  assert.ok(kpis.some((t) => t.includes("Disponibles") && /3/.test(t)));
});

test("Armar propuesta: cambiar a JyP sólo muestra créditos", async () => {
  const ctx = await ctxMontaje({
    rpc: (fn) => {
      if (fn === "catalogo_geo") return [{ estado: "JALISCO", municipio: "G", registros: 1 }];
      if (fn === "buscar_jyp") return [{ vreference: "V1", estado: "JALISCO", municipio: "G", colonia: "C", dias: 1, npendingk: 100 }];
      if (fn === "buscar_grupos") return [{ vgroupid: "G1", integrantes: 1, estados: "JALISCO", municipios: "G", colonias: "C", dias_promedio: 1, capital: 100, disponible: true }];
      return null;
    },
  });
  const c = cont();
  await (await import("../modulos/venta/venta.js")).default.montar(c, ctx);
  [...c.querySelectorAll(".segmentado button")].find((b) => b.textContent === "JyP").click();
  await esperar(5);
  const jalisco = [...c.querySelectorAll(".lista-cas label")].find((l) => l.textContent.includes("JALISCO"));
  jalisco.querySelector("input").click();
  [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Aplicar filtros")).click();
  await esperar(10);
  const filas = visibles(c);
  assert.ok(filas.some((tr) => tr.textContent.includes("V1")));
  assert.ok(!filas.some((tr) => tr.textContent.includes("G1")));
});

// ---------- Bitácora ----------
test("Bitácora: chips por estatus, sólo mías y exportación", async () => {
  const datos = [
    { id_propuesta: "VTA-0300", fecha: "2026-01-01T10:00:00Z", usuario: "Ana", user_id: "u1", comprador: "Cia", tipo_venta: "JyP", capital: 1000, valor_venta: 260, estatus: "EN REVISIÓN", centavos: 0.26, capital_objetivo: 1000 },
    { id_propuesta: "VTA-0301", fecha: "2026-01-02T10:00:00Z", usuario: "Luis", user_id: "u2", comprador: "Otra", tipo_venta: "Grupal", capital: 2000, valor_venta: 520, estatus: "APROBADA", centavos: 0.26, capital_objetivo: 2000 },
    { id_propuesta: "VTA-0302", fecha: "2026-01-03T10:00:00Z", usuario: "Ana", user_id: "u1", comprador: "Cia", tipo_venta: "JyP", capital: 500, valor_venta: 130, estatus: "LIBERADA", centavos: 0.26, capital_objetivo: 500 },
  ];
  const ctx = await ctxMontaje({ filas: () => datos, rpc: () => [] });
  const c = cont();
  await (await import("../modulos/venta/bitacora.js")).default.montar(c, ctx);

  // Por defecto (vendedor) "Sólo mías" está marcado: sólo VTA-0300 y VTA-0302 de Ana, vigentes = VTA-0300
  assert.ok(fila(c, "VTA-0300"));
  assert.ok(!fila(c, "VTA-0301"));
  assert.ok(!fila(c, "VTA-0302"), "LIBERADA no está entre las vigentes");

  // Quitar "Sólo mías" muestra también las de otros
  c.querySelector('input[type="checkbox"]').click();
  await esperar(0);
  assert.ok(fila(c, "VTA-0301"));

  // Chip "Todas" incluye liberadas
  [...c.querySelectorAll(".bit-chip")].find((b) => b.textContent.includes("Todas")).click();
  await esperar(0);
  assert.ok(fila(c, "VTA-0302"));
});

test("Bitácora: exportar genera un CSV con las filas visibles", async () => {
  const datos = [{ id_propuesta: "VTA-0300", fecha: "2026-01-01T10:00:00Z", usuario: "Ana", user_id: "u1", capital: 1000, valor_venta: 260, estatus: "EN REVISIÓN", tipo_venta: "JyP" }];
  const ctx = await ctxMontaje({ filas: () => datos });
  const c = cont();
  await (await import("../modulos/venta/bitacora.js")).default.montar(c, ctx);
  const { blobCapturado, limpiarBlob } = await import("./ayuda.mjs");
  limpiarBlob();
  [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Exportar bitácora")).click();
  await esperar(0);
  const texto = await blobCapturado().text();
  assert.match(texto, /VTA-0300/);
  assert.match(texto, /^id_propuesta,/);
});

// ---------- Revisión ----------
test("Revisión: lista pendientes, abre la primera y calcula el rango", async () => {
  const props = [
    { id_propuesta: "VTA-0300", fecha: "2026-01-01T10:00:00Z", usuario: "Ana", comprador: "Cia", tipo_venta: "JyP", capital: 200000, capital_objetivo: 200000, valor_venta: 52000, centavos: 0.26, dias_mora: 12 },
  ];
  const ctx = await ctxMontaje({
    filas: () => props,
    rpc: (fn) => (fn === "partidas_propuesta" ? [
      { tipo: "JyP", clave: "V1", integrantes: 1, estados: "JALISCO", municipios: "G", colonias: "C", dias: 10, capital: 100000 },
      { tipo: "JyP", clave: "V2", integrantes: 1, estados: "JALISCO", municipios: "G", colonias: "C", dias: 14, capital: 100000 },
    ] : null),
  });
  const c = cont();
  await (await import("../modulos/revision/revision.js")).default.montar(c, ctx);

  assert.ok(fila(c, "VTA-0300"));
  const kpis = [...c.querySelectorAll(".kpi")].map((k) => k.textContent);
  assert.ok(kpis.some((t) => t.includes("En rango")));
  assert.ok(kpis.some((t) => t.includes("2")), "2 partidas");
  // Las partidas se pintan
  assert.ok(fila(c, "V1"));
  assert.ok(fila(c, "V2"));
  // Los botones de aprobar/rechazar se habilitan
  const aprobar = [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Aprobar"));
  assert.equal(aprobar.disabled, false);
});

test("Revisión: avisa y marca las partidas que ya están vendidas en otra venta", async () => {
  const props = [{ id_propuesta: "VTA-0310", fecha: "2026-01-01T10:00:00Z", usuario: "Ana", tipo_venta: "Grupal", capital: 1000, capital_objetivo: 1000, valor_venta: 260, centavos: 0.26, dias_mora: 12 }];
  const ctx = await ctxMontaje({
    filas: () => props,
    rpc: (fn) => (fn === "partidas_propuesta" ? [
      { tipo: "Grupal", clave: "G1", integrantes: 5, capital: 600 }, { tipo: "Grupal", clave: "G2", integrantes: 4, capital: 400 },
    ] : fn === "propuesta_ya_vendidas" ? [{ tipo: "Grupal", clave: "G2", ventas: ["VTA-0205"], integrantes_repetidos: 4 }] : null),
  });
  const c = cont();
  await (await import("../modulos/revision/revision.js")).default.montar(c, ctx);
  await esperar(5);
  const aviso = c.querySelector(".rev-aviso-dup");
  assert.equal(aviso.hidden, false);
  assert.ok(aviso.textContent.includes("1 partidas ya están vendidas"));
  assert.ok(fila(c, "G2").textContent.includes("VTA-0205"));
  [...aviso.querySelectorAll("button")].find((b) => b.textContent.includes("Marcarlas")).click();
  assert.ok(c.textContent.includes("1 marcadas para quitar"));
});

// ---------- Ventas duplicadas ----------
test("Ventas duplicadas: KPIs, filtro y justificar", async () => {
  const llamadas = [];
  const dups = [
    { tipo: "Grupal", clave: "G199051", n_ventas: 3, integrantes_repetidos: 6, mismo_credito: true, revision: "Pendiente",
      ventas: [{ folio: "VTA-0180", visible: true, comprador: "Lic A" }, { folio: "VTA-0205", visible: true }] },
    { tipo: "JyP", clave: "1001469165-2", n_ventas: 2, mismo_credito: true, revision: "Restituido", restituido: "RST-0003",
      ventas: [{ folio: "VTA-0027", visible: true }, { folio: "VTA-0056", visible: true }] },
  ];
  let irA = null;
  const ctx = await ctxMontaje({
    rpc: (fn, args) => { llamadas.push([fn, args]); return fn === "ventas_duplicadas" ? dups : null; },
    tieneRol: () => true, perfil: { rol: "admin" },
  });
  ctx.ui = { ...ctx.ui, pedirTexto: async () => "Otro ciclo del grupo" };
  ctx.ir = (x) => { irA = x; };
  const c = cont();
  await (await import("../modulos/duplicados/duplicados.js")).default.montar(c, ctx);
  const kpis = [...c.querySelectorAll(".kpi")].map((k) => k.textContent);
  assert.ok(kpis.some((x) => x.includes("Repetidos") && x.includes("2")));
  assert.ok(kpis.some((x) => x.includes("Restituidos") && x.includes("1")));
  const sel = [...c.querySelectorAll("select")][0];
  sel.value = "Pendiente"; sel.dispatchEvent(new window.Event("change"));
  assert.ok(fila(c, "G199051")); assert.equal(fila(c, "1001469165-2"), undefined);
  [...c.querySelectorAll("button")].find((b) => b.textContent.startsWith("VTA-0205")).click();
  await esperar(5);
  assert.equal(irA, null, "ya no sale del módulo");
  assert.ok(document.querySelector(".ventana.dup-rst")?.textContent.includes("en VTA-0205"));
  document.querySelectorAll(".velo").forEach((v) => v.remove());
  [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Justificar")).click();
  await esperar(5);
  assert.deepEqual(llamadas.find(([f]) => f === "duplicado_marcar")[1],
    { p_tipo: "Grupal", p_clave: "G199051", p_estatus: "Justificado", p_comentario: "Otro ciclo del grupo" });
});

test("Ventas duplicadas: sólo el administrador; el validador no ve el panel en Restituciones", async () => {
  const mod = (await import("../modulos/duplicados/duplicados.js")).default;
  assert.deepEqual(mod.roles, ["admin"]); assert.equal(mod.rolesExactos, true);
  const llamadas = [];
  const ctx = await ctxMontaje({ perfil: { rol: "validador" }, rpc: (fn) => { llamadas.push(fn); return null; }, filas: () => [] });
  const c = cont();
  await (await import("../modulos/restituciones/restituciones.js")).default.montar(c, ctx);
  assert.ok(!c.textContent.includes("Ventas duplicadas"));
  assert.ok(!llamadas.includes("ventas_duplicadas"));
});

// ---------- Sub bases ----------
test("Sub bases: KPIs de pendientes y en venta", async () => {
  const props = [
    { id_propuesta: "VTA-0300", usuario: "Ana", comprador: "Cia", tipo_venta: "JyP", capital: 1000, centavos: 0.26, valor_venta: 260, dias_mora: 3, estatus: "APROBADA", revisada_en: "2026-01-01", revisada_por: "Val" },
    { id_propuesta: "VTA-0301", usuario: "Ana", comprador: "Cia", tipo_venta: "JyP", capital: 2000, centavos: 0.26, valor_venta: 520, dias_mora: 4, estatus: "EN VENTA", revisada_en: "2026-01-01", revisada_por: "Val" },
  ];
  const ctx = await ctxMontaje({ filas: () => props, rpc: () => [] });
  const c = cont();
  await (await import("../modulos/subbases/subbases.js")).default.montar(c, ctx);
  const kpis = [...c.querySelectorAll(".kpi")].map((k) => k.textContent);
  assert.ok(kpis.some((t) => t.includes("Por generar") && /1/.test(t)));
  assert.ok(kpis.some((t) => t.includes("En venta") && /1/.test(t)));
  // Sólo la APROBADA está en la tabla
  assert.ok(fila(c, "VTA-0300"));
  assert.ok(!fila(c, "VTA-0301"));
  // Al marcar "Incluir ya generadas" aparece la EN VENTA
  c.querySelector('input[type="checkbox"]').click();
  await esperar(0);
  assert.ok(fila(c, "VTA-0301"));
});

// ---------- Usuarios ----------
test("Usuarios: pinta la tabla y filtra por búsqueda", async () => {
  const usuarios = [
    { user_id: "u1", email: "ana@exitus.com", nombre: "Ana", rol: "vendedor", activo: true, creado: "2026-01-01" },
    { user_id: "u2", email: "luis@exitus.com", nombre: "Luis", rol: "validador", activo: false, creado: "2026-01-02" },
  ];
  const ctx = await ctxMontaje({ rpc: (fn) => (fn === "admin_usuarios" ? usuarios : null) });
  const c = cont();
  await (await import("../modulos/usuarios/usuarios.js")).default.montar(c, ctx);
  assert.ok([...c.querySelectorAll("input")].some((i) => i.value === "ana@exitus.com"));
  assert.ok([...c.querySelectorAll("input")].some((i) => i.value === "luis@exitus.com"));
  const buscar = [...c.querySelectorAll("input")].find((i) => i.placeholder.includes("Buscar correo"));
  buscar.value = "luis";
  buscar.dispatchEvent(new Event("input"));
  assert.ok(![...c.querySelectorAll("input")].some((i) => i.value === "ana@exitus.com"));
  assert.ok([...c.querySelectorAll("input")].some((i) => i.value === "luis@exitus.com"));
});

// ---------- Portal del comprador ----------
test("Portal: Inicio muestra el menú y los contadores", async () => {
  const ctx = await ctxMontaje({
    rpc: (fn) => (fn === "portal_inicio" ? { comprador: "ACME", propuestas: 2, propuestas_pendientes: 1, compras: 3, monto_compras: 15000, solicitudes_abiertas: 1 } : null),
    perfil: { rol: "comprador", nombre: "ACME" },
  });
  const c = cont();
  const portal = await import("../modulos/portal/portal.js");
  const inicio = portal.modulos.find((m) => m.id === "inicio");
  await inicio.montar(c, ctx);
  assert.ok(c.textContent.includes("Hola, ACME"));
  assert.ok(c.textContent.includes("Solicitar nueva compra"));
  assert.ok(c.textContent.includes("por responder"));
});

test("Portal: Mis compras calcula etapas, plazo y fecha de entrega", async () => {
  const ctx = await ctxMontaje({
    rpc: (fn) => {
      if (fn === "portal_compras") return [{
        folio: "VTA-0300", fecha_venta: "2026-01-01", con_detalle: true, creditos: 10, capital: 100000, monto_venta: 26000,
        tipo: "JyP", estado: "JALISCO", documentos: 0, estatus_md: "En Proceso",
        fecha_inicio_md: new Date().toISOString().slice(0, 10),
      }];
      if (fn === "plazos_etapas") return [
        { etapa: "md", nombre: "MD", dias: 2, orden: 1 },
        { etapa: "doc", nombre: "Documentos", dias: 15, orden: 2 },
        { etapa: "juridico", nombre: "Jurídico", dias: 10, orden: 3 },
        { etapa: "cierre", nombre: "Cierre", dias: 5, orden: 4 },
      ];
      return null;
    },
    perfil: { rol: "comprador" },
  });
  const c = cont();
  const portal = await import("../modulos/portal/portal.js");
  const compras = portal.modulos.find((m) => m.id === "compras");
  await compras.montar(c, ctx);
  assert.ok(c.textContent.includes("VTA-0300"));
  assert.ok(c.textContent.includes("Compra registrada"));
  assert.ok(/día \d+ de \d+/.test(c.textContent), "muestra el día del plazo actual");
  assert.ok(c.textContent.includes("Fecha estimada de guía de entrega"));
  const pasos = c.querySelectorAll(".pt-pasos li");
  assert.equal(pasos.length, 5); // compra + 4 etapas
});

// ---------- Funnel ----------
test("Funnel: embudo, atraso y edición de una venta", async () => {
  const ventas = [
    { folio: "VTA-0300", mes: "Enero 2026", comprador: "Cia", capital: 1000, monto_venta: 260, estado: "JALISCO", tipo: "J&P",
      vendedor: "Ana", estatus_venta: "Vendida", estatus_md: "En Proceso", fecha_limite_md: "2000-01-01", actualizado: "2026-01-01T10:00:00Z", es_mia: true, id_propuesta: "VTA-0300" },
  ];
  const ctx = await ctxMontaje({ rpc: (fn) => (fn === "funnel_lista" ? ventas : null), tieneRol: () => true });
  const c = cont();
  await (await import("../modulos/funnel/funnel.js")).default.montar(c, ctx);
  assert.ok(c.textContent.includes("VTA-0300"));
  // MD vencida → hay alerta de atraso
  const kA = [...c.querySelectorAll(".kpi")].find((k) => k.textContent.includes("En atraso"));
  assert.ok(/1/.test(kA.textContent));
  // Abrir el detalle
  visibles(c).find((tr) => tr.textContent.includes("VTA-0300")).dispatchEvent(new Event("click", { bubbles: true }));
  await esperar(5);
  const det = c.querySelector(".fun-det");
  assert.ok(!det.hidden);
  assert.ok(det.textContent.includes("VTA-0300"));
  assert.ok(det.textContent.includes("Comentarios"));
  assert.ok(det.textContent.includes("Vendedor responsable"));
});

test("Funnel: filtro por tipo de venta, comentarios y fechas automáticas", async () => {
  const base = { mes: "Enero 2026", capital: 1000, monto_venta: 260, estado: "JALISCO", estatus_venta: "Vendida",
    estatus_md: "En Proceso", actualizado: "2026-01-01T10:00:00Z", es_mia: true, vendedor_user: "u1", vendedor: "Ana" };
  const ventas = [
    { ...base, folio: "VTA-0401", tipo: "J&P", comprador: "Uno", fecha_limite_md: "2999-01-01" },
    { ...base, folio: "VTA-0402", tipo: "Dual", comprador: "Dos", n_comentarios: 2 },
    { ...base, folio: "VTA-0403", tipo: "Grupal", comprador: "Tres", vendedor_user: null, vendedor: "Rubén" },
  ];
  const llamadas = [];
  const ctx = await ctxMontaje({
    rpc: (fn, args) => {
      llamadas.push([fn, args]);
      if (fn === "funnel_lista") return ventas;
      if (fn === "funnel_comentarios_lista") return [{ id: 1, autor: "Aux", texto: "Falta comprobante", fecha: "2026-01-02T10:00:00Z", mio: false }];
      return null;
    },
    tieneRol: () => false, esAdmin: false,
  });
  const c = cont();
  await (await import("../modulos/funnel/funnel.js")).default.montar(c, ctx);
  const selTipo = [...c.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "Dual"));
  selTipo.value = "Dual"; selTipo.dispatchEvent(new Event("change"));
  assert.deepEqual(visibles(c).map((tr) => tr.textContent).filter((t) => t.includes("VTA-")).map((t) => t.match(/VTA-\d+/)[0]), ["VTA-0402"]);
  assert.ok(c.textContent.includes("💬2"));
  fila(c, "VTA-0402").dispatchEvent(new Event("click", { bubbles: true }));
  await esperar(5);
  const det = c.querySelector(".fun-det");
  assert.ok(det.textContent.includes("Falta comprobante"));
  // fechas límite: automáticas (deshabilitadas) para quien no es maestro
  const fechas = [...det.querySelectorAll("input[type=date]")].filter((i) => /Automática/.test(i.title));
  assert.equal(fechas.length, 4);
  assert.ok(fechas.every((i) => i.disabled));
  // el vendedor ya no es un campo editable
  assert.ok(!llamadas.some(([fn]) => fn === "funnel_vendedores"));
  // ventas sin usuario aparecen marcadas
  selTipo.value = ""; selTipo.dispatchEvent(new Event("change"));
  assert.ok(fila(c, "VTA-0403").textContent.includes("sin usuario"));
});

// ---------- Compradores ----------
test("Compradores: pestaña de plazos suma los días de las etapas", async () => {
  const ctx = await ctxMontaje({
    rpc: (fn) => (fn === "plazos_etapas" ? [
      { etapa: "md", nombre: "MD", dias: 2, orden: 1 },
      { etapa: "doc", nombre: "Documentos", dias: 15, orden: 2 },
    ] : fn === "compradores_lista" ? [] : fn === "compradores_nombres_funnel" ? [] : fn === "solicitudes_lista" ? [] : null),
    esAdmin: true,
  });
  const c = cont();
  await (await import("../modulos/compradores/compradores.js")).default.montar(c, ctx);
  [...c.querySelectorAll(".cmp-tabs button")].find((b) => b.textContent.includes("Plazos")).click();
  await esperar(5);
  assert.ok(c.textContent.includes("17 días de la compra al cierre"));
});

// ---------- Restituciones ----------
test("Restituciones: valida un crédito y lista el historial", async () => {
  const ctx = await ctxMontaje({
    rpc: (fn) => (fn === "validar_restitucion" ? {
      tipo: "JyP", clave: "V1", buscado: "V1", capital: 1000, integrantes: 1, dias: 10, estados: "JALISCO", municipios: "G",
      vendido: true, bloqueado: false, id_propuesta: "VTA-0300", estatus_propuesta: "APROBADA", usuario_propuesta: "Ana", disponible_en_base: false,
      venta: { folio: "VTA-0300", id_propuesta: "VTA-0300", comprador: "Jonathan", vendedor: "Victor", tipo: "JyP", estatus_venta: "Vendida", fecha_venta: "2026-11-10", capital: 5000, monto_venta: 1300, centavos: 0.26, partidas: 31, restringida: false },
    } : null),
    filas: (t) => (t === "restituciones" ? [{ id_restitucion: "RST-0001", fecha: "2026-01-01", usuario: "Ana", motivo: "Liquidado", clave_original: "V0", capital_original: 100, clave_reemplazo: "V1", capital_reemplazo: 120, diferencia: 20, tipo_cartera: "JyP" }] : []),
  });
  const c = cont();
  await (await import("../modulos/restituciones/restituciones.js")).default.montar(c, ctx);
  assert.ok(c.textContent.includes("RST-0001"));
  const inTexto = [...c.querySelectorAll("input")].find((i) => i.placeholder.includes("vReference"));
  inTexto.value = "V1";
  [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Validar en bases")).click();
  await esperar(5);
  assert.ok(c.querySelector(".rst-ficha").textContent.includes("VTA-0300"));
  const venta = c.querySelector(".rst-venta").textContent;
  assert.ok(venta.includes("Jonathan") && venta.includes("Victor") && venta.includes("26¢") && venta.includes("Vendida"));
  const buscar = [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Buscar reemplazo"));
  assert.equal(buscar.disabled, false);
});

test("Restituciones: elige venta y luego el grupo de la lista", async () => {
  const llamadas = [];
  const ctx = await ctxMontaje({
    rpc: (fn, args) => {
      llamadas.push([fn, args]);
      if (fn === "restitucion_ventas") return [
        { folio: "VTA-0100", comprador: "Lic. X", vendedor: "Sandibel", partidas: 2, origen: "histórico" },
        { folio: "VTA-0301", comprador: "Jonathan", vendedor: "Victor", partidas: 31, origen: "página" }];
      if (fn === "restitucion_partidas") return [
        { tipo: "Grupal", clave: "G100", nombre: "LAS ROSAS", integrantes: 5, capital: 20000, saldo_total: 25000, dias: 300 },
        { tipo: "Grupal", clave: "G200", nombre: "EL SOL", integrantes: 4, capital: 9000, saldo_total: 9500, dias: 200, restituido: "RST-0001" }];
      if (fn === "validar_restitucion") return { tipo: "Grupal", clave: args.p_texto, buscado: args.p_texto, capital: 20000, integrantes: 5,
        vendido: true, bloqueado: false, disponible_en_base: false, venta: { folio: "VTA-0100", historico: true, restringida: false } };
      return null;
    },
    filas: () => [],
  });
  const c = cont();
  await (await import("../modulos/restituciones/restituciones.js")).default.montar(c, ctx);
  const busca = [...c.querySelectorAll("input")].find((i) => i.placeholder.includes("Folio, comprador"));
  busca.value = "sandibel"; busca.dispatchEvent(new window.Event("input"));
  await esperar(5);
  assert.deepEqual(llamadas.find(([f]) => f === "restitucion_partidas")[1], { p_folio: "VTA-0100" });
  const botones = [...c.querySelectorAll("button")].filter((b) => b.textContent === "Elegir");
  assert.equal(botones.length, 1, "el grupo ya restituido no se puede elegir");
  botones[0].click(); await esperar(5);
  assert.deepEqual(llamadas.find(([f]) => f === "validar_restitucion")[1], { p_texto: "G100" });
  assert.ok(c.querySelector(".rst-ficha").textContent.includes("G100"));
});

test("Restituciones: llega desde Ventas duplicadas con la venta y el grupo", async () => {
  const llamadas = [];
  location.hash = "#/restituciones?venta=VTA-0205&clave=G199051";
  const ctx = await ctxMontaje({
    perfil: { rol: "admin" },
    rpc: (fn, args) => {
      llamadas.push([fn, args]);
      if (fn === "restitucion_ventas") return [{ folio: "VTA-0180", partidas: 12 }, { folio: "VTA-0205", partidas: 3 }];
      if (fn === "restitucion_partidas") return [{ tipo: "Grupal", clave: "G199051", integrantes: 6, capital: 17879 }];
      if (fn === "validar_restitucion") return { tipo: "Grupal", clave: "G199051", buscado: "G199051", capital: 17879, vendido: true, bloqueado: false,
        venta: { folio: "VTA-0180", historico: true, restringida: false } };
      return null;
    },
    filas: () => [],
  });
  const c = cont();
  await (await import("../modulos/restituciones/restituciones.js")).default.montar(c, ctx);
  await esperar(10);
  assert.ok(!c.textContent.includes("⚠ Ventas duplicadas"), "ya no hay panel de duplicados");
  assert.ok(!llamadas.some(([f]) => f === "ventas_duplicadas"));
  assert.deepEqual(llamadas.find(([f]) => f === "restitucion_partidas")[1], { p_folio: "VTA-0205" });
  assert.deepEqual(llamadas.find(([f]) => f === "validar_restitucion")[1], { p_texto: "G199051" });
  assert.equal([...c.querySelectorAll("select")].find((x) => [...x.options].some((o) => o.value === "Venta duplicada")).value, "Venta duplicada");
  location.hash = "";
});

test("Restituciones: crédito de una venta histórica", async () => {
  const ctx = await ctxMontaje({
    rpc: (fn) => (fn === "validar_restitucion" ? {
      tipo: "Grupal", clave: "G1", buscado: "G1", capital: 900, integrantes: 3, dias: 200, vendido: true, bloqueado: false, disponible_en_base: true,
      venta: { folio: "VTA-0100", comprador: "Lic. X", vendedor: "Sandibel", historico: true, archivo: "base_completa.xlsx", otras_ventas: ["VTA-0050"], restringida: false },
    } : null),
    filas: () => [],
  });
  const c = cont();
  await (await import("../modulos/restituciones/restituciones.js")).default.montar(c, ctx);
  [...c.querySelectorAll("input")].find((i) => i.placeholder.includes("vReference")).value = "G1";
  [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Validar en bases")).click();
  await esperar(5);
  const ficha = c.querySelector(".rst-ficha");
  assert.ok(ficha.classList.contains("bien"));
  assert.ok(ficha.textContent.includes("Vendido en VTA-0100") && ficha.textContent.includes("VTA-0050") && ficha.textContent.includes("base_completa.xlsx"));
  assert.equal([...c.querySelectorAll("button")].find((b) => b.textContent.includes("Buscar reemplazo")).disabled, false);
});

test("Restituciones: venta vieja que ya no viene en la base y sin capital", async () => {
  const llamadas = [];
  const ctx = await ctxMontaje({
    rpc: (fn, args) => {
      llamadas.push([fn, args]);
      if (fn === "validar_restitucion") return { tipo: "JyP", clave: "1000123456-1", buscado: "1000123456-1", en_base: false, capital: null,
        integrantes: null, dias: null, vendido: true, bloqueado: false, disponible_en_base: false, estatus_base: "No está en la base del mes",
        venta: { folio: "VTA-0035", comprador: "Lic. Y", vendedor: "Rubén", historico: true, archivo: "base_completa.xlsx", restringida: false },
        detalle_historico: { folio: "VTA-0035", creditos: 1, capital: null, saldo_total: 52000.5, dias: 400,
          filas: [{ vreference: "1000123456-1", nombre: "PEREZ LUIS", saldo_total: 52000.5, dias: 400, ult_pago: "2025-04-28" }] } };
      if (fn === "sugerir_restitucion") return [{ clave: "1000999999-9", integrantes: 1, capital: 15100, diferencia: 100, dias: 200 }];
      if (fn === "aplicar_restitucion") return { id_restitucion: "RST-0009", original: "1000123456-1", reemplazo: "1000999999-9", diferencia: 100, id_propuesta: "RST-0009", propuesta_nueva: true };
      return null;
    },
    filas: () => [],
  });
  const c = cont();
  await (await import("../modulos/restituciones/restituciones.js")).default.montar(c, ctx);
  [...c.querySelectorAll("input")].find((i) => i.placeholder.includes("vReference")).value = "1000123456-1";
  [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Validar en bases")).click();
  await esperar(5);
  assert.ok(c.querySelector(".rst-ficha").textContent.includes("ya no viene en la base del mes"));
  const det = c.querySelector(".rst-detalle").textContent;
  assert.ok(det.includes("PEREZ LUIS") && det.includes("2025-04-28") && det.includes("Saldo total"));
  const buscar = [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Buscar reemplazo"));
  assert.equal(buscar.disabled, true, "sin capital no se puede buscar");
  const cap = [...c.querySelectorAll("input")].find((i) => i.placeholder.includes("Capital del crédito"));
  assert.equal(cap.closest("[hidden]"), null);
  cap.value = "15000"; cap.dispatchEvent(new window.Event("input"));
  assert.equal(buscar.disabled, false);
  buscar.click(); await esperar(5);
  const sug = llamadas.find(([f]) => f === "sugerir_restitucion");
  assert.equal(sug[1].p_capital, 15000);
});

// ---------- Bases ----------
test("Bases: pinta las cargas recibidas", async () => {
  const ctx = await ctxMontaje({ filas: () => [{ cartera: "JyP", archivo: "Base JyP.csv", filas: 100, usuario: "Ana", cargado: "2026-01-01" }] });
  const c = cont();
  await (await import("../modulos/cargas/cargas.js")).default.montar(c, ctx);
  assert.ok(c.textContent.includes("Base JyP.csv"));
});

// ---------- Exclusiones, portal (interés, ofertas, lealtad, noticias) ----------
test("Exclusiones: del archivo de gestiones sólo cuentan las promesas, una por referencia con la fecha más reciente", async () => {
  const { extraerExclusiones, aFecha } = await import("../modulos/cargas/exclusiones.js");
  const r = extraerExclusiones([
    ["vReference", "FechaGestion", "Descripcion_Resultado", "Monto"],
    ["a1", "10/11/2026", "PROMESA DE PAGO", "500"],
    ["A1", "2026-11-20", "Promesa de pago", "700"],
    ["B2", "2026-11-21", "NO CONTESTA", ""],
    ["C3", "46345", "CONVENIO", "$1,200"],
    ["", "2026-11-21", "PROMESA", ""],
  ], "promesa");
  assert.equal(r.filas.length, 2);
  const a1 = r.filas.find((f) => f.ref === "A1");
  assert.equal(a1.fecha, "2026-11-20");
  assert.equal(a1.monto, 700);
  assert.equal(r.filas.find((f) => f.ref === "C3").monto, 1200);
  assert.equal(r.descartadas, 2);
  assert.equal(r.columnas.resultado, "Descripcion_Resultado");
  assert.equal(aFecha("05/03/26"), "2026-03-05");
  // lista negra sin encabezado: primera columna
  const ln = extraerExclusiones([["X-1"], ["x-2"], ["X-1"]], "lista_negra");
  assert.deepEqual(ln.filas.map((f) => f.ref).sort(), ["X-1", "X-2"]);
});

test("Bases: muestra las exclusiones y su interruptor", async () => {
  const llam = [];
  const ctx = await ctxMontaje({
    rpc: (fn, a) => {
      llam.push([fn, a]);
      if (fn === "exclusiones_resumen") return [{ origen: "promesa", cargados: 10, vigentes: 8, jyp_fuera: 5, grupos_fuera: 1, activo: true }];
      if (fn === "config_lista") return [{ clave: "excluir_promesas", valor: true }, { clave: "excluir_lista_negra", valor: false }, { clave: "dias_promesa", valor: 15 }];
      return null;
    },
  });
  const c = cont();
  await (await import("../modulos/cargas/cargas.js")).default.montar(c, ctx);
  assert.ok(c.textContent.includes("Promesas de pago"));
  assert.ok(c.textContent.includes("fuera de la base: 5 JyP y 1 grupos"));
  const sw = c.querySelector('[data-origen="lista_negra"] .excl-sw');
  assert.equal(sw.checked, false);
  sw.checked = true; sw.dispatchEvent(new window.Event("change"));
  await esperar(5);
  assert.ok(llam.some(([f, a]) => f === "config_guardar" && a.p_clave === "excluir_lista_negra" && a.p_valor === true));
});

test("Portal: Inicio muestra nivel de lealtad y casos de éxito", async () => {
  const ctx = await ctxMontaje({
    rpc: (fn) => (fn === "portal_inicio" ? { comprador: "ACME", propuestas: 0, propuestas_pendientes: 0, compras: 3, monto_compras: 15000, solicitudes_abiertas: 0 }
      : fn === "portal_mi_nivel" ? { activo: true, nivel: "Bronce", color: "#b0773b", compras_12m: 3, monto_12m: 150000, beneficios: "Medio centavo de descuento",
          siguiente: { nivel: "Plata", faltan_compras: 1, faltan_monto: 150000, beneficios: "1 centavo" } }
      : fn === "portal_noticias" ? [{ id: 1, titulo: "Sentencia favorable", resumen: "Recuperación en 90 días", contenido: "Detalle", categoria: "Caso de éxito", fecha: "2026-11-20" }]
      : null),
    perfil: { rol: "comprador", nombre: "ACME" },
  });
  const c = cont();
  await (await import("../modulos/portal/portal.js")).modulos.find((m) => m.id === "inicio").montar(c, ctx);
  await esperar(5);
  assert.ok(c.textContent.includes("Bronce"));
  assert.ok(c.textContent.includes("Para nivel Plata"));
  assert.ok(c.textContent.includes("Sentencia favorable"));
});

test("Portal: propuesta pendiente muestra interés de otros compradores y permite ofertar", async () => {
  const llam = [];
  const ctx = await ctxMontaje({
    rpc: (fn, a) => {
      llam.push([fn, a]);
      if (fn === "portal_propuestas") return [{ folio: "VTA-0400", situacion: "PENDIENTE", creditos: 10, capital: 100000, precio: null, tipo: "J&P", estados: "Jalisco", publicada_en: "2026-11-20" }];
      if (fn === "portal_config") return { ver_interes: true, ofertas: true, lealtad: true };
      if (fn === "portal_mis_ofertas") return [];
      if (fn === "portal_interes") return { activo: true, solicitudes: 2, propuestas: 0, por_estado: [{ estado: "Jalisco", compradores: 2 }] };
      if (fn === "portal_ofertar") return { id: 1, monto: 15000, capital: 100000 };
      return null;
    },
    perfil: { rol: "comprador", nombre: "ACME" },
  });
  const c = cont();
  await (await import("../modulos/portal/portal.js")).modulos.find((m) => m.id === "propuestas").montar(c, ctx);
  await esperar(10);
  assert.ok(c.textContent.includes("2 comprador(es) más buscan cartera"));
  [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Ofertar mi precio")).click();
  const inp = c.querySelector(".pt-oferta-form input[type=number]");
  inp.value = "15"; inp.dispatchEvent(new window.Event("input"));
  assert.ok(c.textContent.includes("15,000"));
  [...c.querySelectorAll("button")].find((b) => b.textContent === "Enviar oferta").click();
  await esperar(5);
  const of = llam.find(([f]) => f === "portal_ofertar");
  assert.equal(of[1].p_folio, "VTA-0400");
  assert.equal(of[1].p_centavos, 0.15);
});

test("Compradores: responde una oferta con contraoferta", async () => {
  const llam = [];
  const ctx = await ctxMontaje({
    rpc: (fn, a) => {
      llam.push([fn, a]);
      if (fn === "ofertas_lista") return [{ id: 7, folio: "VTA-0400", comprador: "ACME", nivel: "Plata", centavos: 0.12, capital: 100000, monto: 12000,
        centavos_propuesta: 0.16, precio_propuesta: 16000, estatus: "NUEVA", fecha: "2026-11-20" }];
      return fn.endsWith("_lista") || fn === "compradores_nombres_funnel" ? [] : null;
    },
    esAdmin: true,
  });
  const c = cont();
  await (await import("../modulos/compradores/compradores.js")).default.montar(c, ctx);
  [...c.querySelectorAll(".cmp-tabs button")].find((b) => b.textContent.includes("Ofertas")).click();
  await esperar(5);
  assert.ok(c.textContent.includes("12 ¢"));
  fila(c, "VTA-0400").click();
  const contra = c.querySelector('.cmp-panel input[type=number]');
  contra.value = "14";
  [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Contraofertar")).click();
  await esperar(5);
  const r = llam.find(([f]) => f === "oferta_responder");
  assert.equal(r[1].p_estatus, "CONTRAOFERTA");
  assert.equal(r[1].p_contra, 0.14);
});

test("Ventas duplicadas: clic en una venta abre la ventana y restituye en esa venta", async () => {
  const llam = [];
  const ctx = await ctxMontaje({
    rpc: (fn, a) => {
      llam.push([fn, a]);
      if (fn === "ventas_duplicadas") return [{ tipo: "Grupal", clave: "G199051", n_ventas: 2, revision: "Pendiente", integrantes_repetidos: 6,
        ventas: [{ folio: "VTA-0180", comprador: "LUIS HERNANDEZ", visible: true }, { folio: "VTA-0214", comprador: "ARROYO SALGADO", visible: true }] }];
      if (fn === "validar_restitucion") return { tipo: "Grupal", clave: "G199051", buscado: "G199051", capital: 20000, integrantes: 6, dias: 100,
        estados: "México", vendido: true, bloqueado: false, en_base: true };
      if (fn === "sugerir_restitucion") return [{ clave: "G555", integrantes: 5, estados: "México", municipios: "X", dias: 90, capital: 20500, diferencia: 500 }];
      if (fn === "aplicar_restitucion") return { id_restitucion: "RST-0009", original: "G199051", reemplazo: "G555", diferencia: 500, id_propuesta: "RST-0009", propuesta_nueva: true };
      return null;
    },
    perfil: { rol: "admin" },
  });
  const c = cont();
  await (await import("../modulos/duplicados/duplicados.js")).default.montar(c, ctx);
  [...c.querySelectorAll("button")].find((b) => b.textContent.startsWith("VTA-0214")).click();
  await esperar(10);
  const ven = document.querySelector(".ventana.dup-rst");
  assert.ok(ven, "abre la ventana");
  assert.ok(ven.textContent.includes("Se queda en") && ven.textContent.includes("VTA-0180"));
  [...ven.querySelectorAll("button")].find((b) => b.textContent === "Usar este").click();
  await esperar(5);
  [...document.querySelectorAll(".ventana button")].find((b) => b.textContent === "Aplicar").click();
  await esperar(10);
  const ap = llam.find(([f]) => f === "aplicar_restitucion");
  assert.equal(ap[1].p_folio, "VTA-0214");
  assert.equal(ap[1].p_motivo, "Venta duplicada");
  assert.ok(!document.querySelector(".ventana.dup-rst"), "se cierra al aplicar");
  document.querySelectorAll(".velo").forEach((v) => v.remove());
});

// ---------- Carpeta del cliente y aviso a expedientes ----------
test("Carpeta del cliente: apartados por documento, avance y aviso a expedientes", async () => {
  const llam = [];
  const ctx = await ctxMontaje({
    rpc: (fn, a) => { llam.push([fn, a]); return fn === "expedientes_aviso_datos" ? { aviso: null, para: ["exp@x.mx"], saludo: "Pamela Ingrid" } : null; },
    filas: (t) => (t === "funnel_documentos" ? [{ id: 1, folio: "VTA-0400", tipo: "ine", nombre: "INE.pdf", ruta: "VTA-0400/ine/1_INE.pdf", mime: "application/pdf" }] : []),
  });
  let cuerpo = null;
  ctx.sb.functions.invoke = async (_, { body }) => { cuerpo = body; return { data: { ok: true, para: ["exp@x.mx"], registros: 12 }, error: null }; };
  const { bloqueCarpeta, DOCS_CARPETA, nombreCarpeta } = await import("../modulos/funnel/carpeta.js");
  const f = { folio: "VTA-0400", comprador: "José Pérez & Asoc.", estatus_venta: "Vendida", id_propuesta: "VTA-0400" };
  const el = bloqueCarpeta(ctx, f, { editable: true });
  document.body.append(el);
  await esperar(10);
  assert.equal(el.querySelectorAll(".car-item .doc-bloque").length, DOCS_CARPETA.length);
  for (const [k] of DOCS_CARPETA) assert.ok(el.querySelector(`.doc-bloque[data-tipo="${k}"]`), k);
  assert.ok(el.textContent.includes("Layout para solicitud de expedientes") && el.textContent.includes("Base final"));
  assert.ok(el.querySelector(".car-prog").textContent.includes("de 6"));
  assert.equal(nombreCarpeta(f), "VTA-0400_Jose_Perez_Asoc.");
  [...el.querySelectorAll("button")].find((b) => b.textContent.includes("Avisar a expedientes")).click();
  await esperar(10);
  assert.deepEqual(cuerpo, { accion: "expedientes", folio: "VTA-0400" });
  el.remove();
});

test("Aviso a expedientes sin correo de Microsoft 365: ofrece mandarlo desde Outlook", async () => {
  const ctx = await ctxMontaje({ rpc: () => null });
  ctx.sb.functions.invoke = async () => ({ data: null, error: { message: "x", context: { json: async () => ({ error: "No configurado", sin_configurar: true }) } } });
  let pregunta = null;
  ctx.ui = { ...ctx.ui, confirmar: async (t, m) => { pregunta = m; return false; } };
  const { avisarExpedientes } = await import("../modulos/funnel/carpeta.js");
  const ok = await avisarExpedientes(ctx, { folio: "VTA-0400" });
  assert.equal(ok, false);
  assert.ok(pregunta.includes("Outlook"));
});

test("Portal ⚙️: guarda el correo y saludo de expedientes", async () => {
  const llam = [];
  const ctx = await ctxMontaje({ rpc: (fn, a) => { llam.push([fn, a]); return fn === "config_lista"
    ? [{ clave: "expedientes_aviso", valor: true }, { clave: "expedientes_correo", valor: "" }, { clave: "expedientes_nombre", valor: "Pamela Ingrid" }] : null; } });
  const { ajustesPortal } = await import("../modulos/compradores/extras.js");
  const c = cont();
  await ajustesPortal(ctx, c);
  const correo = c.querySelector('[data-clave="expedientes_correo"]');
  correo.value = "pamela@exitus.test";
  [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Guardar")).click();
  await esperar(5);
  assert.ok(llam.some(([f, a]) => f === "config_guardar" && a.p_clave === "expedientes_correo" && a.p_valor === "pamela@exitus.test"));
  assert.ok(llam.some(([f, a]) => f === "config_guardar" && a.p_clave === "expedientes_nombre" && a.p_valor === "Pamela Ingrid"));
});
