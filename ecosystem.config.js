// ============================================================================
//  Bukéame — configuración del proceso PM2 (versionada en el repo).
//  Mantiene el proceso en UN solo fork: los workers setInterval (recordatorios,
//  despacho, ofertas de lista de espera) DEBEN correr en una sola instancia,
//  o se duplican. No subir a cluster sin aislar esos workers primero.
//
//  Adoptarlo (con cuidado, sin tocar wifnix):
//    cd /var/www/bukeame
//    pm2 delete bukeame-api
//    pm2 start ecosystem.config.js
//    pm2 save
//  Recargar tras un deploy:  pm2 restart bukeame-api --update-env
//  El puerto y los secretos viven en backend/.env (NO aquí).
// ============================================================================
module.exports = {
  apps: [{
    name: 'bukeame-api',
    script: 'server.js',
    cwd: '/var/www/bukeame/backend',   // .env se carga desde aquí, igual que hoy
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '500M',        // sharp (imágenes) puede pasar de 300M
    env: { NODE_ENV: 'production' },
  }],
};
