#!/usr/bin/env bash
set -euo pipefail

REGISTRY="${REGISTRY:-<your-registry>}"
IMAGE="${REGISTRY}/luxterra:latest"
NAMESPACE="${NAMESPACE:-<your-namespace>}"
MANIFEST="${MANIFEST:-k8s/luxterra.yaml}"
CONTAINER_CLI="${CONTAINER_CLI:-docker}"

if [[ "${REGISTRY}" == "<your-registry>" || "${NAMESPACE}" == "<your-namespace>" ]]; then
  echo "Error: Override REGISTRY and NAMESPACE (or edit this script) before running." >&2
  exit 1
fi

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
