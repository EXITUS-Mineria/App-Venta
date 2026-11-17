-- ============================================================
-- DOCUMENTOS DEL FUNNEL · comprobante de pago y documentos del comprador
--  - Bucket PRIVADO "documentos-venta" (Supabase Storage): PDF, fotos (JPG/PNG/WEBP/HEIC) y Word, máx. 10 MB.
--    Ruta: <folio>/<tipo>/<marca>_<nombre>. Las fotos se comprimen en el navegador antes de subir.
--  - funnel_documentos: registro de cada archivo (quién, cuándo, tamaño).
--  - Suben/borran: vendedor de la venta, auxiliar de venta y maestros. Ven: todos los usuarios activos.
--  - Para verlos se generan ligas temporales (5 min); no hay ligas públicas.
-- Requiere 19-22. Idempotente.
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documentos-venta', 'documentos-venta', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
              'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.funnel_documentos (
    id         bigserial primary key,
    folio      text not null references public.funnel_ventas (folio) on delete cascade,
    tipo       text not null check (tipo in ('comprobante_pago', 'comprador')),
    nombre     text not null,
    ruta       text not null unique,
    mime       text,
    bytes      integer,
    user_id    uuid,
    subido_por text,
    fecha      timestamptz not null default now()
);
create index if not exists funnel_documentos_folio on public.funnel_documentos (folio, tipo);
alter table public.funnel_documentos enable row level security;
revoke all on public.funnel_documentos from anon, authenticated;
grant select on public.funnel_documentos to authenticated;
drop policy if exists documentos_lectura on public.funnel_documentos;
create policy documentos_lectura on public.funnel_documentos for select to authenticated using (public.es_activo());

-- ¿Puede el usuario con sesión modificar esta venta? (auxiliar/maestros, o su vendedor)
create or replace function public.funnel_puede_editar(p_folio text) returns boolean
language sql stable security definer set search_path = public as $$
    select public.es_activo() and (
        public.tiene_rol(array['auxiliar'])
        or exists (select 1 from public.funnel_ventas f
                     left join public.propuestas p on p.id_propuesta = f.id_propuesta
                    where f.folio = p_folio
                      and (p.user_id = auth.uid() or public._vendedor_es_yo(f.vendedor))))
$$;
revoke all on function public.funnel_puede_editar(text) from public, anon;
grant execute on function public.funnel_puede_editar(text) to authenticated;

-- Políticas del bucket (Storage valida cada subida / descarga / borrado con la sesión del usuario)
drop policy if exists "documentos_venta_ver" on storage.objects;
create policy "documentos_venta_ver" on storage.objects for select to authenticated
    using (bucket_id = 'documentos-venta' and public.es_activo());
drop policy if exists "documentos_venta_subir" on storage.objects;
create policy "documentos_venta_subir" on storage.objects for insert to authenticated
    with check (bucket_id = 'documentos-venta' and public.funnel_puede_editar(split_part(name, '/', 1))
                and split_part(name, '/', 2) in ('comprobante_pago', 'comprador'));
drop policy if exists "documentos_venta_borrar" on storage.objects;
create policy "documentos_venta_borrar" on storage.objects for delete to authenticated
    using (bucket_id = 'documentos-venta' and public.funnel_puede_editar(split_part(name, '/', 1)));

-- Registrar un archivo ya subido
create or replace function public.funnel_registrar_documento(p_folio text, p_tipo text, p_nombre text, p_ruta text,
                                                             p_mime text, p_bytes integer)
returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare v_id bigint; v_quien text; v_prop text;
begin
    if not public.funnel_puede_editar(p_folio) then
        raise exception 'Sólo el vendedor de %, el auxiliar de venta o un maestro pueden subir documentos', p_folio using errcode = '42501';
    end if;
    if p_tipo not in ('comprobante_pago', 'comprador') then raise exception 'Tipo de documento no válido'; end if;
    if split_part(p_ruta, '/', 1) <> p_folio or split_part(p_ruta, '/', 2) <> p_tipo then
        raise exception 'Ruta de archivo no válida';
    end if;
    select coalesce(nombre, email) into v_quien from public.perfiles where user_id = auth.uid();
    insert into public.funnel_documentos (folio, tipo, nombre, ruta, mime, bytes, user_id, subido_por)
    values (p_folio, p_tipo, left(p_nombre, 200), p_ruta, p_mime, p_bytes, auth.uid(), v_quien)
    returning id into v_id;
    update public.funnel_ventas set actualizado = now(), actualizado_por = v_quien where folio = p_folio;
    select id_propuesta into v_prop from public.funnel_ventas where folio = p_folio;
    if v_prop is not null then
        insert into public.propuesta_eventos (id_propuesta, usuario, evento, detalle)
        values (v_prop, v_quien, 'Documento',
                case p_tipo when 'comprobante_pago' then 'Comprobante de pago: ' else 'Documento del comprador: ' end || p_nombre);
    end if;
    return v_id;
end $$;

-- Quitar el registro (el navegador borra el archivo del bucket con la misma sesión)
create or replace function public.funnel_borrar_documento(p_id bigint)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_d public.funnel_documentos;
begin
    select * into v_d from public.funnel_documentos where id = p_id;
    if not found then raise exception 'No existe el documento'; end if;
    if not public.funnel_puede_editar(v_d.folio) then
        raise exception 'Sólo el vendedor de %, el auxiliar de venta o un maestro pueden borrar documentos', v_d.folio using errcode = '42501';
    end if;
    delete from public.funnel_documentos where id = p_id;
    return v_d.ruta;
end $$;

drop function if exists public.funnel_lista();
create or replace function public.funnel_lista()
returns table (folio text, id_propuesta text, comprador text, capital numeric, monto_venta numeric, estado text,
               municipios text, tipo text, estatus_venta text, fecha_propuesta date, fecha_venta date, vendedor text,
               estatus_md text, fecha_inicio_md date, fecha_limite_md date, base_completa_venta text,
               estatus_control_doc text, fecha_inicio_admin date, fecha_limite_admin date, estatus_juridico text,
               estatus_final text, base_final text, propuesta_url text, comprobante_pago text,
               fecha_ticket_contrato date, numero_ticket_contrato text, numero_guia text, origen text,
               actualizado timestamptz, actualizado_por text, estatus_propuesta text, es_mia boolean,
               mes text, ligas_desc jsonb, adjuntos jsonb, n_comprobantes bigint, n_documentos bigint)
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
           f.actualizado, f.actualizado_por, p.estatus, coalesce(p.user_id = auth.uid(), false) or public._vendedor_es_yo(f.vendedor),
           f.mes, f.ligas_desc, f.adjuntos,
           (select count(*) from public.funnel_documentos d where d.folio = f.folio and d.tipo = 'comprobante_pago'),
           (select count(*) from public.funnel_documentos d where d.folio = f.folio and d.tipo = 'comprador')
      from public.funnel_ventas f
      left join public.propuestas p on p.id_propuesta = f.id_propuesta
      left join geo on geo.id_propuesta = f.id_propuesta
     order by coalesce(f.fecha_venta, f.fecha_propuesta) desc nulls last, f.folio desc;
end $$;

do $$
declare f text;
begin
    foreach f in array array['funnel_lista()', 'funnel_registrar_documento(text,text,text,text,text,integer)',
                             'funnel_borrar_documento(bigint)'] loop
        execute format('revoke all on function public.%s from public, anon', f);
        execute format('grant execute on function public.%s to authenticated', f);
    end loop;
end $$;
