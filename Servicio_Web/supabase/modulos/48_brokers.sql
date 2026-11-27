-- ============================================================
-- BROKERS DE VENTA
--  - brokers: catálogo (datos, estatus de validación). Usuarios con rol «broker» ligados por perfiles.broker_id.
--  - broker_documentos: mismos documentos que al comprador (INE, constancia fiscal, comprobante de domicilio,
--    formato de alta y NDA). Se suben al bucket «documentos-venta» en BRK-<id>/<tipo>/…
--    Validación: cada documento se aprueba o rechaza (con motivo); con todos aprobados el maestro valida al broker.
--    Estatus del broker: documentos → revision (subió todo) → validado | rechazado; suspendido apaga el acceso.
--  - Panel del broker: resumen de la cartera disponible JyP y Grupal (créditos, grupos, capital, mora, por estado).
--  - Propuesta de inversión: elige tipo(s), estado(s) y municipio(s) (y tope opcional) y se arma sola a
--    $0.14 por peso de capital JyP y $0.26 Grupal (config_app: broker_centavos_jyp / broker_centavos_grupal).
--    Sólo un broker validado puede enviarla; el maestro la acepta o rechaza y descarga los créditos.
-- Requiere 23, 25, 42, 46. Idempotente.
-- ============================================================

-- ---------- rol broker ----------
alter table public.perfiles drop constraint if exists perfiles_rol_check;
alter table public.perfiles add constraint perfiles_rol_check
    check (rol in ('vendedor', 'validador', 'auxiliar', 'control_doc', 'admin', 'comprador', 'abogado', 'coord_juridico', 'broker'));

-- Usuario INTERNO (compradores, brokers y jurídico no cuentan)
create or replace function public.es_activo() returns boolean
language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.perfiles where user_id = auth.uid() and activo
                   and rol not in ('comprador', 'abogado', 'coord_juridico', 'broker'))
$$;

create table if not exists public.brokers (
    id             bigserial primary key,
    nombre         text not null,
    empresa        text,
    rfc            text,
    correo         text,
    telefono       text,
    notas          text,
    estatus        text not null default 'documentos'
                   check (estatus in ('documentos', 'revision', 'validado', 'rechazado', 'suspendido')),
    motivo         text,
    validado_por   text,
    validado_fecha timestamptz,
    creado         timestamptz not null default now(),
    creado_por     text
);
alter table public.brokers enable row level security;
revoke all on public.brokers from anon, authenticated;

alter table public.perfiles add column if not exists broker_id bigint references public.brokers (id) on delete set null;

create table if not exists public.broker_documentos (
    id             bigserial primary key,
    broker_id      bigint not null references public.brokers (id) on delete cascade,
    tipo           text not null check (tipo in ('ine', 'comprobante_fiscal', 'comprobante_domicilio', 'alta_comprador', 'nda')),
    nombre         text not null,
    ruta           text not null unique,
    mime           text,
    bytes          integer,
    estatus        text not null default 'pendiente' check (estatus in ('pendiente', 'aprobado', 'rechazado')),
    comentario     text,
    revisado_por   text,
    revisado_fecha timestamptz,
    user_id        uuid,
    subido_por     text,
    fecha          timestamptz not null default now()
);
create index if not exists broker_documentos_broker on public.broker_documentos (broker_id, tipo);
alter table public.broker_documentos enable row level security;
revoke all on public.broker_documentos from anon, authenticated;

create table if not exists public.broker_propuestas (
    id               bigserial primary key,
    folio            text unique,
    broker_id        bigint not null references public.brokers (id) on delete cascade,
    filtros          jsonb not null,
    resumen          jsonb not null,
    claves           text[] not null default '{}',
    creditos         integer not null default 0,
    grupos           integer not null default 0,
    capital          numeric not null default 0,
    monto            numeric not null default 0,
    estatus          text not null default 'enviada' check (estatus in ('enviada', 'aceptada', 'rechazada', 'cancelada')),
    comentario       text,
    respuesta        text,
    respondido_por   text,
    respondido_fecha timestamptz,
    user_id          uuid,
    creado           timestamptz not null default now()
);
create index if not exists broker_propuestas_broker on public.broker_propuestas (broker_id, creado desc);
alter table public.broker_propuestas enable row level security;
revoke all on public.broker_propuestas from anon, authenticated;

insert into public.config_app (clave, valor, descripcion) values
    ('broker_centavos_jyp', '0.14', 'Brokers: precio por peso de capital JyP en la propuesta de inversión'),
    ('broker_centavos_grupal', '0.26', 'Brokers: precio por peso de capital Grupal en la propuesta de inversión')
on conflict (clave) do nothing;

-- ---------- ayudas ----------
create or replace function public._broker_docs_requeridos() returns text[]
language sql immutable as $$ select array['ine', 'comprobante_fiscal', 'comprobante_domicilio', 'alta_comprador', 'nda'] $$;

create or replace function public._mi_broker() returns bigint
language plpgsql stable security definer set search_path = public as $$
declare v bigint;
begin
    select p.broker_id into v from public.perfiles p join public.brokers b on b.id = p.broker_id and b.estatus <> 'suspendido'
     where p.user_id = auth.uid() and p.activo and p.rol = 'broker';
    if v is null then raise exception 'Usuario sin acceso al portal de brokers' using errcode = '42501'; end if;
    return v;
end $$;

-- Ruta BRK-<id>: el broker dueño o un maestro (escribir); internos activos sólo ven. Nunca lanza error (se usa en políticas).
create or replace function public._broker_ruta_ok(p_raiz text, p_escribir boolean) returns boolean
language sql stable security definer set search_path = public as $$
    select p_raiz like 'BRK-%' and (
        public.es_admin()
        or (not p_escribir and public.es_activo())
        or exists (select 1 from public.perfiles p join public.brokers b on b.id = p.broker_id
                    where p.user_id = auth.uid() and p.activo and p.rol = 'broker' and b.estatus <> 'suspendido'
                      and 'BRK-' || p.broker_id = p_raiz))
$$;

drop policy if exists "documentos_broker_ver" on storage.objects;
create policy "documentos_broker_ver" on storage.objects for select to authenticated
    using (bucket_id = 'documentos-venta' and public._broker_ruta_ok(split_part(name, '/', 1), false));
drop policy if exists "documentos_broker_subir" on storage.objects;
create policy "documentos_broker_subir" on storage.objects for insert to authenticated
    with check (bucket_id = 'documentos-venta' and public._broker_ruta_ok(split_part(name, '/', 1), true)
                and split_part(name, '/', 2) = any (public._broker_docs_requeridos()));
drop policy if exists "documentos_broker_borrar" on storage.objects;
create policy "documentos_broker_borrar" on storage.objects for delete to authenticated
    using (bucket_id = 'documentos-venta' and public._broker_ruta_ok(split_part(name, '/', 1), true));

-- Avisar a los usuarios del broker
create or replace function public._notificar_broker(p_broker bigint, p_titulo text, p_mensaje text, p_enlace text)
returns void language sql volatile security definer set search_path = public as $$
    insert into public.notificaciones (user_id, titulo, mensaje, enlace)
    select p.user_id, p_titulo, p_mensaje, p_enlace from public.perfiles p
     where p.broker_id = p_broker and p.rol = 'broker' and p.activo and p.user_id is distinct from auth.uid()
$$;

-- Avance de documentos: por tipo, el último documento y su estatus
create or replace function public._broker_avance(p_broker bigint) returns jsonb
language sql stable security definer set search_path = public as $$
    with t as (select unnest(public._broker_docs_requeridos()) tipo, generate_subscripts(public._broker_docs_requeridos(), 1) orden),
    u as (select distinct on (d.tipo) d.tipo, d.estatus, d.comentario from public.broker_documentos d
           where d.broker_id = p_broker order by d.tipo, (d.estatus = 'aprobado') desc, d.fecha desc)
    select jsonb_build_object(
        'tipos', jsonb_agg(jsonb_build_object('tipo', t.tipo, 'estatus', coalesce(u.estatus, 'falta'), 'comentario', u.comentario) order by t.orden),
        'subidos', count(u.tipo) filter (where u.estatus <> 'rechazado'),
        'aprobados', count(u.tipo) filter (where u.estatus = 'aprobado'),
        'requeridos', count(*))
      from t left join u on u.tipo = t.tipo
$$;

-- Unidades vendibles: crédito JyP o grupo completo disponible, sin apartar ni bloquear
create or replace function public._broker_unidades()
returns table (tipo text, clave text, estado_n text, municipio_n text, capital numeric, dias numeric, creditos bigint)
language sql stable security definer set search_path = public as $$
    select 'JyP', 'J:' || j.vreference, j.estado_n, j.municipio_n, j.npendingk, j.dias::numeric, 1::bigint
      from public.cartera_jyp j
     where j.disponible and length(coalesce(j.estado_n, '')) > 3
       and not exists (select 1 from public.apartados_activos a where a.clave = 'J:' || j.vreference)
       and not exists (select 1 from public.bloqueados b where b.clave = 'J:' || j.vreference)
    union all
    select 'Grupal', 'G:' || g.vgroupid, min(g.estado_n), min(g.municipio_n), sum(g.npendingk), round(avg(g.dias), 0), count(*)
      from public.cartera_grupal g
     group by g.vgroupid
    having bool_and(g.disponible) and length(coalesce(min(g.estado_n), '')) > 3
       and not exists (select 1 from public.apartados_activos a where a.clave = 'G:' || g.vgroupid)
       and not exists (select 1 from public.bloqueados b where b.clave = 'G:' || g.vgroupid)
$$;
revoke all on function public._broker_unidades() from public, anon, authenticated;

create or replace function public._broker_tarifas() returns jsonb
language sql stable security definer set search_path = public as $$
    select jsonb_build_object('JyP', public._num_config('broker_centavos_jyp', 0.14), 'Grupal', public._num_config('broker_centavos_grupal', 0.26))
$$;

-- ---------- panel del broker ----------
create or replace function public.broker_inicio() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v bigint := public._mi_broker(); b public.brokers;
begin
    select * into b from public.brokers where id = v;
    return jsonb_build_object('id', b.id, 'broker', b.nombre, 'empresa', b.empresa, 'estatus', b.estatus, 'motivo', b.motivo,
        'avance', public._broker_avance(v), 'tarifas', public._broker_tarifas(),
        'propuestas', (select count(*) from public.broker_propuestas where broker_id = v and estatus <> 'cancelada'),
        'propuestas_abiertas', (select count(*) from public.broker_propuestas where broker_id = v and estatus = 'enviada'),
        'monto_aceptado', (select coalesce(sum(monto), 0) from public.broker_propuestas where broker_id = v and estatus = 'aceptada'));
end $$;

create or replace function public.broker_resumen_cartera() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare t jsonb; r jsonb;
begin
    if not public.es_activo() then perform public._mi_broker(); end if;
    t := public._broker_tarifas();
    create temp table if not exists _bu on commit drop as select * from public._broker_unidades() limit 0;
    truncate _bu;
    insert into _bu select * from public._broker_unidades();
    select jsonb_build_object(
        'tarifas', t,
        'tipos', (select jsonb_agg(jsonb_build_object('tipo', x.tipo, 'creditos', x.cr, 'grupos', x.gr, 'capital', round(x.cap, 2),
                     'dias', x.d, 'estados', x.est, 'municipios', x.mun, 'precio', round(x.cap * (t->>x.tipo)::numeric, 2)) order by x.tipo desc)
                    from (select u.tipo, sum(u.creditos) cr, count(*) filter (where u.tipo = 'Grupal') gr, sum(u.capital) cap,
                                 round(sum(u.dias * u.creditos) / nullif(sum(u.creditos), 0), 0) d,
                                 count(distinct u.estado_n) est, count(distinct (u.estado_n, u.municipio_n)) mun
                            from _bu u group by u.tipo) x),
        'mora', (select jsonb_agg(jsonb_build_object('tipo', x.tipo, 'tramo', x.tramo, 'creditos', x.cr, 'capital', round(x.cap, 2)) order by x.tipo desc, x.o)
                   from (select u.tipo,
                                case when u.dias <= 90 then '0-90' when u.dias <= 180 then '91-180' when u.dias <= 360 then '181-360' else '361+' end tramo,
                                case when u.dias <= 90 then 1 when u.dias <= 180 then 2 when u.dias <= 360 then 3 else 4 end o,
                                sum(u.creditos) cr, sum(u.capital) cap
                           from _bu u group by 1, 2, 3) x),
        'estados', (select jsonb_agg(jsonb_build_object('clave', e.estado_n, 'estado', initcap(lower(e.estado_n)),
                        'jyp', jsonb_build_object('creditos', e.jc, 'capital', round(e.jk, 2)),
                        'grupal', jsonb_build_object('creditos', e.gc, 'grupos', e.gg, 'capital', round(e.gk, 2)),
                        'capital', round(e.jk + e.gk, 2), 'municipios', e.mun) order by e.jk + e.gk desc)
                      from (select u.estado_n,
                                   coalesce(sum(u.creditos) filter (where u.tipo = 'JyP'), 0) jc, coalesce(sum(u.capital) filter (where u.tipo = 'JyP'), 0) jk,
                                   coalesce(sum(u.creditos) filter (where u.tipo = 'Grupal'), 0) gc, count(*) filter (where u.tipo = 'Grupal') gg,
                                   coalesce(sum(u.capital) filter (where u.tipo = 'Grupal'), 0) gk,
                                   (select jsonb_agg(jsonb_build_object('clave', m.municipio_n, 'municipio', initcap(lower(m.municipio_n)),
                                            'jyp', m.jk, 'grupal', m.gk, 'creditos', m.cr) order by m.jk + m.gk desc)
                                      from (select u2.municipio_n, sum(u2.creditos) cr,
                                                   round(coalesce(sum(u2.capital) filter (where u2.tipo = 'JyP'), 0), 2) jk,
                                                   round(coalesce(sum(u2.capital) filter (where u2.tipo = 'Grupal'), 0), 2) gk
                                              from _bu u2 where u2.estado_n = u.estado_n group by u2.municipio_n) m) mun
                              from _bu u group by u.estado_n) e))
      into r;
    return r;
end $$;

-- Arma la propuesta: p = {tipos:[JyP,Grupal], estados:[clave], municipios:["ESTADO|MUNICIPIO"], tope:numero}
-- Con tope se toman primero los de menor mora (y mayor capital) hasta no pasar el monto.
create or replace function public._broker_calcular(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare t jsonb := public._broker_tarifas(); v_tipos text[]; v_est text[]; v_mun text[]; v_tope numeric; r jsonb;
begin
    v_tipos := coalesce((select array_agg(x) from jsonb_array_elements_text(p->'tipos') x where x in ('JyP', 'Grupal')), '{}');
    if cardinality(v_tipos) = 0 then v_tipos := array['JyP', 'Grupal']; end if;
    v_est := coalesce((select array_agg(x) from jsonb_array_elements_text(p->'estados') x), '{}');
    v_mun := coalesce((select array_agg(x) from jsonb_array_elements_text(p->'municipios') x), '{}');
    v_tope := nullif(public._num(p->>'tope'), 0);
    if cardinality(v_est) = 0 then raise exception 'Elige al menos un estado'; end if;
    with u as (
        select u.*, round(u.capital * (t->>u.tipo)::numeric, 2) precio
          from public._broker_unidades() u
         where u.tipo = any (v_tipos) and u.estado_n = any (v_est)
           and (cardinality(v_mun) = 0
                or u.estado_n || '|' || u.municipio_n = any (v_mun)
                -- estados elegidos sin ningún municipio marcado entran completos
                or not exists (select 1 from unnest(v_mun) m where split_part(m, '|', 1) = u.estado_n))
    ), s as (
        select u.*, sum(u.precio) over (order by u.dias, u.capital desc, u.clave rows unbounded preceding) acum from u
    ), f as (select * from s where v_tope is null or s.acum <= v_tope)
    select jsonb_build_object(
        'tarifas', t, 'tope', v_tope,
        'creditos', coalesce(sum(f.creditos), 0), 'grupos', count(*) filter (where f.tipo = 'Grupal'),
        'capital', round(coalesce(sum(f.capital), 0), 2), 'monto', round(coalesce(sum(f.precio), 0), 2),
        'dias', round(sum(f.dias * f.creditos) / nullif(sum(f.creditos), 0), 0),
        'por_tipo', (select jsonb_agg(jsonb_build_object('tipo', x.tipo, 'creditos', x.cr, 'grupos', x.gr, 'capital', round(x.cap, 2),
                        'centavos', (t->>x.tipo)::numeric, 'monto', round(x.pr, 2)) order by x.tipo desc)
                       from (select f2.tipo, sum(f2.creditos) cr, count(*) filter (where f2.tipo = 'Grupal') gr, sum(f2.capital) cap, sum(f2.precio) pr
                               from f f2 group by f2.tipo) x),
        'lineas', (select jsonb_agg(jsonb_build_object('tipo', x.tipo, 'estado', initcap(lower(x.estado_n)), 'municipio', initcap(lower(x.municipio_n)),
                        'creditos', x.cr, 'grupos', x.gr, 'capital', round(x.cap, 2), 'dias', x.d, 'monto', round(x.pr, 2))
                        order by x.tipo desc, x.estado_n, x.cap desc)
                     from (select f2.tipo, f2.estado_n, f2.municipio_n, sum(f2.creditos) cr, count(*) filter (where f2.tipo = 'Grupal') gr,
                                  sum(f2.capital) cap, sum(f2.precio) pr, round(sum(f2.dias * f2.creditos) / nullif(sum(f2.creditos), 0), 0) d
                             from f f2 group by 1, 2, 3) x),
        'claves', coalesce(array_to_json(array_agg(f.clave))::jsonb, '[]'::jsonb))
      into r from f;
    return r;
end $$;
revoke all on function public._broker_calcular(jsonb) from public, anon, authenticated;

create or replace function public.broker_simular(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
    if not public.es_activo() then perform public._mi_broker(); end if;
    return public._broker_calcular(p) - 'claves';
end $$;

create or replace function public.broker_generar_propuesta(p jsonb, p_comentario text default null) returns text
language plpgsql volatile security definer set search_path = public as $$
declare v bigint := public._mi_broker(); b public.brokers; r jsonb; v_id bigint; v_folio text;
begin
    select * into b from public.brokers where id = v;
    if b.estatus <> 'validado' then
        raise exception 'Tu documentación todavía no está validada; podrás enviar propuestas cuando se apruebe' using errcode = '42501';
    end if;
    r := public._broker_calcular(p);
    if coalesce((r->>'creditos')::int, 0) = 0 then raise exception 'No hay cartera disponible con esos filtros'; end if;
    insert into public.broker_propuestas (broker_id, filtros, resumen, claves, creditos, grupos, capital, monto, comentario, user_id)
    values (v, p, r - 'claves', (select array_agg(x) from jsonb_array_elements_text(r->'claves') x),
            (r->>'creditos')::int, (r->>'grupos')::int, (r->>'capital')::numeric, (r->>'monto')::numeric, nullif(trim(p_comentario), ''), auth.uid())
    returning id into v_id;
    v_folio := 'INV-' || lpad(v_id::text, 4, '0');
    update public.broker_propuestas set folio = v_folio where id = v_id;
    perform public._notificar(array['validador'], null, 'Propuesta de inversión de broker',
        format('%s envió %s: %s créditos, capital %s, monto %s.', b.nombre, v_folio, r->>'creditos',
               to_char((r->>'capital')::numeric, 'FM$999,999,999,990.00'), to_char((r->>'monto')::numeric, 'FM$999,999,999,990.00')),
        '#/brokers');
    return v_folio;
end $$;

create or replace function public.broker_mis_propuestas()
returns table (id bigint, folio text, creado timestamptz, filtros jsonb, resumen jsonb, creditos integer, grupos integer,
               capital numeric, monto numeric, estatus text, comentario text, respuesta text, respondido_fecha timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v bigint := public._mi_broker();
begin
    return query select x.id, x.folio, x.creado, x.filtros, x.resumen, x.creditos, x.grupos, x.capital, x.monto, x.estatus,
                        x.comentario, x.respuesta, x.respondido_fecha
                   from public.broker_propuestas x where x.broker_id = v order by x.creado desc;
end $$;

create or replace function public.broker_cancelar_propuesta(p_id bigint) returns void
language plpgsql volatile security definer set search_path = public as $$
declare v bigint := public._mi_broker();
begin
    update public.broker_propuestas set estatus = 'cancelada' where id = p_id and broker_id = v and estatus = 'enviada';
    if not found then raise exception 'Sólo se pueden cancelar tus propuestas enviadas sin respuesta'; end if;
end $$;

-- Créditos de una propuesta (broker dueño o internos) con su detalle actual
create or replace function public.broker_propuesta_creditos(p_id bigint)
returns table (tipo text, clave text, referencia text, grupo text, estado text, municipio text, dias integer, capital numeric, precio numeric)
language plpgsql stable security definer set search_path = public as $$
declare x public.broker_propuestas; t jsonb := public._broker_tarifas();
begin
    select * into x from public.broker_propuestas where id = p_id;
    if not found then raise exception 'No existe la propuesta'; end if;
    if not public.es_activo() and x.broker_id is distinct from public._mi_broker() then raise exception 'No tienes acceso' using errcode = '42501'; end if;
    t := coalesce(jsonb_build_object('JyP', (x.resumen->'tarifas'->>'JyP')::numeric, 'Grupal', (x.resumen->'tarifas'->>'Grupal')::numeric), t);
    return query
        select 'JyP'::text, k, j.vreference, null::text, j.estado, j.municipio, j.dias::int, j.npendingk, round(j.npendingk * (t->>'JyP')::numeric, 2)
          from unnest(x.claves) k join public.cartera_jyp j on 'J:' || j.vreference = k where k like 'J:%'
        union all
        select 'Grupal'::text, k, g.vreference, g.vgroupid, g.estado, g.municipio, g.dias::int, g.npendingk, round(g.npendingk * (t->>'Grupal')::numeric, 2)
          from unnest(x.claves) k join public.cartera_grupal g on 'G:' || g.vgroupid = k where k like 'G:%'
         order by 1 desc, 5, 6, 3;
end $$;

-- ---------- documentos del broker ----------
create or replace function public.broker_documentos(p_broker bigint default null)
returns table (id bigint, tipo text, nombre text, ruta text, mime text, bytes integer, estatus text, comentario text,
               revisado_por text, revisado_fecha timestamptz, subido_por text, fecha timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v bigint;
begin
    if public.es_activo() then v := p_broker; else v := public._mi_broker(); end if;
    return query select d.id, d.tipo, d.nombre, d.ruta, d.mime, d.bytes, d.estatus, d.comentario, d.revisado_por, d.revisado_fecha,
                        d.subido_por, d.fecha
                   from public.broker_documentos d where d.broker_id = v order by d.tipo, d.fecha desc;
end $$;

create or replace function public.broker_registrar_documento(p_broker bigint, p_tipo text, p_nombre text, p_ruta text, p_mime text, p_bytes integer)
returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare v bigint; v_id bigint; v_quien text; b public.brokers; av jsonb;
begin
    if public.es_admin() and p_broker is not null then v := p_broker; else v := public._mi_broker(); end if;
    if p_tipo <> all (public._broker_docs_requeridos()) then raise exception 'Tipo de documento no válido'; end if;
    if split_part(p_ruta, '/', 1) <> 'BRK-' || v or split_part(p_ruta, '/', 2) <> p_tipo then raise exception 'Ruta no válida'; end if;
    select coalesce(nullif(trim(nombre), ''), email) into v_quien from public.perfiles where user_id = auth.uid();
    insert into public.broker_documentos (broker_id, tipo, nombre, ruta, mime, bytes, user_id, subido_por)
    values (v, p_tipo, p_nombre, p_ruta, p_mime, p_bytes, auth.uid(), v_quien) returning id into v_id;
    select * into b from public.brokers where id = v;
    av := public._broker_avance(v);
    if b.estatus in ('documentos', 'rechazado') and (av->>'subidos')::int >= (av->>'requeridos')::int then
        update public.brokers set estatus = 'revision', motivo = null where id = v;
        perform public._notificar(array['validador'], null, 'Broker listo para validar',
            format('%s subió todos sus documentos. Revísalos y valida su alta.', b.nombre), '#/brokers');
    end if;
    return v_id;
end $$;

create or replace function public.broker_borrar_documento(p_id bigint) returns text
language plpgsql volatile security definer set search_path = public as $$
declare d public.broker_documentos;
begin
    select * into d from public.broker_documentos where id = p_id;
    if not found then raise exception 'No existe el documento'; end if;
    if not public.es_admin() then
        if d.broker_id is distinct from public._mi_broker() then raise exception 'No tienes acceso' using errcode = '42501'; end if;
        if d.estatus = 'aprobado' then raise exception 'Ese documento ya fue aprobado; pide al ejecutivo que lo quite si debes cambiarlo'; end if;
    end if;
    delete from public.broker_documentos where id = p_id;
    return d.ruta;
end $$;

-- ---------- administración (validador / admin) ----------
create or replace function public.brokers_lista()
returns table (id bigint, nombre text, empresa text, rfc text, correo text, telefono text, notas text, estatus text, motivo text,
               validado_por text, validado_fecha timestamptz, creado timestamptz, avance jsonb, accesos jsonb,
               propuestas bigint, abiertas bigint, monto_aceptado numeric)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query
        select b.id, b.nombre, b.empresa, b.rfc, b.correo, b.telefono, b.notas, b.estatus, b.motivo, b.validado_por, b.validado_fecha, b.creado,
               public._broker_avance(b.id),
               coalesce((select jsonb_agg(jsonb_build_object('email', p.email, 'nombre', p.nombre, 'activo', p.activo) order by p.email)
                           from public.perfiles p where p.broker_id = b.id and p.rol = 'broker'), '[]'::jsonb),
               (select count(*) from public.broker_propuestas x where x.broker_id = b.id and x.estatus <> 'cancelada'),
               (select count(*) from public.broker_propuestas x where x.broker_id = b.id and x.estatus = 'enviada'),
               (select coalesce(sum(x.monto), 0) from public.broker_propuestas x where x.broker_id = b.id and x.estatus = 'aceptada')
          from public.brokers b
         order by case b.estatus when 'revision' then 0 when 'documentos' then 1 when 'validado' then 2 else 3 end, b.nombre;
end $$;

create or replace function public.broker_guardar(p jsonb) returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare v_id bigint := nullif(p->>'id', '')::bigint; v_quien text;
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador editan brokers' using errcode = '42501'; end if;
    if coalesce(trim(p->>'nombre'), '') = '' then raise exception 'Escribe el nombre del broker'; end if;
    select coalesce(nullif(trim(nombre), ''), email) into v_quien from public.perfiles where user_id = auth.uid();
    if v_id is null then
        insert into public.brokers (nombre, empresa, rfc, correo, telefono, notas, creado_por)
        values (trim(p->>'nombre'), nullif(trim(p->>'empresa'), ''), upper(nullif(trim(p->>'rfc'), '')), lower(nullif(trim(p->>'correo'), '')),
                nullif(trim(p->>'telefono'), ''), nullif(trim(p->>'notas'), ''), v_quien)
        returning id into v_id;
    else
        update public.brokers set nombre = trim(p->>'nombre'), empresa = nullif(trim(p->>'empresa'), ''), rfc = upper(nullif(trim(p->>'rfc'), '')),
               correo = lower(nullif(trim(p->>'correo'), '')), telefono = nullif(trim(p->>'telefono'), ''), notas = nullif(trim(p->>'notas'), '')
         where id = v_id;
        if not found then raise exception 'No existe el broker'; end if;
    end if;
    return v_id;
end $$;

create or replace function public.broker_crear_acceso(p_broker bigint, p_email text, p_nombre text, p_clave text) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare v_user uuid;
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador dan accesos' using errcode = '42501'; end if;
    if not exists (select 1 from public.brokers where id = p_broker and estatus <> 'suspendido') then
        raise exception 'El broker no existe o está suspendido';
    end if;
    v_user := public._crear_usuario_auth(p_email, p_nombre, 'broker', p_clave, null);
    update public.perfiles set broker_id = p_broker where user_id = v_user;
    return v_user;
end $$;

create or replace function public.broker_revisar_documento(p_id bigint, p_estatus text, p_comentario text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare d public.broker_documentos; v_quien text; b public.brokers;
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador revisan documentos' using errcode = '42501'; end if;
    if p_estatus not in ('aprobado', 'rechazado', 'pendiente') then raise exception 'Estatus no válido'; end if;
    if p_estatus = 'rechazado' and coalesce(trim(p_comentario), '') = '' then raise exception 'Escribe el motivo del rechazo'; end if;
    select coalesce(nullif(trim(nombre), ''), email) into v_quien from public.perfiles where user_id = auth.uid();
    update public.broker_documentos set estatus = p_estatus, comentario = nullif(trim(p_comentario), ''), revisado_por = v_quien, revisado_fecha = now()
     where id = p_id returning * into d;
    if not found then raise exception 'No existe el documento'; end if;
    select * into b from public.brokers where id = d.broker_id;
    if p_estatus = 'rechazado' then
        if b.estatus = 'revision' then update public.brokers set estatus = 'documentos' where id = b.id; end if;
        perform public._notificar_broker(b.id, 'Documento rechazado',
            format('«%s» no se aceptó: %s. Sube uno nuevo en Mis documentos.', d.nombre, trim(p_comentario)), '#/b_documentos');
    end if;
end $$;

create or replace function public.broker_validar(p_broker bigint, p_estatus text, p_motivo text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare av jsonb; v_quien text;
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador validan brokers' using errcode = '42501'; end if;
    if p_estatus not in ('validado', 'rechazado', 'suspendido', 'documentos') then raise exception 'Estatus no válido'; end if;
    av := public._broker_avance(p_broker);
    if p_estatus = 'validado' and (av->>'aprobados')::int < (av->>'requeridos')::int then
        raise exception 'Faltan documentos por aprobar (% de %)', av->>'aprobados', av->>'requeridos';
    end if;
    if p_estatus in ('rechazado', 'suspendido') and coalesce(trim(p_motivo), '') = '' then raise exception 'Escribe el motivo'; end if;
    select coalesce(nullif(trim(nombre), ''), email) into v_quien from public.perfiles where user_id = auth.uid();
    update public.brokers set estatus = p_estatus, motivo = nullif(trim(p_motivo), ''),
           validado_por = case when p_estatus = 'validado' then v_quien else validado_por end,
           validado_fecha = case when p_estatus = 'validado' then now() else validado_fecha end
     where id = p_broker;
    if not found then raise exception 'No existe el broker'; end if;
    perform public._notificar_broker(p_broker,
        case p_estatus when 'validado' then 'Documentación validada' when 'rechazado' then 'Documentación rechazada'
                       when 'suspendido' then 'Acceso suspendido' else 'Revisa tus documentos' end,
        case p_estatus when 'validado' then 'Ya puedes enviar propuestas de inversión.' else coalesce(trim(p_motivo), 'Revisa tus documentos.') end,
        '#/b_inicio');
end $$;

create or replace function public.brokers_propuestas(p_todas boolean default false)
returns table (id bigint, folio text, broker text, broker_id bigint, creado timestamptz, filtros jsonb, resumen jsonb, creditos integer,
               grupos integer, capital numeric, monto numeric, estatus text, comentario text, respuesta text, respondido_por text,
               respondido_fecha timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query select x.id, x.folio, b.nombre, b.id, x.creado, x.filtros, x.resumen, x.creditos, x.grupos, x.capital, x.monto, x.estatus,
                        x.comentario, x.respuesta, x.respondido_por, x.respondido_fecha
                   from public.broker_propuestas x join public.brokers b on b.id = x.broker_id
                  where p_todas or x.estatus = 'enviada' order by x.creado desc;
end $$;

create or replace function public.broker_responder_propuesta(p_id bigint, p_estatus text, p_respuesta text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare x public.broker_propuestas; v_quien text;
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador responden propuestas' using errcode = '42501'; end if;
    if p_estatus not in ('aceptada', 'rechazada') then raise exception 'Estatus no válido'; end if;
    select coalesce(nullif(trim(nombre), ''), email) into v_quien from public.perfiles where user_id = auth.uid();
    update public.broker_propuestas set estatus = p_estatus, respuesta = nullif(trim(p_respuesta), ''), respondido_por = v_quien, respondido_fecha = now()
     where id = p_id and estatus = 'enviada' returning * into x;
    if not found then raise exception 'La propuesta ya fue respondida o cancelada'; end if;
    perform public._notificar_broker(x.broker_id, format('Propuesta %s %s', x.folio, p_estatus),
        coalesce(nullif(trim(p_respuesta), ''), case p_estatus when 'aceptada' then 'Tu ejecutivo te contactará para el siguiente paso.' else 'Puedes armar otra.' end),
        '#/b_propuestas');
end $$;

-- ---------- usuarios: el rol broker sólo se da desde Brokers ----------
create or replace function public.admin_crear_usuario(p_email text, p_nombre text, p_rol text, p_clave text)
returns uuid
language plpgsql volatile security definer set search_path = public as $$
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador pueden dar de alta usuarios'; end if;
    if p_rol = 'comprador' then raise exception 'Los accesos de comprador se dan de alta en el módulo Compradores'; end if;
    if p_rol = 'broker' then raise exception 'Los accesos de broker se dan de alta en el módulo Brokers'; end if;
    if p_rol not in ('vendedor', 'validador', 'auxiliar', 'control_doc', 'admin', 'abogado', 'coord_juridico') then
        raise exception 'Rol no válido: %', p_rol;
    end if;
    return public._crear_usuario_auth(p_email, p_nombre, p_rol, p_clave, null);
end $$;

create or replace function public.admin_editar_usuario(p_user uuid, p_email text, p_nombre text, p_rol text, p_activo boolean)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_email text := lower(trim(p_email)); v_comp bigint; v_brk bigint;
begin
    if not public.es_admin() then raise exception 'Sólo el validador o un administrador pueden editar usuarios'; end if;
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Correo no válido: %', p_email; end if;
    if p_rol not in ('vendedor', 'validador', 'auxiliar', 'control_doc', 'admin', 'comprador', 'abogado', 'coord_juridico', 'broker') then
        raise exception 'Rol no válido: %', p_rol;
    end if;
    select comprador_id, broker_id into v_comp, v_brk from public.perfiles where user_id = p_user;
    if p_rol = 'comprador' and v_comp is null then raise exception 'Los accesos de comprador se dan de alta en el módulo Compradores'; end if;
    if p_rol = 'broker' and v_brk is null then raise exception 'Los accesos de broker se dan de alta en el módulo Brokers'; end if;
    if p_user = auth.uid() and (p_rol not in ('admin', 'validador') or not p_activo) then
        raise exception 'No puedes quitarte a ti mismo el rol de usuario maestro';
    end if;
    if exists (select 1 from auth.users where lower(email) = v_email and id <> p_user) then
        raise exception 'Ya existe otro usuario con el correo %', v_email;
    end if;
    update auth.users set email = v_email, updated_at = now() where id = p_user and email is distinct from v_email;
    update auth.identities set identity_data = identity_data || jsonb_build_object('email', v_email), updated_at = now()
     where user_id = p_user and provider = 'email';
    update public.perfiles
       set email = v_email, nombre = nullif(trim(p_nombre), ''), rol = p_rol, activo = p_activo,
           comprador_id = case when p_rol = 'comprador' then comprador_id end,
           broker_id = case when p_rol = 'broker' then broker_id end
     where user_id = p_user;
    if not found then raise exception 'No existe el usuario'; end if;
end $$;

drop function if exists public.admin_usuarios();
create or replace function public.admin_usuarios()
returns table (user_id uuid, email text, nombre text, rol text, activo boolean, creado timestamptz, comprador text)
language plpgsql stable security definer set search_path = public as $$
begin
    if not public.es_admin() then raise exception 'Sólo administradores'; end if;
    return query select p.user_id, p.email, p.nombre, p.rol, p.activo, p.creado, coalesce(c.nombre, 'Broker: ' || b.nombre)
                 from public.perfiles p left join public.compradores c on c.id = p.comprador_id
                 left join public.brokers b on b.id = p.broker_id order by p.email;
end $$;

create or replace function public.funnel_vendedores()
returns table (user_id uuid, nombre text, email text, rol text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query select p.user_id, coalesce(nullif(trim(p.nombre), ''), p.email), p.email, p.rol
                   from public.perfiles p where p.activo and p.rol not in ('comprador', 'broker') order by 2;
end $$;

-- ---------- permisos ----------
do $$
declare f text;
begin
    foreach f in array array[
        'broker_inicio()', 'broker_resumen_cartera()', 'broker_simular(jsonb)', 'broker_generar_propuesta(jsonb, text)',
        'broker_mis_propuestas()', 'broker_cancelar_propuesta(bigint)', 'broker_propuesta_creditos(bigint)',
        'broker_documentos(bigint)', 'broker_registrar_documento(bigint, text, text, text, text, integer)', 'broker_borrar_documento(bigint)',
        'brokers_lista()', 'broker_guardar(jsonb)', 'broker_crear_acceso(bigint, text, text, text)',
        'broker_revisar_documento(bigint, text, text)', 'broker_validar(bigint, text, text)', 'brokers_propuestas(boolean)',
        'broker_responder_propuesta(bigint, text, text)', '_broker_ruta_ok(text, boolean)', '_mi_broker()'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
    foreach f in array array['_broker_avance(bigint)', '_notificar_broker(bigint, text, text, text)', '_broker_tarifas()'] loop
        execute format('revoke all on function public.%s from public, anon, authenticated', f);
    end loop;
end $$;
