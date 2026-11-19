-- ============================================================
-- VENTAS DUPLICADAS: un crédito JyP o un grupo no debe venderse en más de una venta
--  ventas_duplicadas(): cada vReference (JyP) o vGroupId (Grupal) que aparece en 2 o más ventas
--  (archivos históricos + propuestas de la página vigentes). En Grupal indica cuántos integrantes
--  (vReference) se repiten: si se repiten es el MISMO crédito; si no, puede ser otro ciclo del grupo.
--  Se excluyen ventas Canceladas y propuestas RECHAZADA / LIBERADA. Sólo regresa duplicados donde
--  al menos una de las ventas es visible para el usuario (funnel_puede_ver o propuesta propia).
-- Requiere 38. Idempotente.
-- ============================================================
create or replace function public.ventas_duplicadas()
returns table (tipo text, clave text, n_ventas integer, integrantes_repetidos integer, mismo_credito boolean,
               ventas json, restituido text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    with pag as (   -- propuestas de la página vigentes, con su folio de Funnel si ya lo tienen
        select coalesce(f.folio, p.id_propuesta) folio, p.id_propuesta, d.tipo_cartera tipo, d.vreference, d.vgroupid
          from public.propuesta_detalle d
          join public.propuestas p on p.id_propuesta = d.id_propuesta
          left join public.funnel_ventas f on f.id_propuesta = p.id_propuesta
         where p.estatus not in ('RECHAZADA', 'LIBERADA', 'CANCELADA')
           and coalesce(f.estatus_venta, '') <> 'Cancelada'
    ),
    cred as (       -- un renglón por crédito (vReference) y venta
        select h.folio, h.tipo, h.vreference, h.vgroupid from public.ventas_historico_detalle h
        union
        select h.folio, h.tipo, h.vreference, h.vgroupid from public.ventas_historico_creditos h
         where not exists (select 1 from public.ventas_historico_detalle d where d.folio = h.folio)
        union
        select pag.folio, pag.tipo, pag.vreference, pag.vgroupid from pag
    ),
    llaves as (
        select c.tipo, case when c.tipo = 'JyP' then c.vreference else c.vgroupid end clave, c.folio
          from cred c
         where (c.tipo = 'JyP' and c.vreference is not null) or (c.tipo = 'Grupal' and c.vgroupid is not null)
         group by 1, 2, 3
    ),
    dup as (
        select l.tipo, l.clave, array_agg(l.folio order by l.folio) folios
          from llaves l group by 1, 2 having count(*) > 1
    ),
    miembros as (   -- integrantes de grupo que se repiten entre las ventas del duplicado
        select d.clave, count(*) n
          from dup d
          join lateral (select c.vreference from cred c
                         where d.tipo = 'Grupal' and c.tipo = 'Grupal' and c.vgroupid = d.clave and c.vreference is not null
                         group by c.vreference having count(distinct c.folio) > 1) m on true
         group by d.clave
    )
    select d.tipo, d.clave, cardinality(d.folios),
           case when d.tipo = 'Grupal' then coalesce(mi.n, 0)::integer end,
           d.tipo = 'JyP' or coalesce(mi.n, 0) > 0,
           (select json_agg(json_build_object(
                'folio', x.folio, 'comprador', coalesce(f.comprador, p.comprador), 'vendedor', coalesce(f.vendedor, p.usuario),
                'estatus', coalesce(f.estatus_venta, p.estatus), 'fecha', coalesce(f.fecha_venta, f.fecha_propuesta, p.fecha::date),
                'visible', case when f.folio is not null then public.funnel_puede_ver(f.folio)
                                else p.user_id = auth.uid() or public.tiene_rol(array['auxiliar', 'control_doc']) end)
                order by x.folio)
              from unnest(d.folios) x(folio)
              left join public.funnel_ventas f on f.folio = x.folio
              left join public.propuestas p on p.id_propuesta = x.folio),
           (select b.id_restitucion from public.bloqueados b
             where b.clave = case when d.tipo = 'JyP' then 'J:' else 'G:' end || d.clave)
      from dup d
      left join miembros mi on mi.clave = d.clave
     where exists (select 1 from unnest(d.folios) x(folio)
                    left join public.funnel_ventas f on f.folio = x.folio
                    left join public.propuestas p on p.id_propuesta = x.folio
                   where (f.folio is not null and public.funnel_puede_ver(f.folio))
                      or (f.folio is null and (p.user_id = auth.uid() or public.tiene_rol(array['auxiliar', 'control_doc']))))
     order by (d.tipo = 'JyP' or coalesce(mi.n, 0) > 0) desc, cardinality(d.folios) desc, d.clave;
end $$;
revoke all on function public.ventas_duplicadas() from public, anon;
grant execute on function public.ventas_duplicadas() to authenticated;
