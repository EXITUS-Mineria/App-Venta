import { esperar, ctxMontaje, blobCapturado, limpiarBlob } from "./ayuda.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const cont = () => { const d = document.createElement("div"); document.body.append(d); return d; };
const hoy = new Date(), MES = hoy.getMonth() + 1, ANIO = hoy.getFullYear();
const METAS = [{ clave: "general", valor: 1500000 }, { clave: "grupal", valor: 750000 }, { clave: "jyp", valor: 750000 },
  { clave: "complementario", valor: 50000 }, { clave: "zona:Centro", valor: 675000 }, { clave: "zona:Norte", valor: 525000 },
  { clave: "zona:Sur", valor: 300000 }, { clave: "vendedor:Sandibel", valor: 975000 }, { clave: "vendedor:Maricela", valor: 525000 }];
const fila = (o) => ({ anio: ANIO, mes: MES, capital: 0, zona: "Centro", tipo: "Grupal", estatus_venta: "Vendida", vendedor: "Sandibel Lara Lopez", ...o });

test("dashboard: diasHabiles y metaDeVendedor", async () => {
  const { diasHabiles, metaDeVendedor } = await import("../modulos/dashboard/dashboard.js");
  const d = diasHabiles(2026, 11, new Date(2026, 10, 18));   // noviembre 2026, miércoles 18
  assert.equal(d.total, 21); assert.equal(d.transcurridos, 13); assert.equal(d.restantes, 8);
  assert.equal(diasHabiles(2026, 10, new Date(2026, 10, 18)).transcurridos, 22);   // mes pasado: completo
  const metas = { complementario: 50000, "vendedor:Sandibel": 975000 };
  assert.equal(metaDeVendedor(metas, "Sandibel Lara López").meta, 975000);
  assert.equal(metaDeVendedor(metas, "Rubén Orozco").meta, 50000);
});

test("dashboard: vista de admin con metas, zonas, candados, comparativa y CSV", async () => {
  const datos = [fila({ folio: "VTA-1", monto_venta: 300000 }), fila({ folio: "VTA-2", monto_venta: 100000, zona: "Norte", tipo: "JyP", vendedor: "Ruben Orozco Panecatl" }),
    fila({ folio: "VTA-3", monto_venta: 80000, estatus_venta: "Propuesta" }),
    fila({ folio: "VTA-0", monto_venta: 200000, mes: MES > 1 ? MES - 1 : MES })];
  const ctx = await ctxMontaje({ perfil: { rol: "admin", nombre: "Daniel" }, esAdmin: true,
    rpc: (fn) => (fn === "dashboard_datos" ? datos : fn === "dashboard_metas_lista" ? METAS : null) });
  const c = cont();
  await (await import("../modulos/dashboard/dashboard.js")).default.montar(c, ctx);
  await esperar(5);
  const t = c.textContent;
  assert.ok(t.includes("Resultado del mes") && t.includes("Vendedores principales"));
  assert.ok(t.includes("$400 mil"), "vendido del mes = 300k + 100k");
  assert.ok(t.includes("26.7%"), "avance contra meta general 1.5M");
  assert.ok(t.includes("$80 mil") && t.includes("1 propuestas abiertas"));
  assert.ok(t.includes("Ruben Orozco"), "complementario con nombre corto");
  assert.ok(t.includes("🔒 Pendiente"));
  assert.ok(c.querySelector(".dsh-barras") && t.includes("VS MES ANTERIOR"));
  assert.ok([...c.querySelectorAll("button")].some((b) => b.textContent.includes("⚙ Metas")));
  // filtro de vendedor usa su meta principal
  const sel = [...c.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "Sandibel Lara Lopez"));
  sel.value = "Sandibel Lara Lopez"; sel.dispatchEvent(new Event("change"));
  assert.ok(c.textContent.includes("meta de Sandibel Lara"));
  limpiarBlob();
  [...c.querySelectorAll("button")].find((b) => b.textContent.includes("Exportar CSV")).click();
  const csv = await blobCapturado().text();
  assert.ok(csv.includes("VTA-1") && !csv.includes("VTA-2"));
});

test("dashboard: el vendedor ve sólo su resultado contra su meta", async () => {
  const datos = [fila({ folio: "VTA-9", monto_venta: 25000, vendedor: "Rubén Orozco Panecatl", es_mio: true })];
  const ctx = await ctxMontaje({ perfil: { rol: "vendedor", nombre: "Rubén Orozco Panecatl" },
    rpc: (fn) => (fn === "dashboard_datos" ? datos : fn === "dashboard_metas_lista" ? METAS : null) });
  const c = cont();
  await (await import("../modulos/dashboard/dashboard.js")).default.montar(c, ctx);
  await esperar(5);
  const t = c.textContent;
  assert.ok(t.includes("Mi resultado del mes") && t.includes("Mi candado"));
  assert.ok(t.includes("50.0%"), "25k de meta complementaria 50k");
  assert.ok(!t.includes("Vendedores principales"));
  assert.ok(![...c.querySelectorAll("button")].some((b) => b.textContent.includes("⚙ Metas")));
  assert.ok(![...c.querySelectorAll("label")].some((l) => l.textContent === "VENDEDOR"));
});
