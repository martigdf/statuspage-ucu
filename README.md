# Status Page UCU

## 1. Descripción

Status Page UCU es una aplicación web que permite visualizar el estado de disponibilidad de los servicios digitales de la Universidad Católica del Uruguay (UCU).

El proyecto está contenerizado mediante Docker y desplegado en Kubernetes utilizando Minikube. Para la actualización entre versiones se implementa la estrategia de despliegue Blue/Green.

## 2. Objetivo del proyecto

objetivo del proyecto es desarrollar una aplicación que permita aplicar los conceptos de contenerización y despliegue en Kubernetes.

El proyecto incluye:
- Aplicación web funcional.
- Contenerización mediante Docker.
- Despliegue en Kubernetes.
- Múltiples réplicas.
- Persistencia mediante un PersistentVolumeClaim.
- Health checks mediante readinessProbe y livenessProbe.
- Dos versiones de la aplicación.
- Estrategia de despliegue Blue/Green.
- Cambio entre versiones mediante el Service.
- RPersistencia del historial de disponibilidad.

## 3. Tecnologías utilizadas

- Node.js:
    Entorno de ejecución de la aplicación.
- Express:
    Framework utilizado para el servidor y la API.
- HTML / CSS / JavaScript:
    Interfaz web.
- Docker:
    Contenerización.
- Kubernetes:
    Despliegue y orquestación.
- Minikube:
    Cluster Kubernetes utilizado para el despliegue.
- Bash:
    Script para alternar entre versiones.

## 4. Arquitectura

La aplicación se despliega en Kubernetes mediante dos Deployments independientes: uno para la versión v1 (Blue) y otro para la versión v2 (Green). Cada Deployment tiene dos réplicas.

Los cuatro pods permanecen desplegados. El Sevice determina cuál de las dos versiones recibe las peticiones mediante el selector env.

El PVC se monta en /data y permite conservar los resultados de las comprobaciones entre reinicios de los pods y cambios de versión.

## 5. Versiones de la aplicación

La diferencia funcional entre las versiones se controla mediante la cariable de entorno APP_VERSION.

v1 - estado actual
v2 - estado actual + información histórica.

La versión se configura en cada Deployment:
#### Blue
- name: APP_VERSION
  value: "v1"
##### Green
- name: APP_VERSION
  value: "v2"

### v1 - Blue

La API informa para cada servicio:
- Estado actual.
- Código HTTP.
- Latencia.
- Fecha y hora de la última comprobación.

Aunque v1 no muestra el historial en la respuesta de la API si almacena los datos de las comprobaciones, esto permite que los datos generados mientras v1 está activa puedan ser utilizados posteriormente por v2.

### v2 - Green

La API informa para cada servicio:
- Estado actual.
- Código HTTP.
- Latencia.
- Fecha y hora de la última comprobación.
- Uptime acumulado.
- Cantidad de comprobaciones.
- Historial de disponibilidad de los últimos 90 días.
- Historial de incidentes.

## 6. Docker

La aplicación utiliza un Dockerfile basado en node:18-alpine.

El contenedor ejecuta la aplicación mediante:

```bash
npm start
```

y expone el puerto 3000.

### Construcción de la imagen

Para construir la imagen:

```bash
docker build -t status-page:v1 .
```

También se puede construir la imagen con el tag utilizado por el entorno Green:

```bash
docker build -t status-page:v2 .
```

Las dos imágenes se construyen a partir del mismo código fuente. La diferencia entre las versiones se determina mediante APP_VERSION, configurada en los respectivos Deployments de Kubernetes.

### Ejecución local

Para ejecutar la aplicación con la versión v1:

```bash
docker run -p 3000:3000 -e APP_VERSION=v1 status-page:v1
```

Para ejecutar la aplicación con la versión v2:

```bash
docker run -p 3000:3000 -e APP_VERSION=v2 status-page:v2
```

## 7. Kubernetes

### Namespace

Los recursos utilizan el namespace:

- status-project

### Deployments

Se utilizan dos Deployments cada uno con dos réplicas:

- status-page-blue
- status-page-green

#### Deployment v1

env=blue
APP_VERSION=v1

#### Deployment v2

env=green
APP_VERSION=v2

### Service

La aplicación se expone mediante un Service de tipo NodePort.

El Service utiliza:

Port:       80
TargetPort: 3000
NodePort:   30080
selector:
    app: status-page
    env: blue

Cuando se realiza el cambio a Green, el selector pasa a:

selector:
    app: status-page
    env: green

### PVC

Se utiliza un PersistentVolumeClaim denominado status-page-data

Storage:    1Gi
AccessMode: ReadWriteOnce

El volumen se monta en los pods mediante /data

Los resultados se almacenan en el volumen para conservar la información entre reinicios y cambios de versión.

### Probes

Los Deployments utilizan dos probes sobre el endpoint:

GET /healthz

#### Readiness Probe

Determina si el pod está preparado para recibir tráfico.

#### Liveness Probe

Permite detectar si el contenedor dejó de responder y necesita ser reiniciado.

## 8. Estrategia Blue/Green

El proyecto implementa la estrategia de despliegue Blue/Green.

BLUE
v1
2 pods

GREEN
v2
2 pods

Las dos versiones permanecen disponibles durante el cambio. El Service dirige el tráfico únicamente hacia una de ellas, utiliza los labels de los pods para determinar cuáles son los endpoints que reciben tráfico.

## 9. Despliegue en Minikube

### Iniciar Minikube

```bash
minikube start
```

### Utilizar el Docker daemon de Minikube

Las imágenes se construyen dentro del entorno de Minikube ya que los Deployments utilizan imagePullPolicy: Never.

```bash
eval $(minikube docker-env)
```

### Construir las imágenes

```bash
docker build -t status-page:v1 .
docker build -t status-page:v2 .
```

### Crear los recursos

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment-v1.yaml
kubectl apply -f k8s/deployment-v2.yaml
kubectl apply -f k8s/service.yaml
```

### Acceder a la aplicación

Para abrir el Service mediante Minikube:

```bash
minikube service status-page-service -n status-project
```

También se puede utilizar:

```bash
kubectl port-forward -n status-project svc/status-page-service 8080:80
```

y acceder a: http://localhost:8080

## 10. Verificación

Para comprobar los pods:

```bash
kubectl get pods -n status-project
```

- Se deben encontrar dos pods correspondientes a Blue y dos correspondientes a Green.

Para consultar los principales recursos:

```bash
kubectl get pods,pvc,svc -n status-project
```

Para consultar los Deployments:

```bash
kubectl get deployments -n status-project
```

Para consultar los endpoints del Service:

```bash
kubectl get endpoints -n status-project
```

Para consultar los logs de los pods:

```bash
kubectl logs -n status-project -l env=blue
```

Para consultar qué versión está siendo servida:

```bash
./scripts/switch.sh --status
```

## 11. Cambio de versión

El proyecto incluye el script:

- scripts/switch.sh

que permite alternar entre los entornos Blue y Green.

### Alternar entre versiones

```bash
./scripts/switch.sh
```

El script detecta la versión actualmente activa y realiza el cambio hacia la otra.

### Seleccionar una versión específica

Para activar v1:

```bash
./scripts/switch.sh v1
```

Para activar v2:

```bash
./scripts/switch.sh v2
```

Para consultar la versión activa sin modificarla:

```bash
./scripts/switch.sh --status
```

Antes de realizar el cambio el script verifica que existan pods Ready correspondientes a la versión destino.

## 12. Rollback

La versión anterior permanece desplegada durante el cambio de versión haciendo que se pueda volver a una versión anterior realizando nuevamente el switch.

## 14. Limitaciones

- El historial comienza a generarse cuando comienza el monitoreo. No existen datos correspondientes a períodos anteriores al inicio de la aplicación.
- El monitoreo comprueba la disponibilidad HTTP de los servicios. Una respuesta HTTP indica que el servidor responde, pero no necesariamente que todas las funcionalidades internas del servicio estén operativas.
- La aplicación informa sobre el estado de los servicios, pero no implementa alertas o notificaciones.
