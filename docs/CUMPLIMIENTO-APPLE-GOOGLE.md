# Cumplimiento Apple App Store y Google Play — Checklist de aprobación

Esta guía es el **checklist de parámetros y requisitos** para que la app de Bukéame
(operada por Wifnix LLC, Puerto Rico) sea **aprobada** en la **Apple App Store** y en
**Google Play**. Está pensada para una app que envuelve el sitio web (WebView/híbrida)
o para una app nativa que consume el mismo backend `/api`.

> **Cómo leer esta guía**
> - `[ ]` = tarea accionable que debes completar y poder demostrar.
> - **VALIDAR LEGAL/POLÍTICA** = punto que NO debes asumir; requiere confirmación con
>   un abogado o con la política vigente de la tienda antes de someter. Las políticas
>   de Apple y Google cambian; verifica las versiones actuales al momento de someter.
> - Las dos tiendas comparten muchos requisitos pero los formularios y nombres difieren.
>   Donde aplica, se separa **APPLE** y **GOOGLE**.

> **Advertencia de alcance:** este documento es una lista de cumplimiento operativa,
> no asesoría legal. Las reglas de pagos de Apple (Guideline 3.1.1 / 3.1.3) y la
> clasificación de tu modelo de negocio son el riesgo de rechazo #1 — ver la sección
> de PAGOS y marcarla como VALIDAR antes de invertir en el envío.

---

## 0. Resumen de los 8 puntos que más rechazan apps

| # | Requisito | Apple | Google | Riesgo si falta |
|---|-----------|-------|--------|-----------------|
| 1 | Política de privacidad en URL pública | Sí | Sí | Rechazo seguro |
| 2 | Eliminación de cuenta **dentro de la app** | Sí | Sí | Rechazo seguro |
| 3 | Etiquetas de privacidad / Data Safety completas y veraces | Sí | Sí | Rechazo / retiro |
| 4 | Reglas de pago (IAP vs externo) correctas | Sí (crítico) | Sí | Rechazo / suspensión |
| 5 | Permisos justificados con texto de propósito | Sí | Sí | Rechazo |
| 6 | Moderación de contenido generado por usuarios | Sí | Sí | Rechazo (apps UGC) |
| 7 | Soporte / contacto accesible | Sí | Sí | Rechazo |
| 8 | Edad mínima y clasificación de contenido | Sí | Sí | Rechazo |

---

## 1. Política de privacidad (URL pública)

- [ ] La política existe en una **URL pública, estable y accesible sin login**:
      `https://bukeame.com/privacidad.html` (ya existe, v1.0 jun-2026).
- [ ] La misma URL se pega en **App Store Connect** (campo *Privacy Policy URL*) y en
      **Google Play Console** (*Store listing → Privacy Policy*).
- [ ] La política debe estar **enlazada también dentro de la app** (no solo en la ficha
      de la tienda): un enlace visible en ajustes / menú de cuenta.
- [ ] El **contenido debe coincidir** con lo que realmente recopila la app y con lo
      declarado en Data Safety / Nutrition Labels (inconsistencia = causa de rechazo).
- [ ] **VALIDAR:** la política actual (`privacidad.html` v1.0) **no menciona por nombre**
      Stripe, PayPal, gift cards, lista de espera, reseñas, geolocalización/Leaflet,
      `localStorage`, ni Resend/Evolution en detalle. Antes de someter, **ampliar la
      política** para nombrar explícitamente:
  - Procesadores de pago: **Stripe, PayPal, ATH Móvil** (y que el dinero va directo al negocio).
  - Mensajería: **WhatsApp/Evolution** (recordatorios y avisos).
  - Email: **Resend** (verificación, avisos, gift cards).
  - **Geolocalización** opcional del navegador/dispositivo y mapas **Leaflet/OpenStreetMap**.
  - Uso de **`localStorage`** para sesión (`bukeame_token`, `bukeame_role`) y tema (`bukeame_theme`).
  - **Reseñas, gift cards, lista de espera** como datos que se recopilan.
- [ ] Identificar al responsable: **Wifnix LLC, Puerto Rico**, con método de contacto.
- [ ] **VALIDAR LEGAL:** como Bukéame procesa datos de **clientes finales** en nombre del
      negocio (modelo encargado/responsable), confirmar el lenguaje de rol de datos.

---

## 2. Eliminación de cuenta DENTRO de la app (requisito de AMBAS tiendas)

> Apple lo exige desde 2022; Google lo exige vía formulario de **Data deletion**.
> No basta con "borra desde la web" — debe poder iniciarse desde la app.

- [ ] La app debe ofrecer una opción **clara para iniciar el borrado de la cuenta**
      desde dentro de la app (no solo enviar a soporte).
- [ ] Bukéame **ya tiene** el flujo en el panel: *Mi cuenta → Zona de peligro → Borrar
      cuenta* (`deleteModal`, escribir "BORRAR MI CUENTA"). Confirmar que ese flujo es
      **alcanzable desde la versión app** (que la WebView/nativa exponga esa pantalla).
- [ ] **GOOGLE:** llenar en Play Console el formulario de **Data deletion**:
  - URL para **solicitar borrado de cuenta** (puede ser la pantalla in-app o una web).
  - URL para **solicitar borrado de datos sin borrar la cuenta** (si aplica).
- [ ] **APPLE:** la ruta de borrado debe estar accesible y, si el borrado requiere pasos
      fuera de la app, explicarlo claramente.
- [ ] **Documentar la retención post-borrado** y que sea consistente con la política:
      Bukéame **conserva transacciones anonimizadas** por requisito **fiscal de PR y EE.UU.**
      Esto es legítimo, pero **debe declararse** (qué se borra vs. qué se conserva anonimizado).
- [ ] **VALIDAR LEGAL:** confirmar que la retención fiscal de registros anonimizados está
      correctamente fundamentada y descrita, para que no contradiga "borramos tus datos".
- [ ] Ofrecer **descargar la contabilidad/datos antes de borrar** (Bukéame ya lo ofrece).

---

## 3. Declaración de datos: Data Safety (Google) y Nutrition Labels (Apple)

> Ambas son **autodeclaraciones** que el desarrollador llena. Deben ser **veraces** y
> **coincidir** con la política de privacidad y con el comportamiento real de la app.

### 3A. Qué datos declarar (mapa de recopilación de Bukéame)

| Categoría de dato | Qué recopila Bukéame | ¿Vinculado al usuario? | Propósito |
|-------------------|----------------------|------------------------|-----------|
| **Nombre** | Cuenta, reservas, gift cards | Sí | Funcionalidad de la app, cuenta |
| **Email** | Cuenta, verificación, avisos | Sí | Cuenta, comunicaciones |
| **Teléfono / WhatsApp** | Cuenta y reservas/recordatorios | Sí | Funcionalidad, comunicaciones |
| **Contraseña / credenciales** | Login (hash, nunca texto plano) | Sí | Autenticación |
| **Ubicación aproximada** | Geolocalización opcional para "cerca de ti"; lat/lng del negocio | Sí (opcional) | Funcionalidad de búsqueda |
| **Identificadores de usuario** | Token JWT en `localStorage`, rol | Sí | Sesión / autenticación |
| **Compras / historial de transacciones** | Citas, órdenes, propinas, método de pago, gift cards | Sí | Funcionalidad |
| **Contenido del usuario** | Reseñas, comentarios, notas de cliente, fotos (logo/banner/portafolio/productos) | Sí | Funcionalidad |
| **Mensajes / contactos del negocio** | Datos de clientes que el negocio gestiona (nombre, WhatsApp, notas) | Sí | Funcionalidad (en nombre del negocio) |
| **Info financiera (limitada)** | Bukéame **no custodia** dinero; conecta cuentas (ATH Móvil/PayPal/Stripe) | Parcial | Pagos (procesados por terceros) |

- [ ] Declarar **recopilación** de cada categoría aplicable arriba.
- [ ] Declarar **compartición con terceros** solo lo que aplica: procesadores de pago
      (Stripe/PayPal/ATH Móvil), mensajería (Evolution/WhatsApp), email (Resend),
      hosting, mapas (OpenStreetMap/Leaflet). **No se vende** información.
- [ ] Declarar **cifrado en tránsito** (HTTPS) — ambas tiendas lo preguntan.
- [ ] Declarar que el usuario **puede solicitar borrado** de datos (enlaza con sección 2).

### 3B. GOOGLE — Data Safety (Play Console)

- [ ] Completar la sección **Data safety**: Data collected, Data shared, Security practices.
- [ ] Marcar para cada tipo: **¿se recopila?**, **¿se comparte?**, **¿es obligatorio u opcional?**,
      **propósito** (App functionality, Account management, etc.).
- [ ] Marcar **"Datos cifrados en tránsito"** = Sí.
- [ ] Marcar **"El usuario puede solicitar eliminación de datos"** = Sí (apunta al flujo de la sección 2).
- [ ] Verificar consistencia con la **Account deletion URL** del mismo formulario.

### 3C. APPLE — Privacy Nutrition Labels (App Store Connect)

- [ ] Completar **App Privacy** en App Store Connect declarando los tipos de datos arriba.
- [ ] Para cada tipo: indicar si es **Used to Track You**, **Linked to You**, o **Not Linked**.
      En Bukéame casi todo es **Linked to You** (cuenta), y **no debe haber tracking
      cross-app** (no hay SDKs de publicidad) → declarar **"Data Not Used to Track You"**.
- [ ] Si NO hay tracking, **no incluir** `AppTrackingTransparency`/IDFA. Si en el futuro se
      añade analítica de terceros, **VALIDAR** si requiere prompt de ATT.
- [ ] Confirmar que **no hay SDKs ocultos** que recopilen más de lo declarado (revisar
      cualquier librería de terceros incluida en el binario).

---

## 4. Reglas de PAGOS — Apple IAP vs pago externo (PUNTO CRÍTICO — VALIDAR)

> Esta es la sección de **mayor riesgo de rechazo**. Apple distingue entre **bienes/servicios
> digitales** (deben usar In-App Purchase y pagar comisión) y **bienes/servicios físicos o
> del mundo real** (pueden y deben usar pago externo). Bukéame mezcla ambos.

### 4A. Tres flujos de dinero en Bukéame — clasificación

| Flujo | Qué es | Clasificación probable | Regla |
|-------|--------|------------------------|-------|
| **A. Citas/servicios** | Reservas y **depósitos** a barberías/salones (mundo real) | Servicio del **mundo real** | **Pago externo permitido** (ATH Móvil/PayPal/Stripe directo al negocio) |
| **B. Productos físicos / tienda** | Compra de productos físicos, gift cards de un negocio físico | **Bienes físicos** | **Pago externo permitido**; **IAP prohibido** para bienes físicos |
| **C. Suscripción del negocio a Bukéame** | Planes Pro/Studio, add-ons, "destacar", semanas de featured | Acceso a **funciones de software / servicio digital** | **ZONA GRIS — VALIDAR** |

- [ ] **A y B (citas, depósitos, productos, gift cards): pago externo es correcto.** Estos
      son servicios del mundo real y bienes físicos; Apple **no exige IAP** y de hecho
      **no permite IAP** para bienes físicos. Mantener ATH Móvil/PayPal/Stripe directo al negocio.
- [ ] **NO** poner botones que parezcan venta digital ni "desbloqueos" para los flujos A/B.

### 4B. El punto a validar: la suscripción del negocio (flujo C)

- [ ] **VALIDAR CON POLÍTICA DE APPLE / ABOGADO:** la **suscripción de negocios a Bukéame**
      (planes pagos, add-ons, featured) podría interpretarse como **servicio digital**
      cuyo acceso se consume *dentro de la app*, lo que **podría obligar a usar Apple IAP**
      (con comisión 15–30%) si se vende/activa desde la app de iOS.
- [ ] Considerar las **excepciones / matices** (verificar redacción vigente):
  - **"Reader" / multiplataforma:** apps que dan acceso a contenido/servicio comprado
    fuera pueden no requerir IAP, bajo condiciones.
  - **App de negocios / B2B:** Bukéame es una herramienta para negocios; algunos modelos
    SaaS B2B han operado con pago web. **No asumir** — confirmar.
  - **Cambios recientes de Apple** (resultado de litigios) permiten en algunas regiones
    enlazar a pago externo. **VALIDAR jurisdicción** (PR/EE.UU.).
- [ ] **Estrategia conservadora a evaluar (con abogado):** en la versión iOS, **no vender ni
      cobrar la suscripción Bukéame dentro de la app**; el negocio gestiona su plan en la web.
      La app iOS solo refleja el plan ya activo. **VALIDAR que esto cumple** y que no se
      considera "redirección prohibida" hacia pago externo de un bien digital.
- [ ] **GOOGLE Play:** Google también exige **Play Billing** para bienes/servicios digitales
      in-app, con matices distintos a Apple. Bienes físicos y servicios del mundo real van
      por pago externo. **VALIDAR** el mismo punto del flujo C para Android.
- [ ] **No mezclar** en una misma pantalla un pago IAP con un pago externo para el mismo ítem.
- [ ] Documentar la decisión final de pagos **por tienda** antes de construir el binario.

---

## 5. Permisos y su justificación

> Cada permiso sensible necesita: (a) usarse solo si el usuario lo activa, y
> (b) un **texto de propósito** claro. Pedir permisos que la app no usa = rechazo.

### 5A. Ubicación

- [ ] La ubicación es **opcional** (solo para "cerca de ti" en el buscador). Pedirla
      **en contexto**, justo cuando el usuario toca "usar mi ubicación", no al abrir la app.
- [ ] **APPLE — Info.plist:** `NSLocationWhenInUseUsageDescription` con texto en español, ej.:
      *"Bukéame usa tu ubicación para mostrarte negocios cercanos y calcular la distancia. Es opcional."*
- [ ] **NO** pedir ubicación *Always* (en segundo plano); solo **When In Use**.
- [ ] **GOOGLE:** declarar `ACCESS_COARSE_LOCATION` (aproximada basta) en el manifest y en
      la sección de permisos de Play; **no** usar `ACCESS_FINE_LOCATION` ni background salvo
      que se justifique (background location en Google requiere revisión especial).
- [ ] La app debe **funcionar sin ubicación** (degradar a búsqueda por nombre/pueblo).

### 5B. Notificaciones

- [ ] **APPLE:** pedir permiso de notificaciones **en contexto** (no al primer arranque);
      explicar el valor (recordatorios de citas, avisos de lista de espera).
- [ ] **GOOGLE (Android 13+):** declarar y solicitar `POST_NOTIFICATIONS` en contexto.
- [ ] Nota: hoy los avisos de Bukéame van por **WhatsApp/email**, no push nativo. Si la app
      **no** usa push, **no** pidas permiso de notificaciones (pedir permisos sin uso = rechazo).

### 5C. Otros permisos a revisar (solo si la app los usa)

- [ ] **Cámara / Fotos** (`NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`):
      solo si la app permite subir logo/banner/portafolio/fotos de producto desde el dispositivo.
- [ ] **NO declarar** permisos no usados. Auditar el manifest/Info.plist final.

---

## 6. Contenido generado por usuarios (UGC) y moderación

> Bukéame tiene UGC: **reseñas, comentarios, fotos de portafolio/productos, perfiles de
> negocio, notas**. Ambas tiendas **exigen mecanismos de moderación** para apps con UGC.

- [ ] **Términos de uso** que prohíban contenido ofensivo, ilegal o spam (Bukéame ya lo
      tiene en `terminos.html`, sección de uso aceptable — confirmar que cubre UGC).
- [ ] **Filtro/método de moderación** del contenido objetable (manual o automático).
- [ ] **Mecanismo para reportar** contenido o usuarios abusivos **desde la app**.
- [ ] **Mecanismo para bloquear** usuarios abusivos (Bukéame ya permite al negocio
      **bloquear clientes**; evaluar si se necesita reporte por parte del cliente final).
- [ ] **Acción del desarrollador** para eliminar contenido y expulsar usuarios infractores
      (debe existir un proceso y poder demostrarlo a la tienda).
- [ ] **APPLE (Guideline 1.2):** estas 4 piezas (filtro, reporte, bloqueo, acción) son
      requisito explícito para apps con UGC. Tenerlas listas **antes** de someter.
- [ ] **VALIDAR:** confirmar que reseñas y fotos de producto/portafolio pasan por algún
      control antes o después de publicarse.

---

## 7. Soporte y contacto

- [ ] **URL de soporte** pública y funcional (App Store Connect: *Support URL*; Play: contacto).
- [ ] **Email de contacto** monitoreado (puede ser el de Wifnix LLC / Bukéame).
- [ ] Información de contacto **dentro de la app** (menú de ayuda/cuenta).
- [ ] **GOOGLE:** email del desarrollador verificado en Play Console (obligatorio).
- [ ] **APPLE:** datos de contacto de la *App Review* (nombre, teléfono, email) por si el
      revisor necesita comunicarse.

---

## 8. Edad mínima y clasificación de contenido

- [ ] Definir **edad mínima**: Bukéame es plataforma de servicios; cuentas de **negocio
      requieren 18+** (ya en `terminos.html`). Definir edad para **clientes** que reservan.
- [ ] **APPLE:** completar el cuestionario de **Age Rating** en App Store Connect (probable
      **4+ / 17+** según se interprete UGC y contacto entre usuarios — responder con honestidad).
- [ ] **GOOGLE:** completar el **Content Rating Questionnaire** (IARC) — genera la clasificación
      por región. Responder veraz sobre UGC, comunicación entre usuarios y comercio.
- [ ] **VALIDAR:** si se recopilan datos de menores o se permite que reserven menores,
      podrían aplicar reglas extra (Apple Kids Category, Google Families, COPPA). Bukéame
      **no** está dirigido a niños — declararlo así y **no** marcarse para público infantil.

---

## 9. Cuenta de demostración para el revisor

> Apple y Google necesitan **probar la app completa**, incluyendo áreas tras login.

- [ ] Crear **credenciales de prueba** (usuario/clave) de un negocio con datos de muestra:
      servicios, equipo, agenda, productos, una orden, etc.
- [ ] **APPLE:** poner esas credenciales en **App Review Information → Sign-In Information**.
- [ ] **GOOGLE:** proveer credenciales y, si hay flujos que el bot no alcanza, instrucciones.
- [ ] Si hay **login social** (Google/Apple), asegurar que el revisor pueda entrar **sin**
      depender de una cuenta social (dar login email/clave de prueba).
- [ ] Si algún flujo requiere pago real (depósito ATH), explicar cómo probar sin cobrar
      (o dejar un negocio de prueba con pago opcional/diferido).

---

## 10. Requisitos técnicos y de ficha (store listing)

- [ ] **APPLE — "Sign in with Apple":** si la app ofrece login con **Google u otro social**,
      Apple **exige** ofrecer también **Sign in with Apple** (con excepciones). **VALIDAR**
      si aplica a Bukéame; ya hay infraestructura de Apple login (`APPLE_CLIENT_ID`).
- [ ] **WebView/híbrida — riesgo Apple 4.2 ("minimum functionality"):** una app que es solo
      el sitio web envuelto **puede ser rechazada** por no aportar valor nativo suficiente.
      **VALIDAR/MITIGAR:** añadir funciones nativas (push, cámara, offline, atajos) o justificar.
- [ ] **Enlaces externos:** evitar dentro de la app botones/links que lleven a "compra en la web"
      de servicios digitales (relacionado con sección 4). Links a info general (soporte) sí.
- [ ] **Íconos, capturas y descripción** veraces; sin menciones a otras plataformas
      ("disponible en Android" dentro de la app iOS = rechazo).
- [ ] **Cumplir tamaños de capturas** por dispositivo y proveer ícono en alta resolución.
- [ ] **Versión mínima de OS** y prueba en dispositivos reales.
- [ ] **HTTPS en todo** (ATS de Apple). Confirmar que `unpkg.com`, `payments.athmovil.com`,
      `fonts.googleapis.com`, tiles de OSM, etc. cargan por HTTPS.
- [ ] **APPLE:** completar el cuestionario de **Export Compliance** (uso de cifrado HTTPS).

---

## 11. Antes de someter — lista accionable final

**Privacidad y cuenta**
- [ ] `privacidad.html` actualizada y ampliada (sección 1) y enlazada **dentro de la app**.
- [ ] URL de política pegada en App Store Connect y Play Console.
- [ ] Flujo de **borrar cuenta in-app** accesible y probado (sección 2).
- [ ] Formulario **Data Safety** (Google) completo y veraz.
- [ ] **Privacy Nutrition Labels** (Apple) completas y veraces.
- [ ] Coincidencia total entre política ↔ Data Safety ↔ Nutrition Labels ↔ comportamiento real.

**Pagos (VALIDAR antes que nada)**
- [ ] Decisión documentada por tienda sobre flujo C (suscripción del negocio) — sección 4B.
- [ ] Confirmado que citas/depósitos/productos/gift cards usan pago externo (correcto).
- [ ] Sin botones de venta digital que disparen reglas de IAP/Play Billing.

**Permisos**
- [ ] Ubicación: opcional, *When In Use*, con texto de propósito; app funciona sin ella.
- [ ] Notificaciones: solo si se usan; pedidas en contexto.
- [ ] Cámara/Fotos: declaradas solo si se usan; sin permisos sobrantes.

**UGC y comunidad**
- [ ] Filtro de contenido, reporte in-app, bloqueo y proceso de acción del desarrollador.
- [ ] Términos cubren contenido aceptable de reseñas/fotos.

**Operación / revisión**
- [ ] Cuenta y credenciales de **demo** para el revisor (sección 9).
- [ ] URL de **soporte** + email monitoreado; contacto in-app.
- [ ] **Age Rating** (Apple) y **Content Rating IARC** (Google) completados.
- [ ] Capturas, ícono, descripción, idioma (es-PR/es) listos y veraces.
- [ ] Probado en dispositivo real iOS y Android; todo por HTTPS.

**Puntos marcados VALIDAR (no someter sin resolver):**
- [ ] Reglas de pago de la **suscripción del negocio** (Apple IAP / Play Billing) — sección 4B.
- [ ] **Sign in with Apple** obligatorio si hay login social — sección 10.
- [ ] Riesgo **WebView 4.2** (valor nativo mínimo) — sección 10.
- [ ] Lenguaje legal de **retención fiscal anonimizada** post-borrado — sección 2.
- [ ] Rol de datos (encargado/responsable) y datos de menores — secciones 1 y 8.

---

> **Recordatorio final:** las políticas de Apple (App Store Review Guidelines) y de Google
> (Play Developer Program Policies) cambian con frecuencia. Antes de cada envío, **relee las
> versiones vigentes** de las guidelines de pago, privacidad y UGC, y consulta a un abogado
> para los puntos marcados **VALIDAR**. Este checklist no sustituye asesoría legal.
>
> Bukéame · Wifnix LLC · Puerto Rico
