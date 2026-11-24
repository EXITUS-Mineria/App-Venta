// Layout para Funnel (mismo formato que la app de escritorio), en Latin-1.
const META = [
  "IdPropuesta", "UsuarioWindows", "EquipoWindows", "FechaPropuesta", "CapitalObjetivo",
  "CentavosPorPeso", "CapitalSeleccionadoPropuesta", "ValorVentaPropuesta",
  "DiasPromedioMoraPropuesta", "EstatusPropuesta", "Comprador",
];

/** Arma la base final (layout Funnel) sin descargarla: { nombre, columnas, filas }. */
export async function armarLayout(ctx, propuesta) {
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
    Comprador: propuesta.comprador || "",
  }));
  // Nombre con la nomenclatura de la venta y el comprador: VTA-0300_Comprador_BaseFinal.csv
  return { nombre: nombreArchivo(propuesta, "BaseFinal"), columnas: todas, filas: salida };
}

export async function descargarLayout(ctx, propuesta) {
  const { nombre, columnas, filas } = await armarLayout(ctx, propuesta);
  ctx.ui.descargarCSV(nombre, columnas, filas, "latin1");
  return filas.length;
}

/** Nombre de archivo con folio y comprador: VTA-0301_Jonathan_Caballero_Propuesta.csv */
export function nombreArchivo(p, sufijo) {
  const comp = (p.comprador || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return `${p.id_propuesta}${comp ? `_${comp}` : ""}_${sufijo}.csv`;
}

/** CSV de la propuesta (un renglón por crédito), generado al momento, con nombre, saldos y fechas. */
export async function descargarPropuestaCSV(ctx, p) {
  const filas = await ctx.rpc("propuesta_descarga", { p_id: p.id_propuesta });
  if (!filas?.length) throw new Error("La propuesta no tiene créditos.");
  const cols = ["IdPropuesta", "Estatus", "Vendedor", "Comprador", "TipoCartera", "vGroupId", "NombreGrupo", "vReference", "NombreCliente",
    "Estado", "Municipio", "Colonia", "CP", "DiasMora", "Capital", "MontoOriginal", "SaldoTotal", "SaldoVencido",
    "FechaApertura", "UltimoPago", "Frecuencia"];
  ctx.ui.descargarCSV(nombreArchivo(p, "Propuesta"), cols, filas.map((f) => ({
    IdPropuesta: p.id_propuesta, Estatus: p.estatus, Vendedor: p.usuario, Comprador: p.comprador || "", TipoCartera: f.tipo,
    vGroupId: f.vgroupid || "", NombreGrupo: f.grupo || "", vReference: f.vreference, NombreCliente: f.nombre || "",
    Estado: f.estado, Municipio: f.municipio, Colonia: f.colonia || "", CP: f.cp || "", DiasMora: f.dias, Capital: f.capital,
    MontoOriginal: f.monto_original ?? "", SaldoTotal: f.saldo_total ?? "", SaldoVencido: f.saldo_vencido ?? "",
    FechaApertura: f.fecha_apertura || "", UltimoPago: f.ultimo_pago || "", Frecuencia: f.frecuencia || "" })));
  return filas.length;
}

/** Revisión: sólo las referencias, para preguntar si siguen disponibles para venta. */
export async function descargarCuentasRevision(ctx, p) {
  const filas = await ctx.rpc("creditos_propuesta", { p_id: p.id_propuesta });
  if (!filas?.length) throw new Error("La propuesta no tiene créditos.");
  const cols = ["IdPropuesta", "Comprador", "TipoCartera", "vReference", "vGroupId", "Capital"];
  ctx.ui.descargarCSV(nombreArchivo(p, "Cuentas_Revision"), cols, filas.map((f) => ({
    IdPropuesta: p.id_propuesta, Comprador: p.comprador || "", TipoCartera: f.tipo, vReference: f.vreference,
    vGroupId: f.vgroupid || "", Capital: f.capital })));
  return filas.length;
}
