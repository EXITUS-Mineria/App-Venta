// ============================================================
// Lectura de archivos de exclusión (sin interfaz; se prueba aparte)
//  · promesa: gestiones SIGE. Si el archivo trae columna de resultado (Resultado, Descripcion_Resultado,
//    Tipificación…) sólo cuentan las filas con PROMESA / CONVENIO / COMPROMISO / PDP. Fecha: la de la
//    promesa (FechaPromesa, FechaCompromiso) o, si no hay, la de la gestión.
//  · pago: pagos (FechaPago / Fecha, Monto / Importe).
//  · lista_negra: basta la columna de referencia (o la primera columna si no hay encabezado).
// Se queda una fila por vReference, con la fecha más reciente.
// ============================================================
export const XLSX_CDN = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm";

const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const REF = ["vreference", "referencia", "reference", "vref", "ref", "referenciacredito", "credito"];
const FECHA = {
  promesa: ["fechapromesa", "fechadepromesa", "fechacompromiso", "fechapdp", "fechapago", "fechagestion", "fechadegestion", "fecha", "dfecha", "vfecha"],
  pago: ["fechapago", "fechadepago", "fechaaplicacion", "dfechapago", "fechamovimiento", "fecha", "dfecha", "vfecha"],
  lista_negra: ["fecha", "fechaalta", "fechaingreso"],
};
const MONTO = ["montopromesa", "montopdp", "montocompromiso", "montopago", "monto", "importe", "npago", "pago", "namount"];
const RESULTADO = ["descripcionresultado", "resultado", "tipificacion", "resultadogestion", "vresultado", "codigoresultado", "dictamen", "estatusgestion"];
export const ES_PROMESA = /PROMESA|CONVENIO|COMPROMISO|\bPDP\b|PROMETE/i;

const buscar = (enc, nombres) => { for (const n of nombres) { const i = enc.indexOf(n); if (i >= 0) return i; } return -1; };

/** Fecha de una celda (Date, número de serie de Excel, dd/mm/aaaa, aaaa-mm-dd) → "AAAA-MM-DD" o null. */
export function aFecha(v) {
  if (v == null || v === "") return null;
  const iso = (d) => (isNaN(d) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  if (v instanceof Date) return iso(v);
  const s = String(v).trim();
  if (/^\d{4,5}(\.\d+)?$/.test(s)) { const n = Number(s); if (n > 20000 && n < 80000) return iso(new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000 + 43200000)); }
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) { const a = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${a}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return null;
}
const aNumero = (v) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[$,\s]/g, "")); return isNaN(n) ? null : n; };

/** filas: arreglo de arreglos (la primera puede ser encabezado). Regresa { filas: [{ref, fecha, monto, detalle}], leidas, descartadas, columnas }. */
export function extraerExclusiones(filas, origen) {
  if (!filas?.length) return { filas: [], leidas: 0, descartadas: 0, columnas: {} };
  const enc = filas[0].map(norm);
  let iRef = buscar(enc, REF);
  const conEnc = iRef >= 0;
  if (!conEnc) iRef = 0;
  const iFecha = conEnc ? buscar(enc, FECHA[origen] || FECHA.pago) : -1;
  const iMonto = conEnc ? buscar(enc, MONTO) : -1;
  const iRes = conEnc && origen === "promesa" ? buscar(enc, RESULTADO) : -1;
  const datos = conEnc ? filas.slice(1) : filas;
  const porRef = new Map();
  let descartadas = 0;
  for (const f of datos) {
    const ref = String(f[iRef] ?? "").trim().toUpperCase();
    if (!ref) { descartadas++; continue; }
    const detalle = iRes >= 0 ? String(f[iRes] ?? "").trim() : "";
    if (iRes >= 0 && !ES_PROMESA.test(detalle)) { descartadas++; continue; }
    const fila = { ref, fecha: iFecha >= 0 ? aFecha(f[iFecha]) : null, monto: iMonto >= 0 ? aNumero(f[iMonto]) : null, detalle: detalle || null };
    const prev = porRef.get(ref);
    if (!prev || (fila.fecha && (!prev.fecha || fila.fecha > prev.fecha))) porRef.set(ref, fila);
  }
  const nombre = (i) => (i >= 0 && conEnc ? String(filas[0][i]) : null);
  return { filas: [...porRef.values()], leidas: datos.length, descartadas,
           columnas: { referencia: conEnc ? String(filas[0][iRef]) : "(primera columna)", fecha: nombre(iFecha), monto: nombre(iMonto), resultado: nombre(iRes) } };
}

/** Lee CSV / Excel a arreglo de arreglos. */
export async function leerTabla(archivo, leerCSV) {
  if (/\.xlsx?$/i.test(archivo.name)) {
    const XLSX = await import(XLSX_CDN);
    const libro = XLSX.read(await archivo.arrayBuffer(), { type: "array", cellDates: true });
    const hoja = libro.Sheets[libro.SheetNames[0]];
    return XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: "" });
  }
  const buf = await archivo.arrayBuffer();
  let texto = new TextDecoder("utf-8").decode(buf);
  if (texto.includes("�")) texto = new TextDecoder("latin1").decode(buf);
  return leerCSV(texto);
}
