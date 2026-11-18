// ============================================================
// Cartera: reglas y utilidades compartidas por "Armar propuesta" y "Propuesta IA".
// Rango permitido, optimizador de la propuesta y mapeo de las filas de la base.
// ============================================================

export const RANGO_ABAJO = 1000;
export const RANGO_ARRIBA = 2000;

/** Rango [mínimo, máximo] del capital objetivo (mismo criterio que la app de escritorio). */
export const rangoObjetivo = (objetivo) => [Math.max(0, objetivo - RANGO_ABAJO), objetivo + RANGO_ARRIBA];

/** Igual que la app de escritorio: llena hasta el objetivo sin pasarse del máximo y, si falta, intercambia. */
export function sugerir(candidatos, objetivo, minimo, maximo, prioridad) {
  const c = candidatos.filter((x) => x.capital > 0).map((x) => ({ ...x }));
  const mora = (x) => (x.mora === null || x.mora === undefined || isNaN(x.mora) ? null : Number(x.mora));
  const porMora = (asc) => (a, b) => {
    const ma = mora(a), mb = mora(b);
    if (ma === null && mb === null) return b.capital - a.capital;
    if (ma === null) return 1;
    if (mb === null) return -1;
    return (asc ? ma - mb : mb - ma) || b.capital - a.capital;
  };
  if (prioridad === "Mayor mora primero") c.sort(porMora(false));
  else if (prioridad === "Menor mora primero") c.sort(porMora(true));
  else if (prioridad === "Menor capital primero") c.sort((a, b) => a.capital - b.capital);
  else c.sort((a, b) => b.capital - a.capital);

  const elegidos = [];
  let total = 0;
  for (const x of c) {
    if (total >= objetivo) break;
    if (total + x.capital <= maximo) { elegidos.push(x); total += x.capital; }
  }
  if (total < minimo) {
    const usados = new Set(elegidos.map((x) => x.key));
    const resto = c.filter((x) => !usados.has(x.key));
    const cierre = resto.find((x) => x.capital >= minimo - total && x.capital <= maximo - total);
    if (cierre) { elegidos.push(cierre); total += cierre.capital; }
  }
  if (total < minimo && elegidos.length) {
    const usados = new Set(elegidos.map((x) => x.key));
    const resto = c.filter((x) => !usados.has(x.key)).sort((a, b) => a.capital - b.capital);
    for (let i = elegidos.length - 1; i >= 0; i--) {
      const base = total - elegidos[i].capital;
      const sub = resto.find((x) => base + x.capital >= minimo && base + x.capital <= maximo);
      if (sub) { elegidos[i] = sub; total = base + sub.capital; break; }
    }
  }
  return { keys: elegidos.map((x) => x.key), total };
}

/** Términos de búsqueda escritos por el usuario (vReference / grupo). */
export const terminos = (texto) =>
  texto.split(/[\s,;]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

/** Fila de la tabla a partir de un crédito JyP de buscar_jyp(). */
export const mapearJyP = (r) => ({
  key: `J:${r.vreference}`, tipo: "JyP", id: r.vreference, estado: r.estado, municipio: r.municipio,
  colonia: r.colonia, integrantes: 1, mora: num(r.dias), capital: Number(r.npendingk),
  disponible: true, estatus: "DISPONIBLE",
});

/** Fila de la tabla a partir de un grupo de buscar_grupos(). */
export const mapearGrupo = (r) => ({
  key: `G:${r.vgroupid}`, tipo: "Grupal", id: r.vgroupid, estado: r.estados, municipio: r.municipios,
  colonia: r.colonias, integrantes: Number(r.integrantes), mora: num(r.dias_promedio), capital: Number(r.capital),
  disponible: r.disponible, estatus: r.disponible ? "DISPONIBLE" : "BLOQUEADO",
});

/** Candidatos disponibles para el optimizador (sólo key, capital y mora). */
export const aCandidato = (f) => ({ key: f.key, capital: f.capital, mora: f.mora });
