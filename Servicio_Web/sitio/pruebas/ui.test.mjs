import { test } from "node:test";
import assert from "node:assert/strict";
import { blobCapturado, limpiarBlob, esperar } from "./ayuda.mjs";
import * as ui from "../nucleo/ui.js";

const leerBlob = async () => {
  const b = blobCapturado();
  assert.ok(b, "no se capturó ningún Blob de descarga");
  return await b.text();
};

test("h construye elementos con atributos, clases, estilos y eventos", () => {
  let clic = 0;
  const el = ui.h("div", { class: "x", "data-id": 7, style: { width: "10px" }, onclick: () => clic++ },
    "hola", null, false, ui.h("b", {}, "mundo"));
  assert.equal(el.tagName, "DIV");
  assert.equal(el.className, "x");
  assert.equal(el.getAttribute("data-id"), "7");
  assert.equal(el.style.width, "10px");
  assert.equal(el.childNodes.length, 2); // ignora null/false
  el.dispatchEvent(new Event("click"));
  assert.equal(clic, 1);
});

test("h omite atributos undefined/null/false y no asigna onclick como atributo", () => {
  const el = ui.h("input", { type: "text", value: undefined, disabled: false, onclick: () => {} });
  assert.equal(el.getAttribute("value"), null);
  assert.equal(el.disabled, false);
  assert.equal(el.getAttribute("onclick"), null);
});

test("dinero, numero y dias formatean en es-MX", () => {
  assert.match(ui.dinero(1234.5), /1,234\.50/);
  assert.match(ui.numero(1234567), /1,234,567/);
  assert.equal(ui.dias(null), "N/D");
  assert.equal(ui.dias(""), "N/D");
  assert.equal(ui.dias("abc"), "N/D");
  assert.equal(ui.dias(3), "3.0 días");
  assert.equal(ui.dinero(null), ui.dinero(0));
});

test("pastillaEstatus aplica la clase del estatus y tolera desconocidos", () => {
  assert.equal(ui.pastillaEstatus("APROBADA").className, "estatus aprobada");
  assert.equal(ui.pastillaEstatus("EN VENTA").className, "estatus venta");
  assert.equal(ui.pastillaEstatus("RARO").className, "estatus ");
});

test("descargarCSV en latin1 convierte a bytes y descarta lo no representable", async () => {
  limpiarBlob();
  ui.descargarCSV("x.csv", ["a", "b"], [{ a: "ñ", b: 1 }], "latin1");
  const bytes = new Uint8Array(await blobCapturado().arrayBuffer());
  const texto = String.fromCharCode(...bytes);
  assert.match(texto, /^a,b\r\n/);
  assert.equal(texto.charCodeAt(5), 0xF1);        // "ñ" en Latin-1
  assert.equal(bytes[0], 0x61);                   // sin BOM: inicia con "a"
  assert.ok(![...bytes.slice(0, 3)].every((b, i) => b === [0xEF, 0xBB, 0xBF][i]));
  ui.descargarCSV("y.csv", ["a"], [{ a: "🙂" }], "latin1");
  const raro = String.fromCharCode(...new Uint8Array(await blobCapturado().arrayBuffer()));
  assert.equal(raro.charCodeAt(3), 0x3F);         // fuera de Latin-1 → "?"
});

test("descargarCSV en utf8 agrega BOM y escapa comillas/comas", async () => {
  limpiarBlob();
  ui.descargarCSV("x.csv", ["a"], [{ a: 'di "hola", sí' }]);
  const bytes = new Uint8Array(await blobCapturado().arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF]); // BOM UTF-8
  assert.match(await leerBlob(), /"di ""hola"", sí"/);
});

test("tabla ordena, filtra selección y respeta filas bloqueadas", () => {
  const sel = new Set();
  const cambios = [];
  const t = ui.tabla(
    [{ clave: "id", titulo: "Id" }, { clave: "n", titulo: "N", num: true }],
    { seleccion: sel, idFila: (f) => f.id, bloqueada: (f) => f.bloq, alCambiar: () => cambios.push(sel.size) },
  );
  t.setFilas([{ id: "b", n: 2 }, { id: "a", n: 1 }, { id: "c", n: 3, bloq: true }]);
  assert.equal(t.el.querySelectorAll("tbody tr").length, 3);
  // clic en el encabezado "N" ordena asc
  const ths = t.el.querySelectorAll("th");
  ths[1].dispatchEvent(new Event("click"));
  const ids = [...t.el.querySelectorAll("tbody tr")].map((tr) => tr.dataset.id);
  assert.deepEqual(ids, ["a", "b", "c"]);
  // seleccionar la fila "a"
  const filaA = [...t.el.querySelectorAll("tbody tr")].find((tr) => tr.dataset.id === "a");
  filaA.dispatchEvent(new Event("click", { bubbles: true }));
  assert.ok(sel.has("a"));
  assert.ok(filaA.classList.contains("sel"));
  // la fila bloqueada no se puede seleccionar
  const filaC = [...t.el.querySelectorAll("tbody tr")].find((tr) => tr.dataset.id === "c");
  filaC.dispatchEvent(new Event("click", { bubbles: true }));
  assert.ok(!sel.has("c"));
  assert.deepEqual(cambios, [1]);
  assert.equal(t.filaDe(filaA).id, "a");
});

test("tabla muestra el texto de vacío", () => {
  const t = ui.tabla([{ clave: "id", titulo: "Id" }], { vacio: "Nada aquí" });
  t.setFilas([]);
  assert.equal(t.el.querySelector(".vacio").textContent, "Nada aquí");
});

test("kpi.set actualiza valor, subtexto y estado", () => {
  const k = ui.kpi("Capital");
  k.set("$10", "sub", "bien");
  assert.equal(k.el.querySelector(".v").textContent, "$10");
  assert.equal(k.el.querySelector(".s").textContent, "sub");
  assert.equal(k.el.className, "kpi bien");
});

test("toast se muestra y se elimina pasado el tiempo", async () => {
  ui.toast("hola", "bien", 10);
  const cont = document.querySelector(".toasts");
  assert.ok(cont);
  assert.equal(cont.lastChild.textContent, "hola");
  await esperar(30);
  assert.equal(cont.querySelectorAll(".toast").length, 0);
});

test("cargarCSS no duplica la hoja de estilos", () => {
  const antes = document.head.querySelectorAll('link[href*="prueba-css"]').length;
  ui.cargarCSS("https://pruebas.test/prueba-css.css");
  ui.cargarCSS("https://pruebas.test/prueba-css.css");
  const despues = document.head.querySelectorAll('link[href*="prueba-css"]').length;
  assert.equal(despues - antes, 1);
});

test("confirmar resuelve true/false y avisar cierra con Aceptar", async () => {
  const p = ui.confirmar("T", "M");
  await esperar(0);
  const velo = document.querySelector(".velo");
  assert.ok(velo);
  velo.querySelector(".btn-marca").dispatchEvent(new Event("click"));
  assert.equal(await p, true);
  assert.equal(document.querySelector(".velo"), null);

  const p2 = ui.confirmar("T", "M");
  await esperar(0);
  document.querySelector(".velo .btn-secundario").dispatchEvent(new Event("click"));
  assert.equal(await p2, false);
});

test("pedirTexto regresa el texto escrito", async () => {
  const p = ui.pedirTexto("T", "M", "def");
  await esperar(0);
  const velo = document.querySelector(".velo");
  const input = velo.querySelector("input");
  assert.equal(input.value, "def");
  input.value = "nuevo";
  velo.querySelector(".btn-primario").dispatchEvent(new Event("click"));
  assert.equal(await p, "nuevo");
});
