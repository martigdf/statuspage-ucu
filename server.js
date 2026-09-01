const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// La versión se define mediante variable de entorno inyectada en K8s
const APP_VERSION = process.env.APP_VERSION || 'v1';

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
    res.json({
        version: APP_VERSION,
        status: "All Systems Operational",
        timestamp: new Date().toISOString(),
        services: [
            { name: "API Gateway", status: "Operational", uptime: "99.98%" },
            { name: "Autenticación (Auth0)", status: "Operational", uptime: "100%" },
            { name: "Base de Datos Principal", status: "Operational", uptime: "99.95%" },
            { name: "Pasarela de Pagos", status: "Operational", uptime: "99.90%" }
        ],
        // Elemento diferenciador para la versión 2
        incidentHistory: APP_VERSION === 'v2' ? [
            { date: "2026-06-12", title: "Mantenimiento programado completado con éxito", severity: "Low" }
        ] : []
    });
});

app.listen(PORT, () => {
    console.log(`Status Page (${APP_VERSION}) running on port ${PORT}`);
});