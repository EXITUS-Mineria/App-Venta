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
function leerEscala() { try { return Number(localStorage.getItem("vc_escala")) || 1; } catch { return 1; } }
function ponerEscala(e) {
  document.documentElement.style.setProperty("--escala", e);
  try { localStorage.setItem("vc_escala", e); } catch { /* sin almacenamiento */ }
}
ponerEscala(leerEscala());
function cambiarEscala(paso) {
  const actual = leerEscala();
  const i = ESCALAS.reduce((m, e, k) => (Math.abs(e - actual) < Math.abs(ESCALAS[m] - actual) ? k : m), 0);
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

async function rpc(funcion, args = {}) {
  const { data, error } = await sb.rpc(funcion, args);
  if (error) throw new Error(traducir(error.message));
  return data;
}

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
  const resp = await fetch(new URL("../modulos/modulos.json", import.meta.url), { cache: "no-store" });
  const lista = (await resp.json()).modulos.filter((m) => m.activo !== false);
  const cargados = [];
  for (const m of lista) {
    try {
      const mod = (await import(new URL(`../modulos/${m.archivo}`, import.meta.url))).default;
      const roles = mod.roles || ["vendedor", "admin"];
      if (MAESTROS.includes(perfil.rol) || roles.includes(perfil.rol)) cargados.push({ ...mod, id: mod.id || m.id });
    } catch (e) {
      console.error("No se pudo cargar el módulo", m.archivo, e);
      ui.toast(`No se pudo cargar el módulo ${m.id}`, "mal");
    }
  }
  return cargados;
}

let moduloActual = null;
let relojAvisos = null;

export const ROLES = { vendedor: "Vendedor", validador: "Validador (maestro)", auxiliar: "Auxiliar de venta", admin: "Administrador" };
// Usuarios maestros: ven todos los módulos y pueden todo (incluye dar de alta usuarios)
const MAESTROS = ["admin", "validador"];

// ---------- Campana de notificaciones ----------
function campana() {
  const cuenta = h("span", { class: "campana-cuenta", hidden: true });
  const lista = h("div", { class: "campana-lista", hidden: true });
  const boton = h("button", { class: "btn-oscuro campana", title: "Avisos", onclick: (e) => { e.stopPropagation(); alternar(); } }, "🔔", cuenta);
  const el = h("div", { class: "campana-caja" }, boton, lista);
  let datos = [];

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
          lista.hidden = true;
          if (n.enlace) location.hash = `#/${n.enlace}`;
          refrescar();
        },
      }, h("b", {}, n.titulo), n.mensaje ? h("div", {}, n.mensaje) : null, h("small", {}, ui.fecha(n.creada))))
        : [h("div", { class: "campana-vacio" }, "Sin avisos")]));
  }
  function alternar() { lista.hidden = !lista.hidden; if (!lista.hidden) pintar(); }
  document.addEventListener("click", (e) => { if (!el.contains(e.target)) lista.hidden = true; });

  clearInterval(relojAvisos);
  relojAvisos = setInterval(refrescar, 60000);
  refrescar();
  return { el, refrescar };
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

  const avisos = campana();
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
    contenido.replaceChildren();
    avisos.refrescar();
    document.title = `${mod.titulo} · ${CONFIG.SISTEMA}`;
    Promise.resolve(mod.montar(contenido, ctx)).catch((e) => {
      console.error(e);
      contenido.replaceChildren(h("div", { class: "tarjeta" }, `Error en el módulo: ${e.message}`));
    });
  }

  for (const m of modulos) nav.append(h("a", { href: `#/${m.id}`, "data-id": m.id }, `${m.icono || ""} ${m.titulo}`));

  app.replaceChildren(
    h("header", { class: "enc" },
      h("div", { class: "marca" }, h("b", {}, `💼 ${CONFIG.SISTEMA}`), h("span", {}, CONFIG.EMPRESA)),
      nav,
      h("div", { class: "derecha" },
        avisos.el,
        h("button", { class: "btn-oscuro", title: "Letra más chica", onclick: () => cambiarEscala(-1) }, "A−"),
        h("button", { class: "btn-oscuro", title: "Letra más grande", onclick: () => cambiarEscala(1) }, "A+"),
        h("div", { class: "usuario" }, h("b", {}, `👤 ${perfil.nombre || perfil.email}`),
          h("span", {}, ROLES[perfil.rol] || perfil.rol)),
        h("button", { class: "btn-oscuro", onclick: async () => { clearInterval(relojAvisos); await sb.auth.signOut(); location.hash = ""; pantallaLogin(); } }, "Salir"))),
    contenido);

  window.onhashchange = mostrar;
  mostrar();
}

sb.auth.onAuthStateChange((evento) => {
  if (evento === "PASSWORD_RECOVERY") pantallaNuevaClave();
  if (evento === "SIGNED_OUT") pantallaLogin();
});

iniciar();
