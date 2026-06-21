# Guía de instalación — Bukéame en Hostinger VPS

Esta guía instala Bukéame en el mismo VPS donde corre Wifnix, **completamente aislado** para que nunca se toquen.

> ⚠️ **Antes de empezar:** corre los comandos de diagnóstico de la sección 0 y compártelos, para calibrar los pasos a tu servidor exacto.

---

## Aislamiento: Bukéame vs Wifnix

| | Wifnix | Bukéame |
|---|---|---|
| Carpeta | `/var/www/wifnix` | `/var/www/bukeame` |
| Proceso PM2 | `wifnix-api` | `bukeame-api` |
| Puerto | `:3000` | `:3001` |
| Base de datos | `wifnix` | `bukeame` |
| Usuario DB | (el de Wifnix) | `bukeame_user` |
| Nginx | (server block Wifnix) | server block aparte |

El usuario `bukeame_user` **no tiene permisos** sobre la base de datos de Wifnix. Pared a nivel de motor.

---

## 0. Diagnóstico (solo lectura — no cambia nada)

Corre esto y comparte la salida antes de seguir:

```bash
pm2 list
node -v && psql --version
ss -tlnp | grep -E ':(3000|3001|5432)'
sudo -u postgres psql -l
ls /etc/nginx/sites-enabled/
free -h
```

Esto dice: qué procesos corren, si el puerto 3001 está libre, qué bases existen, cómo está Nginx, y cuánta RAM hay.

---

## 1. Crear la base de datos aislada

```bash
sudo -u postgres psql
```

Dentro de psql:

```sql
-- Crear usuario y base de datos de Bukéame
CREATE USER bukeame_user WITH PASSWORD 'PON_UN_PASSWORD_FUERTE_AQUI';
CREATE DATABASE bukeame OWNER bukeame_user;

-- Asegurar que NO tiene acceso a la base de Wifnix
REVOKE ALL ON DATABASE wifnix FROM bukeame_user;

\q
```

---

## 2. Clonar el repositorio

```bash
cd /var/www
sudo git clone https://github.com/jcolon91/Bukeame.git bukeame
sudo chown -R $USER:$USER /var/www/bukeame
cd /var/www/bukeame
```

> Si prefieres tu método de `wget` por archivo (como en Wifnix), también sirve — pero `git clone` es más limpio para la primera instalación.

---

## 3. Cargar los esquemas de la base de datos

```bash
cd /var/www/bukeame/database
psql -U bukeame_user -d bukeame -f 01-schema-base.sql
psql -U bukeame_user -d bukeame -f 02-schema-v1.1.sql
```

Verifica que cargó (debe mostrar ~40 tablas):

```bash
psql -U bukeame_user -d bukeame -c "\dt" | wc -l
```

---

## 4. Configurar el backend

```bash
cd /var/www/bukeame/backend
npm install --production

# Crear el .env desde la plantilla
cp .env.example .env
nano .env
```

En el `.env`, llena:
- `DATABASE_URL` con el password que pusiste en el paso 1
- `JWT_SECRET` y `JWT_REFRESH_SECRET` — genera cada uno con `openssl rand -base64 48`
- `CORS_ORIGINS` con `https://bukeame.com`
- Las credenciales de Evolution (WhatsApp) y Resend (email)

---

## 5. Validar y arrancar con PM2

```bash
cd /var/www/bukeame/backend

# Validar sintaxis primero (tu paso de siempre)
node --check server.js

# Arrancar con PM2 (límite de memoria por seguridad)
pm2 start server.js --name bukeame-api --max-memory-restart 300M
pm2 save
```

Verifica que arrancó:

```bash
pm2 list
curl http://localhost:3001/api/health
```

Debe responder: `{"ok":true,"service":"bukeame-api",...}`

---

## 6. Nginx — server block para bukeame.com

Crea el archivo:

```bash
sudo nano /etc/nginx/sites-available/bukeame.com
```

Contenido:

```nginx
server {
    listen 80;
    server_name bukeame.com www.bukeame.com;

    # Frontend (HTML estático)
    root /var/www/bukeame/frontend;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # API → proxy al backend en :3001
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Activar y recargar:

```bash
sudo ln -s /etc/nginx/sites-available/bukeame.com /etc/nginx/sites-enabled/
sudo nginx -t          # validar configuración
sudo systemctl reload nginx
```

---

## 7. SSL (HTTPS) con Let's Encrypt

```bash
sudo certbot --nginx -d bukeame.com -d www.bukeame.com
```

Certbot configura HTTPS automáticamente y renueva solo.

---

## Actualizaciones futuras (tu flujo de siempre)

Cuando haya cambios en el código:

```bash
cd /var/www/bukeame
git pull origin main

# Si cambió el backend:
cd backend
npm install --production        # solo si cambiaron dependencias
node --check server.js
pm2 restart bukeame-api

# Si cambió el frontend: nada que hacer, Nginx ya sirve los HTML nuevos
# Si cambió la base de datos: corre el nuevo .sql con psql
```

---

## Comandos útiles

```bash
pm2 logs bukeame-api           # ver logs en vivo
pm2 restart bukeame-api        # reiniciar
pm2 stop bukeame-api           # detener
pm2 monit                      # monitor de recursos

# Ver conexiones a la base de datos
sudo -u postgres psql -d bukeame -c "SELECT count(*) FROM pg_stat_activity WHERE datname='bukeame';"
```

---

## Solución de problemas

**El API no responde:**
```bash
pm2 logs bukeame-api --lines 50
```

**Error de conexión a la base de datos:**
- Verifica el `DATABASE_URL` en `.env`
- Confirma que PostgreSQL corre: `sudo systemctl status postgresql`

**Nginx da 502:**
- El backend probablemente está caído: `pm2 list` y `pm2 restart bukeame-api`

**Puerto 3001 ocupado:**
- Cambia `PORT` en `.env` a otro (ej. 3002) y actualiza el `proxy_pass` en Nginx.
