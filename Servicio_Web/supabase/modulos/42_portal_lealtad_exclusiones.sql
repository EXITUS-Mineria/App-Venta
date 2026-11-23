-- ============================================================
-- PORTAL DEL COMPRADOR (interés de otros compradores, ofertas, noticias, lealtad)
-- y EXCLUSIONES DE CARTERA (promesas de pago SIGE, pagos recientes, lista negra)
--  · config_app: interruptores que el administrador prende / apaga.
--  · exclusiones_credito: vReference que no deben ofrecerse. Al cargar la base (trigger) y al
--    llamar aplicar_exclusiones() los créditos Disponibles excluidos cambian su estatus_base a
--    «Promesa de pago» / «Pago reciente» / «Lista negra» (así dejan de estar disponibles) y su
--    estatus original queda en estatus_origen para regresarlos cuando la exclusión ya no aplique.
--    En Grupal se excluye el grupo completo si algún integrante está excluido.
-- Requiere 25, 30 (geo), 41. Idempotente.
-- ============================================================

-- ---------- Configuración ----------
create table if not exists public.config_app (
    clave           text primary key,
    valor           jsonb not null,
    descripcion     text,
    actualizado     timestamptz not null default now(),
    actualizado_por text
);
alter table public.config_app enable row level security;
revoke all on public.config_app from anon, authenticated;

insert into public.config_app (clave, valor, descripcion) values
    ('portal_ver_interes',  'true',  'El comprador ve si otros compradores buscan cartera de la misma zona que su propuesta'),
    ('portal_ofertas',      'true',  'El comprador puede ofertar un precio (centavos por peso de capital) en sus propuestas'),
    ('portal_lealtad',      'true',  'El comprador ve su nivel de lealtad y sus beneficios'),
    ('excluir_promesas',    'true',  'Quitar de la cartera disponible los créditos con promesa de pago vigente (gestiones SIGE)'),
    ('excluir_pagos',       'true',  'Quitar de la cartera disponible los créditos con pagos recientes'),
    ('excluir_lista_negra', 'false', 'Quitar de la cartera disponible los créditos de la lista negra'),
    ('dias_promesa',        '15',    'Días que sigue vigente una promesa de pago después de su fecha'),
    ('dias_pago',           '30',    'Días hacia atrás en que un pago deja fuera al crédito')
on conflict (clave) do nothing;

create or replace function public._config(p_clave text)
returns jsonb language sql stable security definer set search_path = public as $$
    select valor from public.config_app where clave = p_clave
$$;
revoke all on function public._config(text) from public, anon, authenticated;

create or replace function public._config_si(p_clave text)
returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select valor = 'true'::jsonb from public.config_app where clave = p_clave), false)
$$;
revoke all on function public._config_si(text) from public, anon, authenticated;

drop function if exists public.config_lista();
create or replace function public.config_lista()
returns table (clave text, valor jsonb, descripcion text, actualizado timestamptz, actualizado_por text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query select c.clave, c.valor, c.descripcion, c.actualizado, c.actualizado_por from public.config_app c order by c.clave;
end $$;
revoke all on function public.config_lista() from public, anon;
grant execute on function public.config_lista() to authenticated;

create or replace function public.config_guardar(p_clave text, p_valor jsonb)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    if not public.es_admin() then raise exception 'Sólo un administrador o validador cambia la configuración' using errcode = '42501'; end if;
    update public.config_app set valor = p_valor, actualizado = now(),
           actualizado_por = (select coalesce(nombre, email) from public.perfiles where user_id = auth.uid())
     where clave = p_clave;
    if not found then raise exception 'Opción desconocida: %', p_clave; end if;
    if p_clave in ('excluir_promesas', 'excluir_pagos', 'excluir_lista_negra', 'dias_promesa', 'dias_pago') then
        perform public.aplicar_exclusiones();
    end if;
end $$;
revoke all on function public.config_guardar(text, jsonb) from public, anon;
grant execute on function public.config_guardar(text, jsonb) to authenticated;

-- ---------- Exclusiones ----------
create table if not exists public.exclusiones_credito (
    vreference text not null,
    origen     text not null check (origen in ('promesa', 'pago', 'lista_negra')),
    fecha      date,
    monto      numeric,
    detalle    text,
    archivo    text,
    cargado    timestamptz not null default now(),
    cargado_por text,
    primary key (vreference, origen)
);
alter table public.exclusiones_credito enable row level security;
revoke all on public.exclusiones_credito from anon, authenticated;

alter table public.cartera_jyp    add column if not exists estatus_origen text;
alter table public.cartera_grupal add column if not exists estatus_origen text;

/** vReference con exclusión vigente según los interruptores; la etiqueta más fuerte gana. */
create or replace function public._exclusiones_vigentes()
returns table (vreference text, etiqueta text)
language sql stable security definer set search_path = public as $$
    with hoy as (select (now() at time zone 'America/Mexico_City')::date d)
    select distinct on (e.vreference) e.vreference,
           case e.origen when 'lista_negra' then 'Lista negra' when 'pago' then 'Pago reciente' else 'Promesa de pago' end
      from public.exclusiones_credito e, hoy
     where (e.origen = 'lista_negra' and public._config_si('excluir_lista_negra'))
        or (e.origen = 'pago' and public._config_si('excluir_pagos')
            and (e.fecha is null or e.fecha >= hoy.d - coalesce((public._config('dias_pago'))::text::int, 30)))
        or (e.origen = 'promesa' and public._config_si('excluir_promesas')
            and (e.fecha is null or e.fecha >= hoy.d - coalesce((public._config('dias_promesa'))::text::int, 15)))
     order by e.vreference, case e.origen when 'lista_negra' then 1 when 'pago' then 2 else 3 end
$$;
revoke all on function public._exclusiones_vigentes() from public, anon, authenticated;

/** Quita de la cartera disponible lo excluido y regresa lo que ya no aplica. */
create or replace function public.aplicar_exclusiones()
returns json language plpgsql volatile security definer set search_path = public as $$
declare r_j int; r_g int; q_j int; q_g int;
begin
    create temp table if not exists _exv (vreference text primary key, etiqueta text) on commit drop;
    truncate _exv;
    insert into _exv select * from public._exclusiones_vigentes();
    create temp table if not exists _exg (vgroupid text primary key, etiqueta text) on commit drop;
    truncate _exg;
    insert into _exg select distinct on (g.vgroupid) g.vgroupid, x.etiqueta
      from public.cartera_grupal g join _exv x on x.vreference = g.vreference
     order by g.vgroupid, case x.etiqueta when 'Lista negra' then 1 when 'Pago reciente' then 2 else 3 end;

    -- regresar
    update public.cartera_jyp j set estatus_base = j.estatus_origen, estatus_origen = null
     where j.estatus_origen is not null and not exists (select 1 from _exv x where x.vreference = j.vreference);
    get diagnostics r_j = row_count;
    update public.cartera_grupal g set estatus_base = g.estatus_origen, estatus_origen = null
     where g.estatus_origen is not null and not exists (select 1 from _exg x where x.vgroupid = g.vgroupid);
    get diagnostics r_g = row_count;
    -- etiqueta cambió (p. ej. de promesa a lista negra)
    update public.cartera_jyp j set estatus_base = x.etiqueta from _exv x
     where x.vreference = j.vreference and j.estatus_origen is not null and j.estatus_base is distinct from x.etiqueta;
    update public.cartera_grupal g set estatus_base = x.etiqueta from _exg x
     where x.vgroupid = g.vgroupid and g.estatus_origen is not null and g.estatus_base is distinct from x.etiqueta;
    -- quitar
    update public.cartera_jyp j set estatus_origen = j.estatus_base, estatus_base = x.etiqueta from _exv x
     where x.vreference = j.vreference and j.estatus_origen is null and public.norm(j.estatus_base) = 'DISPONIBLE'
       and not exists (select 1 from public.apartados_activos a where a.clave = 'J:' || j.vreference);
    get diagnostics q_j = row_count;
    update public.cartera_grupal g set estatus_origen = g.estatus_base, estatus_base = x.etiqueta from _exg x
     where x.vgroupid = g.vgroupid and g.estatus_origen is null and public.norm(g.estatus_base) = 'DISPONIBLE'
       and not exists (select 1 from public.apartados_activos a where a.clave = 'G:' || g.vgroupid);
    get diagnostics q_g = row_count;
    return json_build_object('jyp_quitados', q_j, 'grupal_quitados', q_g, 'jyp_regresados', r_j, 'grupal_regresados', r_g);
end $$;
revoke all on function public.aplicar_exclusiones() from public, anon, authenticated;

-- Al cargar la base: marcar lo nuevo que esté excluido
create or replace function public._tg_exclusiones_jyp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    update public.cartera_jyp j set estatus_origen = j.estatus_base, estatus_base = x.etiqueta
      from nuevas n, public._exclusiones_vigentes() x
     where n.vreference = j.vreference and x.vreference = j.vreference
       and j.estatus_origen is null and public.norm(j.estatus_base) = 'DISPONIBLE'
       and not exists (select 1 from public.apartados_activos a where a.clave = 'J:' || j.vreference);
    return null;
end $$;
create or replace function public._tg_exclusiones_grupal()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    with x as (select * from public._exclusiones_vigentes()),
         grupos as (select distinct on (g.vgroupid) g.vgroupid, x.etiqueta
                      from public.cartera_grupal g join x on x.vreference = g.vreference
                     where g.vgroupid in (select n.vgroupid from nuevas n)
                     order by g.vgroupid, case x.etiqueta when 'Lista negra' then 1 when 'Pago reciente' then 2 else 3 end)
    update public.cartera_grupal g set estatus_origen = g.estatus_base, estatus_base = gr.etiqueta
      from grupos gr
     where gr.vgroupid = g.vgroupid and g.estatus_origen is null and public.norm(g.estatus_base) = 'DISPONIBLE'
       and not exists (select 1 from public.apartados_activos a where a.clave = 'G:' || g.vgroupid);
    return null;
end $$;
drop trigger if exists exclusiones_al_cargar on public.cartera_jyp;
create trigger exclusiones_al_cargar after insert on public.cartera_jyp
    referencing new table as nuevas for each statement execute function public._tg_exclusiones_jyp();
drop trigger if exists exclusiones_al_cargar on public.cartera_grupal;
create trigger exclusiones_al_cargar after insert on public.cartera_grupal
    referencing new table as nuevas for each statement execute function public._tg_exclusiones_grupal();

-- Al liberar apartados: lo liberado que esté excluido sale de la base disponible
create or replace function public._tg_exclusiones_liberar()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if exists (select 1 from public.exclusiones_credito) then perform public.aplicar_exclusiones(); end if;
    return null;
end $$;
drop trigger if exists exclusiones_al_liberar on public.apartados_activos;
create trigger exclusiones_al_liberar after delete on public.apartados_activos
    for each statement execute function public._tg_exclusiones_liberar();

/** Carga por partes. p_filas: [{ref, fecha (YYYY-MM-DD), monto, detalle}]. Primera parte con p_reemplazar = true. */
create or replace function public.exclusiones_cargar(p_origen text, p_filas jsonb, p_reemplazar boolean default false, p_archivo text default null)
returns json language plpgsql volatile security definer set search_path = public as $$
declare n int; quien text;
begin
    perform public._exigir_activo();
    if not public._es_administrador() then raise exception 'Sólo un administrador carga exclusiones' using errcode = '42501'; end if;
    if p_origen not in ('promesa', 'pago', 'lista_negra') then raise exception 'Origen inválido: %', p_origen; end if;
    select coalesce(nombre, email) into quien from public.perfiles where user_id = auth.uid();
    if p_reemplazar then delete from public.exclusiones_credito where origen = p_origen; end if;
    insert into public.exclusiones_credito as e (vreference, origen, fecha, monto, detalle, archivo, cargado_por)
    select distinct on (ref) ref, p_origen, fecha, monto, detalle, p_archivo, quien
      from (select upper(trim(x->>'ref')) ref,
                   case when x->>'fecha' ~ '^\d{4}-\d{2}-\d{2}' then left(x->>'fecha', 10)::date end fecha,
                   nullif(x->>'monto', '')::numeric monto, left(nullif(x->>'detalle', ''), 200) detalle
              from jsonb_array_elements(p_filas) x) s
     where ref <> ''
     order by ref, fecha desc nulls last
    on conflict (vreference, origen) do update
       set fecha = greatest(e.fecha, excluded.fecha), monto = coalesce(excluded.monto, e.monto),
           detalle = coalesce(excluded.detalle, e.detalle), archivo = excluded.archivo, cargado = now(), cargado_por = excluded.cargado_por;
    get diagnostics n = row_count;
    return json_build_object('filas', n);
end $$;
revoke all on function public.exclusiones_cargar(text, jsonb, boolean, text) from public, anon;
grant execute on function public.exclusiones_cargar(text, jsonb, boolean, text) to authenticated;

create or replace function public.exclusiones_aplicar()
returns json language plpgsql volatile security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    if not public.es_admin() then raise exception 'Sólo un administrador aplica exclusiones' using errcode = '42501'; end if;
    return public.aplicar_exclusiones();
end $$;
revoke all on function public.exclusiones_aplicar() from public, anon;
grant execute on function public.exclusiones_aplicar() to authenticated;

drop function if exists public.exclusiones_resumen();
create or replace function public.exclusiones_resumen()
returns table (origen text, cargados bigint, vigentes bigint, jyp_fuera bigint, grupos_fuera bigint, archivo text, cargado timestamptz, cargado_por text, activo boolean)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    if not public.es_admin() then raise exception 'Sin acceso' using errcode = '42501'; end if;
    return query
    with v as (select * from public._exclusiones_vigentes()),
         o(origen, etiqueta, clave) as (values ('promesa', 'Promesa de pago', 'excluir_promesas'), ('pago', 'Pago reciente', 'excluir_pagos'),
                                            ('lista_negra', 'Lista negra', 'excluir_lista_negra'))
    select o.origen,
           (select count(*) from public.exclusiones_credito e where e.origen = o.origen),
           (select count(*) from v where v.etiqueta = o.etiqueta),
           (select count(*) from public.cartera_jyp j where j.estatus_origen is not null and j.estatus_base = o.etiqueta),
           (select count(distinct g.vgroupid) from public.cartera_grupal g where g.estatus_origen is not null and g.estatus_base = o.etiqueta),
           (select max(e.archivo) from public.exclusiones_credito e where e.origen = o.origen and e.cargado = (select max(cargado) from public.exclusiones_credito where exclusiones_credito.origen = o.origen)),
           (select max(e.cargado) from public.exclusiones_credito e where e.origen = o.origen),
           (select max(e.cargado_por) from public.exclusiones_credito e where e.origen = o.origen),
           public._config_si(o.clave)
      from o;
end $$;
revoke all on function public.exclusiones_resumen() from public, anon;
grant execute on function public.exclusiones_resumen() to authenticated;

/** Créditos que hoy están fuera de la base por una exclusión (para descargar). */
drop function if exists public.exclusiones_fuera();
create or replace function public.exclusiones_fuera()
returns table (tipo text, vreference text, vgroupid text, motivo text, estatus_original text, capital numeric, estado text, municipio text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    if not public.es_admin() then raise exception 'Sin acceso' using errcode = '42501'; end if;
    return query
    select 'JyP', j.vreference, null::text, j.estatus_base, j.estatus_origen, j.npendingk, j.estado, j.municipio from public.cartera_jyp j where j.estatus_origen is not null
    union all
    select 'Grupal', g.vreference, g.vgroupid, g.estatus_base, g.estatus_origen, g.npendingk, g.estado, g.municipio from public.cartera_grupal g where g.estatus_origen is not null
    order by 1, 3, 2;
end $$;
revoke all on function public.exclusiones_fuera() from public, anon;
grant execute on function public.exclusiones_fuera() to authenticated;

-- ---------- Interés de otros compradores ----------
/** Para una propuesta del comprador: cuántos OTROS compradores buscan cartera en los mismos estados
    (solicitudes abiertas) o tienen otra propuesta abierta en esos estados. No revela nombres. */
create or replace function public.portal_interes(p_folio text)
returns json language plpgsql stable security definer set search_path = public as $$
declare v bigint := public._mi_comprador(); f public.funnel_ventas; tipos text[]; est text[]; n_sol int; n_prop int; por_estado json;
begin
    if not public._config_si('portal_ver_interes') then return json_build_object('activo', false); end if;
    select * into f from public.funnel_ventas where folio = p_folio and comprador_id = v and publicada_en is not null;
    if not found then raise exception 'Propuesta no encontrada' using errcode = 'P0002'; end if;
    select array_agg(distinct d.tipo_cartera), array_agg(distinct coalesce(j.estado_n, g.estado_n)) filter (where coalesce(j.estado_n, g.estado_n) <> '')
      into tipos, est
      from public.propuesta_detalle d
      left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
      left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
     where d.id_propuesta = f.id_propuesta;
    with sol as (
        select s.comprador_id, public._sin_acentos(trim(e)) estado
          from public.solicitudes_compra s
          cross join lateral unnest(string_to_array(coalesce(nullif(s.estados, ''), '*'), ',')) e
         where s.comprador_id <> v and s.estatus in ('NUEVA', 'EN PROCESO')
           and (s.tipo_cartera = 'Cualquiera' or s.tipo_cartera = any(tipos))
    ), coinc as (
        select comprador_id, estado from sol where estado = '*' or estado = any(est)
    )
    select count(distinct comprador_id),
           (select json_agg(json_build_object('estado', initcap(lower(x.estado)), 'compradores', x.n)) from
              (select estado, count(distinct comprador_id) n from coinc where estado <> '*' group by estado order by 2 desc) x)
      into n_sol, por_estado from coinc;
    select count(distinct f2.comprador_id) into n_prop
      from public.funnel_ventas f2 join public.propuestas p on p.id_propuesta = f2.id_propuesta
     where f2.comprador_id is not null and f2.comprador_id <> v and f2.publicada_en is not null
       and public._portal_situacion(f2, p.estatus) = 'PENDIENTE'
       and exists (select 1 from public.propuesta_detalle d
                     left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
                     left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
                    where d.id_propuesta = f2.id_propuesta and coalesce(j.estado_n, g.estado_n) = any(est));
    return json_build_object('activo', true, 'solicitudes', coalesce(n_sol, 0), 'propuestas', coalesce(n_prop, 0),
        'por_estado', coalesce(por_estado, '[]'::json));
end $$;
revoke all on function public.portal_interes(text) from public, anon;
grant execute on function public.portal_interes(text) to authenticated;

-- ---------- Ofertas de precio ----------
create table if not exists public.ofertas_comprador (
    id            bigint generated always as identity primary key,
    folio         text not null references public.funnel_ventas(folio) on update cascade on delete cascade,
    comprador_id  bigint not null references public.compradores(id),
    centavos      numeric not null check (centavos > 0 and centavos < 1),
    capital       numeric,
    monto         numeric,
    comentario    text,
    estatus       text not null default 'NUEVA' check (estatus in ('NUEVA', 'ACEPTADA', 'RECHAZADA', 'CONTRAOFERTA', 'RETIRADA')),
    respuesta     text,
    contra_centavos numeric,
    respondida_por text,
    respondida_en timestamptz,
    fecha         timestamptz not null default now()
);
create index if not exists ofertas_comprador_folio on public.ofertas_comprador (folio);
alter table public.ofertas_comprador enable row level security;
revoke all on public.ofertas_comprador from anon, authenticated;

/** El comprador oferta centavos por peso de capital (p_centavos = 0.15 → 15 ¢). Una oferta abierta por propuesta. */
create or replace function public.portal_ofertar(p_folio text, p_centavos numeric, p_comentario text default '')
returns json language plpgsql volatile security definer set search_path = public as $$
declare v bigint := public._mi_comprador(); f public.funnel_ventas; p public.propuestas; cap numeric; id_o bigint; nom text;
begin
    if not public._config_si('portal_ofertas') then raise exception 'Las ofertas no están habilitadas' using errcode = '42501'; end if;
    if p_centavos is null or p_centavos <= 0 or p_centavos >= 1 then raise exception 'La oferta debe ser entre 1 y 99 centavos por peso'; end if;
    select * into f from public.funnel_ventas where folio = p_folio and comprador_id = v and publicada_en is not null;
    if not found then raise exception 'Propuesta no encontrada' using errcode = 'P0002'; end if;
    select * into p from public.propuestas where id_propuesta = f.id_propuesta;
    if public._portal_situacion(f, p.estatus) <> 'PENDIENTE' then raise exception 'Sólo se oferta en propuestas por responder'; end if;
    cap := coalesce((select sum(d.npendingk) from public.propuesta_detalle d where d.id_propuesta = f.id_propuesta), f.capital);
    update public.ofertas_comprador set estatus = 'RETIRADA' where folio = p_folio and comprador_id = v and estatus in ('NUEVA', 'CONTRAOFERTA');
    insert into public.ofertas_comprador (folio, comprador_id, centavos, capital, monto, comentario)
    values (p_folio, v, round(p_centavos, 4), cap, round(cap * p_centavos, 2), nullif(trim(p_comentario), ''))
    returning id into id_o;
    select nombre into nom from public.compradores where id = v;
    perform public._notificar(array['validador'], p.user_id, '💰 Oferta de comprador: ' || p_folio,
        coalesce(nom, '') || ' ofrece ' || to_char(p_centavos * 100, 'FM990.0') || ' ¢ por peso (' ||
        to_char(cap * p_centavos, 'FM$999,999,990.00') || ')' || coalesce(' · «' || nullif(trim(p_comentario), '') || '»', ''), 'compradores');
    return json_build_object('id', id_o, 'monto', round(cap * p_centavos, 2), 'capital', cap);
end $$;
revoke all on function public.portal_ofertar(text, numeric, text) from public, anon;
grant execute on function public.portal_ofertar(text, numeric, text) to authenticated;

drop function if exists public.portal_mis_ofertas();
create or replace function public.portal_mis_ofertas()
returns table (id bigint, folio text, centavos numeric, monto numeric, comentario text, estatus text, respuesta text, contra_centavos numeric, fecha timestamptz, respondida_en timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v bigint := public._mi_comprador();
begin
    return query select o.id, o.folio, o.centavos, o.monto, o.comentario, o.estatus, o.respuesta, o.contra_centavos, o.fecha, o.respondida_en
      from public.ofertas_comprador o where o.comprador_id = v and o.estatus <> 'RETIRADA' order by o.fecha desc;
end $$;
revoke all on function public.portal_mis_ofertas() from public, anon;
grant execute on function public.portal_mis_ofertas() to authenticated;

/** Interno: ofertas (el vendedor ve las de sus propuestas; validador / admin todas). */
drop function if exists public.ofertas_lista(boolean);
create or replace function public.ofertas_lista(p_todas boolean default false)
returns table (id bigint, folio text, comprador text, nivel text, centavos numeric, capital numeric, monto numeric, centavos_propuesta numeric,
               precio_propuesta numeric, comentario text, estatus text, respuesta text, contra_centavos numeric, respondida_por text,
               respondida_en timestamptz, fecha timestamptz, vendedor text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    select o.id, o.folio, c.nombre, (public._nivel_comprador(o.comprador_id))->>'nivel', o.centavos, o.capital, o.monto, p.centavos, f.monto_venta,
           o.comentario, o.estatus, o.respuesta, o.contra_centavos, o.respondida_por, o.respondida_en, o.fecha, p.usuario
      from public.ofertas_comprador o
      join public.compradores c on c.id = o.comprador_id
      join public.funnel_ventas f on f.folio = o.folio
      left join public.propuestas p on p.id_propuesta = f.id_propuesta
     where o.estatus <> 'RETIRADA'
       and (public.es_admin() or public.tiene_rol(array['auxiliar']) or p.user_id = auth.uid() or c.vendedor_user = auth.uid())
       and (p_todas or o.estatus in ('NUEVA', 'CONTRAOFERTA'))
     order by (o.estatus = 'NUEVA') desc, o.fecha desc;
end $$;
revoke all on function public.ofertas_lista(boolean) from public, anon;
grant execute on function public.ofertas_lista(boolean) to authenticated;

/** Responder una oferta: ACEPTADA / RECHAZADA / CONTRAOFERTA (con p_contra en fracción, 0.16). Avisa al comprador.
    Aceptar NO cambia el precio de la propuesta: el precio se autoriza en Revisión como siempre. */
create or replace function public.oferta_responder(p_id bigint, p_estatus text, p_respuesta text default '', p_contra numeric default null)
returns void language plpgsql volatile security definer set search_path = public as $$
declare o public.ofertas_comprador; p public.propuestas; quien text;
begin
    perform public._exigir_activo();
    select * into o from public.ofertas_comprador where id = p_id;
    if not found then raise exception 'Oferta no encontrada'; end if;
    select p2.* into p from public.propuestas p2 join public.funnel_ventas f on f.id_propuesta = p2.id_propuesta where f.folio = o.folio;
    if not (public.es_admin() or p.user_id = auth.uid() or exists (select 1 from public.compradores c where c.id = o.comprador_id and c.vendedor_user = auth.uid())) then
        raise exception 'Sólo el vendedor de la propuesta o un administrador responde la oferta' using errcode = '42501';
    end if;
    if p_estatus not in ('ACEPTADA', 'RECHAZADA', 'CONTRAOFERTA') then raise exception 'Respuesta inválida'; end if;
    if p_estatus = 'CONTRAOFERTA' and (p_contra is null or p_contra <= 0 or p_contra >= 1) then raise exception 'Indica la contraoferta en centavos (1 a 99)'; end if;
    select coalesce(nombre, email) into quien from public.perfiles where user_id = auth.uid();
    update public.ofertas_comprador set estatus = p_estatus, respuesta = nullif(trim(p_respuesta), ''),
           contra_centavos = case when p_estatus = 'CONTRAOFERTA' then round(p_contra, 4) end,
           respondida_por = quien, respondida_en = now()
     where id = p_id;
    perform public._notificar_comprador(o.comprador_id,
        case p_estatus when 'ACEPTADA' then '✅ Aceptamos tu oferta en ' when 'RECHAZADA' then 'Tu oferta en ' else '💬 Contraoferta en ' end || o.folio ||
        case p_estatus when 'RECHAZADA' then ' no fue aceptada' else '' end,
        case p_estatus when 'CONTRAOFERTA' then 'Te proponemos ' || to_char(p_contra * 100, 'FM990.0') || ' ¢ por peso. ' else '' end ||
        coalesce(nullif(trim(p_respuesta), ''), case p_estatus when 'ACEPTADA' then 'Tu ejecutivo te confirmará el precio final.' else '' end),
        'propuestas');
end $$;
revoke all on function public.oferta_responder(bigint, text, text, numeric) from public, anon;
grant execute on function public.oferta_responder(bigint, text, text, numeric) to authenticated;

-- ---------- Noticias: casos de éxito de demandas digitales ----------
create table if not exists public.noticias_portal (
    id         bigint generated always as identity primary key,
    titulo     text not null,
    resumen    text,
    contenido  text,
    categoria  text not null default 'Caso de éxito',
    enlace     text,
    fecha      date not null default (now() at time zone 'America/Mexico_City')::date,
    publicado  boolean not null default false,
    creado_por text,
    actualizado timestamptz not null default now()
);
alter table public.noticias_portal enable row level security;
revoke all on public.noticias_portal from anon, authenticated;

drop function if exists public.noticias_lista();
create or replace function public.noticias_lista()
returns setof public.noticias_portal language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    if not public.es_admin() then raise exception 'Sin acceso' using errcode = '42501'; end if;
    return query select * from public.noticias_portal order by fecha desc, id desc;
end $$;
revoke all on function public.noticias_lista() from public, anon;
grant execute on function public.noticias_lista() to authenticated;

create or replace function public.noticia_guardar(p jsonb)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare v_id bigint := nullif(p->>'id', '')::bigint; quien text;
begin
    perform public._exigir_activo();
    if not public.es_admin() then raise exception 'Sólo un administrador publica noticias' using errcode = '42501'; end if;
    if nullif(trim(p->>'titulo'), '') is null then raise exception 'La noticia necesita título'; end if;
    if nullif(p->>'enlace', '') is not null and p->>'enlace' !~* '^https://' then raise exception 'El enlace debe empezar con https://'; end if;
    select coalesce(nombre, email) into quien from public.perfiles where user_id = auth.uid();
    if v_id is null then
        insert into public.noticias_portal (titulo, resumen, contenido, categoria, enlace, fecha, publicado, creado_por)
        values (trim(p->>'titulo'), nullif(trim(p->>'resumen'), ''), nullif(trim(p->>'contenido'), ''), coalesce(nullif(trim(p->>'categoria'), ''), 'Caso de éxito'),
                nullif(trim(p->>'enlace'), ''), coalesce(nullif(p->>'fecha', '')::date, (now() at time zone 'America/Mexico_City')::date),
                coalesce((p->>'publicado')::boolean, false), quien)
        returning id into v_id;
    else
        update public.noticias_portal set titulo = trim(p->>'titulo'), resumen = nullif(trim(p->>'resumen'), ''), contenido = nullif(trim(p->>'contenido'), ''),
               categoria = coalesce(nullif(trim(p->>'categoria'), ''), 'Caso de éxito'), enlace = nullif(trim(p->>'enlace'), ''),
               fecha = coalesce(nullif(p->>'fecha', '')::date, fecha), publicado = coalesce((p->>'publicado')::boolean, publicado), actualizado = now()
         where id = v_id;
    end if;
    return v_id;
end $$;
revoke all on function public.noticia_guardar(jsonb) from public, anon;
grant execute on function public.noticia_guardar(jsonb) to authenticated;

create or replace function public.noticia_borrar(p_id bigint)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    if not public.es_admin() then raise exception 'Sin acceso' using errcode = '42501'; end if;
    delete from public.noticias_portal where id = p_id;
end $$;
revoke all on function public.noticia_borrar(bigint) from public, anon;
grant execute on function public.noticia_borrar(bigint) to authenticated;

drop function if exists public.portal_noticias();
create or replace function public.portal_noticias()
returns table (id bigint, titulo text, resumen text, contenido text, categoria text, enlace text, fecha date)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._mi_comprador();
    return query select n.id, n.titulo, n.resumen, n.contenido, n.categoria, n.enlace, n.fecha
      from public.noticias_portal n where n.publicado order by n.fecha desc, n.id desc limit 12;
end $$;
revoke all on function public.portal_noticias() from public, anon;
grant execute on function public.portal_noticias() to authenticated;

-- ---------- Programa de lealtad ----------
create table if not exists public.lealtad_niveles (
    nivel        text primary key,
    orden        int not null,
    compras_min  int not null default 0,        -- compras (Vendida) en los últimos 12 meses
    monto_min    numeric not null default 0,    -- o monto comprado en 12 meses
    descuento_centavos numeric not null default 0,  -- centavos por peso que se descuentan del precio de lista
    dias_anticipo int not null default 0,       -- días de acceso anticipado a cartera nueva
    beneficios   text,
    color        text
);
alter table public.lealtad_niveles enable row level security;
revoke all on public.lealtad_niveles from anon, authenticated;
insert into public.lealtad_niveles (nivel, orden, compras_min, monto_min, descuento_centavos, dias_anticipo, beneficios, color) values
    ('Inicial', 0, 0, 0,       0,     0, 'Atención de tu ejecutivo y seguimiento de tus compras en el portal.', '#8a8f98'),
    ('Bronce',  1, 2, 100000,  0.005, 0, 'Medio centavo de descuento por peso · tus solicitudes se atienden primero.', '#b0773b'),
    ('Plata',   2, 4, 300000,  0.01,  1, '1 centavo de descuento · 24 h de acceso anticipado a cartera nueva de tu zona · expedientes prioritarios.', '#8c9aa8'),
    ('Oro',     3, 8, 800000,  0.02,  2, '2 centavos de descuento · 48 h de acceso anticipado · restitución exprés · ejecutivo dedicado.', '#c9a227')
on conflict (nivel) do nothing;

/** Nivel de un comprador según sus compras (Vendida) de los últimos 12 meses. */
create or replace function public._nivel_comprador(p_comprador bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare n int; m numeric; act public.lealtad_niveles; sig public.lealtad_niveles;
begin
    select count(*), coalesce(sum(monto_venta), 0) into n, m from public.funnel_ventas
     where comprador_id = p_comprador and estatus_venta = 'Vendida'
       and coalesce(fecha_venta, fecha_propuesta) >= (now() at time zone 'America/Mexico_City')::date - 365;
    select * into act from public.lealtad_niveles where n >= compras_min or (monto_min > 0 and m >= monto_min) or orden = 0 order by orden desc limit 1;
    select * into sig from public.lealtad_niveles where orden > coalesce(act.orden, 0) order by orden limit 1;
    return jsonb_build_object('nivel', act.nivel, 'color', act.color, 'compras_12m', n, 'monto_12m', m,
        'descuento_centavos', act.descuento_centavos, 'dias_anticipo', act.dias_anticipo, 'beneficios', act.beneficios,
        'siguiente', case when sig.nivel is null then null else jsonb_build_object('nivel', sig.nivel,
            'faltan_compras', greatest(sig.compras_min - n, 0), 'faltan_monto', greatest(sig.monto_min - m, 0), 'beneficios', sig.beneficios) end);
end $$;
revoke all on function public._nivel_comprador(bigint) from public, anon, authenticated;

create or replace function public.portal_mi_nivel()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v bigint := public._mi_comprador();
begin
    if not public._config_si('portal_lealtad') then return jsonb_build_object('activo', false); end if;
    return public._nivel_comprador(v) || jsonb_build_object('activo', true,
        'niveles', (select jsonb_agg(jsonb_build_object('nivel', nivel, 'compras_min', compras_min, 'monto_min', monto_min,
                     'beneficios', beneficios, 'color', color) order by orden) from public.lealtad_niveles));
end $$;
revoke all on function public.portal_mi_nivel() from public, anon;
grant execute on function public.portal_mi_nivel() to authenticated;

drop function if exists public.lealtad_lista();
create or replace function public.lealtad_lista()
returns table (nivel text, orden int, compras_min int, monto_min numeric, descuento_centavos numeric, dias_anticipo int, beneficios text, color text, compradores bigint)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    with nv as (select (public._nivel_comprador(c.id))->>'nivel' nivel from public.compradores c where c.activo)
    select l.nivel, l.orden, l.compras_min, l.monto_min, l.descuento_centavos, l.dias_anticipo, l.beneficios, l.color,
           (select count(*) from nv where nv.nivel = l.nivel)
      from public.lealtad_niveles l order by l.orden;
end $$;
revoke all on function public.lealtad_lista() from public, anon;
grant execute on function public.lealtad_lista() to authenticated;

drop function if exists public.lealtad_compradores();
create or replace function public.lealtad_compradores()
returns table (id bigint, comprador text, nivel text, color text, compras_12m int, monto_12m numeric, descuento_centavos numeric, siguiente text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
    select c.id, c.nombre, x->>'nivel', x->>'color', (x->>'compras_12m')::int, (x->>'monto_12m')::numeric, (x->>'descuento_centavos')::numeric,
           case when x->'siguiente' is null or x->'siguiente' = 'null'::jsonb then null
                else (x->'siguiente'->>'nivel') || ': faltan ' || (x->'siguiente'->>'faltan_compras') || ' compra(s) o ' ||
                     to_char((x->'siguiente'->>'faltan_monto')::numeric, 'FM$999,999,990') end
      from public.compradores c, lateral public._nivel_comprador(c.id) x
     where c.activo
     order by (x->>'monto_12m')::numeric desc, c.nombre;
end $$;
revoke all on function public.lealtad_compradores() from public, anon;
grant execute on function public.lealtad_compradores() to authenticated;

create or replace function public.lealtad_guardar(p_niveles jsonb)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    if not public.es_admin() then raise exception 'Sólo un administrador cambia los niveles' using errcode = '42501'; end if;
    update public.lealtad_niveles l set
           compras_min = coalesce((x->>'compras_min')::int, l.compras_min),
           monto_min = coalesce((x->>'monto_min')::numeric, l.monto_min),
           descuento_centavos = coalesce((x->>'descuento_centavos')::numeric, l.descuento_centavos),
           dias_anticipo = coalesce((x->>'dias_anticipo')::int, l.dias_anticipo),
           beneficios = coalesce(x->>'beneficios', l.beneficios)
      from jsonb_array_elements(p_niveles) x
     where l.nivel = x->>'nivel';
end $$;
revoke all on function public.lealtad_guardar(jsonb) from public, anon;
grant execute on function public.lealtad_guardar(jsonb) to authenticated;

-- ---------- Portal: inicio con nivel y noticias ----------
create or replace function public.portal_config()
returns json language plpgsql stable security definer set search_path = public as $$
begin
    perform public._mi_comprador();
    return json_build_object('ver_interes', public._config_si('portal_ver_interes'), 'ofertas', public._config_si('portal_ofertas'),
                             'lealtad', public._config_si('portal_lealtad'));
end $$;
revoke all on function public.portal_config() from public, anon;
grant execute on function public.portal_config() to authenticated;
