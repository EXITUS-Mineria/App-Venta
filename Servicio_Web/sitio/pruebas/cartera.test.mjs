import { test } from "node:test";
import assert from "node:assert/strict";
import "./ayuda.mjs";
import { sugerir, rangoObjetivo, terminos, mapearJyP, mapearGrupo, aCandidato } from "../modulos/venta/cartera.js";

const c = (key, capital, mora = null) => ({ key, capital, mora });

test("rangoObjetivo respeta −$1,000 / +$2,000 y no baja de 0", () => {
  assert.deepEqual(rangoObjetivo(200000), [199000, 202000]);
  assert.deepEqual(rangoObjetivo(500), [0, 2500]);
});

test("sugerir llena hasta el objetivo sin pasarse del máximo", () => {
  const r = sugerir([c("a", 1000, 10), c("b", 1000, 5), c("c", 1000, 1)], 2000, 1000, 4000, "Mayor capital primero");
  assert.equal(r.total, 2000);
  assert.deepEqual(r.keys, ["a", "b"]);
});

test("sugerir prioriza por mora y desempata por capital", () => {
  const r = sugerir([c("a", 100, 1), c("b", 300, 9), c("c", 200, 9)], 600, 0, 1000, "Mayor mora primero");
  assert.deepEqual(r.keys, ["b", "c", "a"]); // b y c (mora 9, mayor capital primero) luego a
});

test("sugerir ignora capitales no positivos y mora inválida", () => {
  const r = sugerir([c("a", 0), c("b", -5), c("c", 500, "x")], 500, 0, 500, "Mayor mora primero");
  assert.deepEqual(r.keys, ["c"]);
});

test("sugerir cierra con un crédito extra cuando no alcanza el mínimo", () => {
  const r = sugerir([c("a", 300), c("b", 400), c("c", 700)], 1000, 900, 3000, "Menor capital primero");
  assert.ok(r.total >= 900, `total ${r.total}`);
});

test("sugerir intercambia una partida para caer en el rango", () => {
  const cand = [c("a", 100), c("b", 100), c("c", 100), c("d", 800)];
  const r = sugerir(cand, 1000, 900, 3000, "Mayor capital primero");
  assert.ok(r.total >= 900 && r.total <= 3000);
});

test("terminos separa por espacios, comas y punto y coma en mayúsculas", () => {
  assert.deepEqual(terminos("ab-1, cd 2;ef"), ["AB-1", "CD", "2", "EF"]);
  assert.deepEqual(terminos("   "), []);
});

test("mapearJyP normaliza la fila de buscar_jyp", () => {
  const f = mapearJyP({ vreference: "V1", estado: "Jalisco", municipio: "Guadalajara", colonia: "Centro", dias: "12", npendingk: "1500.5" });
  assert.equal(f.key, "J:V1");
  assert.equal(f.mora, 12);
  assert.equal(f.capital, 1500.5);
  assert.equal(f.disponible, true);
  assert.equal(f.integrantes, 1);
});

test("mapearJyP deja la mora en null cuando no viene", () => {
  assert.equal(mapearJyP({ vreference: "V", npendingk: 10, dias: null }).mora, null);
});

test("mapearGrupo refleja disponibilidad y bloqueo", () => {
  const f = mapearGrupo({ vgroupid: "G1", estados: "CDMX", municipios: "Iztapalapa", colonias: "X", dias_promedio: "7.5", capital: "900", integrantes: "4", disponible: false });
  assert.equal(f.key, "G:G1");
  assert.equal(f.disponible, false);
  assert.equal(f.estatus, "BLOQUEADO");
  assert.equal(f.integrantes, 4);
});

test("aCandidato conserva sólo key, capital y mora", () => {
  assert.deepEqual(aCandidato({ key: "k", capital: 1, mora: 2, extra: 9 }), { key: "k", capital: 1, mora: 2 });
});
