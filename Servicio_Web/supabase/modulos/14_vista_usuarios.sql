-- ============================================================
-- Vista para consultar usuarios desde Supabase (Table Editor › usuarios_app).
-- Correo = el que se usa para entrar. No muestra contraseñas (sólo existen cifradas en auth.users).
-- No se expone a la página. Altas y cambios: módulo Usuarios del sitio.
-- ============================================================
drop view if exists public.usuarios_app;
create view public.usuarios_app
with (security_invoker = true) as
select u.email::text                    as correo,
       p.nombre,
       case p.rol when 'validador' then 'Validador (maestro)' when 'auxiliar' then 'Auxiliar de venta'
                  when 'admin' then 'Administrador' else 'Vendedor' end as rol,
       p.activo,
       u.email_confirmed_at is not null as confirmado,
       u.last_sign_in_at                as ultimo_ingreso,
       p.creado                         as alta,
       p.user_id
  from public.perfiles p
  join auth.users u on u.id = p.user_id;
revoke all on public.usuarios_app from anon, authenticated;
