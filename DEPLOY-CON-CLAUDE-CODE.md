# Deploy de Bukéame con Claude Code — Guía de arranque

Esta guía te lleva de cero a Bukéame corriendo, usando Claude Code en tu VPS de Hostinger. Tú supervisas desde el móvil con Remote Control.

---

## Resumen del plan

1. Conectarte a tu VPS por SSH (una vez)
2. Crear un usuario seguro (no-root) para Claude Code
3. Instalar Claude Code en el VPS
4. Darle el "prompt maestro" para que instale Bukéame
5. Supervisar desde el móvil con Remote Control

---

## Antes de empezar — lo que necesitas

- **Acceso SSH a tu VPS** (IP del servidor + tu forma de conectarte)
- **Tu plan de Claude** (Max recomendado para Remote Control; verifica si Pro te lo permite)
- **El app de Claude en tu teléfono**, actualizado a la última versión
- **El repo ya subido** a `github.com/jcolon91/Bukeame` ✅ (ya lo tienes)

---

## Paso 1 — Conéctate a tu VPS

Desde una terminal (o desde donde te conectes normalmente a Hostinger):

```bash
ssh root@2.24.70.107
```

> Usa la IP y el método que ya usas para entrar a tu servidor de Wifnix.

---

## Paso 2 — Crea un usuario seguro para Claude Code

**Importante:** nunca corras Claude Code como root. Esto también protege a Wifnix.

```bash
# Crear usuario dedicado con permisos sudo
adduser deploy
usermod -aG sudo deploy

# Cambiar a ese usuario
su - deploy
```

> Si ya tienes un usuario no-root que usas para Wifnix, puedes usar ese en vez de crear "deploy".

---

## Paso 3 — Instala Claude Code

Ya como el usuario `deploy` (no root):

```bash
# Instalador nativo (recomendado para Linux en 2026, sin dependencia de Node)
curl -fsSL https://claude.ai/install.sh | bash

# Verificar que instaló
claude --version

# Chequeo de salud (confirma auth y config)
claude doctor
```

La primera vez te va a pedir que inicies sesión con tu cuenta de Anthropic. Sigue las instrucciones en pantalla.

---

## Paso 4 — Activa Remote Control (para supervisar desde el móvil)

Inicia una sesión de Claude Code:

```bash
claude
```

Dentro de la sesión, escribe:

```
/remote-control
```

Aparecerá un **código QR**. Escanéalo con el app de Claude en tu teléfono. A partir de ahí, controlas la sesión desde el móvil.

---

## Paso 5 — El PROMPT MAESTRO

Una vez en la sesión de Claude Code (desde la terminal o ya controlando desde el móvil), pégale esto:

---

> Vas a instalar mi aplicación "Bukéame" en este VPS de Hostinger. Es CRÍTICO que mantengas aislamiento total de mi otra aplicación "Wifnix" que ya corre en este mismo servidor — no debes tocar nada de Wifnix.
>
> Pasos:
> 1. Primero corre estos comandos de diagnóstico de SOLO LECTURA y muéstrame la salida: `pm2 list`, `node -v && psql --version`, `ss -tlnp | grep -E ':(3000|3001|5432)'`, `sudo -u postgres psql -l`, `ls /etc/nginx/sites-enabled/`, `free -h`
> 2. Clona el repositorio: `https://github.com/jcolon91/Bukeame.git` en `/var/www/turnify`
> 3. Sigue exactamente la guía que está en `docs/DEPLOY.md` del repositorio. Esa guía tiene todos los pasos: crear la base de datos `turnify` con usuario `turnify_user` aislado, cargar los schemas, configurar el backend, arrancar con PM2 como `turnify-api` en el puerto 3001, y configurar Nginx para `bukeame.com`.
> 4. Para el archivo `.env`: genera secretos seguros para JWT_SECRET y JWT_REFRESH_SECRET con `openssl rand -base64 48`. Para las credenciales de Evolution (WhatsApp) y Resend (email), déjalas con placeholders y avísame cuáles necesito llenar después.
> 5. Antes de cada comando que modifique algo, explícame qué vas a hacer. No ejecutes nada destructivo sin confirmarme.
> 6. Reglas de aislamiento que NO puedes violar: usa la carpeta `/var/www/turnify` (no `/var/www/wifnix`), el proceso PM2 `turnify-api` (no `wifnix-api`), el puerto 3001 (Wifnix usa 3000), la base de datos `turnify` con usuario `turnify_user`, y asegúrate de correr `REVOKE ALL ON DATABASE wifnix FROM turnify_user` para que Bukéame nunca pueda tocar la base de datos de Wifnix.
> 7. Al final, verifica que todo corre con `curl http://localhost:3001/api/health` y muéstrame el resultado.
>
> Procede paso a paso, mostrándome la salida de cada comando.

---

## Qué esperar

Claude Code va a:
1. Correr el diagnóstico y mostrarte el estado del servidor
2. Clonar el repo
3. Ir ejecutando el `DEPLOY.md` paso a paso, pidiéndote confirmación en los pasos que modifican algo
4. Levantar Bukéame y confirmarte que responde

Tú solo supervisas y confirmas desde el móvil.

---

## Después del deploy — lo que tendrás que completar tú

Estas cosas Claude Code no las puede hacer solo (requieren tus cuentas externas):

| Qué | Dónde |
|---|---|
| Apuntar el dominio `bukeame.com` al IP del VPS | Tu panel de DNS (donde compraste el dominio) |
| Credenciales de Evolution API (WhatsApp) | Llenar en el `.env` |
| Credenciales de Resend (email) | Llenar en el `.env` |
| Certificado SSL | Claude Code lo intenta con certbot, pero necesita que el DNS ya apunte al server |

---

## Seguridad — recordatorios

- **Nunca como root.** Claude Code corre como el usuario `deploy` con permisos limitados.
- **El `.env` nunca se sube a GitHub** (ya está en `.gitignore`).
- **Remote Control es seguro:** tu servidor solo hace conexiones salientes por HTTPS, no abre puertos de entrada.
- **Wifnix está protegido:** el aislamiento por usuario de base de datos y el `REVOKE` garantizan que Bukéame no pueda tocar a Wifnix.

---

## Si algo sale mal

Claude Code mismo puede diagnosticar y arreglar. Pero si quieres parar todo:

```bash
pm2 stop turnify-api      # detiene solo Bukéame, Wifnix sigue corriendo
```

Y si necesitas revisar qué pasó:

```bash
pm2 logs turnify-api --lines 50
```
