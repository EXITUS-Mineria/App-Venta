-- ============================================================
-- DOCUMENTOS POR COMPRADOR
--  Los documentos del comprador (INE, constancia fiscal, comprobante de domicilio, formato de alta, NDA y
--  otros) se suben UNA vez y aplican a todas sus ventas; por venta sólo se sube el comprobante de pago.
--  El archivo se registra en la venta donde se subió (funnel_documentos), y se comparte con las demás
--  ventas del mismo comprador: catálogo (comprador_id) o, si no está en catálogo, el mismo nombre.
-- Requiere 23, 44, 45 (_clave_comprador). Idempotente.
-- ============================================================
drop function if exists public.comprador_documentos(text, text);
create or replace function public.comprador_documentos(p_folio text, p_tipo text default null)
returns table (id bigint, folio text, tipo text, nombre text, ruta text, mime text, bytes integer, subido_por text, fecha timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare k text;
begin
    perform public._exigir_activo();
    select public._clave_comprador(coalesce(f.comprador_id, public._comprador_de(f.comprador)), f.comprador) into k
      from public.funnel_ventas f where f.folio = p_folio;
    return query
    select d.id, d.folio, d.tipo, d.nombre, d.ruta, d.mime, d.bytes::integer, d.subido_por, d.fecha
      from public.funnel_documentos d
      join public.funnel_ventas v on v.folio = d.folio
     where d.tipo <> 'comprobante_pago'
       and (p_tipo is null or d.tipo = p_tipo)
       and (d.folio = p_folio
            or (k is not null and k <> 'N:' and public._clave_comprador(coalesce(v.comprador_id, public._comprador_de(v.comprador)), v.comprador) = k))
     order by d.fecha;
end $$;
revoke all on function public.comprador_documentos(text, text) from public, anon;
grant execute on function public.comprador_documentos(text, text) to authenticated;
