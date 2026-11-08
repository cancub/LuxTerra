#!/usr/bin/env bash
set -euo pipefail

REGISTRY="127.0.0.1:30500"
IMAGE="${REGISTRY}/luxterra:latest"
NAMESPACE="webapps"

echo "==> Building container image ${IMAGE}..."
podman build -t "${IMAGE}" .

echo "==> Pushing image to local k3s registry..."
podman push --tls-verify=false "${IMAGE}"

echo "==> Applying Kubernetes manifests to namespace '${NAMESPACE}'..."
kubectl apply -f k8s/luxterra.yaml

echo "==> Restarting deployment to pull latest image..."
kubectl rollout restart deployment/luxterra -n "${NAMESPACE}"
kubectl rollout status deployment/luxterra -n "${NAMESPACE}" --timeout=180s

echo "==> Deployment complete!"
kubectl get pods,svc,ingress -n "${NAMESPACE}" -l app=luxterra
