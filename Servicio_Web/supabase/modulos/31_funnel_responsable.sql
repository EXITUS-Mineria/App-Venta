-- ============================================================
-- FUNNEL: VENDEDOR RESPONSABLE (usuario), VISIBILIDAD, REASIGNACIÓN, COMENTARIOS Y FECHAS LÍMITE
--  - Cada venta tiene un vendedor responsable que es un USUARIO (funnel_ventas.vendedor_user).
--    Las ventas de la página lo toman de quien armó la propuesta; las históricas se ligan por nombre
--    y las que no tienen usuario quedan "sin asignar" hasta que un admin las asigne.
--  - Ve la venta: su responsable, auxiliar de venta, control documental y los maestros (validador, admin).
--    Edita: su responsable, auxiliar y maestros. El RESPONSABLE sólo lo cambia un maestro (reasignar).
--  - Comentarios por venta (hilo) con aviso 🔔 al responsable / validador.
--  - Fechas límite automáticas con los plazos de etapas_plazos (29):
--      al marcar Vendida      → Inicio MD = fecha de venta, Límite MD = + plazo "md"
--      al terminar MD         → Inicio Admin = hoy, Límite Admin = + plazo "doc"
--    Sólo se llenan si están vacías (un maestro las puede corregir).
-- Requiere 19-29. Idempotente.
-- ============================================================
alter table public.funnel_ventas add column if not exists vendedor_user uuid references auth.users (id) on delete set null;
create index if not exists funnel_vendedor_user on public.funnel_ventas (vendedor_user);

-- ligar lo que ya existe: ventas de la página → quien armó la propuesta; históricas → por nombre
update public.funnel_ventas f set vendedor_user = p.user_id
  from public.propuestas p where p.id_propuesta = f.id_propuesta and f.vendedor_user is null and p.user_id is not null;
update public.funnel_ventas f set vendedor_user = (
        select pe.user_id from public.perfiles pe
         where pe.activo and pe.rol <> 'comprador' and coalesce(trim(pe.nombre), '') <> ''
           and not exists (select 1 from regexp_split_to_table(public._sin_acentos(pe.nombre), '\s+') w
                            where length(w) >= 3 and position(w in public._sin_acentos(f.vendedor)) = 0)
         order by length(pe.nombre) desc limit 1)
 where f.vendedor_user is null and coalesce(trim(f.vendedor), '') <> '';

-- ventas nuevas de la página: el responsable es quien armó la propuesta
create or replace function public._funnel_responsable() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if new.vendedor_user is null and new.id_propuesta is not null then
        select user_id into new.vendedor_user from public.propuestas where id_propuesta = new.id_propuesta;
    end if;
    return new;
end $$;
revoke all on function public._funnel_responsable() from public, anon, authenticated;
drop trigger if exists funnel_responsable on public.funnel_ventas;
create trigger funnel_responsable before insert on public.funnel_ventas
    for each row execute function public._funnel_responsable();

-- ¿Quién ve / quién edita una venta?
create or replace function public.funnel_puede_ver(p_folio text) returns boolean
language sql stable security definer set search_path = public as $$
    select public.es_activo() and (
        public.tiene_rol(array['auxiliar', 'control_doc'])
        or exists (select 1 from public.funnel_ventas f where f.folio = p_folio and f.vendedor_user = auth.uid()))
$$;
create or replace function public.funnel_puede_editar(p_folio text) returns boolean
language sql stable security definer set search_path = public as $$
    select public.es_activo() and (
        public.tiene_rol(array['auxiliar'])
        or exists (select 1 from public.funnel_ventas f where f.folio = p_folio and f.vendedor_user = auth.uid()))
$$;
revoke all on function public.funnel_puede_ver(text) from public, anon;
grant execute on function public.funnel_puede_ver(text) to authenticated;

-- Documentos: sólo quien ve la venta
drop policy if exists documentos_lectura on public.funnel_documentos;
create policy documentos_lectura on public.funnel_documentos for select to authenticated using (public.funnel_puede_ver(folio));
drop policy if exists "documentos_venta_ver" on storage.objects;
create policy "documentos_venta_ver" on storage.objects for select to authenticated
    using (bucket_id = 'documentos-venta' and public.funnel_puede_ver(split_part(name, '/', 1)));

-- Usuarios que pueden ser responsables (para el selector del admin)
create or replace function public.funnel_vendedores()
returns table (user_id uuid, nombre text, email text, rol text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query select p.user_id, coalesce(nullif(trim(p.nombre), ''), p.email), p.email, p.rol
                   from public.perfiles p where p.activo and p.rol <> 'comprador' order by 2;
end $$;

-- Reasignar (sólo maestros). Acepta varias ventas a la vez.
create or replace function public.funnel_asignar_vendedor(p_folios text[], p_user uuid)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare v_nombre text; v_quien text; v_n integer; r record;
begin
    if not public.es_admin() then raise exception 'Sólo un administrador o el validador reasignan ventas' using errcode = '42501'; end if;
    select coalesce(nullif(trim(nombre), ''), email) into v_nombre from public.perfiles
     where user_id = p_user and activo and rol <> 'comprador';
    if v_nombre is null then raise exception 'Ese usuario no existe o está inactivo'; end if;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    for r in select folio, id_propuesta, vendedor from public.funnel_ventas
              where folio = any (p_folios) and vendedor_user is distinct from p_user loop
        update public.funnel_ventas set vendedor_user = p_user, vendedor = v_nombre, actualizado = now(), actualizado_por = v_quien
         where folio = r.folio;
        if r.id_propuesta is not null then
            insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle)
            values (r.id_propuesta, v_quien, 'Reasignada', coalesce(r.vendedor, 'sin asignar') || ' → ' || v_nombre);
        end if;
    end loop;
    select count(*) into v_n from public.funnel_ventas where folio = any (p_folios) and vendedor_user = p_user;
    perform public._notificar(null, p_user, '📈 Te asignaron ' || cardinality(p_folios) || ' venta(s)',
        left(array_to_string(p_folios, ', '), 200) || ' (' || v_quien || ')', 'funnel');
    return v_n;
end $$;

-- funnel_guardar: el vendedor ya no se edita aquí (se reasigna); permisos por responsable
create or replace function public.funnel_guardar(p_folio text, p_datos jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
    v_f public.funnel_ventas; v_quien text; k text;
    v_back   text[] := array['estatus_md','fecha_inicio_md','fecha_limite_md','base_completa_venta','estatus_control_doc',
                             'fecha_inicio_admin','fecha_limite_admin','estatus_juridico','estatus_final','base_final',
                             'fecha_ticket_contrato','numero_ticket_contrato','numero_guia','capital','monto_venta','tipo','estatus_venta'];
    v_venta  text[] := array['comprador','estado','municipios','fecha_venta','propuesta_url','comprobante_pago','fecha_propuesta','mes'];
begin
    perform public._exigir_activo();
    select * into v_f from public.funnel_ventas where folio = p_folio for update;
    if not found then raise exception 'No existe la venta %', p_folio; end if;
    if not public.funnel_puede_editar(p_folio) then
        raise exception 'Sólo el vendedor responsable de %, el auxiliar de venta o un maestro pueden editarla', p_folio using errcode = '42501';
    end if;
    for k in select jsonb_object_keys(p_datos) loop
        if k = 'vendedor' then raise exception 'El vendedor responsable sólo lo cambia un administrador con «Reasignar»'; end if;
        if not (k = any (v_back) or k = any (v_venta)) then raise exception 'Campo no editable: %', k; end if;
        if k in ('fecha_inicio_md', 'fecha_limite_md', 'fecha_inicio_admin', 'fecha_limite_admin') and not public.es_admin() then
            raise exception 'Las fechas de inicio y límite son automáticas; sólo un maestro las corrige';
        end if;
    end loop;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();

    update public.funnel_ventas f set
        comprador              = case when p_datos ? 'comprador' then nullif(trim(p_datos->>'comprador'), '') else f.comprador end,
        capital                = case when p_datos ? 'capital' then nullif(p_datos->>'capital', '')::numeric else f.capital end,
        monto_venta            = case when p_datos ? 'monto_venta' then nullif(p_datos->>'monto_venta', '')::numeric else f.monto_venta end,
        estado                 = case when p_datos ? 'estado' then nullif(trim(p_datos->>'estado'), '') else f.estado end,
        municipios             = case when p_datos ? 'municipios' then nullif(trim(p_datos->>'municipios'), '') else f.municipios end,
        tipo                   = case when p_datos ? 'tipo' then nullif(p_datos->>'tipo', '') else f.tipo end,
        estatus_venta          = case when p_datos ? 'estatus_venta' then coalesce(nullif(p_datos->>'estatus_venta', ''), 'Propuesta') else f.estatus_venta end,
        fecha_propuesta        = case when p_datos ? 'fecha_propuesta' then nullif(p_datos->>'fecha_propuesta', '')::date else f.fecha_propuesta end,
        fecha_venta            = case when p_datos ? 'fecha_venta' then nullif(p_datos->>'fecha_venta', '')::date else f.fecha_venta end,
        estatus_md             = case when p_datos ? 'estatus_md' then nullif(p_datos->>'estatus_md', '') else f.estatus_md end,
        fecha_inicio_md        = case when p_datos ? 'fecha_inicio_md' then nullif(p_datos->>'fecha_inicio_md', '')::date else f.fecha_inicio_md end,
        fecha_limite_md        = case when p_datos ? 'fecha_limite_md' then nullif(p_datos->>'fecha_limite_md', '')::date else f.fecha_limite_md end,
        base_completa_venta    = case when p_datos ? 'base_completa_venta' then nullif(trim(p_datos->>'base_completa_venta'), '') else f.base_completa_venta end,
        estatus_control_doc    = case when p_datos ? 'estatus_control_doc' then nullif(p_datos->>'estatus_control_doc', '') else f.estatus_control_doc end,
        fecha_inicio_admin     = case when p_datos ? 'fecha_inicio_admin' then nullif(p_datos->>'fecha_inicio_admin', '')::date else f.fecha_inicio_admin end,
        fecha_limite_admin     = case when p_datos ? 'fecha_limite_admin' then nullif(p_datos->>'fecha_limite_admin', '')::date else f.fecha_limite_admin end,
        estatus_juridico       = case when p_datos ? 'estatus_juridico' then nullif(p_datos->>'estatus_juridico', '') else f.estatus_juridico end,
        estatus_final          = case when p_datos ? 'estatus_final' then nullif(p_datos->>'estatus_final', '') else f.estatus_final end,
        base_final             = case when p_datos ? 'base_final' then nullif(trim(p_datos->>'base_final'), '') else f.base_final end,
        propuesta_url          = case when p_datos ? 'propuesta_url' then nullif(trim(p_datos->>'propuesta_url'), '') else f.propuesta_url end,
        comprobante_pago       = case when p_datos ? 'comprobante_pago' then nullif(trim(p_datos->>'comprobante_pago'), '') else f.comprobante_pago end,
        fecha_ticket_contrato  = case when p_datos ? 'fecha_ticket_contrato' then nullif(p_datos->>'fecha_ticket_contrato', '')::date else f.fecha_ticket_contrato end,
        numero_ticket_contrato = case when p_datos ? 'numero_ticket_contrato' then nullif(trim(p_datos->>'numero_ticket_contrato'), '') else f.numero_ticket_contrato end,
        numero_guia            = case when p_datos ? 'numero_guia' then nullif(trim(p_datos->>'numero_guia'), '') else f.numero_guia end,
        mes                    = case when p_datos ? 'mes' then nullif(trim(p_datos->>'mes'), '') else f.mes end,
        actualizado = now(), actualizado_por = v_quien
     where f.folio = p_folio;

    if v_f.id_propuesta is not null then
        insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle)
        select v_f.id_propuesta, v_quien, 'Funnel',
               string_agg(initcap(replace(k2, '_', ' ')) || ': ' || coalesce(nullif(p_datos->>k2, ''), '—'), ' · ')
          from jsonb_object_keys(p_datos) k2;
    end if;
end $$;

-- Fechas límite automáticas
create or replace function public._funnel_fechas_auto() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_md integer; v_doc integer; v_hoy date := (now() at time zone 'America/Mexico_City')::date;
begin
    select max(dias) filter (where etapa = 'md'), max(dias) filter (where etapa = 'doc') into v_md, v_doc from public.etapas_plazos;
    if new.estatus_venta = 'Vendida' and (tg_op = 'INSERT' or old.estatus_venta is distinct from 'Vendida') then
        new.fecha_inicio_md := coalesce(new.fecha_inicio_md, new.fecha_venta, v_hoy);
        new.fecha_limite_md := coalesce(new.fecha_limite_md, new.fecha_inicio_md + coalesce(v_md, 2));
    end if;
    if new.estatus_md = 'Informacion Enviada' and (tg_op = 'INSERT' or old.estatus_md is distinct from 'Informacion Enviada') then
        new.fecha_inicio_admin := coalesce(new.fecha_inicio_admin, v_hoy);
        new.fecha_limite_admin := coalesce(new.fecha_limite_admin, new.fecha_inicio_admin + coalesce(v_doc, 15));
    end if;
    return new;
end $$;
revoke all on function public._funnel_fechas_auto() from public, anon, authenticated;
drop trigger if exists funnel_fechas_auto on public.funnel_ventas;
create trigger funnel_fechas_auto before insert or update of estatus_venta, estatus_md on public.funnel_ventas
    for each row execute function public._funnel_fechas_auto();

-- Comentarios
create table if not exists public.funnel_comentarios (
    id      bigserial primary key,
    folio   text not null references public.funnel_ventas (folio) on delete cascade,
    user_id uuid references auth.users (id) on delete set null,
    autor   text,
    texto   text not null check (length(trim(texto)) between 1 and 2000),
    fecha   timestamptz not null default now()
);
create index if not exists funnel_comentarios_folio on public.funnel_comentarios (folio, fecha);
alter table public.funnel_comentarios enable row level security;
revoke all on public.funnel_comentarios from anon, authenticated;

create or replace function public.funnel_comentarios_lista(p_folio text)
returns table (id bigint, autor text, texto text, fecha timestamptz, mio boolean)
language plpgsql stable security definer set search_path = public as $$
begin
    if not public.funnel_puede_ver(p_folio) then raise exception 'Sin acceso a %', p_folio using errcode = '42501'; end if;
    return query select c.id, c.autor, c.texto, c.fecha, c.user_id = auth.uid()
                   from public.funnel_comentarios c where c.folio = p_folio order by c.fecha;
end $$;

create or replace function public.funnel_comentar(p_folio text, p_texto text)
returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare v_id bigint; v_quien text; v_resp uuid;
begin
    if not public.funnel_puede_ver(p_folio) then raise exception 'Sin acceso a %', p_folio using errcode = '42501'; end if;
    if coalesce(trim(p_texto), '') = '' then raise exception 'Escribe el comentario'; end if;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    insert into public.funnel_comentarios (folio, user_id, autor, texto) values (p_folio, auth.uid(), v_quien, left(trim(p_texto), 2000))
    returning id into v_id;
    select vendedor_user into v_resp from public.funnel_ventas where folio = p_folio;
    -- avisa al responsable (si no es quien escribe) y, si escribe el responsable, al validador
    perform public._notificar(case when v_resp = auth.uid() then array['validador'] else array[]::text[] end,
        case when v_resp is distinct from auth.uid() then v_resp end,
        '💬 Comentario en ' || p_folio, v_quien || ': ' || left(trim(p_texto), 160), 'funnel');
    return v_id;
end $$;

create or replace function public.funnel_borrar_comentario(p_id bigint)
returns void
language plpgsql volatile security definer set search_path = public as $$
begin
    delete from public.funnel_comentarios where id = p_id and (user_id = auth.uid() or public.es_admin());
    if not found then raise exception 'Sólo quien lo escribió o un maestro lo puede borrar'; end if;
end $$;

-- funnel_lista: sólo las ventas que el usuario puede ver + responsable + comentarios
drop function if exists public.funnel_lista();
create or replace function public.funnel_lista()
returns table (folio text, id_propuesta text, comprador text, capital numeric, monto_venta numeric, estado text,
               municipios text, tipo text, estatus_venta text, fecha_propuesta date, fecha_venta date, vendedor text,
               estatus_md text, fecha_inicio_md date, fecha_limite_md date, base_completa_venta text,
               estatus_control_doc text, fecha_inicio_admin date, fecha_limite_admin date, estatus_juridico text,
               estatus_final text, base_final text, propuesta_url text, comprobante_pago text,
               fecha_ticket_contrato date, numero_ticket_contrato text, numero_guia text, origen text,
               actualizado timestamptz, actualizado_por text, estatus_propuesta text, es_mia boolean,
               mes text, ligas_desc jsonb, adjuntos jsonb, n_comprobantes bigint, n_documentos bigint,
               correo_comprador text, enviada_en timestamptz, enviada_por text, envios integer,
               comprador_id bigint, comprador_cat text, publicada_en timestamptz, publicada_por text, vistas integer,
               ultima_vista timestamptz, respuesta text, respuesta_en timestamptz, respuesta_por text, respuesta_comentario text,
               vendedor_user uuid, n_comentarios bigint, ultimo_comentario timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v_todo boolean;
begin
    perform public._exigir_activo();
    v_todo := public.tiene_rol(array['auxiliar', 'control_doc']);
    return query
    with vis as (select fv.* from public.funnel_ventas fv where v_todo or fv.vendedor_user = auth.uid()),
    geo as (
        select d.id_propuesta,
               string_agg(distinct initcap(lower(coalesce(j.estado, g.estado))), ', ') estados,
               string_agg(distinct coalesce(j.municipio, g.municipio), ', ') munis
          from public.propuesta_detalle d
          left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
          left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
         where d.id_propuesta in (select v.id_propuesta from vis v where v.id_propuesta is not null)
         group by d.id_propuesta
    )
    select f.folio, f.id_propuesta, f.comprador, f.capital, f.monto_venta,
           coalesce(nullif(f.estado, ''), geo.estados), coalesce(nullif(f.municipios, ''), left(geo.munis, 300)),
           f.tipo, f.estatus_venta, f.fecha_propuesta, f.fecha_venta, f.vendedor,
           f.estatus_md, f.fecha_inicio_md, f.fecha_limite_md, f.base_completa_venta,
           f.estatus_control_doc, f.fecha_inicio_admin, f.fecha_limite_admin, f.estatus_juridico,
           f.estatus_final, f.base_final, f.propuesta_url, f.comprobante_pago,
           f.fecha_ticket_contrato, f.numero_ticket_contrato, f.numero_guia, f.origen,
           f.actualizado, f.actualizado_por, p.estatus, coalesce(f.vendedor_user = auth.uid(), false),
           f.mes, f.ligas_desc, f.adjuntos,
           (select count(*) from public.funnel_documentos d where d.folio = f.folio and d.tipo = 'comprobante_pago'),
           (select count(*) from public.funnel_documentos d where d.folio = f.folio and d.tipo = 'comprador'),
           f.correo_comprador, f.enviada_en, f.enviada_por, f.envios,
           f.comprador_id, c.nombre, f.publicada_en, f.publicada_por, f.vistas, f.ultima_vista,
           f.respuesta, f.respuesta_en, f.respuesta_por, f.respuesta_comentario,
           f.vendedor_user,
           (select count(*) from public.funnel_comentarios k where k.folio = f.folio),
           (select max(k.fecha) from public.funnel_comentarios k where k.folio = f.folio)
      from vis f
      left join public.propuestas p on p.id_propuesta = f.id_propuesta
      left join public.compradores c on c.id = f.comprador_id
      left join geo on geo.id_propuesta = f.id_propuesta
     order by coalesce(f.fecha_venta, f.fecha_propuesta) desc nulls last, f.folio desc;
end $$;

do $$
declare f text;
begin
    foreach f in array array['funnel_lista()', 'funnel_vendedores()', 'funnel_asignar_vendedor(text[],uuid)', 'funnel_guardar(text,jsonb)',
                             'funnel_comentarios_lista(text)', 'funnel_comentar(text,text)', 'funnel_borrar_comentario(bigint)',
                             'funnel_puede_editar(text)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
