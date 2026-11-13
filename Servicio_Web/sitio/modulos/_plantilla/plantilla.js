// ============================================================
// PLANTILLA DE MÓDULO
// 1. Copia esta carpeta: modulos/_plantilla -> modulos/mi_modulo
// 2. Cambia id, titulo, icono y roles.
// 3. Agrega en modulos/modulos.json:
//      { "id": "mi_modulo", "archivo": "mi_modulo/plantilla.js", "activo": true }
// 4. Si necesitas tablas o funciones SQL, crea supabase/modulos/20_mi_modulo.sql
//    y córrelo con cargar_supabase.py (opción 1). No edites otros módulos.
//
// ctx trae:
//   ctx.sb        cliente de Supabase (consultas: ctx.sb.from("tabla").select())
//   ctx.rpc(f,a)  llama una función SQL y devuelve los datos (lanza Error en español)
//   ctx.ui        h, tabla, kpi, toast, confirmar, pedirTexto, avisar, dinero, numero,
//                 dias, fecha, descargarCSV, cargarCSS
//   ctx.perfil    { email, nombre, rol, user_id }    ctx.esAdmin  true/false
//   ctx.tieneRol("validador", ...)  true si el usuario tiene ese rol (admin siempre)
//   ctx.refrescarAvisos()  actualiza la campana. Para avisar desde SQL:
//     perform public._notificar(array['auxiliar'], null, 'Título', 'Mensaje', 'id_modulo');
//   Roles: vendedor, validador, auxiliar, admin (admin ve todos los módulos)
//   ctx.ir("id")  cambia de módulo
// ============================================================
export default {
  id: "ejemplo",
  titulo: "Ejemplo",
  icono: "🧩",
  roles: ["admin"],            // p. ej. ["vendedor", "validador", "auxiliar"] para todos

  async montar(cont, ctx) {
    const { h, kpi, toast } = ctx.ui;
    const k = kpi("Propuestas vigentes");
    cont.append(h("div", { class: "kpis" }, k.el));
    const { count, error } = await ctx.sb.from("propuestas").select("*", { count: "exact", head: true }).neq("estatus", "LIBERADA");
    if (error) toast(error.message, "mal");
    k.set(String(count ?? 0), `Hola ${ctx.perfil.nombre}`);
  },

  desmontar() {
    // opcional: limpiar temporizadores, etc.
  },
};
