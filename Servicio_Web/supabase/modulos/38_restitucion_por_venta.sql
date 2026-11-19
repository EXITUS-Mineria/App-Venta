-- ============================================================
-- RESTITUCIONES: ELEGIR VENTA → ELEGIR CRÉDITO / GRUPO
--  restitucion_ventas(): ventas que el usuario puede ver (funnel_puede_ver) y que tienen créditos
--    registrados (propuesta de la página o archivo histórico), más las propuestas de la página que aún
--    no están en el Funnel (las propias del vendedor; todas para auxiliar / validador / admin).
--  restitucion_partidas(folio): créditos JyP y grupos de esa venta con nombre, capital, saldo y mora,
--    y si ya fueron restituidos.
-- Requiere 36. Idempotente.
-- ============================================================
create or replace function public.restitucion_ventas()
returns table (folio text, id_propuesta text, comprador text, vendedor text, tipo text, estatus text,
               fecha date, partidas bigint, origen text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    with hist as (
        select h.folio, count(*) n from public.ventas_historico_creditos h group by h.folio
    ),
    det as (
        select d.id_propuesta,
               count(distinct case when d.tipo_cartera = 'JyP' then 'J:' || d.vreference else 'G:' || d.vgroupid end) n
          from public.propuesta_detalle d group by d.id_propuesta
    ),
    fun as (
        select f.folio, f.id_propuesta, f.comprador, f.vendedor, f.tipo, f.estatus_venta,
               coalesce(f.fecha_venta, f.fecha_propuesta) fecha,
               coalesce(dt.n, hi.n, 0) n,
               case when dt.n is not null then 'página' else 'histórico' end origen
          from public.funnel_ventas f
          left join det dt on dt.id_propuesta = f.id_propuesta
          left join hist hi on hi.folio = f.folio
         where public.funnel_puede_ver(f.folio)
           and coalesce(f.estatus_venta, '') <> 'Cancelada'
           and coalesce(dt.n, hi.n, 0) > 0
    ),
    pro as (
        select p.id_propuesta folio, p.id_propuesta, p.comprador, p.usuario vendedor, p.tipo_venta tipo, p.estatus,
               p.fecha::date fecha, dt.n, 'página'::text origen
          from public.propuestas p
          join det dt on dt.id_propuesta = p.id_propuesta
         where p.estatus not in ('RECHAZADA', 'LIBERADA', 'CANCELADA')
           and not exists (select 1 from public.funnel_ventas f where f.id_propuesta = p.id_propuesta)
           and (p.user_id = auth.uid() or public.tiene_rol(array['auxiliar', 'control_doc']))
    )
    select x.folio, x.id_propuesta, x.comprador, x.vendedor, x.tipo, x.estatus_venta, x.fecha, x.n, x.origen from fun x
    union all
    select y.folio, y.id_propuesta, y.comprador, y.vendedor, y.tipo, y.estatus, y.fecha, y.n, y.origen from pro y
    order by 1 desc;
end $$;

create or replace function public.restitucion_partidas(p_folio text)
returns table (tipo text, clave text, nombre text, integrantes bigint, capital numeric, saldo_total numeric,
               dias numeric, estado text, municipio text, restituido text, origen text)
language plpgsql stable security definer set search_path = public as $$
declare v_prop text; v_folio text;
begin
    perform public._exigir_activo();
    p_folio := trim(coalesce(p_folio, ''));
    select f.folio, f.id_propuesta into v_folio, v_prop from public.funnel_ventas f
     where f.folio = p_folio or f.id_propuesta = p_folio limit 1;
    if v_folio is not null then
        if not public.funnel_puede_ver(v_folio) then
            raise exception 'No tienes acceso a la venta %', p_folio using errcode = '42501';
        end if;
    else
        select p.id_propuesta into v_prop from public.propuestas p
         where p.id_propuesta = p_folio and (p.user_id = auth.uid() or public.tiene_rol(array['auxiliar', 'control_doc']));
        if v_prop is null then raise exception 'No encontré la venta %', p_folio; end if;
    end if;

    if v_prop is not null and exists (select 1 from public.propuesta_detalle d where d.id_propuesta = v_prop) then
        return query
        select d.tipo_cartera,
               case when d.tipo_cartera = 'JyP' then d.vreference else d.vgroupid end,
               max(case when d.tipo_cartera = 'JyP' then d.datos->>'vName' else coalesce(d.datos->>'vGroup', d.datos->>'Grupo') end),
               count(*), round(sum(d.npendingk), 2), round(sum(public._num(d.datos->>'nTotBalance')), 2),
               round(avg(coalesce(j.dias, g.dias)), 0),
               max(coalesce(j.estado, g.estado)), max(coalesce(j.municipio, g.municipio)),
               max(b.id_restitucion), 'página'::text
          from public.propuesta_detalle d
          left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
          left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
          left join public.bloqueados b on b.clave = case when d.tipo_cartera = 'JyP' then 'J:' || d.vreference else 'G:' || d.vgroupid end
         where d.id_propuesta = v_prop
         group by 1, 2
         order by 1, 2;
        return;
    end if;

    -- venta histórica: detalle del archivo; si no hay detalle, sólo las llaves
    return query
    with dd as (
        select d.tipo, case when d.tipo = 'JyP' then d.vreference else d.vgroupid end clave, d.datos
          from public.ventas_historico_detalle d where d.folio = v_folio
    )
    select dd.tipo, dd.clave,
           max(case when dd.tipo = 'JyP' then dd.datos->>'nombre' else coalesce(dd.datos->>'grupo', dd.datos->>'nombre') end),
           count(*), round(sum((dd.datos->>'capital')::numeric), 2), round(sum((dd.datos->>'saldo_total')::numeric), 2),
           round(avg((dd.datos->>'dias')::numeric), 0), max(dd.datos->>'estado'), max(dd.datos->>'municipio'),
           max(b.id_restitucion), 'histórico'::text
      from dd
      left join public.bloqueados b on b.clave = case when dd.tipo = 'JyP' then 'J:' else 'G:' end || dd.clave
     where dd.clave is not null
     group by 1, 2
    union all
    select h.tipo, coalesce(h.vreference, h.vgroupid), null, null, h.npendingk, null, null, null, null,
           b.id_restitucion, 'histórico'
      from public.ventas_historico_creditos h
      left join public.bloqueados b on b.clave = case when h.tipo = 'JyP' then 'J:' || h.vreference else 'G:' || h.vgroupid end
     where h.folio = v_folio
       and not exists (select 1 from public.ventas_historico_detalle d where d.folio = v_folio)
     order by 1, 2;
end $$;

do $$
declare f text;
begin
    foreach f in array array['restitucion_ventas()', 'restitucion_partidas(text)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
