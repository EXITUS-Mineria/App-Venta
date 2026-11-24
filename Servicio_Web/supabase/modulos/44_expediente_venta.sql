-- ============================================================
-- EXPEDIENTE DE LA VENTA (carpeta del cliente) y AVISO A EXPEDIENTES
--  · funnel_documentos: tipos por documento de la carpeta del cliente:
--      ine, comprobante_fiscal, comprobante_domicilio, alta_comprador, comprobante_pago, nda (+ comprador = otros).
--    El bucket acepta también Excel / CSV (formato de alta del comprador).
--  · Al pasar una venta a «Vendida» queda un aviso pendiente para expedientes (expedientes_avisos) y se
--    notifica en la campana a los usuarios cuyo correo esté en la configuración. El correo lo manda la
--    función enviar-propuesta (accion "expedientes") con el layout para solicitud de expedientes adjunto.
--  · config_app: expedientes_correo (destinatarios), expedientes_nombre (saludo), expedientes_aviso (on/off).
--  · expedientes_layout(folio): créditos de la venta para pedir expedientes (ventas de la página o históricas).
-- Requiere 23, 37, 42. Idempotente.
-- ============================================================

-- ---------- Tipos de documento ----------
alter table public.funnel_documentos drop constraint if exists funnel_documentos_tipo_check;
alter table public.funnel_documentos add constraint funnel_documentos_tipo_check check (tipo in
    ('comprobante_pago', 'comprador', 'ine', 'comprobante_fiscal', 'comprobante_domicilio', 'alta_comprador', 'nda'));

update storage.buckets set allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv']
 where id = 'documentos-venta';

drop policy if exists "documentos_venta_subir" on storage.objects;
create policy "documentos_venta_subir" on storage.objects for insert to authenticated
    with check (bucket_id = 'documentos-venta' and public.funnel_puede_editar(split_part(name, '/', 1))
                and split_part(name, '/', 2) in ('comprobante_pago', 'comprador', 'ine', 'comprobante_fiscal',
                                                  'comprobante_domicilio', 'alta_comprador', 'nda'));

create or replace function public.funnel_registrar_documento(p_folio text, p_tipo text, p_nombre text, p_ruta text,
                                                             p_mime text, p_bytes integer)
returns bigint
language plpgsql volatile security definer set search_path = public as $$
declare v_id bigint; v_quien text; v_prop text;
begin
    if not public.funnel_puede_editar(p_folio) then
        raise exception 'Sólo el vendedor de %, el auxiliar de venta o un maestro pueden subir documentos', p_folio using errcode = '42501';
    end if;
    if p_tipo not in ('comprobante_pago', 'comprador', 'ine', 'comprobante_fiscal', 'comprobante_domicilio', 'alta_comprador', 'nda') then
        raise exception 'Tipo de documento no válido';
    end if;
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
        values (v_prop, v_quien, 'Documento', case p_tipo
            when 'comprobante_pago' then 'Comprobante de pago: ' when 'ine' then 'INE: '
            when 'comprobante_fiscal' then 'Constancia fiscal: ' when 'comprobante_domicilio' then 'Comprobante de domicilio: '
            when 'alta_comprador' then 'Formato de alta del comprador: ' when 'nda' then 'NDA: '
            else 'Documento del comprador: ' end || p_nombre);
    end if;
    return v_id;
end $$;
revoke all on function public.funnel_registrar_documento(text, text, text, text, text, integer) from public, anon;
grant execute on function public.funnel_registrar_documento(text, text, text, text, text, integer) to authenticated;

-- ---------- Configuración del aviso ----------
insert into public.config_app (clave, valor, descripcion) values
    ('expedientes_aviso',  'true',            'Avisar por correo a expedientes cuando una venta pasa a Vendida'),
    ('expedientes_correo', '""',              'Correo(s) de quien envía los expedientes (separados por coma)'),
    ('expedientes_nombre', '"Pamela Ingrid"', 'Nombre para el saludo del correo a expedientes')
on conflict (clave) do nothing;

create table if not exists public.expedientes_avisos (
    folio      text primary key references public.funnel_ventas(folio) on update cascade on delete cascade,
    creado     timestamptz not null default now(),
    enviado_en timestamptz,
    enviado_a  text,
    enviado_por text,
    error      text
);
alter table public.expedientes_avisos enable row level security;
revoke all on public.expedientes_avisos from anon, authenticated;

create or replace function public._correos_expedientes()
returns text[] language sql stable security definer set search_path = public as $$
    select coalesce(array_agg(distinct lower(trim(c))) filter (where trim(c) ~ '^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$'), '{}')
      from unnest(string_to_array(coalesce(public._config('expedientes_correo') #>> '{}', ''), ',')) c
$$;
revoke all on function public._correos_expedientes() from public, anon, authenticated;

-- Al pasar a Vendida: aviso pendiente + campana para quien tenga usuario con ese correo
create or replace function public._tg_expedientes_vendida()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
    if new.estatus_venta = 'Vendida' and (tg_op = 'INSERT' or old.estatus_venta is distinct from 'Vendida')
       and public._config_si('expedientes_aviso') then
        insert into public.expedientes_avisos (folio) values (new.folio) on conflict (folio) do nothing;
        for v_user in select p.user_id from public.perfiles p
                       where p.activo and lower(p.email) = any(public._correos_expedientes()) loop
            perform public._notificar(null, v_user, '📂 Venta para expedientes: ' || new.folio,
                coalesce(new.comprador, '') || ' · ' || coalesce(new.tipo, '') || ' · favor de enviar los expedientes.', 'funnel');
        end loop;
    end if;
    return new;
end $$;
drop trigger if exists funnel_expedientes_vendida on public.funnel_ventas;
create trigger funnel_expedientes_vendida after insert or update of estatus_venta on public.funnel_ventas
    for each row execute function public._tg_expedientes_vendida();

/** Créditos de la venta para solicitar expedientes (página: propuesta_detalle; históricas: archivo de la venta). */
drop function if exists public.expedientes_layout(text);
create or replace function public.expedientes_layout(p_folio text)
returns table (folio text, comprador text, fecha_venta date, tipo text, vgroupid text, grupo text, vreference text,
               icredid text, ipersonid text, nombre text, estado text, municipio text, sucursal text, capital numeric, expediente text)
language plpgsql stable security definer set search_path = public as $$
declare f public.funnel_ventas;
begin
    perform public._exigir_activo();
    select * into f from public.funnel_ventas where funnel_ventas.folio = p_folio;
    if not found then raise exception 'No existe la venta %', p_folio; end if;
    if f.id_propuesta is not null and exists (select 1 from public.propuesta_detalle d where d.id_propuesta = f.id_propuesta) then
        return query
        select f.folio, f.comprador, f.fecha_venta, d.tipo_cartera, d.vgroupid, d.datos->>'vGroup', d.vreference,
               coalesce(d.datos->>'iCredId', d.datos->>'iCredId_x'), coalesce(d.datos->>'iPersonId', d.datos->>'iPersonId_x'),
               coalesce(d.datos->>'vName', d.datos->>'NombreCliente'),
               coalesce(j.estado, g.estado), coalesce(j.municipio, g.municipio),
               coalesce(d.datos->>'vSuc', d.datos->>'vSubBranch'), round(d.npendingk, 2), d.datos->>'Expediente'
          from public.propuesta_detalle d
          left join public.cartera_jyp j on d.tipo_cartera = 'JyP' and j.vreference = d.vreference
          left join public.cartera_grupal g on d.tipo_cartera = 'Grupal' and g.vgroupid = d.vgroupid and g.vreference = d.vreference
         where d.id_propuesta = f.id_propuesta
         order by d.tipo_cartera, d.vgroupid nulls first, d.vreference;
    else
        return query
        select f.folio, f.comprador, f.fecha_venta, h.tipo, h.vgroupid, h.datos->>'grupo', h.vreference,
               h.datos->>'icredid', null::text, h.datos->>'nombre', h.datos->>'estado', h.datos->>'municipio', h.datos->>'sucursal',
               public._num(h.datos->>'capital'), null::text
          from public.ventas_historico_detalle h
         where upper(h.folio) = upper(f.folio)
         order by h.tipo, h.vgroupid nulls first, h.vreference;
    end if;
end $$;
revoke all on function public.expedientes_layout(text) from public, anon;
grant execute on function public.expedientes_layout(text) to authenticated;

/** Datos para el correo a expedientes (lo usa la función enviar-propuesta). */
create or replace function public.expedientes_aviso_datos(p_folio text)
returns json language plpgsql stable security definer set search_path = public as $$
declare f public.funnel_ventas; yo record;
begin
    perform public._exigir_activo();
    if not public.funnel_puede_editar(p_folio) then
        raise exception 'Sólo el vendedor de %, el auxiliar de venta o un maestro avisan a expedientes', p_folio using errcode = '42501';
    end if;
    select * into f from public.funnel_ventas where folio = p_folio;
    select coalesce(nombre, email) nombre, email into yo from public.perfiles where user_id = auth.uid();
    return json_build_object('folio', f.folio, 'comprador', f.comprador, 'tipo', f.tipo, 'estatus', f.estatus_venta,
        'capital', f.capital, 'fecha_venta', f.fecha_venta, 'estado', f.estado,
        'para', to_json(public._correos_expedientes()),
        'saludo', coalesce(public._config('expedientes_nombre') #>> '{}', ''),
        'yo_nombre', yo.nombre, 'yo_correo', yo.email,
        'aviso', (select row_to_json(a) from public.expedientes_avisos a where a.folio = p_folio));
end $$;
revoke all on function public.expedientes_aviso_datos(text) from public, anon;
grant execute on function public.expedientes_aviso_datos(text) to authenticated;

create or replace function public.expedientes_aviso_marcar(p_folio text, p_para text, p_error text default null)
returns void language plpgsql volatile security definer set search_path = public as $$
declare quien text;
begin
    perform public._exigir_activo();
    if not public.funnel_puede_editar(p_folio) then raise exception 'Sin permiso' using errcode = '42501'; end if;
    select coalesce(nombre, email) into quien from public.perfiles where user_id = auth.uid();
    insert into public.expedientes_avisos as a (folio, enviado_en, enviado_a, enviado_por, error)
    values (p_folio, case when p_error is null then now() end, p_para, quien, p_error)
    on conflict (folio) do update set
        enviado_en = case when p_error is null then now() else a.enviado_en end,
        enviado_a = coalesce(excluded.enviado_a, a.enviado_a), enviado_por = excluded.enviado_por, error = p_error;
    if p_error is null then
        insert into public.funnel_comentarios (folio, user_id, autor, texto)
        values (p_folio, auth.uid(), quien, '📧 Aviso a expedientes enviado a ' || p_para);
    end if;
end $$;
revoke all on function public.expedientes_aviso_marcar(text, text, text) from public, anon;
grant execute on function public.expedientes_aviso_marcar(text, text, text) to authenticated;

/** Ventas vendidas cuyo aviso a expedientes sigue pendiente (las ve auxiliar / maestros o su vendedor). */
drop function if exists public.expedientes_pendientes();
create or replace function public.expedientes_pendientes()
returns table (folio text, comprador text, creado timestamptz, error text)
language plpgsql stable security definer set search_path = public as $$
begin
    perform public._exigir_activo();
    return query select a.folio, f.comprador, a.creado, a.error
      from public.expedientes_avisos a join public.funnel_ventas f on f.folio = a.folio
     where a.enviado_en is null and public.funnel_puede_editar(a.folio)
     order by a.creado;
end $$;
revoke all on function public.expedientes_pendientes() from public, anon;
grant execute on function public.expedientes_pendientes() to authenticated;
