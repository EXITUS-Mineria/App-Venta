// ============================================================
// Edge Function: enviar-propuesta
//   accion "avisar"    → avisa por correo a los usuarios del portal del comprador que tienen una propuesta
//                        publicada (sólo la liga al portal, SIN archivo). Es la que usa la página.
//   accion "descargar" → regresa el Excel de la propuesta (uso interno; no se guarda en ningún lado)
//   accion "enviar"    → (anterior) manda el Excel por correo y registra el envío
// Permisos: los valida la base con la sesión del usuario (vendedor dueño, auxiliar o maestros).
// Secretos (Supabase › Edge Functions › Secrets), los da TI:
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET  (registro de app en Azure con permiso Mail.Send de aplicación)
//   MS_REMITENTE                                   (buzón que envía, p. ej. ventas.cartera@exitus...)
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import * as XLSX from "npm:xlsx@0.18.5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const dinero = (n: number) => n.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
const CORREO = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function armarExcel(folio: string, comprador: string, filas: any[]) {
  const enc = ["vReference", "vGroupId", "Días de atraso", "Capital", "Colonia", "C.P.", "Municipio", "Estado"];
  const total = filas.reduce((s, f) => s + Number(f.capital || 0), 0);
  const aoa: any[][] = [
    [`Propuesta ${folio}`], [`Comprador: ${comprador || ""}`],
    [`Créditos: ${filas.length}`, "", "", `Capital total: ${dinero(total)}`], [],
    enc,
    ...filas.map((f) => [f.vreference, f.vgroupid || "", f.dias == null ? "" : Number(f.dias), Number(f.capital || 0),
      f.colonia || "", f.cp || "", f.municipio || "", f.estado || ""]),
    ["TOTAL", "", "", Math.round(total * 100) / 100],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [16, 12, 14, 14, 26, 9, 24, 18].map((w) => ({ wch: w }));
  ws["!autofilter"] = { ref: `A5:H${5 + filas.length}` };
  for (let r = 6; r <= 6 + filas.length; r++) { const c = ws[`D${r}`]; if (c) c.z = "$#,##0.00"; }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Propuesta");
  return { base64: XLSX.write(wb, { type: "base64", bookType: "xlsx" }) as string, total: Math.round(total * 100) / 100 };
}

async function tokenGraph() {
  const t = Deno.env.get("MS_TENANT_ID"), id = Deno.env.get("MS_CLIENT_ID"), sec = Deno.env.get("MS_CLIENT_SECRET");
  if (!t || !id || !sec || !Deno.env.get("MS_REMITENTE")) return null;
  const r = await fetch(`https://login.microsoftonline.com/${t}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: sec, scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials" }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Microsoft 365 no dio acceso: ${d.error_description || d.error || r.status}`);
  return d.access_token as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization") || "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { accion = "descargar", folio, correo = "", cc = "", mensaje = "", sitio = "" } = await req.json();
    if (!folio) return json({ error: "Falta el folio" }, 400);

    if (accion === "avisar") {
      const { data: dest, error: e0 } = await sb.rpc("funnel_aviso_portal", { p_folio: folio });
      if (e0) return json({ error: e0.message }, 403);
      if (!dest?.length) return json({ ok: true, para: [] });
      const token = await tokenGraph();
      if (!token) return json({ error: "El aviso por correo aún no está configurado (faltan los datos de Microsoft 365 en Supabase).", sin_configurar: true }, 503);
      const liga = /^https:\/\/[\w.-]+(:\d+)?$/.test(String(sitio)) ? `${sitio}/#/propuestas` : "";
      const yo = { nombre: dest[0].vendedor_nombre, email: dest[0].vendedor_correo };
      const firma = yo.nombre || yo.email || "Exitus Credit";
      const para = [...new Set(dest.map((d: any) => d.correo))];
      const cuerpo = `<p>Buen día${dest[0].comprador ? ` ${esc(dest[0].comprador)}` : ""}:</p>` +
        `<p>Tienes una nueva propuesta de cartera (<b>${esc(folio)}</b>) para revisar en tu portal de compradores.</p>` +
        (liga ? `<p><a href="${esc(liga)}">Abrir mi portal</a></p>` : "") +
        `<p>Ahí puedes ver el detalle de los créditos y aceptarla o rechazarla.</p><p>Saludos,<br>${esc(firma)}<br>Exitus Credit</p>`;
      const remitente = Deno.env.get("MS_REMITENTE")!;
      const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(remitente)}/sendMail`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject: `Nueva propuesta de cartera ${folio}`,
            body: { contentType: "HTML", content: cuerpo },
            toRecipients: para.map((a) => ({ emailAddress: { address: a } })),
            replyTo: yo.email ? [{ emailAddress: { address: yo.email, name: firma } }] : [],
          },
          saveToSentItems: true,
        }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); return json({ error: `No se pudo enviar: ${d?.error?.message || r.status}` }, 502); }
      return json({ ok: true, para });
    }

    const { data: filas, error } = await sb.rpc("propuesta_para_comprador", { p_folio: folio });
    if (error) return json({ error: error.message }, 403);
    if (!filas?.length) return json({ error: `${folio} no tiene créditos` }, 400);
    const comprador = filas[0].comprador || "";
    const { base64, total } = armarExcel(folio, comprador, filas);
    const archivo = `${folio}_Propuesta.xlsx`;
    if (accion === "descargar") return json({ archivo, base64, registros: filas.length });

    const para = String(correo).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    const copia = String(cc).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    if (!para.length || [...para, ...copia].some((c) => !CORREO.test(c))) return json({ error: "Revisa el correo del comprador" }, 400);

    const token = await tokenGraph();
    if (!token) return json({ error: "El envío de correo aún no está configurado (faltan los datos de Microsoft 365 en Supabase). " +
      "Mientras, usa «⬇ Excel» y mándalo desde tu Outlook.", sin_configurar: true }, 503);

    const yo = { nombre: filas[0].vendedor_nombre, email: filas[0].vendedor_correo };
    const firma = yo.nombre || yo.email || "Exitus Credit";
    const cuerpo = `<p>Buen día${comprador ? ` ${esc(comprador)}` : ""}:</p>` +
      (mensaje ? `<p>${esc(String(mensaje)).replace(/\n/g, "<br>")}</p>` : "<p>Le compartimos la propuesta de cartera para su revisión.</p>") +
      `<p><b>Propuesta ${esc(folio)}</b> · ${filas.length} créditos · capital ${dinero(total)}.<br>El detalle va en el archivo adjunto.</p>` +
      `<p>Saludos,<br>${esc(firma)}<br>Exitus Credit</p>`;
    const remitente = Deno.env.get("MS_REMITENTE")!;
    const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(remitente)}/sendMail`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: `Propuesta de cartera ${folio}${comprador ? ` · ${comprador}` : ""}`,
          body: { contentType: "HTML", content: cuerpo },
          toRecipients: para.map((a) => ({ emailAddress: { address: a } })),
          ccRecipients: copia.map((a) => ({ emailAddress: { address: a } })),
          replyTo: yo.email ? [{ emailAddress: { address: yo.email, name: firma } }] : [],
          attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment", name: archivo,
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", contentBytes: base64 }],
        },
        saveToSentItems: true,
      }),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); return json({ error: `No se pudo enviar: ${d?.error?.message || r.status}` }, 502); }

    const { error: e2 } = await sb.rpc("funnel_registrar_envio", { p_folio: folio, p_correo: para.join("; ") });
    return json({ ok: true, para, registros: filas.length, aviso: e2?.message || null });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
