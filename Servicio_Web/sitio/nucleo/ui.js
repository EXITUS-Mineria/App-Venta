// ============================================================
// Utilidades de interfaz compartidas por todos los módulos.
// ============================================================

/** Crea un elemento: h("div", {class: "x", onclick: fn}, "texto", otroNodo) */
export function h(tag, attrs = {}, ...hijos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of hijos.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const fmtDinero = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: 2 });
const fmtNum = new Intl.NumberFormat("es-MX");

export const dinero = (n) => fmtDinero.format(Number(n) || 0);
export const numero = (n) => fmtNum.format(Number(n) || 0);
export const dias = (n) => (n === null || n === undefined || n === "" || isNaN(n) ? "N/D" : `${Number(n).toFixed(1)} días`);
export const fecha = (t) => (t ? new Date(t).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" }) : "");

/** Pastilla de estatus de propuesta */
const CLASE_ESTATUS = { "EN REVISIÓN": "revision", APROBADA: "aprobada", "EN VENTA": "venta", APARTADA: "venta",
  RECHAZADA: "rechazada", "EN CONFLICTO": "conflicto", LIBERADA: "liberada" };
export const pastillaEstatus = (e) => h("span", { class: `estatus ${CLASE_ESTATUS[e] || ""}` }, e || "");

/** Aviso flotante. tipo: "bien" | "mal" | "" */
export function toast(mensaje, tipo = "", ms = 4500) {
  let cont = document.querySelector(".toasts");
  if (!cont) document.body.append((cont = h("div", { class: "toasts", role: "status", "aria-live": "polite" })));
  const t = h("div", { class: `toast ${tipo}` }, mensaje);
  cont.append(t);
  setTimeout(() => t.remove(), ms);
}

function ventana(titulo, cuerpo, botones) {
  return new Promise((resolve) => {
    const cerrar = (v) => { velo.remove(); resolve(v); };
    const pie = h("footer", {}, ...botones.map((b) =>
      h("button", { class: `btn ${b.clase || "btn-secundario"}`, onclick: () => cerrar(b.valor()) }, b.texto)));
    const velo = h("div", { class: "velo" },
      h("div", { class: "ventana", role: "dialog", "aria-modal": "true", "aria-label": titulo },
        h("header", {}, titulo), h("div", { class: "cuerpo" }, cuerpo), pie));
    velo.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrar(null); });
    document.body.append(velo);
    (velo.querySelector("input,textarea") || pie.lastChild).focus();
  });
}

export const avisar = (titulo, mensaje) =>
  ventana(titulo, mensaje, [{ texto: "Aceptar", clase: "btn-primario", valor: () => true }]);

export const confirmar = (titulo, mensaje, textoSi = "Sí, continuar") =>
  ventana(titulo, mensaje, [
    { texto: "Cancelar", valor: () => false },
    { texto: textoSi, clase: "btn-marca", valor: () => true },
  ]).then(Boolean);

export function pedirTexto(titulo, mensaje, defecto = "") {
  const inp = h("input", { class: "campo", value: defecto, style: { marginTop: "10px" } });
  return ventana(titulo, h("div", {}, mensaje, inp), [
    { texto: "Cancelar", valor: () => null },
    { texto: "Aceptar", clase: "btn-primario", valor: () => inp.value },
  ]);
}

/** Tarjeta de indicador: const k = kpi("Capital"); k.set("$1", "sub", "bien"|"mal"|"alerta") */
export function kpi(titulo) {
  const v = h("div", { class: "v" }, "—");
  const s = h("div", { class: "s" }, "");
  const el = h("div", { class: "kpi" }, h("div", { class: "t" }, titulo), v, s);
  return {
    el,
    set(valor, sub = "", estado = "") {
      v.textContent = valor; s.textContent = sub; el.className = `kpi ${estado}`;
    },
  };
}

// Hojas de estilos ya cargadas: evita recorrer document.styleSheets en cada llamada.
const CSS_CARGADOS = new Set();

/** Carga una hoja de estilos de un módulo (una sola vez). */
export function cargarCSS(url) {
  const href = new URL(url, import.meta.url).href;
  if (CSS_CARGADOS.has(href)) return;
  CSS_CARGADOS.add(href);
  document.head.append(h("link", { rel: "stylesheet", href: url }));
}

function celdaCSV(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Arma el texto CSV (separador coma, fin de línea CRLF) con su fila de encabezados. */
export function construirCSV(columnas, filas) {
  const lineas = [columnas.map(celdaCSV).join(",")];
  for (const f of filas) lineas.push(columnas.map((c) => celdaCSV(f[c])).join(","));
  return lineas.join("\r\n") + "\r\n";
}

/** Convierte texto a bytes Latin-1; lo que no existe en Latin-1 se vuelve "?". */
export function textoALatin1(texto) {
  const datos = new Uint8Array(texto.length);
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charCodeAt(i);
    datos[i] = c < 256 ? c : 63;
  }
  return datos;
}

/** Descarga un CSV. codificacion: "latin1" (Funnel) o "utf8" (Excel con acentos). */
export function descargarCSV(nombre, columnas, filas, codificacion = "utf8") {
  const texto = construirCSV(columnas, filas);
  const datos = codificacion === "latin1" ? textoALatin1(texto) : "﻿" + texto;
  const url = URL.createObjectURL(new Blob([datos], { type: "text/csv" }));
  const a = h("a", { href: url, download: nombre });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Clave inicial para un usuario nuevo: 10 caracteres al azar + prefijo y signo. */
export function claveAleatoria(prefijo) {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const n = new Uint32Array(10);
  crypto.getRandomValues(n);
  return `${prefijo}-${[...n].map((x) => letras[x % letras.length]).join("")}!`;
}

/**
 * Lista de casillas con buscador (estados / municipios).
 * items: [{nombre, n}], sel: Set(nombre), filtro: texto de búsqueda.
 * vacio: mensaje cuando no hay items; si no se da, usa los textos por defecto.
 */
export function listaCasillas(cont, items, sel, filtro, alCambiar, vacio) {
  const f = (filtro || "").trim().toUpperCase();
  const vis = f ? items.filter((i) => i.nombre.toUpperCase().includes(f)) : items;
  cont.replaceChildren(...(vis.length ? vis.map((i) => {
    const chk = h("input", { type: "checkbox", checked: sel.has(i.nombre) });
    const lab = h("label", { class: sel.has(i.nombre) ? "sel" : "" }, chk, i.nombre, h("small", {}, numero(i.n)));
    chk.addEventListener("change", () => {
      chk.checked ? sel.add(i.nombre) : sel.delete(i.nombre);
      lab.classList.toggle("sel", chk.checked);
      alCambiar();
    });
    return lab;
  }) : [h("div", { class: "vacio" }, items.length ? "Sin coincidencias" : (vacio ?? "Elige primero un estado"))]));
}

/**
 * Agrupa el catálogo geográfico para armar las listas sin recorrerlo dos veces:
 * estados ordenados con su total, y municipios por estado con su total.
 * geo: [{estado, municipio, registros}] (ya viene ordenado por estado, municipio).
 */
export function indiceGeo(geo) {
  const estados = new Map();       // estado → {nombre, n}
  const munis = new Map();         // estado → Map(municipio → {nombre, n})
  for (const g of geo) {
    const n = Number(g.registros) || 0;
    const e = estados.get(g.estado) || { nombre: g.estado, n: 0 };
    e.n += n; estados.set(g.estado, e);
    if (!g.municipio) continue;
    let porEstado = munis.get(g.estado);
    if (!porEstado) munis.set(g.estado, (porEstado = new Map()));
    const m = porEstado.get(g.municipio) || { nombre: g.municipio, n: 0 };
    m.n += n; porEstado.set(g.municipio, m);
  }
  return {
    estados: [...estados.values()],
    municipios(estado) { return munis.has(estado) ? [...munis.get(estado).values()] : []; },
    tieneEstado(estado) { return estados.has(estado); },
  };
}

/**
 * Tabla ordenable.
 * columnas: [{clave, titulo, num?, formato?(valor, fila)}]
 * opciones: {seleccion?: Set, idFila?(fila), bloqueada?(fila), alCambiar?(), claseFila?(fila), vacio?}
 */
export function tabla(columnas, opciones = {}) {
  let filas = [];
  let orden = { clave: null, asc: true };
  const thead = h("thead");
  const tbody = h("tbody");
  const el = h("div", { class: "tabla-caja" }, h("table", { class: "tabla" }, thead, tbody));
  const sel = opciones.seleccion;
  const id = opciones.idFila || ((f) => f.id);
  const bloq = opciones.bloqueada || (() => false);

  function encabezado() {
    thead.replaceChildren(h("tr", {},
      sel ? h("th", { class: "chk", scope: "col", title: "Seleccionar / quitar visibles", onclick: alternarTodos }, "✓") : null,
      ...columnas.map((c) => h("th", {
        class: c.num ? "num" : "",
        scope: "col",
        "aria-sort": orden.clave === c.clave ? (orden.asc ? "ascending" : "descending") : null,
        onclick: () => { orden = { clave: c.clave, asc: orden.clave === c.clave ? !orden.asc : true }; dibujar(); },
      }, c.titulo + (orden.clave === c.clave ? (orden.asc ? " ▲" : " ▼") : "")))));
  }

  function alternarTodos() {
    const libres = filas.filter((f) => !bloq(f));
    const todas = libres.length && libres.every((f) => sel.has(id(f)));
    libres.forEach((f) => (todas ? sel.delete(id(f)) : sel.add(id(f))));
    dibujar(); opciones.alCambiar?.();
  }

  function dibujar() {
    encabezado();
    let datos = filas;
    if (orden.clave) {
      const k = orden.clave, m = orden.asc ? 1 : -1;
      datos = [...filas].sort((a, b) => {
        const x = a[k], y = b[k];
        if (typeof x === "number" || typeof y === "number") return ((x ?? -Infinity) - (y ?? -Infinity)) * m;
        return String(x ?? "").localeCompare(String(y ?? ""), "es") * m;
      });
    }
    if (!datos.length) {
      tbody.replaceChildren(h("tr", {}, h("td", { class: "vacio", colSpan: columnas.length + (sel ? 1 : 0) },
        opciones.vacio || "Sin registros")));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const f of datos) {
      const clave = id(f), b = bloq(f), marcada = sel?.has(clave);
      const tr = h("tr", { class: [b ? "bloq" : "", marcada ? "sel" : "", opciones.claseFila?.(f) || ""].join(" "),
                           "data-id": String(clave) },
        sel ? h("td", { class: "chk" }, b ? "—" : (marcada ? "☑" : "☐")) : null,
        ...columnas.map((c) => {
          const v = c.formato ? c.formato(f[c.clave], f) : f[c.clave];
          return h("td", { class: c.num ? "num" : "", title: typeof v === "string" && v.length > 28 ? v : null },
            v instanceof Node ? v : (v ?? ""));
        }));
      if (sel && !b) {
        tr.addEventListener("click", (e) => {
          if (e.target.closest("button,a,input,select")) return;
          sel.has(clave) ? sel.delete(clave) : sel.add(clave);
          const ahora = sel.has(clave);
          tr.classList.toggle("sel", ahora);
          tr.firstChild.textContent = ahora ? "☑" : "☐";
          opciones.alCambiar?.();
        });
      }
      frag.append(tr);
    }
    tbody.replaceChildren(frag);
  }

  return {
    el,
    setFilas(nuevas) { filas = nuevas || []; dibujar(); },
    setColumnas(nuevas) { columnas = nuevas; orden = { clave: null, asc: true }; dibujar(); },
    redibujar: dibujar,
    verSeleccion() { el.querySelector("tr.sel")?.scrollIntoView({ block: "center" }); },
    get filas() { return filas; },
    /** fila (objeto) a partir de un <tr> pintado */
    filaDe(tr) { const k = tr?.dataset?.id; return filas.find((f) => String(id(f)) === k); },
  };
}

// ---------- Llamadas a funciones de la base ----------
/**
 * Llama una función de Supabase y junta TODAS sus filas. La API regresa como máximo 1,000 filas por
 * llamada (max_rows); si la función regresa justo ese tope se piden las páginas siguientes.
 * Así no se cortan el catálogo geográfico, la búsqueda de créditos ni el Funnel.
 */
export async function rpcPaginado(cliente, funcion, args = {}, traducir = (m) => m) {
  const { data, error } = await cliente.rpc(funcion, args);
  if (error) throw new Error(traducir(error.message));
  if (!Array.isArray(data) || data.length < 1000 || data.length % 1000) return data;
  const pagina = data.length, todo = [...data];
  for (let desde = pagina; ; desde += pagina) {
    const r = await cliente.rpc(funcion, args).range(desde, desde + pagina - 1);
    if (r.error) throw new Error(traducir(r.error.message));
    todo.push(...r.data);
    if (r.data.length < pagina) return todo;
  }
}
