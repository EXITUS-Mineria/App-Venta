-- ============================================================
-- COMPRADORES: lo que nos compró cada uno en el año y sus zonas recurrentes
-- PORTAL: 🛍️ Tienda de paquetes (armados por el administrador) y recomendados según sus compras
--  · _compras_zonas(): una fila por crédito vendido (ventas «Vendida»): comprador, fecha, estado y municipio
--    (ventas de la página: propuesta_detalle + cartera; históricas: archivo de la venta).
--  · compradores_resumen(año): compras, monto, capital, precio promedio, mes a mes y zonas (top estados / municipios).
--    Validador / admin / auxiliar ven todos; el vendedor sólo sus ventas.
--  · paquetes_tienda: paquetes pre-armados (tipo, estados, municipios, mora, capital, centavos). Las cifras de
--    disponibilidad se calculan al momento sobre la cartera Disponible y no apartada. NO se aparta nada:
--    al pedir un paquete se crea una solicitud de compra (portal_solicitar) y el vendedor arma la propuesta.
-- Requiere 25, 30, 42. Idempotente.
-- ============================================================

-- Comprador de una venta: catálogo (id) o nombre normalizado
create or replace function public._clave_comprador(p_id bigint, p_nombre text)
returns text language sql immutable as $$
    select case when p_id is not null then 'C' || p_id else 'N:' || upper(regexp_replace(trim(coalesce(p_nombre, '')), '\s+', ' ', 'g')) end
$$;

create or replace function public._compras_zonas()
returns table (folio text, clave text, comprador text, comprador_id bigint, vendedor_user uuid, vendedor text, fecha date,
               tipo text, estado_n text, municipio_n text, capital numeric)
language sql stable security definer set search_path = public as $$
    with v as (
        select f.*, coalesce(f.comprador_id, public._comprador_de(f.comprador)) cid,
               coalesce(f.fecha_venta, f.fecha_propuesta) fec
          from public.funnel_ventas f where f.estatus_venta = 'Vendida'
    )
    select v.folio, public._clave_comprador(v.cid, v.comprador), coalesce(c.nombre, v.comprador), v.cid, v.vendedor_user, v.vendedor, v.fec,
           d.tipo_cartera, coalesce(j.estado_n, g.estado_n), coalesce(j.municipio_n, g.municipio_n), d.npendingk
      from v left join public.compradores c on c.id = v.cid
      join public.propuesta_detalle d on d.id_propuesta = v.id_propuesta
      left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
      left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
    union all
    select v.folio, public._clave_comprador(v.cid, v.comprador), coalesce(c.nombre, v.comprador), v.cid, v.vendedor_user, v.vendedor, v.fec,
           h.tipo, public._sin_acentos(public._estado_oficial(h.datos->>'estado')), public._sin_acentos(upper(trim(h.datos->>'municipio'))),
           public._num(h.datos->>'capital')
      from v left join public.compradores c on c.id = v.cid
      join public.ventas_historico_detalle h on upper(h.folio) = upper(v.folio)
     where not exists (select 1 from public.propuesta_detalle d where d.id_propuesta = v.id_propuesta)
$$;
revoke all on function public._compras_zonas() from public, anon, authenticated;

drop function if exists public.compradores_resumen(int);
create or replace function public.compradores_resumen(p_anio int default null)
returns table (clave text, comprador text, comprador_id bigint, registrado boolean, ventas bigint, capital numeric, monto numeric,
               centavos numeric, meses jsonb, primera date, ultima date, tipo_principal text, estados jsonb, municipios jsonb,
               vendedores text, detalle jsonb, nivel text)
language plpgsql stable security definer set search_path = public as $$
declare todo boolean;
begin
    perform public._exigir_activo();
    todo := public.es_admin() or public.tiene_rol(array['auxiliar']);
    return query
    with v as (
        select f.folio, coalesce(f.comprador_id, public._comprador_de(f.comprador)) cid, f.comprador, f.vendedor, f.vendedor_user,
               coalesce(f.fecha_venta, f.fecha_propuesta) fec, f.tipo, f.capital cap, f.monto_venta mon, f.estado
          from public.funnel_ventas f
         where f.estatus_venta = 'Vendida'
           and (p_anio is null or extract(year from coalesce(f.fecha_venta, f.fecha_propuesta)) = p_anio)
           and (todo or f.vendedor_user = auth.uid())
    ), vk as (select v.*, public._clave_comprador(v.cid, v.comprador) k from v),
    z as (select zz.* from public._compras_zonas() zz where zz.folio in (select vk.folio from vk)),
    est as (select z.clave k, z.estado_n e, sum(z.capital) cap, count(*) n from z where coalesce(z.estado_n, '') <> '' group by 1, 2),
    mun as (select z.clave k, z.estado_n e, z.municipio_n m, sum(z.capital) cap, count(*) n from z where coalesce(z.municipio_n, '') <> '' group by 1, 2, 3)
    select vk.k, coalesce(max(c.nombre), max(vk.comprador)), max(vk.cid), max(vk.cid) is not null,
           count(*), round(sum(coalesce(vk.cap, 0)), 2), round(sum(coalesce(vk.mon, 0)), 2),
           round(sum(coalesce(vk.mon, 0)) / nullif(sum(coalesce(vk.cap, 0)) filter (where vk.mon is not null), 0), 4),
           (select jsonb_agg(coalesce((select sum(x.mon) from vk x where x.k = vk.k and extract(month from x.fec) = m), 0) order by m)
              from generate_series(1, 12) m),
           min(vk.fec), max(vk.fec), mode() within group (order by vk.tipo),
           (select jsonb_agg(jsonb_build_object('estado', initcap(lower(e.e)), 'capital', round(e.cap, 2), 'creditos', e.n) order by e.cap desc)
              from (select * from est where est.k = vk.k order by cap desc limit 5) e),
           (select jsonb_agg(jsonb_build_object('municipio', initcap(lower(mm.m)), 'estado', initcap(lower(mm.e)), 'capital', round(mm.cap, 2), 'creditos', mm.n) order by mm.cap desc)
              from (select * from mun where mun.k = vk.k order by cap desc limit 8) mm),
           string_agg(distinct vk.vendedor, ', '),
           jsonb_agg(jsonb_build_object('folio', vk.folio, 'fecha', vk.fec, 'tipo', vk.tipo, 'capital', vk.cap, 'monto', vk.mon, 'estado', vk.estado) order by vk.fec desc),
           case when max(vk.cid) is not null then (public._nivel_comprador(max(vk.cid)))->>'nivel' end
      from vk left join public.compradores c on c.id = vk.cid
     group by vk.k
     order by sum(coalesce(vk.mon, 0)) desc;
end $$;
revoke all on function public.compradores_resumen(int) from public, anon;
grant execute on function public.compradores_resumen(int) to authenticated;

-- ---------- Tienda ----------
create table if not exists public.paquetes_tienda (
    id          bigint generated always as identity primary key,
    titulo      text not null,
    descripcion text,
    tipo        text not null check (tipo in ('JyP', 'Grupal')),
    estados     text[] not null default '{}',     -- estado_n (sin acentos, mayúsculas); vacío = todos
    municipios  text[] not null default '{}',     -- municipio_n; vacío = todos los del estado
    dias_min    int,
    dias_max    int,
    capital_objetivo numeric,                     -- tamaño del paquete (capital); null = todo lo disponible
    centavos    numeric check (centavos is null or (centavos > 0 and centavos < 1)),
    destacado   boolean not null default false,
    activo      boolean not null default true,
    creado_por  text,
    actualizado timestamptz not null default now()
);
alter table public.paquetes_tienda enable row level security;
revoke all on public.paquetes_tienda from anon, authenticated;

/** Cartera Disponible y no apartada que cumple el filtro (cifras agregadas, sin datos de acreditados).
    SQL dinámico para que cada filtro use el índice (estado_n, municipio_n). */
create or replace function public._paquete_stats(p_tipo text, p_estados text[], p_municipios text[], p_dmin int, p_dmax int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare w text := ''; r jsonb;
begin
    if coalesce(cardinality(p_estados), 0) > 0 then w := w || ' and estado_n = any($1)'; end if;
    if coalesce(cardinality(p_municipios), 0) > 0 then w := w || ' and municipio_n = any($2)'; end if;
    if p_tipo = 'JyP' then
        if p_dmin is not null then w := w || ' and dias >= $3'; end if;
        if p_dmax is not null then w := w || ' and dias <= $4'; end if;
        execute 'select jsonb_build_object(''creditos'', count(*), ''grupos'', 0, ''capital'', round(coalesce(sum(npendingk), 0), 2),
                        ''dias'', round(avg(dias), 0), ''municipios'', count(distinct municipio_n))
                   from public.cartera_jyp where disponible' || w || '
                    and not exists (select 1 from public.apartados_activos a where a.clave = ''J:'' || vreference)
                    and not exists (select 1 from public.bloqueados b where b.clave = ''J:'' || vreference)'
           into r using p_estados, p_municipios, p_dmin, p_dmax;
    else
        execute 'select jsonb_build_object(''creditos'', coalesce(sum(n), 0), ''grupos'', count(*), ''capital'', round(coalesce(sum(cap), 0), 2),
                        ''dias'', round(avg(d), 0), ''municipios'', count(distinct m))
                   from (select vgroupid, sum(npendingk) cap, avg(dias) d, count(*) n, min(municipio_n) m
                           from public.cartera_grupal where true' || w || '
                          group by vgroupid
                         having bool_and(disponible)
                            and ($3::int is null or avg(dias) >= $3) and ($4::int is null or avg(dias) <= $4)
                            and not exists (select 1 from public.apartados_activos a where a.clave = ''G:'' || vgroupid)
                            and not exists (select 1 from public.bloqueados b where b.clave = ''G:'' || vgroupid)) g'
           into r using p_estados, p_municipios, p_dmin, p_dmax;
    end if;
    return r;
end $$;
revoke all on function public._paquete_stats(text, text[], text[], int, int) from public, anon, authenticated;

drop function if exists public.paquetes_lista();
create or replace function public.paquetes_lista()
returns table (id bigint, titulo text, descripcion text, tipo text, estados text[], municipios text[], dias_min int, dias_max int,
               capital_objetivo numeric, centavos numeric, destacado boolean, activo boolean, disponible jsonb, pedidos bigint)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    select p.id, p.titulo, p.descripcion, p.tipo, p.estados, p.municipios, p.dias_min, p.dias_max, p.capital_objetivo, p.centavos,
           p.destacado, p.activo, public._paquete_stats(p.tipo, p.estados, p.municipios, p.dias_min, p.dias_max),
           (select count(*) from public.solicitudes_compra s where s.comentarios like '🛍️ Paquete #' || p.id || ' %')
      from public.paquetes_tienda p order by p.activo desc, p.destacado desc, p.id desc;
end $$;
revoke all on function public.paquetes_lista() from public, anon;
grant execute on function public.paquetes_lista() to authenticated;

/** Vista previa al armar un paquete (cuánto hay disponible con esos filtros). */
create or replace function public.paquete_vista_previa(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return public._paquete_stats(p->>'tipo',
        array(select public._sin_acentos(public._estado_oficial(x)) from jsonb_array_elements_text(coalesce(p->'estados', '[]')) x),
        array(select public._sin_acentos(upper(trim(x))) from jsonb_array_elements_text(coalesce(p->'municipios', '[]')) x),
        nullif(p->>'dias_min', '')::int, nullif(p->>'dias_max', '')::int);
end $$;
revoke all on function public.paquete_vista_previa(jsonb) from public, anon;
grant execute on function public.paquete_vista_previa(jsonb) to authenticated;

create or replace function public.paquete_guardar(p jsonb)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare v_id bigint := nullif(p->>'id', '')::bigint; quien text; est text[]; mun text[];
begin
    perform public._exigir_activo();
    if not (public.es_admin() or public.tiene_rol(array['auxiliar'])) then raise exception 'Sólo administración arma paquetes' using errcode = '42501'; end if;
    if nullif(trim(p->>'titulo'), '') is null then raise exception 'El paquete necesita título'; end if;
    if p->>'tipo' not in ('JyP', 'Grupal') then raise exception 'Tipo de cartera inválido'; end if;
    est := array(select public._sin_acentos(public._estado_oficial(x)) from jsonb_array_elements_text(coalesce(p->'estados', '[]')) x where trim(x) <> '');
    mun := array(select public._sin_acentos(upper(trim(x))) from jsonb_array_elements_text(coalesce(p->'municipios', '[]')) x where trim(x) <> '');
    select coalesce(nombre, email) into quien from public.perfiles where user_id = auth.uid();
    if v_id is null then
        insert into public.paquetes_tienda (titulo, descripcion, tipo, estados, municipios, dias_min, dias_max, capital_objetivo, centavos, destacado, activo, creado_por)
        values (trim(p->>'titulo'), nullif(trim(p->>'descripcion'), ''), p->>'tipo', est, mun, nullif(p->>'dias_min', '')::int, nullif(p->>'dias_max', '')::int,
                nullif(p->>'capital_objetivo', '')::numeric, nullif(p->>'centavos', '')::numeric, coalesce((p->>'destacado')::boolean, false),
                coalesce((p->>'activo')::boolean, true), quien)
        returning id into v_id;
    else
        update public.paquetes_tienda set titulo = trim(p->>'titulo'), descripcion = nullif(trim(p->>'descripcion'), ''), tipo = p->>'tipo',
               estados = est, municipios = mun, dias_min = nullif(p->>'dias_min', '')::int, dias_max = nullif(p->>'dias_max', '')::int,
               capital_objetivo = nullif(p->>'capital_objetivo', '')::numeric, centavos = nullif(p->>'centavos', '')::numeric,
               destacado = coalesce((p->>'destacado')::boolean, false), activo = coalesce((p->>'activo')::boolean, true), actualizado = now()
         where id = v_id;
    end if;
    return v_id;
end $$;
revoke all on function public.paquete_guardar(jsonb) from public, anon;
grant execute on function public.paquete_guardar(jsonb) to authenticated;

create or replace function public.paquete_borrar(p_id bigint)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    if not (public.es_admin() or public.tiene_rol(array['auxiliar'])) then raise exception 'Sin acceso' using errcode = '42501'; end if;
    delete from public.paquetes_tienda where id = p_id;
end $$;
revoke all on function public.paquete_borrar(bigint) from public, anon;
grant execute on function public.paquete_borrar(bigint) to authenticated;

/** Tienda del comprador: paquetes activos con disponibilidad y recomendados según sus compras anteriores. */
create or replace function public.portal_tienda()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v bigint := public._mi_comprador(); desc_c numeric; paq jsonb; rec jsonb; hist jsonb; mis_cent numeric; mi_cap numeric;
begin
    desc_c := coalesce(((public._nivel_comprador(v))->>'descuento_centavos')::numeric, 0);
    -- paquetes del administrador
    select coalesce(jsonb_agg(x order by (x->>'destacado')::boolean desc, (x->>'id')::bigint desc), '[]') into paq from (
        select jsonb_build_object('id', p.id, 'titulo', p.titulo, 'descripcion', p.descripcion, 'tipo', p.tipo,
               'estados', (select jsonb_agg(initcap(lower(e))) from unnest(p.estados) e),
               'municipios', (select jsonb_agg(initcap(lower(m))) from unnest(p.municipios) m),
               'dias_min', p.dias_min, 'dias_max', p.dias_max, 'destacado', p.destacado,
               'capital', least(coalesce(p.capital_objetivo, (s->>'capital')::numeric), (s->>'capital')::numeric),
               'centavos', p.centavos, 'centavos_lealtad', case when p.centavos is not null then greatest(p.centavos - desc_c, 0.01) end,
               'disponible', s) x
          from public.paquetes_tienda p, lateral public._paquete_stats(p.tipo, p.estados, p.municipios, p.dias_min, p.dias_max) s
         where p.activo and (s->>'capital')::numeric > 0) t(x);

    -- historia del comprador (sus compras por zona)
    with z as (select * from public._compras_zonas() z where z.comprador_id = v),
         top as (select z.tipo, z.estado_n, array_agg(distinct z.municipio_n) filter (where z.municipio_n <> '') muns, sum(z.capital) cap, count(distinct z.folio) ventas
                   from z where coalesce(z.estado_n, '') <> '' group by 1, 2 order by cap desc limit 3)
    select coalesce(jsonb_agg(jsonb_build_object('tipo', t.tipo, 'estado', initcap(lower(t.estado_n)),
               'municipios', (select jsonb_agg(initcap(lower(m))) from (select unnest(t.muns[1:6]) m) mm),
               'ventas', t.ventas, 'capital_comprado', round(t.cap, 2),
               'disponible', public._paquete_stats(t.tipo, array[t.estado_n], t.muns, null, null),
               'disponible_estado', public._paquete_stats(t.tipo, array[t.estado_n], '{}', null, null))), '[]')
      into hist from top t;
    select round(sum(f.monto_venta) / nullif(sum(f.capital), 0), 4), round(avg(f.capital), 0) into mis_cent, mi_cap
      from public.funnel_ventas f
     where f.estatus_venta = 'Vendida' and coalesce(f.comprador_id, public._comprador_de(f.comprador)) = v and f.monto_venta > 0;

    -- sin historia: los estados con más cartera disponible
    if jsonb_array_length(hist) = 0 then
        select coalesce(jsonb_agg(jsonb_build_object('tipo', x.tipo, 'estado', initcap(lower(x.estado_n)), 'municipios', '[]'::jsonb,
                   'ventas', 0, 'capital_comprado', 0,
                   'disponible', public._paquete_stats(x.tipo, array[x.estado_n], '{}', null, null))), '[]')
          into rec from (
            (select 'JyP' tipo, estado_n, sum(npendingk) cap from public.cartera_jyp where disponible group by 2 order by 3 desc limit 2)
            union all
            (select 'Grupal', estado_n, sum(npendingk) from public.cartera_grupal where disponible group by 2 order by 3 desc limit 1)) x;
    end if;
    return jsonb_build_object('paquetes', paq, 'recomendados', hist, 'populares', coalesce(rec, '[]'::jsonb),
        'mi_centavos', mis_cent, 'mi_capital_promedio', mi_cap, 'descuento_centavos', desc_c);
end $$;
revoke all on function public.portal_tienda() from public, anon;
grant execute on function public.portal_tienda() to authenticated;

/** El comprador pide un paquete o una recomendación: se crea su solicitud de compra (no se aparta nada). */
create or replace function public.portal_pedir_paquete(p jsonb)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare v bigint := public._mi_comprador(); pq public.paquetes_tienda; datos jsonb; cap numeric := nullif(p->>'capital', '')::numeric;
begin
    if nullif(p->>'paquete_id', '') is not null then
        select * into pq from public.paquetes_tienda where id = (p->>'paquete_id')::bigint and activo;
        if not found then raise exception 'El paquete ya no está disponible'; end if;
        datos := jsonb_build_object('tipo_cartera', pq.tipo,
            'estados', (select string_agg(initcap(lower(e)), ', ') from unnest(pq.estados) e),
            'municipios', (select string_agg(initcap(lower(m)), ', ') from unnest(pq.municipios) m),
            'dias_min', pq.dias_min, 'dias_max', pq.dias_max, 'capital_aprox', coalesce(cap, pq.capital_objetivo),
            'comentarios', '🛍️ Paquete #' || pq.id || ' «' || pq.titulo || '»' ||
                coalesce(' · ' || to_char(pq.centavos * 100, 'FM990.0') || ' ¢ de lista', '') || coalesce(' · ' || nullif(trim(p->>'comentario'), ''), ''));
    else
        if p->>'tipo' not in ('JyP', 'Grupal') or nullif(trim(p->>'estado'), '') is null then raise exception 'Indica tipo y estado'; end if;
        datos := jsonb_build_object('tipo_cartera', p->>'tipo', 'estados', p->>'estado',
            'municipios', (select string_agg(x, ', ') from jsonb_array_elements_text(coalesce(p->'municipios', '[]')) x),
            'capital_aprox', cap,
            'comentarios', '🛍️ Recomendado según mis compras anteriores' || coalesce(' · ' || nullif(trim(p->>'comentario'), ''), ''));
    end if;
    return public.portal_solicitar(datos);
end $$;
revoke all on function public.portal_pedir_paquete(jsonb) from public, anon;
grant execute on function public.portal_pedir_paquete(jsonb) to authenticated;
