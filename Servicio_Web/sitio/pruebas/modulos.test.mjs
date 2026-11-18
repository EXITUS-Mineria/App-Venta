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
  const buscar = [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Buscar reemplazo"));
  assert.equal(buscar.disabled, false);
});

// ---------- Bases ----------
test("Bases: pinta las cargas recibidas", async () => {
  const ctx = await ctxMontaje({ filas: () => [{ cartera: "JyP", archivo: "Base JyP.csv", filas: 100, usuario: "Ana", cargado: "2026-01-01" }] });
  const c = cont();
  await (await import("../modulos/cargas/cargas.js")).default.montar(c, ctx);
  assert.ok(c.textContent.includes("Base JyP.csv"));
});
