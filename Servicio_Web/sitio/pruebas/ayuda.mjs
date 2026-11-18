// Entorno DOM para las pruebas (jsdom) + utilidades de espionaje.
// Importa este módulo ANTES que los módulos del sitio: sus efectos
// (window/document/...) se ejecutan al evaluarse y quedan disponibles.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://pruebas.test/",
  pretendToBeVisual: true,
});
const { window } = dom;

for (const clave of ["window", "document", "HTMLElement", "Node", "DocumentFragment", "Event", "CustomEvent", "CSS", "getComputedStyle"]) {
  if (window[clave] !== undefined) {
    Object.defineProperty(globalThis, clave, { value: window[clave], configurable: true, writable: true });
  }
}
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
Object.defineProperty(globalThis, "location", { value: window.location, configurable: true });

// jsdom no implementa navegación ni object URLs: se sustituyen para poder
// inspeccionar las descargas sin salir del proceso de pruebas.
let ultimoBlob = null;
URL.createObjectURL = (blob) => { ultimoBlob = blob; return "blob:pruebas"; };
URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { /* sin navegación */ };

export const blobCapturado = () => ultimoBlob;
export const limpiarBlob = () => { ultimoBlob = null; };
export { window };

/** Espera a que se vacíe la cola de microtareas/timers pendientes. */
export const esperar = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * ctx realista para montar módulos: usa el kit de interfaz de verdad (nucleo/ui.js)
 * y un cliente Supabase falso cuyas respuestas se definen por prueba.
 */
export async function ctxMontaje(over = {}) {
  const ui = await import("../nucleo/ui.js");
  const llamadas = { rpc: [], from: [] };
  const respuestas = over.rpc || (() => null);
  const filas = over.filas || (() => []);
  const ctx = {
    llamadas, ui,
    rpc: async (fn, args) => { llamadas.rpc.push([fn, args]); return respuestas(fn, args); },
    sb: {
      from(tabla) {
        llamadas.from.push(tabla);
        const cadena = {
          select: () => cadena, eq: () => cadena, in: () => cadena, neq: () => cadena, or: () => cadena,
          order: () => cadena, limit: () => cadena,
          maybeSingle: async () => ({ data: filas(tabla)?.[0] ?? null, error: null }),
          single: async () => ({ data: filas(tabla)?.[0] ?? null, error: null }),
          then: (ok) => Promise.resolve({ data: filas(tabla), error: null }).then(ok),
        };
        return cadena;
      },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://x" }, error: null }) }) },
      auth: { getSession: async () => ({ data: { session: null } }) },
      functions: { invoke: async () => ({ data: null, error: null }) },
    },
    perfil: { email: "x@y.z", nombre: "Prueba", rol: "vendedor", user_id: "u1", ...(over.perfil || {}) },
    config: {},
    esAdmin: !!over.esAdmin,
    tieneRol: over.tieneRol || (() => false),
    refrescarAvisos: () => {},
    ir: () => {},
  };
  return ctx;
}
