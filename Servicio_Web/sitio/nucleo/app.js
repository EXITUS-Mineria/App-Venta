// ============================================================
// NÚCLEO del sitio: login, perfil, menú y carga de módulos.
// Para agregar funcionalidades NO se edita este archivo:
//   1. crea una carpeta en sitio/modulos/ con tu módulo (ver modulos/_plantilla)
//   2. agrégalo a sitio/modulos/modulos.json
// ============================================================
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { CONFIG } from "../config.js";
import * as ui from "./ui.js";

const { h } = ui;
const app = document.getElementById("app");

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ---------- tamaño de letra (A− / A+) ----------
const ESCALAS = [0.9, 1, 1.1, 1.2, 1.35, 1.5];
const leerEscala = () => { try { return Number(localStorage.getItem("vc_escala")) || 1; } catch { return 1; } };
const ponerEscala = (e) => {
  document.documentElement.style.setProperty("--escala", e);
  try { localStorage.setItem("vc_escala", e); } catch { /* sin almacenamiento */ }
};
ponerEscala(leerEscala());
function cambiarEscala(paso) {
  const actual = leerEscala();
  // ESCALAS está ordenado: se toma la posición más cercana y se avanza un paso.
  const i = ESCALAS.indexOf(ESCALAS.reduce((m, e) => (Math.abs(e - actual) < Math.abs(m - actual) ? e : m), ESCALAS[0]));
  ponerEscala(ESCALAS[Math.max(0, Math.min(ESCALAS.length - 1, i + paso))]);
}

// ---------- mensajes de error en español ----------
const TRADUCCIONES = [
  [/Invalid login credentials/i, "Correo o contraseña incorrectos."],
  [/Email not confirmed/i, "Tu correo aún no está confirmado. Revisa tu bandeja o pide ayuda al administrador."],
  [/Failed to fetch|NetworkError|Load failed/i, "No hay conexión con el servidor. Revisa tu internet."],
  [/JWT expired/i, "Tu sesión expiró. Vuelve a entrar."],
  [/rate limit/i, "Demasiados intentos. Espera un momento."],
];
export function traducir(msg) {
  for (const [re, t] of TRADUCCIONES) if (re.test(msg || "")) return t;
  return msg || "Error desconocido";
}

const rpc = (funcion, args = {}) => ui.rpcPaginado(sb, funcion, args, traducir);

// ---------- Login ----------
function pantallaLogin(mensaje = "") {
  const correo = h("input", { class: "campo", type: "email", autocomplete: "username", required: true });
  const clave = h("input", { class: "campo", type: "password", autocomplete: "current-password", required: true });
  const error = h("div", { class: "error" }, mensaje);
  const boton = h("button", { class: "btn btn-marca", type: "submit", style: { width: "100%", marginTop: "14px" } }, "Entrar");

  const form = h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      boton.disabled = true; error.textContent = "";
      const { error: err } = await sb.auth.signInWithPassword({ email: correo.value.trim(), password: clave.value });
      boton.disabled = false;
      if (err) error.textContent = traducir(err.message);
      else iniciar();
    },
  },
  h("label", { class: "etiqueta" }, "Correo"), correo,
  h("label", { class: "etiqueta" }, "Contraseña"), clave,
  boton, error,
  h("div", { style: { marginTop: "10px" } }, h("a", {
    onclick: async () => {
      if (!correo.value.trim()) { error.textContent = "Escribe tu correo y vuelve a dar clic."; return; }
      const { error: err } = await sb.auth.resetPasswordForEmail(correo.value.trim(), { redirectTo: location.origin });
      error.textContent = err ? traducir(err.message) : "Te enviamos un correo para cambiar tu contraseña.";
    },
  }, "¿Olvidaste tu contraseña?")));

  app.replaceChildren(h("div", { class: "login" }, h("div", { class: "caja" },
    h("header", {}, h("b", {}, `💼 ${CONFIG.SISTEMA}`), h("span", {}, CONFIG.EMPRESA)), form)));
  correo.focus();
}

async function pantallaNuevaClave() {
  const clave = await ui.pedirTexto("Nueva contraseña", "Escribe tu nueva contraseña (mínimo 8 caracteres).");
  if (!clave) return iniciar();
  const { error } = await sb.auth.updateUser({ password: clave });
  ui.toast(error ? traducir(error.message) : "Contraseña actualizada.", error ? "mal" : "bien");
  iniciar();
}

// ---------- Módulos ----------
async function cargarModulos(perfil) {
  // Compradores: sólo su portal (Inicio, Solicitar nueva compra, Mis propuestas, Mis compras)
  if (perfil.rol === "comprador") return (await import(new URL("../modulos/portal/portal.js", import.meta.url))).modulos;
  const resp = await fetch(new URL("../modulos/modulos.json", import.meta.url), { cache: "no-store" });
  const lista = (await resp.json()).modulos.filter((m) => m.activo !== false);
  // Se importan en paralelo (los módulos son independientes) y se conserva el orden del menú.
  const importados = await Promise.all(lista.map(async (m) => {
    try { return (await import(new URL(`../modulos/${m.archivo}`, import.meta.url))).default; }
    catch (e) {
      console.error("No se pudo cargar el módulo", m.archivo, e);
      ui.toast(`No se pudo cargar el módulo ${m.id}`, "mal");
      return null;
    }
  }));
  return importados
    .map((mod, i) => (mod ? { ...mod, id: mod.id || lista[i].id } : null))
    // rolesExactos: el módulo sólo lo ven los roles listados (los maestros no lo ven por ser maestros)
    .filter((mod) => mod && ((!mod.rolesExactos && MAESTROS.includes(perfil.rol)) || (mod.roles || ["vendedor", "admin"]).includes(perfil.rol)));
}

let moduloActual = null;
let avisosActual = null;    // campana montada de la sesión vigente
let cerrarCampana = null;   // cierra la lista de avisos al dar clic fuera (se reemplaza en cada sesión)

export const ROLES = { vendedor: "Vendedor", validador: "Validador (maestro)", auxiliar: "Auxiliar de venta", control_doc: "Control documental", admin: "Administrador", comprador: "Comprador" };
// Usuarios maestros: ven todos los módulos y pueden todo (incluye dar de alta usuarios)
const MAESTROS = ["admin", "validador"];

// ---------- Campana de notificaciones ----------
function campana() {
  const cuenta = h("span", { class: "campana-cuenta", hidden: true });
  const lista = h("div", { class: "campana-lista", hidden: true });
  const boton = h("button", { class: "btn-oscuro campana", title: "Avisos", "aria-label": "Avisos", "aria-expanded": "false", onclick: (e) => { e.stopPropagation(); alternar(); } }, "🔔", cuenta);
  const el = h("div", { class: "campana-caja" }, boton, lista);
  let datos = [];
  let reloj = null;   // propio de esta campana: no lo comparte otra sesión

  async function refrescar() {
    try { datos = (await rpc("mis_notificaciones", { p_limite: 30 })) || []; } catch { return; }
    const n = Number(datos[0]?.sin_leer || 0);
    cuenta.hidden = n === 0; cuenta.textContent = n > 99 ? "99+" : n;
    if (!lista.hidden) pintar();
  }
  function pintar() {
    lista.replaceChildren(
      h("div", { class: "campana-enc" }, h("b", {}, "Avisos"),
        h("a", { onclick: async () => { await rpc("marcar_notificaciones", { p_ids: null }).catch(() => {}); refrescar(); } }, "Marcar todo como leído")),
      ...(datos.length ? datos.map((n) => h("div", {
        class: `campana-item ${n.leida ? "" : "nueva"}`,
        onclick: async () => {
          if (!n.leida) await rpc("marcar_notificaciones", { p_ids: [n.id] }).catch(() => {});
          ocultar();
          if (n.enlace) location.hash = `#/${n.enlace.replace(/^#\//, "")}`;
          refrescar();
        },
      }, h("b", {}, n.titulo), n.mensaje ? h("div", {}, n.mensaje) : null, h("small", {}, ui.fecha(n.creada))))
        : [h("div", { class: "campana-vacio" }, "Sin avisos")]));
  }
  function ocultar() { lista.hidden = true; boton.setAttribute("aria-expanded", "false"); }
  function alternar() {
    lista.hidden = !lista.hidden;
    boton.setAttribute("aria-expanded", String(!lista.hidden));
    if (!lista.hidden) pintar();
  }
  // Un solo listener por sesión: se retira el anterior para no acumular cierres al reentrar.
  if (cerrarCampana) document.removeEventListener("click", cerrarCampana);
  cerrarCampana = (e) => { if (!el.contains(e.target)) ocultar(); };
  document.addEventListener("click", cerrarCampana);

  reloj = setInterval(refrescar, 60000);
  refrescar();
  return {
    el, refrescar,
    desmontar() {
      clearInterval(reloj);
      if (cerrarCampana) document.removeEventListener("click", cerrarCampana);
      cerrarCampana = null;
    },
  };
}

/** Cierra la campana de la sesión anterior (timer + listener) al salir del sistema. */
function cerrarSesion() {
  avisosActual?.desmontar();
  avisosActual = null;
  window.onhashchange = null;
}

async function iniciar() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return pantallaLogin();

  let perfil;
  try {
    perfil = await rpc("mi_perfil");
  } catch (e) {
    return pantallaLogin(e.message);
  }
  if (!perfil || !perfil.activo) {
    await sb.auth.signOut();
    return pantallaLogin("Tu usuario no tiene acceso. Pide a un administrador que te dé de alta.");
  }
  perfil.user_id = session.user.id;

  const modulos = await cargarModulos(perfil);
  const contenido = h("main", { class: "contenido" });
  const nav = h("nav");

  cerrarSesion();
  const avisos = campana();
  avisosActual = avisos;
  const ctx = {
    sb, rpc, ui, perfil, config: CONFIG,
    esAdmin: MAESTROS.includes(perfil.rol),
    tieneRol: (...roles) => MAESTROS.includes(perfil.rol) || roles.includes(perfil.rol),
    refrescarAvisos: () => avisos.refrescar(),
    ir: (id) => { location.hash = `#/${id}`; },
  };

  function mostrar() {
    const id = (location.hash.match(/^#\/([\w-]+)/) || [])[1] || modulos[0]?.id;
    const mod = modulos.find((m) => m.id === id) || modulos[0];
    if (!mod) { contenido.replaceChildren(h("p", {}, "No hay módulos disponibles para tu usuario.")); return; }
    try { moduloActual?.desmontar?.(); } catch { /* ignorar */ }
    moduloActual = mod;
    nav.querySelectorAll("a").forEach((a) => a.classList.toggle("activo", a.dataset.id === mod.id));
    // Cada pantalla se monta en su propia caja: si un módulo anterior termina de cargar tarde,
    // lo que agregue cae en su caja vieja (ya fuera de la página) y no se mezcla con la nueva.
    const caja = h("div", { class: "modulo-caja" });
    contenido.replaceChildren(caja);
    avisos.refrescar();
    document.title = `${mod.titulo} · ${CONFIG.SISTEMA}`;
    Promise.resolve(mod.montar(caja, ctx)).catch((e) => {
      console.error(e);
      if (caja.isConnected) caja.replaceChildren(h("div", { class: "tarjeta" }, `Error en el módulo: ${e.message}`));
    });
  }

  for (const m of modulos) nav.append(h("a", { href: `#/${m.id}`, "data-id": m.id }, `${m.icono || ""} ${m.titulo}`));

  app.replaceChildren(
    h("header", { class: "enc" },
      h("div", { class: "marca" }, h("b", {}, perfil.rol === "comprador" ? "💼 Portal de compradores" : `💼 ${CONFIG.SISTEMA}`),
        h("span", {}, CONFIG.EMPRESA)),
      nav,
      h("div", { class: "derecha" },
        avisos.el,
        h("button", { class: "btn-oscuro", title: "Letra más chica", "aria-label": "Disminuir tamaño de letra", onclick: () => cambiarEscala(-1) }, "A−"),
        h("button", { class: "btn-oscuro", title: "Letra más grande", "aria-label": "Aumentar tamaño de letra", onclick: () => cambiarEscala(1) }, "A+"),
        h("div", { class: "usuario" }, h("b", {}, `👤 ${perfil.nombre || perfil.email}`),
          h("span", {}, ROLES[perfil.rol] || perfil.rol)),
        h("button", { class: "btn-oscuro", onclick: async () => { cerrarSesion(); await sb.auth.signOut(); location.hash = ""; pantallaLogin(); } }, "Salir"))),
    contenido);

  window.onhashchange = mostrar;
  mostrar();
}

sb.auth.onAuthStateChange((evento) => {
  if (evento === "PASSWORD_RECOVERY") { cerrarSesion(); pantallaNuevaClave(); }
  if (evento === "SIGNED_OUT") { cerrarSesion(); pantallaLogin(); }
});

iniciar();
