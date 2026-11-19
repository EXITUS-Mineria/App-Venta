-- ============================================================
-- REVISIÓN DE VENTAS DUPLICADAS
--  duplicados_revision: seguimiento de cada crédito / grupo repetido entre ventas
--    (Pendiente, En revisión, Justificado; «Restituido» lo da la restitución misma).
--  ventas_duplicadas(): ahora incluye el estatus de revisión, comentario, quién y cuándo.
--  duplicado_marcar(tipo, clave, estatus, comentario): validador, admin y auxiliar.
--  propuesta_ya_vendidas(id): partidas de una propuesta que ya aparecen en otra venta
--    (se usa en Revisión antes de aprobar).
-- Requiere 39. Idempotente.
-- ============================================================
create table if not exists public.duplicados_revision (
    tipo text not null check (tipo in ('JyP', 'Grupal')),
    clave text not null,
    estatus text not null default 'Pendiente' check (estatus in ('Pendiente', 'En revisión', 'Justificado')),
    comentario text,
    usuario text,
    actualizado timestamptz not null default now(),
    primary key (tipo, clave)
);
alter table public.duplicados_revision enable row level security;
revoke all on public.duplicados_revision from anon, authenticated;

-- créditos de todas las ventas (histórico + propuestas vigentes de la página), un renglón por crédito y venta
create or replace function public._creditos_vendidos()
returns table (folio text, tipo text, vreference text, vgroupid text)
language sql stable security definer set search_path = public as $$
    select h.folio, h.tipo, h.vreference, h.vgroupid from public.ventas_historico_detalle h
    union
    select h.folio, h.tipo, h.vreference, h.vgroupid from public.ventas_historico_creditos h
     where not exists (select 1 from public.ventas_historico_detalle d where d.folio = h.folio)
    union
    select coalesce(f.folio, p.id_propuesta), d.tipo_cartera, d.vreference, d.vgroupid
      from public.propuesta_detalle d
      join public.propuestas p on p.id_propuesta = d.id_propuesta
      left join public.funnel_ventas f on f.id_propuesta = p.id_propuesta
     where p.estatus not in ('RECHAZADA', 'LIBERADA', 'CANCELADA')
       and coalesce(f.estatus_venta, '') <> 'Cancelada'
$$;
revoke all on function public._creditos_vendidos() from public, anon, authenticated;

drop function if exists public.ventas_duplicadas();
create or replace function public.ventas_duplicadas()
returns table (tipo text, clave text, n_ventas integer, integrantes_repetidos integer, mismo_credito boolean,
               ventas json, restituido text, revision text, comentario text, revisado_por text, revisado_en timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    with cred as (select * from public._creditos_vendidos()),
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
    miembros as (
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
           bl.id_restitucion,
           case when bl.id_restitucion is not null then 'Restituido' else coalesce(r.estatus, 'Pendiente') end,
           r.comentario, r.usuario, r.actualizado
      from dup d
      left join miembros mi on mi.clave = d.clave
      left join public.duplicados_revision r on r.tipo = d.tipo and r.clave = d.clave
      left join public.bloqueados bl on bl.clave = case when d.tipo = 'JyP' then 'J:' else 'G:' end || d.clave
     where exists (select 1 from unnest(d.folios) x(folio)
                    left join public.funnel_ventas f on f.folio = x.folio
                    left join public.propuestas p on p.id_propuesta = x.folio
                   where (f.folio is not null and public.funnel_puede_ver(f.folio))
                      or (f.folio is null and (p.user_id = auth.uid() or public.tiene_rol(array['auxiliar', 'control_doc']))))
     order by (bl.id_restitucion is null and coalesce(r.estatus, 'Pendiente') <> 'Justificado') desc,
              (d.tipo = 'JyP' or coalesce(mi.n, 0) > 0) desc, cardinality(d.folios) desc, d.clave;
end $$;

create or replace function public.duplicado_marcar(p_tipo text, p_clave text, p_estatus text, p_comentario text default null)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_quien text;
begin
    perform public._exigir_activo();
    if not public.tiene_rol(array['auxiliar']) then
        raise exception 'Sólo validador, administrador o auxiliar revisan duplicados' using errcode = '42501';
    end if;
    if p_estatus not in ('Pendiente', 'En revisión', 'Justificado') then raise exception 'Estatus no válido: %', p_estatus; end if;
    if p_estatus = 'Justificado' and nullif(trim(coalesce(p_comentario, '')), '') is null then
        raise exception 'Escribe por qué está justificado (p. ej. otro ciclo del grupo)';
    end if;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    insert into public.duplicados_revision (tipo, clave, estatus, comentario, usuario, actualizado)
    values (p_tipo, trim(p_clave), p_estatus, nullif(trim(coalesce(p_comentario, '')), ''), v_quien, now())
    on conflict (tipo, clave) do update
       set estatus = excluded.estatus,
           comentario = coalesce(excluded.comentario, public.duplicados_revision.comentario),
           usuario = excluded.usuario, actualizado = now();
end $$;

-- partidas de la propuesta que ya están en OTRA venta
create or replace function public.propuesta_ya_vendidas(p_id text)
returns table (tipo text, clave text, ventas text[], integrantes_repetidos integer)
language plpgsql stable security definer set search_path = public as $$
declare v_folio text;
begin
    perform public._exigir_activo();
    select coalesce(f.folio, p.id_propuesta) into v_folio from public.propuestas p
      left join public.funnel_ventas f on f.id_propuesta = p.id_propuesta where p.id_propuesta = p_id;
    return query
    with mia as (
        select d.tipo_cartera tipo, d.vreference, d.vgroupid from public.propuesta_detalle d where d.id_propuesta = p_id
    ),
    otras as (select * from public._creditos_vendidos() c where c.folio is distinct from v_folio and c.folio <> p_id)
    select m.tipo, case when m.tipo = 'JyP' then m.vreference else m.vgroupid end,
           array_agg(distinct o.folio order by o.folio),
           case when m.tipo = 'Grupal' then count(distinct m.vreference) filter (where o.vreference = m.vreference)::integer end
      from mia m
      join otras o on o.tipo = m.tipo
                  and ((m.tipo = 'JyP' and o.vreference = m.vreference)
                    or (m.tipo = 'Grupal' and (o.vgroupid = m.vgroupid or o.vreference = m.vreference)))
     group by 1, 2
     order by 1, 2;
end $$;

do $$
declare f text;
begin
    foreach f in array array['ventas_duplicadas()', 'duplicado_marcar(text,text,text,text)', 'propuesta_ya_vendidas(text)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
