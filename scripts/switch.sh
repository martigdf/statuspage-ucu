#!/usr/bin/env bash
#
# Alterna el Service entre blue (v1) y green (v2).
#
#   ./scripts/switch.sh              alterna a la version contraria
#   ./scripts/switch.sh blue         fuerza v1
#   ./scripts/switch.sh green        fuerza v2
#   ./scripts/switch.sh --status     solo informa, no cambia nada
#   ./scripts/switch.sh --no-sync    no toca k8s/service.yaml
#
set -euo pipefail

NS="status-project"
SVC="status-page-service"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFIESTO="$RAIZ/k8s/service.yaml"

rojo()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
gris()  { printf '\033[90m%s\033[0m\n' "$*"; }

version_de() { [ "$1" = "blue" ] && echo "v1" || echo "v2"; }

command -v kubectl >/dev/null || { rojo "kubectl no esta instalado"; exit 1; }

if ! kubectl get svc "$SVC" -n "$NS" >/dev/null 2>&1; then
    rojo "No existe el service $SVC en el namespace $NS."
    gris "Levantalo con: kubectl apply -f k8s/"
    exit 1
fi

ACTUAL=$(kubectl get svc "$SVC" -n "$NS" -o jsonpath='{.spec.selector.env}')

SYNC=1
DESTINO=""
for arg in "$@"; do
    case "$arg" in
        blue|v1)  DESTINO="blue" ;;
        green|v2) DESTINO="green" ;;
        --no-sync) SYNC=0 ;;
        --status)
            echo "Sirviendo: $(version_de "$ACTUAL") (env=$ACTUAL)"
            kubectl get pods -n "$NS" -l "env=$ACTUAL" --no-headers 2>/dev/null | awk '{print "  " $1 "  " $3}'
            exit 0 ;;
        *) rojo "Argumento desconocido: $arg"; exit 1 ;;
    esac
done

if [ -z "$DESTINO" ]; then
    case "$ACTUAL" in
        blue)  DESTINO="green" ;;
        green) DESTINO="blue" ;;
        *) rojo "El selector actual ('$ACTUAL') no es blue ni green; no se puede alternar."; exit 1 ;;
    esac
fi

if [ "$DESTINO" = "$ACTUAL" ]; then
    echo "Ya esta sirviendo $(version_de "$ACTUAL") (env=$ACTUAL). Sin cambios."
    exit 0
fi

# No conviene mandar trafico a pods que no estan listos.
LISTOS=$(kubectl get pods -n "$NS" -l "env=$DESTINO" \
    -o jsonpath='{range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' 2>/dev/null \
    | grep -c "True" || true)

if [ "$LISTOS" -eq 0 ]; then
    rojo "No hay pods Ready con env=$DESTINO. Se cancela el switch."
    gris "Revisa con: kubectl get pods -n $NS -l env=$DESTINO"
    exit 1
fi

echo "$(version_de "$ACTUAL") (env=$ACTUAL)  ->  $(version_de "$DESTINO") (env=$DESTINO)   [$LISTOS pods listos]"

kubectl patch svc "$SVC" -n "$NS" \
    -p "{\"spec\":{\"selector\":{\"app\":\"status-page\",\"env\":\"$DESTINO\"}}}" >/dev/null

# Mantener el manifiesto alineado, para que un kubectl apply no revierta el switch.
if [ "$SYNC" -eq 1 ] && [ -f "$MANIFIESTO" ]; then
    if [ "$DESTINO" = "green" ]; then
        COMENTARIO="# <--- CAMBIAR A 'blue' PARA VOLVER ATRAS (rollback instantaneo)"
    else
        COMENTARIO="# <--- CAMBIAR A 'green' PARA REALIZAR EL BLUE/GREEN SWITCH"
    fi
    perl -pi -e "s{^(\s*)env: (?:blue|green).*}{\${1}env: $DESTINO   $COMENTARIO}" "$MANIFIESTO"
    gris "k8s/service.yaml sincronizado"
fi

# Esperar a que los endpoints apunten efectivamente a los pods nuevos.
for _ in $(seq 1 20); do
    EP=$(kubectl get endpoints "$SVC" -n "$NS" \
        -o jsonpath='{.subsets[0].addresses[*].targetRef.name}' 2>/dev/null || true)
    case "$EP" in
        *"status-page-$DESTINO"*) break ;;
    esac
    sleep 0.5
done

verde "Ahora sirve $(version_de "$DESTINO")"
gris "  endpoints: ${EP:-(ninguno)}"
