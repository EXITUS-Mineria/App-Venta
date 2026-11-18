// Archivo de propuesta final y nombres de descarga.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./ayuda.mjs";
import { leerCSV, extraerCuentas } from "../modulos/venta/propuesta_final.js";
import { nombreArchivo } from "../modulos/venta/layout.js";

test("leerCSV detecta separador y respeta comillas", () => {
  assert.deepEqual(leerCSV("vReference;Capital\r\n1000-1;\"1,500.00\"\r\n"), [["vReference", "Capital"], ["1000-1", "1,500.00"]]);
  assert.deepEqual(leerCSV("﻿a,b\n\"x,1\",2\n"), [["a", "b"], ["x,1", "2"]]);
});

test("extraerCuentas reconoce encabezados y, sin encabezado, toma la primera columna", () => {
  assert.deepEqual(extraerCuentas([["IdPropuesta", "vReference", "vGroupId"], ["VTA-1", "R1", ""], ["VTA-1", "R2", "G9"], ["VTA-1", "R1", ""]]),
    { refs: ["R1", "R2"], grupos: ["G9"] });
  assert.deepEqual(extraerCuentas([["Referencia"], ["0000343399-2"]]), { refs: ["0000343399-2"], grupos: [] });
  assert.deepEqual(extraerCuentas([["0000343399-2"], ["1000391636-7"]]), { refs: ["0000343399-2", "1000391636-7"], grupos: [] });
  assert.deepEqual(extraerCuentas([]), { refs: [], grupos: [] });
});

test("nombreArchivo incluye folio y comprador sin acentos ni símbolos", () => {
  assert.equal(nombreArchivo({ id_propuesta: "VTA-0301", comprador: "jonathan caballero" }, "Propuesta"), "VTA-0301_jonathan_caballero_Propuesta.csv");
  assert.equal(nombreArchivo({ id_propuesta: "VTA-0302", comprador: "José Peña / S.A." }, "BaseFinal"), "VTA-0302_Jose_Pena_S_A_BaseFinal.csv");
  assert.equal(nombreArchivo({ id_propuesta: "VTA-0303", comprador: "" }, "Cuentas_Revision"), "VTA-0303_Cuentas_Revision.csv");
});
