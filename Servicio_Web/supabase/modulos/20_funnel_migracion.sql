-- ============================================================
-- FUNNEL · campos para la migración desde la lista SharePoint "VENTAS DE CARTERA"
--  - mes (como venía en la lista), ligas_desc (texto de cada liga), adjuntos (ligas a los
--    archivos adjuntos en SharePoint; NO se copian archivos para no ocupar almacenamiento).
-- Requiere 19. Idempotente.
-- ============================================================
alter table public.funnel_ventas add column if not exists mes        text;
alter table public.funnel_ventas add column if not exists ligas_desc jsonb;
alter table public.funnel_ventas add column if not exists adjuntos   jsonb;
alter table public.funnel_ventas add column if not exists sp_id      integer;

drop function if exists public.funnel_lista();
create or replace function public.funnel_lista()
returns table (folio text, id_propuesta text, comprador text, capital numeric, monto_venta numeric, estado text,
               municipios text, tipo text, estatus_venta text, fecha_propuesta date, fecha_venta date, vendedor text,
               estatus_md text, fecha_inicio_md date, fecha_limite_md date, base_completa_venta text,
               estatus_control_doc text, fecha_inicio_admin date, fecha_limite_admin date, estatus_juridico text,
               estatus_final text, base_final text, propuesta_url text, comprobante_pago text,
               fecha_ticket_contrato date, numero_ticket_contrato text, numero_guia text, origen text,
               actualizado timestamptz, actualizado_por text, estatus_propuesta text, es_mia boolean,
               mes text, ligas_desc jsonb, adjuntos jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    with geo as (
        select d.id_propuesta,
               string_agg(distinct initcap(lower(coalesce(j.estado, g.estado))), ', ') estados,
               string_agg(distinct coalesce(j.municipio, g.municipio), ', ') munis
          from public.propuesta_detalle d
          left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
          left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
         where d.id_propuesta in (select f.id_propuesta from public.funnel_ventas f where f.id_propuesta is not null)
         group by d.id_propuesta
    )
    select f.folio, f.id_propuesta, f.comprador, f.capital, f.monto_venta,
           coalesce(nullif(f.estado, ''), geo.estados), coalesce(nullif(f.municipios, ''), left(geo.munis, 300)),
           f.tipo, f.estatus_venta, f.fecha_propuesta, f.fecha_venta, f.vendedor,
           f.estatus_md, f.fecha_inicio_md, f.fecha_limite_md, f.base_completa_venta,
           f.estatus_control_doc, f.fecha_inicio_admin, f.fecha_limite_admin, f.estatus_juridico,
           f.estatus_final, f.base_final, f.propuesta_url, f.comprobante_pago,
           f.fecha_ticket_contrato, f.numero_ticket_contrato, f.numero_guia, f.origen,
           f.actualizado, f.actualizado_por, p.estatus, (p.user_id = auth.uid()),
           f.mes, f.ligas_desc, f.adjuntos
      from public.funnel_ventas f
      left join public.propuestas p on p.id_propuesta = f.id_propuesta
      left join geo on geo.id_propuesta = f.id_propuesta
     order by coalesce(f.fecha_venta, f.fecha_propuesta) desc nulls last, f.folio desc;
end $$;
revoke all on function public.funnel_lista() from public, anon;
grant execute on function public.funnel_lista() to authenticated;
