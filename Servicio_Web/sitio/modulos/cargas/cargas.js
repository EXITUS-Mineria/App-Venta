// ============================================================
// MÓDULO: Bases cargadas (sólo administradores)
// Las bases se suben con cargar_supabase.py (fuera del sitio).
// ============================================================
export default {
  id: "cargas",
  titulo: "Bases",
  icono: "🗂️",
  roles: ["admin"],

  async montar(cont, ctx) {
    const { h, tabla, numero, fecha, toast } = ctx.ui;
    const t = tabla([
      { clave: "cartera", titulo: "Cartera" },
      { clave: "archivo", titulo: "Archivo" },
      { clave: "filas", titulo: "Filas", num: true, formato: (v) => numero(v) },
      { clave: "usuario", titulo: "Cargó" },
      { clave: "cargado", titulo: "Fecha", formato: (v) => fecha(v) },
    ], { vacio: "Aún no se han cargado bases" });

    cont.append(h("div", { class: "tarjeta" },
      h("h3", {}, "🗂️ Bases cargadas"),
      h("p", { class: "nota", style: { fontSize: ".85rem" } },
        "Para actualizar la cartera del mes corre cargar_supabase.py con Base JyP.csv y Base Grupal.csv. ",
        "Los apartados vigentes se conservan."),
      t.el));

    const { data, error } = await ctx.sb.from("cargas").select("cartera, archivo, filas, usuario, cargado").order("cargado", { ascending: false }).limit(50);
    if (error) toast(error.message, "mal");
    t.setFilas(data || []);
  },
};
