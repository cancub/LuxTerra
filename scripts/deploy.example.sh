#!/usr/bin/env bash
set -euo pipefail

REGISTRY="${REGISTRY:-localhost:5000}"
IMAGE="${REGISTRY}/luxterra:latest"
NAMESPACE="${NAMESPACE:-webapps}"
MANIFEST="${MANIFEST:-k8s/luxterra.yaml}"
CONTAINER_CLI="${CONTAINER_CLI:-docker}"

echo "==> Building container image ${IMAGE}..."
"${CONTAINER_CLI}" build -t "${IMAGE}" .

echo "==> Pushing image to registry ${REGISTRY}..."
"${CONTAINER_CLI}" push "${IMAGE}"

echo "==> Applying Kubernetes manifests (${MANIFEST}) to namespace '${NAMESPACE}'..."
kubectl apply -f "${MANIFEST}"

echo "==> Restarting deployment to pull latest image..."
kubectl rollout restart deployment/luxterra -n "${NAMESPACE}"
kubectl rollout status deployment/luxterra -n "${NAMESPACE}" --timeout=180s

echo "==> Deployment complete!"
kubectl get pods,svc,ingress -n "${NAMESPACE}" -l app=luxterra
