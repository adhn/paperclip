#!/usr/bin/env python3
"""Static safety checks. Does not establish live CNI, SSH or provider behavior."""
from pathlib import Path
import hashlib, json, yaml
root=Path(__file__).resolve().parents[1]
objects=[]
for filename in ['workloads.yaml','network-policies.yaml']:
    objects.extend(yaml.safe_load_all((root/filename).read_text()))
deployments=[x for x in objects if x['kind']=='Deployment']
assert len(deployments)==4
claims=[x for x in objects if x['kind']=='PersistentVolumeClaim']
assert len(claims)==4 and len({x['metadata']['name'] for x in claims})==4
for obj in deployments:
    assert obj['spec']['replicas']==1 and obj['spec']['strategy']['type']=='Recreate'
    pod=obj['spec']['template']['spec']
    assert pod['automountServiceAccountToken'] is False
    assert pod['securityContext']['runAsUser']==1000
    assert not any(pod.get(x,False) for x in ['hostNetwork','hostPID','hostIPC'])
    assert all('hostPath' not in x for x in pod['volumes'])
    container=pod['containers'][0]
    security=container['securityContext']
    assert security['allowPrivilegeEscalation'] is False and security['capabilities']['drop']==['ALL']
    assert security['readOnlyRootFilesystem'] is True
    if obj['metadata']['name'].startswith('runner-'):
        assert len([x for x in pod['volumes'] if 'secret' in x])==1
        assert all('valueFrom' not in x for x in container['env'])
        assert {x['mountPath'] for x in container['volumeMounts']}=={'/home/node','/tmp','/etc/runner-ssh/authorized_keys'}
        key_mount=next(x for x in container['volumeMounts'] if x['name']=='authorized-key')
        assert key_mount['subPath']=='authorized_keys' and key_mount['readOnly'] is True
    else:
        assert {x['name'] for x in container['env'] if 'valueFrom' in x}=={'DATABASE_URL','BETTER_AUTH_SECRET','PAPERCLIP_AGENT_JWT_SECRET'}
        assert not any(x['name'] in ['OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY'] for x in container['env'])
policies=[x for x in objects if x['kind']=='NetworkPolicy']
assert len(policies)==5
assert all(x['spec']['policyTypes']==['Ingress','Egress'] for x in policies)
for provider in ['claude','codex','gemini']:
    config=json.loads((root/'config'/f'{provider}-environment.json').read_text())
    assert config['driver']=='ssh' and config['config']['strictHostKeyChecking'] is True
    assert json.loads((root/'config'/f'{provider}-adapter.json').read_text())['engine']=='cli'
    lock=json.loads((root/'images/runner'/provider/'package-lock.json').read_text())
    package=json.loads((root/'images/runner'/provider/'package.json').read_text())
    assert lock['packages']['']['dependencies']==package['dependencies']
    for value in lock['packages'].values():
        if 'resolved' in value: assert value['resolved'].startswith('https://registry.npmjs.org/') and 'integrity' in value
inputs=json.loads((root/'images/inputs.json').read_text())
assert hashlib.sha256((root/'images/controller/pnpm-lock.yaml').read_bytes()).hexdigest()==inputs['controllerLockSha256']
cluster_root=root.parents[1]/'kustomization.yaml'
active='infrastructure/paperclip-evaluation' in yaml.safe_load(cluster_root.read_text())['resources']
if active:
    published=json.loads((root/'images/published.json').read_text())['images']
    assert 'private-ingress' in yaml.safe_load((root/'kustomization.yaml').read_text())['resources']
    for obj in deployments:
        name=obj['metadata']['name']
        assert obj['spec']['template']['spec']['containers'][0]['image']==published[name]
    proxy=next(x for x in yaml.safe_load_all((root/'private-ingress/proxy.yaml').read_text()) if x['kind']=='Deployment')
    assert proxy['spec']['template']['spec']['containers'][0]['image']==published['lan-proxy']
    controller=next(x for x in deployments if x['metadata']['name']=='controller')
    env={x['name']:x.get('value') for x in controller['spec']['template']['spec']['containers'][0]['env']}
    assert env['HEARTBEAT_SCHEDULER_ENABLED']=='false' and env['PAPERCLIP_DB_BACKUP_ENABLED']=='false'
    assert env['PAPERCLIP_DEPLOYMENT_MODE']=='authenticated' and env['PAPERCLIP_DEPLOYMENT_EXPOSURE']=='private'
    assert all('@sha256:' in ref and len(ref.rsplit(':',1)[1])==64 for ref in published.values())
assert not any(x['kind'] in ['Ingress','Cluster','CronJob','RoleBinding','ClusterRoleBinding'] for x in objects)
print('PASS: four restricted single-writer workloads, separate state, no runner cluster/controller credentials, locked npm inputs, explicit SSH CLI configuration; Flux evaluation path '+('enabled with pinned images and LAN addon' if active else 'inactive')+'. Live tests NOT RUN.')
