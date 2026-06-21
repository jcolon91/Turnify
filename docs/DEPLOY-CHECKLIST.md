# Checklist de Deploy — Bukéame

Runbook consolidado para subir todo a GitHub (repo `jcolon91/Bukeame`, rama `main`)
y deployar al VPS. Sigue los pasos EN ORDEN. Da un solo comando a la vez en el server.

Resumen de esta sesion: rebrand Turnify -> Bukeame (frontend 100% turnify-free),
rediseno completo (tema claro/oscuro en las 13 paginas), fundacion de metodos de
pago de los negocios (tabla nueva + modulo + vista), 11 fixes de seguridad ya
aplicados, y switch al dominio nuevo `bukeame.com`.

---

## 0. Antes de empezar (pre-checks)

- [ ] Confirmar que el codigo local en `Turnify app/` ya esta sincronizado con
      produccion + todos los cambios de la sesion (lo esta).
- [ ] `node --check` debe pasar en backend (server.js y los 6 modulos).
- [ ] DNS de `bukeame.com` -> VPS: YA HECHO.
- [ ] Resend con `bukeame.com` verificado (DNS): YA HECHO.

---

## 1. Archivos a subir a GitHub

Subir con GitHub web (Add file -> Upload files, arrastrando carpetas).
NUNCA subir el repo completo (revierte cambios de produccion no sincronizados).
Subir SOLO lo que cambio, en su estructura de carpetas.

### Subir (carpetas completas, porque cambiaron enteras esta sesion)
- [ ] `backend/` — server.js, module-revenue.js, module-loyalty.js,
      module-admin.js, module-accounting.js, module-account.js,
      module-payments.js (NUEVO), package.json, .env.example
- [ ] `frontend/` — las 13 paginas .html (rediseno aplicado a todas) +
      `bukeame-banners.js` (renombrado desde turnify-banners.js)
- [ ] `database/` — incluir `07-schema-payments.sql` (NUEVA). Las 01-06 ya
      existen en el repo; subirlas no hace dano (idempotente al no re-correrlas).
- [ ] `docs/` — ARCHITECTURE.md, DEPLOY.md, DEPLOY-CON-CLAUDE-CODE.md,
      PAGOS-FASE-PROCESAMIENTO.md, PAGOS-ATH-MOVIL.md, y este DEPLOY-CHECKLIST.md
- [ ] Raiz — README.md, .gitignore (solo si cambiaron)

### BORRAR / NO subir (importante)
- [ ] NO subir `uploads/` — la copia local esta DESFASADA (dominio viejo
      bukeamepr.com, sin vista de Clientes ni reset.html). El bueno vive en el
      server. Borrarla del folder local antes de armar el upload.
- [ ] NO subir la carpeta del diseno (`_diseno_ref` / "Diseno app citas
      servicios") — era temporal, solo fuente de mockups.
- [ ] NO subir `Documentos/` ni copias viejas duplicadas en la raiz.
- [ ] Recordatorio: si el dueno crea un archivo en la RAIZ del repo por error,
      editar el que YA existe en su carpeta, no duplicar.

---

## 2. Migraciones SQL (correr en el VPS, en orden)

Comando base:
```
sudo -u postgres psql -d turnify -f /var/www/turnify/database/<archivo>.sql
```

- [ ] **CRITICA / NUEVA: `07-schema-payments.sql`** — crea la tabla
      `payment_providers` (metodos de pago de los negocios). SIN esto, la vista
      "Pagos" y `module-payments.js` fallan.
- [ ] Antes de correr la 07, VERIFICAR que 04, 05 y 06 ya corrieron en el VPS
      (multiservice, password-reset, reminders). Si alguna falta, correrla
      primero, en orden numerico. Chequeo rapido:
      `sudo -u postgres psql -d turnify -c "\dt"` y confirmar que existen las
      tablas de esos schemas (ej. `password_resets`).
- [ ] Tras crear la tabla nueva, dar permisos al usuario de la app:
      `sudo -u postgres psql -d turnify -c "GRANT SELECT,INSERT,UPDATE,DELETE ON payment_providers TO turnify_user;"`
      (`turnify_user` NO crea/altera tablas; por eso el DDL va como postgres.)

---

## 3. Switch de dominio a bukeame.com

(DNS -> VPS y Resend ya estan hechos. Falta Nginx + SSL + .env.)

- [ ] Nginx server_block para `bukeame.com`:
      - `root /var/www/turnify/frontend;`
      - `location /api` -> `proxy_pass http://localhost:3002;`
        (con los headers de proxy: Host, X-Real-IP, X-Forwarded-For/Proto).
      - `server_name bukeame.com www.bukeame.com;`
- [ ] Recargar Nginx: `sudo nginx -t && sudo systemctl reload nginx`
- [ ] Certbot (SSL): `sudo certbot --nginx -d bukeame.com -d www.bukeame.com`
- [ ] Actualizar el `.env` del server (`/var/www/turnify/backend/.env`):
      - `CORS_ORIGINS=https://bukeame.com`
      - `EMAIL_FROM=Bukeame <citas@bukeame.com>`
      - Verificar que `JWT_SECRET` real (64 chars) sigue puesto y que
        `SELF_SERVE_PAID` esta ausente o false (gated = seguro por defecto).

---

## 4. Deploy (en el VPS, un comando a la vez)

```
cd /var/www/turnify && git pull origin main
```
- [ ] Si dice "local changes would be overwritten":
      `git checkout -- <archivo>` y volver a hacer pull.

```
cd backend && node --check server.js
```
- [ ] Debe pasar sin errores antes de reiniciar.

```
pm2 restart turnify-api
```

- [ ] Frontend: recargar el sitio en INCOGNITO (Brave cachea agresivo).
- [ ] NOTA: el rebrand cambio claves localStorage `turnify_*` -> `bukeame_*`,
      asi que este deploy cierra sesiones UNA vez. Es esperado.

---

## 5. Post-deploy (verificacion)

- [ ] El sitio carga en `https://bukeame.com` con candado (HTTPS valido).
- [ ] Login/registro funciona (sesion nueva tras el cierre por localStorage).
- [ ] La vista "Pagos" en el panel carga sin error (tabla `payment_providers` OK);
      Cash y ATH Movil activables; Stripe/PayPal muestran "Proximamente".
- [ ] La pagina publica `negocio.html` muestra los metodos de pago activos del
      negocio.
- [ ] Un email de prueba (bienvenida o recordatorio) SALE desde
      `citas@bukeame.com` y se ve bien (diseno nuevo, sin emojis).
- [ ] Bug `payment_status: "completed"`: revisar logs tras el restart. Al
      deployar el codigo actual ya sincronizado, el error podria desaparecer
      solo. Si PERSISTE, capturar `method url` + `err.stack` del error handler
      global, o revisar vistas/funciones de la DB del VPS que mezclen enums.

---

## 6. Nota sobre la infraestructura interna (NO cambiar)

A proposito se MANTIENE como `turnify` (es interno/invisible; cambiarlo rompe el
server o cierra sesiones sin beneficio de marca):
- DB `turnify`, usuario `turnify_user`
- Proceso PM2 `turnify-api`
- Directorio `/var/www/turnify`
- `EVOLUTION_INSTANCE=turnify`
- Puerto 3002

El rebrand a Bukeame es solo de cara al usuario (dominio, UI, emails).

---

## 7. Pendiente futuro (NO ahora)

Fase de PROCESAMIENTO de pagos — hacer cuando existan las cuentas de plataforma
(Stripe Connect / PayPal) y se pongan las llaves en `.env`:
- Spec completo: `docs/PAGOS-FASE-PROCESAMIENTO.md`
  (Stripe Connect + PayPal + Stripe Billing de membresias + DB + .env +
  seguridad + orden). Un solo Stripe Connect cubre tarjetas + Apple Pay +
  Google Pay + Klarna.
- ATH Movil automatico: `docs/PAGOS-ATH-MOVIL.md`
  (recomendacion: manual como default; Payment Button API como Fase 2 opt-in,
  despues de Stripe).

Por ahora NO se necesita tocar esto para el deploy del rebrand + dominio.
