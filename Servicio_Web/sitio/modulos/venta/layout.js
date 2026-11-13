// Layout para Funnel (mismo formato que la app de escritorio), en Latin-1.
const META = [
  "IdPropuesta", "UsuarioWindows", "EquipoWindows", "FechaPropuesta", "CapitalObjetivo",
  "CentavosPorPeso", "CapitalSeleccionadoPropuesta", "ValorVentaPropuesta",
  "DiasPromedioMoraPropuesta", "EstatusPropuesta",
];

export async function descargarLayout(ctx, propuesta) {
  const filas = await ctx.rpc("layout_propuesta", { p_id: propuesta.id_propuesta });
  if (!filas?.length) throw new Error("La propuesta no tiene detalle.");

  // columnas en el orden original de cada base (primero JyP, luego Grupal)
  const columnas = [];
  for (const tipo of ["JyP", "Grupal"]) {
    const f = filas.find((x) => x.tipo_cartera === tipo);
    for (const c of f?.columnas || Object.keys(f?.datos || {})) if (!columnas.includes(c)) columnas.push(c);
  }
  if (!columnas.includes("TipoCartera")) columnas.push("TipoCartera");
  const todas = [...columnas, ...META];

  const fechaLocal = new Date(propuesta.fecha).toLocaleString("sv-SE", { timeZone: "America/Mexico_City" });
  const salida = filas.map((f) => ({
    ...f.datos,
    Estatus: "Propuesta/Venta",
    TipoCartera: f.tipo_cartera,
    IdPropuesta: propuesta.id_propuesta,
    UsuarioWindows: propuesta.usuario,
    EquipoWindows: "Web",
    FechaPropuesta: fechaLocal,
    CapitalObjetivo: propuesta.capital_objetivo,
    CentavosPorPeso: propuesta.centavos,
    CapitalSeleccionadoPropuesta: propuesta.capital,
    ValorVentaPropuesta: propuesta.valor_venta,
    DiasPromedioMoraPropuesta: propuesta.dias_mora,
    EstatusPropuesta: propuesta.estatus || "APARTADA",
  }));
  ctx.ui.descargarCSV(`${propuesta.id_propuesta}.csv`, todas, salida, "latin1");
  return salida.length;
}
