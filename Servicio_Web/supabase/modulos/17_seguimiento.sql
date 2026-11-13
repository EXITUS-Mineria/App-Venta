-- ============================================================
-- SEGUIMIENTO · historial de cada propuesta/venta y descargas desde la Bitácora
--  - propuesta_eventos: se llena sola con un trigger (creada, aprobada, rechazada, sub base,
--    liberada, regresa a revisión, cambios de capital por complementos/quitas/restituciones).
--  - creditos_propuesta(): detalle a nivel crédito para el CSV de la propuesta.
--  - layout_propuesta(): el dueño también descarga la base final cuando ya está APROBADA / EN VENTA.
-- Requiere 10-16. Idempotente.
-- ============================================================
create table if not exists public.propuesta_eventos (
    id            bigserial primary key,
    id_propuesta  text not null references public.propuestas on delete cascade,
    fecha         timestamptz not null default now(),
    usuario       text,
    evento        text not null,
    detalle       text
);
create index if not exists eventos_propuesta on public.propuesta_eventos (id_propuesta, fecha);
alter table public.propuesta_eventos enable row level security;
revoke all on public.propuesta_eventos from anon, authenticated;
grant select on public.propuesta_eventos to authenticated;
drop policy if exists eventos_lectura on public.propuesta_eventos;
create policy eventos_lectura on public.propuesta_eventos for select to authenticated using (public.es_activo());

create or replace function public.tg_propuesta_evento() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_quien text; v_ultimo text;
begin
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    v_quien := coalesce(v_quien, new.usuario, 'sistema');
    if tg_op = 'INSERT' then
        insert into public.propuesta_eventos (id_propuesta, fecha, usuario, evento, detalle)
        values (new.id_propuesta, new.fecha, v_quien, 'Creada',
                coalesce(new.tipo_venta, '') || ' · capital ' || to_char(coalesce(new.capital, 0), 'FM$999,999,990.00')
                || ' · ' || new.estatus || coalesce(' · ' || nullif(new.comentario, ''), ''));
        return new;
    end if;

    if new.estatus is distinct from old.estatus then
        insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle)
        values (new.id_propuesta, v_quien,
            case new.estatus when 'APROBADA' then 'Aprobada' when 'RECHAZADA' then 'Rechazada'
                             when 'EN VENTA' then 'Sub base generada' when 'LIBERADA' then 'Liberada'
                             when 'EN REVISIÓN' then 'Regresa a revisión' else new.estatus end,
            case new.estatus when 'LIBERADA' then nullif(new.motivo, '')
                             when 'APROBADA' then nullif(new.comentario, '')
                             when 'RECHAZADA' then nullif(new.comentario, '') else null end);
    end if;
    if new.capital is distinct from old.capital then
        v_ultimo := case when new.comentario is distinct from old.comentario
                         then regexp_replace(coalesce(new.comentario, ''), '^.*\| ', '') end;
        insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle)
        values (new.id_propuesta, v_quien,
            case when new.partidas_quitadas > old.partidas_quitadas then 'Partidas quitadas por el validador'
                 when new.complementos > old.complementos then 'Complemento'
                 when v_ultimo like 'RST-%' or new.tipo_venta = 'Restitución' then 'Restitución'
                 else 'Capital modificado' end,
            to_char(coalesce(old.capital, 0), 'FM$999,999,990.00') || ' → ' || to_char(coalesce(new.capital, 0), 'FM$999,999,990.00')
            || coalesce(' · ' || nullif(v_ultimo, ''), ''));
    end if;
    return new;
end $$;
revoke all on function public.tg_propuesta_evento() from public, anon, authenticated;

drop trigger if exists tr_propuesta_evento on public.propuestas;
create trigger tr_propuesta_evento after insert or update on public.propuestas
    for each row execute function public.tg_propuesta_evento();

-- Historial de lo que ya existía (una sola vez)
insert into public.propuesta_eventos (id_propuesta, fecha, usuario, evento, detalle)
select p.id_propuesta, p.fecha, p.usuario, 'Creada',
       coalesce(p.tipo_venta, '') || ' · capital ' || to_char(coalesce(p.capital_original, p.capital, 0), 'FM$999,999,990.00')
  from public.propuestas p
 where not exists (select 1 from public.propuesta_eventos e where e.id_propuesta = p.id_propuesta);
insert into public.propuesta_eventos (id_propuesta, fecha, usuario, evento, detalle)
select p.id_propuesta, p.revisada_en, p.revisada_por,
       case when p.estatus = 'RECHAZADA' then 'Rechazada' else 'Aprobada' end, nullif(p.comentario, '')
  from public.propuestas p
 where p.revisada_en is not null
   and not exists (select 1 from public.propuesta_eventos e where e.id_propuesta = p.id_propuesta and e.evento in ('Aprobada', 'Rechazada'));
insert into public.propuesta_eventos (id_propuesta, fecha, usuario, evento)
select p.id_propuesta, p.sub_base_en, p.sub_base_por, 'Sub base generada'
  from public.propuestas p
 where p.sub_base_en is not null
   and not exists (select 1 from public.propuesta_eventos e where e.id_propuesta = p.id_propuesta and e.evento = 'Sub base generada');
insert into public.propuesta_eventos (id_propuesta, fecha, usuario, evento, detalle)
select p.id_propuesta, p.liberada_en, p.liberada_por, 'Liberada', nullif(p.motivo, '')
  from public.propuestas p
 where p.liberada_en is not null
   and not exists (select 1 from public.propuesta_eventos e where e.id_propuesta = p.id_propuesta and e.evento = 'Liberada');

-- Detalle a nivel crédito (CSV de la propuesta)
create or replace function public.creditos_propuesta(p_id text)
returns table (tipo text, vgroupid text, vreference text, estado text, municipio text, dias numeric, capital numeric)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    select d.tipo_cartera, d.vgroupid, d.vreference,
           coalesce(j.estado, g.estado), coalesce(j.municipio, g.municipio),
           coalesce(j.dias, g.dias), round(d.npendingk, 2)
      from public.propuesta_detalle d
      left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
      left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
     where d.id_propuesta = p_id
     order by d.tipo_cartera, d.vgroupid nulls first, d.vreference;
end $$;

-- Base final (layout Funnel): auxiliar/validador/admin siempre; el dueño cuando ya está aprobada
create or replace function public.layout_propuesta(p_id text)
returns table (tipo_cartera text, datos jsonb, columnas text[])
language plpgsql stable security definer set search_path = public as $$
declare v_p public.propuestas;
begin
    perform public._exigir_activo();
    select * into v_p from public.propuestas where id_propuesta = p_id;
    if not found then raise exception 'No existe la propuesta %', p_id; end if;
    if not public.tiene_rol(array['auxiliar', 'validador'])
       and not (v_p.user_id = auth.uid() and v_p.estatus in ('APROBADA', 'EN VENTA', 'APARTADA')) then
        raise exception 'La base final se puede descargar cuando la venta está aprobada (está %)', v_p.estatus
            using errcode = '42501';
    end if;
    return query
    select d.tipo_cartera, d.datos,
           (select c.columnas from public.cargas c where c.cartera = d.tipo_cartera order by c.id desc limit 1)
    from public.propuesta_detalle d where d.id_propuesta = p_id order by d.id;
end $$;

do $$
declare f text;
begin
    foreach f in array array['creditos_propuesta(text)', 'layout_propuesta(text)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
