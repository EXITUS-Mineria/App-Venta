// Pruebas de la hoja de estilo del núcleo: mantiene el contrato del tema
// (tokens definidos, sin variables huérfanas y con reglas responsivas).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const nucleo = readFileSync(join(raiz, "nucleo/estilos.css"), "utf8");

const cssDeModulos = () => {
  const base = join(raiz, "modulos");
  const salida = [];
  for (const dir of readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const sub = join(base, dir.name);
    for (const f of readdirSync(sub)) if (f.endsWith(".css")) salida.push([f, readFileSync(join(sub, f), "utf8")]);
  }
  return salida;
};

test("estilos.css define los tokens del tema Ejecutivo Exitus", () => {
  for (const t of ["--rojo", "--tinta", "--fondo", "--borde", "--bien", "--alerta", "--mal", "--info-bg", "--aviso-bg", "--ok-bg", "--neutro-bg"]) {
    assert.match(nucleo, new RegExp(`${t}\\s*:`), `falta el token ${t}`);
  }
  assert.match(nucleo, /--escala\s*:\s*1/);
});

test("estilos.css no tiene llaves desbalanceadas", () => {
  assert.equal((nucleo.match(/{/g) || []).length, (nucleo.match(/}/g) || []).length);
});

test("estilos.css incluye reglas responsivas y de accesibilidad", () => {
  assert.match(nucleo, /@media \(max-width: 760px\)/);
  assert.match(nucleo, /@media \(max-width: 480px\)/);
  assert.match(nucleo, /prefers-reduced-motion/);
  assert.match(nucleo, /:focus-visible/);
});

test("ningún CSS usa variables sin definir", () => {
  const archivos = [["estilos.css", nucleo], ...cssDeModulos()];
  const definidas = new Set();
  for (const [, css] of archivos) for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) definidas.add(m[1]);
  const huerfanas = [];
  for (const [nombre, css] of archivos) {
    for (const m of css.matchAll(/var\((--[\w-]+)/g)) {
      if (!definidas.has(m[1])) huerfanas.push(`${nombre}: ${m[1]}`);
    }
  }
  assert.deepEqual(huerfanas, []);
});

test("los CSS de los módulos no redefinen colores base del tema", () => {
  for (const [nombre, css] of cssDeModulos()) {
    assert.ok(!/--rojo\s*:/.test(css), `${nombre} redefine --rojo`);
    assert.ok(!/--tinta\s*:/.test(css), `${nombre} redefine --tinta`);
  }
});
