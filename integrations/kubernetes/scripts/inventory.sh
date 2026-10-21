#!/bin/sh
set -eu
# Read-only. Never query Secret.data, raw kubeconfig, or raw environment variables.
# Run on a workstation with working cluster access, redirect to an operator-only file.
KUBECTL_BIN=${KUBECTL_BIN:-kubectl}
"$KUBECTL_BIN" config current-context
"$KUBECTL_BIN" version -o yaml
"$KUBECTL_BIN" get nodes -o custom-columns='NAME:.metadata.name,ARCH:.status.nodeInfo.architecture,OS:.status.nodeInfo.osImage,PODCIDR:.spec.podCIDR,CPU:.status.allocatable.cpu,MEMORY:.status.allocatable.memory'
"$KUBECTL_BIN" top nodes || true
"$KUBECTL_BIN" get namespaces --show-labels
"$KUBECTL_BIN" get storageclass
"$KUBECTL_BIN" get pvc -A -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,CLASS:.spec.storageClassName,VOLUME:.spec.volumeName,SIZE:.status.capacity.storage,PHASE:.status.phase'
"$KUBECTL_BIN" get pods -A -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,NODE:.spec.nodeName,IMAGES:.spec.containers[*].image,CLAIMS:.spec.volumes[*].persistentVolumeClaim.claimName'
"$KUBECTL_BIN" get svc -A -o wide
"$KUBECTL_BIN" get ingressclass
"$KUBECTL_BIN" get ingress -A
"$KUBECTL_BIN" get networkpolicy -A
"$KUBECTL_BIN" get daemonset -A -o wide
"$KUBECTL_BIN" get runtimeclass
"$KUBECTL_BIN" get cluster.postgresql.cnpg.io -A -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,IMAGE:.spec.imageName,BACKUP:.spec.backup,PLUGINS:.spec.plugins,INSTANCES:.spec.instances'
"$KUBECTL_BIN" get cronjob -A
"$KUBECTL_BIN" get scheduledbackup.postgresql.cnpg.io -A || true
"$KUBECTL_BIN" get backup.postgresql.cnpg.io -A || true
"$KUBECTL_BIN" get objectstores.barmancloud.cnpg.io -A || true
"$KUBECTL_BIN" get secrets -A -o go-template='{{range .items}}{{.metadata.namespace}}/{{.metadata.name}} keys:{{range $k,$v := .data}} {{$k}}{{end}}{{"\n"}}{{end}}'
printf '%s\n' 'Follow up: MicroK8s Service CIDRs, CNI host policy, Postgres TLS/SQL version, PVC ownership/usage, public tunnel routes and backup destinations. No values were requested.'
