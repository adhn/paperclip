"""Pure harness-contract checks; these do not run controller images or Kubernetes."""
import copy
import unittest
from image_pvc_clone import (APP_COMMAND, CANDIDATE, CLUSTER, MIGRATE_JS, POLICY_PATH, POLICY_PREFLIGHT_JS, OLD_SOURCE_MIGRATE_JS, migration_pod, NAMESPACE, OLD_IMAGE,
    POLICY, POSTGRES_IMAGE, STALE_SCHEMA_ERROR, OLD_ALIAS, bind_host_image, registry_digest, verify_imported_image,
    environment, host_cleanup_references, remove_imported_host_image, kind_configuration, network_policies, pod, pvc, validate_context)


class ImagePVCCloneContractTests(unittest.TestCase):
    def pulled_image(self):
        return {"Id": "sha256:" + "1" * 64, "RepoDigests": [OLD_IMAGE], "Os": "linux", "Architecture": "amd64",
            "RootFS": {"Type": "layers", "Layers": ["sha256:" + "2" * 64]}}

    def test_exact_registry_pull_binds_config_rootfs_and_disposable_alias(self):
        binding = bind_host_image(OLD_IMAGE, OLD_ALIAS, self.pulled_image(), require_digest=True)
        self.assertEqual(binding["source"], OLD_IMAGE)
        self.assertEqual(binding["registryDigest"], OLD_IMAGE)
        self.assertEqual(binding["configId"], "sha256:" + "1" * 64)
        self.assertEqual(binding["localAlias"], OLD_ALIAS)
        self.assertEqual(binding["rootfsLayers"], ["sha256:" + "2" * 64])
        verify_imported_image(binding, {"status": {"id": binding["configId"]}})
        with self.assertRaisesRegex(ValueError, "differs_from_bound_host"):
            verify_imported_image(binding, {"status": {"id": "sha256:" + "3" * 64}})

    def test_wrong_missing_digest_platform_or_rootfs_refuses_before_import(self):
        for mutation in ({"RepoDigests": []}, {"RepoDigests": [OLD_IMAGE.replace("8bd2d8cc", "9bd2d8cc")]},
                {"Id": "floating-tag"}, {"RootFS": {"Type": "layers", "Layers": []}}, {"Architecture": "arm64"}):
            value = self.pulled_image(); value.update(mutation)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                bind_host_image(OLD_IMAGE, OLD_ALIAS, value, require_digest=True)

    def test_docker_repo_digest_normalization_preserves_repository_and_checksum(self):
        checksum = "sha256:" + "4" * 64
        self.assertEqual(registry_digest("postgres:18-bookworm@" + checksum), "docker.io/library/postgres@" + checksum)
        self.assertEqual(registry_digest("postgres@" + checksum), "docker.io/library/postgres@" + checksum)
        image = self.pulled_image(); image["RepoDigests"] = ["docker.io/library/postgres@" + checksum]
        bind_host_image("postgres:18-bookworm@" + checksum, "pc-clone-postgres:disposable", image, require_digest=True)
        image["RepoDigests"] = ["attacker.example/postgres@" + checksum]
        with self.assertRaisesRegex(ValueError, "registry_digest_missing"):
            bind_host_image("postgres:18-bookworm@" + checksum, "pc-clone-postgres:disposable", image, require_digest=True)

    def test_running_pod_image_id_must_resolve_to_the_bound_host_config(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from image_pvc_clone import Rehearsal
        from types import SimpleNamespace
        binding = bind_host_image(OLD_IMAGE, OLD_ALIAS, self.pulled_image(), require_digest=True)
        value = {"metadata": {"uid": "synthetic-pod-uid", "name": "synthetic-old"}, "spec": {"containers": [{"image": OLD_ALIAS}]},
            "status": {"containerStatuses": [{"imageID": "docker-pullable://fixture.example/image@sha256:" + "5" * 64,
                "containerID": "containerd://" + "6" * 64}]}}
        rehearsal = Rehearsal.__new__(Rehearsal)
        rehearsal.bindings = {OLD_ALIAS: binding}; rehearsal.image_observations = {}
        with tempfile.TemporaryDirectory() as directory:
            rehearsal.evidence = Path(directory)
            import json
            def inspected(argv):
                if "inspect" in argv:
                    return SimpleNamespace(stdout=json.dumps({"status": {"id": "6" * 64, "imageRef": "sha256:" + "1" * 64}}).encode())
                return SimpleNamespace(stdout=b'{"status":{"id":"sha256:' + b'1'*64 + b'"}}')
            with patch("image_pvc_clone.run", side_effect=inspected):
                rehearsal.verify_pod_image(value)
                self.assertIn("synthetic-pod-uid", rehearsal.image_observations)
                self.assertEqual(rehearsal.image_observations["synthetic-pod-uid"]["containerImageRef"], "sha256:" + "1" * 64)
            with patch("image_pvc_clone.run", return_value=SimpleNamespace(stdout=b'{"status":{"id":"sha256:' + b'3'*64 + b'"}}')):
                with self.assertRaisesRegex(ValueError, "differs_from_bound_host"): rehearsal.verify_pod_image(value)

    def test_host_cleanup_selects_only_exact_source_and_fixed_alias(self):
        from image_pvc_clone import POSTGRES_ALIAS
        binding = bind_host_image(OLD_IMAGE, OLD_ALIAS, self.pulled_image(), require_digest=True)
        self.assertEqual(host_cleanup_references(binding), [OLD_IMAGE, OLD_ALIAS])
        self.assertEqual(host_cleanup_references({"source": POSTGRES_IMAGE, "localAlias": POSTGRES_ALIAS}),
            [registry_digest(POSTGRES_IMAGE), POSTGRES_ALIAS])
        self.assertEqual(host_cleanup_references({"source": CANDIDATE, "localAlias": CANDIDATE}), [CANDIDATE])
        for mutation in ({"source": "unrelated:latest"}, {"localAlias": "unrelated:latest"}):
            value = dict(binding); value.update(mutation)
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, "exact_fixture_host_cleanup"):
                host_cleanup_references(value)

    def test_host_cleanup_requires_verified_import_and_current_metadata(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        import json
        binding = bind_host_image(OLD_IMAGE, OLD_ALIAS, self.pulled_image(), require_digest=True)
        with patch("image_pvc_clone.run") as command:
            with self.assertRaisesRegex(ValueError, "differs_from_bound_host"):
                remove_imported_host_image(binding, {"status": {"id": "sha256:" + "3" * 64}})
            command.assert_not_called()
        changed = self.pulled_image(); changed["Id"] = "sha256:" + "3" * 64
        with patch("image_pvc_clone.run", return_value=SimpleNamespace(stdout=json.dumps([changed]).encode())) as command:
            with self.assertRaisesRegex(RuntimeError, "metadata_rebound"):
                remove_imported_host_image(binding, {"status": {"id": binding["configId"]}})
            self.assertTrue(all("rm" not in call.args[0] for call in command.call_args_list))

    def test_host_cleanup_untags_exact_references_without_force_prune_or_node_access(self):
        import json
        from unittest.mock import patch
        from types import SimpleNamespace
        binding = bind_host_image(OLD_IMAGE, OLD_ALIAS, self.pulled_image(), require_digest=True)
        removed = []
        def docker(argv, **kwargs):
            if argv[:4] == ["docker", "image", "rm", "--no-prune"]:
                removed.append(argv[4]); return SimpleNamespace(stdout=b"", returncode=0)
            self.assertEqual(argv[:3], ["docker", "image", "inspect"])
            return SimpleNamespace(stdout=json.dumps([self.pulled_image()]).encode(), returncode=1 if argv[3] in removed else 0)
        with patch("image_pvc_clone.run", side_effect=docker):
            result = remove_imported_host_image(binding, {"status": {"id": binding["configId"]}})
        self.assertEqual(removed, [OLD_IMAGE, OLD_ALIAS])
        self.assertTrue(result["nodeImageRetained"])
        self.assertFalse(result["unrelatedImagesPruned"])

    def test_postgres_socket_volume_matches_entrypoint_default_without_root_init(self):
        value = pod("database", POSTGRES_IMAGE, [], db=True)
        spec, container = value["spec"], value["spec"]["containers"][0]
        self.assertEqual(spec["securityContext"]["runAsUser"], 999)
        self.assertEqual(spec["securityContext"]["fsGroup"], 999)
        self.assertNotIn("initContainers", spec)
        self.assertIn({"name": "postgres-socket", "mountPath": "/var/run/postgresql"}, container["volumeMounts"])
        self.assertIn({"name": "postgres-socket", "emptyDir": {"medium": "Memory", "sizeLimit": "4Mi"}}, spec["volumes"])
        self.assertEqual(container["command"], ["docker-entrypoint.sh", "postgres", "-c", "shared_buffers=16MB"])
        self.assertNotIn("PGHOST", {item["name"] for item in container["env"]})

    def test_failed_database_exits_immediately_with_logs_not_a_readiness_timeout(self):
        from unittest.mock import patch
        from image_pvc_clone import Rehearsal
        value = {"status": {"phase": "Failed", "containerStatuses": [{"state": {"terminated": {"exitCode": 2}}}]}}
        rehearsal = Rehearsal.__new__(Rehearsal)
        with patch.object(rehearsal, "object", return_value=value), patch.object(rehearsal, "save"), \
                patch.object(rehearsal, "capture_pod_logs") as logs, patch.object(rehearsal, "exec") as probe:
            with self.assertRaisesRegex(RuntimeError, "fixture_database_exited_before_ready:Failed"):
                rehearsal.wait_database_ready()
            logs.assert_called_once_with("database")
            probe.assert_not_called()

    def test_failure_log_collection_is_fixture_scoped_and_bounded(self):
        import json
        from types import SimpleNamespace
        from unittest.mock import patch
        from image_pvc_clone import Rehearsal
        rehearsal = Rehearsal.__new__(Rehearsal)
        result = SimpleNamespace(returncode=0, stderr=b"", stdout=json.dumps({"items": [{"metadata": {"name": "database"}}]}).encode())
        with patch.object(rehearsal, "kube", return_value=result) as kube, patch.object(rehearsal, "save"), \
                patch.object(rehearsal, "capture_pod_logs") as logs:
            rehearsal.collect_failure_diagnostics()
            self.assertEqual(kube.call_args.args[:2], ("-n", NAMESPACE))
            logs.assert_called_once_with("database")
        with patch.object(rehearsal, "kube", return_value=SimpleNamespace(stdout=b"log", stderr=b"")) as kube, patch.object(rehearsal, "save"):
            rehearsal.capture_pod_logs("database")
            self.assertIn("--limit-bytes=32768", kube.call_args.args)
            self.assertIn("--tail=100", kube.call_args.args)
            self.assertEqual(kube.call_args.kwargs["timeout"], 12)

    def test_accepts_only_explicit_single_loopback_disposable_context(self):
        expected = {"current-context": "kind-" + CLUSTER,
            "clusters": [{"cluster": {"server": "https://127.0.0.1:12345"}}]}
        validate_context(expected)
        for mutation in ({"current-context": "homelab"}, {"clusters": []},
                {"clusters": [{"cluster": {"server": "https://192.168.1.11:16443"}}]},
                {"clusters": expected["clusters"] * 2}):
            value = copy.deepcopy(expected); value.update(mutation)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): validate_context(value)

    def test_application_has_no_ambient_token_host_or_runtime_mount(self):
        value = pod("test", CANDIDATE, APP_COMMAND, database_url="postgresql://synthetic", state="restored-state")
        self.assertEqual(value["metadata"]["name"], "test")
        spec = value["spec"]
        self.assertFalse(spec["automountServiceAccountToken"])
        self.assertFalse(spec["enableServiceLinks"])
        self.assertTrue(spec["securityContext"]["runAsNonRoot"])
        self.assertEqual(spec["securityContext"]["runAsUser"], 1000)
        self.assertEqual(spec["restartPolicy"], "Never")
        for forbidden in ("hostNetwork", "hostPID", "hostIPC", "nodeName", "initContainers", "ephemeralContainers"):
            self.assertNotIn(forbidden, spec)
        self.assertFalse(any("hostPath" in volume or "secret" in volume for volume in spec["volumes"]))
        self.assertEqual({mount["mountPath"] for mount in spec["containers"][0]["volumeMounts"]}, {"/tmp", "/paperclip", POLICY_PATH})
        self.assertEqual(spec["containers"][0]["imagePullPolicy"], "Never")

    def test_every_workload_is_nonroot_readonly_capability_free(self):
        for manifest in (pod("old", OLD_IMAGE, APP_COMMAND, database_url="synthetic", state="source-state"),
                pod("new", CANDIDATE, APP_COMMAND, database_url="synthetic", state="restored-state"),
                pod("database", POSTGRES_IMAGE, [], db=True),
                pod("tools", POSTGRES_IMAGE, ["bash"], state="restored-state", checkpoints=True)):
            with self.subTest(name=manifest["metadata"]["name"]):
                spec = manifest["spec"]
                self.assertGreater(spec["securityContext"]["runAsUser"], 0)
                security = spec["containers"][0]["securityContext"]
                self.assertFalse(security["allowPrivilegeEscalation"])
                self.assertTrue(security["readOnlyRootFilesystem"])
                self.assertEqual(security["capabilities"], {"drop": ["ALL"]})

    def test_old_image_is_exact_live_checkpoint_digest_not_a_floating_tag(self):
        self.assertEqual(OLD_IMAGE, "ghcr.io/adhn/paperclip-eval/controller@sha256:8bd2d8ccef956c777ea6eefa2004152632e0781706031e8cd42ef89bdd7c50ca")

    def test_applications_do_not_mount_source_or_checkpoint_storage(self):
        value = pod("test", CANDIDATE, APP_COMMAND, database_url="synthetic", state="restored-state")
        self.assertNotIn("source-state", str(value))
        self.assertNotIn("checkpoint", str(value))
        self.assertEqual(pvc("restored-state")["spec"]["accessModes"], ["ReadWriteOnce"])

    def test_timers_auto_migration_telemetry_and_backups_off(self):
        values = {item["name"]: item["value"] for item in environment("synthetic")}
        for key in ("HEARTBEAT_SCHEDULER_ENABLED", "PAPERCLIP_MIGRATION_AUTO_APPLY", "PAPERCLIP_TELEMETRY_ENABLED", "PAPERCLIP_DB_BACKUP_ENABLED"):
            self.assertEqual(values[key], "false")
        self.assertEqual(POLICY["mode"], "held")
        self.assertFalse(any(key in values for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "KUBECONFIG")))

    def test_default_network_deny_and_only_same_namespace_database_allow(self):
        policies = network_policies()
        self.assertEqual(policies[0]["spec"], {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]})
        self.assertEqual(policies[1]["spec"]["egress"], [{"to": [{"podSelector": {"matchLabels": {"app": "database"}}}], "ports": [{"protocol": "TCP", "port": 5432}]}])
        self.assertNotIn("ipBlock", str(policies))
        self.assertNotIn("namespaceSelector", str(policies))
        self.assertTrue(all(policy["metadata"]["namespace"] == NAMESPACE for policy in policies))

    def test_kubelet_pid_patch_is_on_first_node_and_has_exact_api(self):
        import json
        config = kind_configuration()
        self.assertNotIn("kubeadmConfigPatches", config)
        self.assertEqual(json.loads(config["nodes"][0]["kubeadmConfigPatches"][0]), {
            "apiVersion": "kubelet.config.k8s.io/v1beta1", "kind": "KubeletConfiguration", "podPidsLimit": 256})

    def test_stale_schema_refusal_matches_mandatory_production_bootstrap(self):
        self.assertEqual(STALE_SCHEMA_ERROR, b"admission_bootstrap_schema_not_current")
        self.assertEqual(APP_COMMAND[:3], ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"])

    def test_manual_migration_uses_built_image_db_module_and_verifies_head(self):
        self.assertIn("/app/packages/db/src/client.ts", MIGRATE_JS)
        self.assertIn("applyPendingMigrations(process.env.DATABASE_URL)", MIGRATE_JS)
        self.assertIn("result.status!=='upToDate'", MIGRATE_JS)
        self.assertNotIn("embedded", MIGRATE_JS)

    def test_candidate_policy_validation_precedes_packaged_database_migration(self):
        self.assertLess(MIGRATE_JS.index("await loadProductionAdmissionPolicy("), MIGRATE_JS.index("await import('/app/packages/db/src/client.ts')"))
        self.assertLess(MIGRATE_JS.index("await loadProductionAdmissionPolicy("), MIGRATE_JS.index("await applyPendingMigrations("))
        self.assertIn("databaseUrl:process.env.DATABASE_URL", MIGRATE_JS)
        self.assertIn("autoApply:process.env.PAPERCLIP_MIGRATION_AUTO_APPLY", MIGRATE_JS)
        self.assertIn("policyPath:process.env.PAPERCLIP_ADMISSION_POLICY_FILE", MIGRATE_JS)
        self.assertNotIn("loadProductionAdmissionPolicy", OLD_SOURCE_MIGRATE_JS)
        self.assertIn("result.status!=='upToDate'", OLD_SOURCE_MIGRATE_JS)
        self.assertEqual(migration_pod("old", OLD_ALIAS, "synthetic", "source-state")["spec"]["containers"][0]["command"][-1], OLD_SOURCE_MIGRATE_JS)

    def test_candidate_negative_policy_controls_preserve_security_and_select_exact_errors(self):
        missing = migration_pod("missing", CANDIDATE, "synthetic", "restored-state", policy_failure="missing")
        self.assertNotIn("PAPERCLIP_ADMISSION_POLICY_FILE", {item["name"] for item in missing["spec"]["containers"][0]["env"]})
        invalid = migration_pod("invalid", CANDIDATE, "synthetic", "restored-state", policy_failure="invalid")
        self.assertEqual(next(volume for volume in invalid["spec"]["volumes"] if volume["name"] == "policy")["configMap"]["name"], "invalid-policy")
        for value in (missing, invalid):
            self.assertTrue(value["spec"]["securityContext"]["runAsNonRoot"])
            self.assertFalse(value["spec"]["automountServiceAccountToken"])
            self.assertTrue(value["spec"]["containers"][0]["securityContext"]["readOnlyRootFilesystem"])
            self.assertEqual(value["spec"]["containers"][0]["command"][-1], MIGRATE_JS)
        with self.assertRaisesRegex(ValueError, "candidate_policy_failure_mode"):
            migration_pod("old", OLD_ALIAS, "synthetic", "source-state", policy_failure="missing")
        with self.assertRaisesRegex(ValueError, "exact_fixture_migration_image"):
            migration_pod("unknown", "unknown-image", "synthetic", "source-state")

    def test_import_timeout_retains_output_diagnostics_and_never_accepts_image(self):
        import json
        import subprocess
        from types import SimpleNamespace
        from unittest.mock import Mock, patch
        from image_pvc_clone import import_bound_image, collect_import_diagnostics
        binding = {"source": CANDIDATE, "localAlias": CANDIDATE, "configId": "sha256:" + "a" * 64}
        rehearsal = SimpleNamespace(evidence="/tmp/fixture", save=Mock())
        timeout = subprocess.TimeoutExpired(["kind"], 600, output=b"partial import", stderr=b"retained stderr")
        with patch("image_pvc_clone.run", side_effect=timeout) as execute, patch("image_pvc_clone.collect_import_diagnostics") as diagnostic:
            with self.assertRaisesRegex(RuntimeError, "fixture_image_import_timeout"):
                import_bound_image("/verified-kind", binding, rehearsal)
            self.assertEqual(execute.call_count, 1)
            self.assertEqual(execute.call_args.kwargs["timeout"], 600)
            diagnostic.assert_called_once()
        calls = rehearsal.save.call_args_list
        self.assertTrue(any(call.args[1] == b"partial import" for call in calls))
        self.assertTrue(any(call.args[1] == b"retained stderr" for call in calls))
        record = next(call.args[1] for call in reversed(calls) if call.args[0].endswith("-import-attempt.json"))
        self.assertEqual(record["status"], "TIMEOUT")
        self.assertNotIn("verifiedConfigId", record)
        with patch("image_pvc_clone.run", return_value=SimpleNamespace(returncode=1, stdout=b"", stderr=b"missing")) as execute:
            collect_import_diagnostics(rehearsal, "candidate")
            self.assertEqual(execute.call_count, 8)
            self.assertTrue(all(call.kwargs["timeout"] == 12 for call in execute.call_args_list))
            self.assertFalse(any("rm" in call.args[0] or "prune" in call.args[0] for call in execute.call_args_list))

    def test_import_success_requires_exact_cri_config_and_saves_identity(self):
        import json
        from types import SimpleNamespace
        from unittest.mock import Mock, patch
        from image_pvc_clone import import_bound_image
        binding = bind_host_image(OLD_IMAGE, OLD_ALIAS, self.pulled_image(), require_digest=True)
        imported = {"status": {"id": binding["configId"]}}
        rehearsal = SimpleNamespace(evidence="/tmp/fixture", save=Mock())
        for observed, succeeds in ((imported, True), ({"status": {"id": "sha256:" + "f" * 64}}, False)):
            values = [SimpleNamespace(returncode=0, stdout=b"import completed", stderr=b"import stderr"),
                SimpleNamespace(returncode=0, stdout=json.dumps(observed).encode(), stderr=b"")]
            with patch("image_pvc_clone.run", side_effect=values) as execute, patch("image_pvc_clone.collect_import_diagnostics") as diagnostics:
                if succeeds: self.assertEqual(import_bound_image("/verified-kind", binding, rehearsal), imported)
                else:
                    with self.assertRaisesRegex(ValueError, "differs_from_bound_host"): import_bound_image("/verified-kind", binding, rehearsal)
                    diagnostics.assert_called_once()
                self.assertEqual(execute.call_args_list[0].kwargs["timeout"], 600)
        record = rehearsal.save.call_args_list[-1].args[1]
        self.assertEqual(record["status"], "IMPORT_IDENTITY_OR_INSPECTION_FAILED")
        self.assertNotIn("verifiedConfigId", record)
        pg = {"source": POSTGRES_IMAGE, "localAlias": "pc-clone-postgres:disposable", "configId": binding["configId"]}
        values = [SimpleNamespace(returncode=0, stdout=b"import completed", stderr=b""),
            SimpleNamespace(returncode=0, stdout=json.dumps(imported).encode(), stderr=b"")]
        with patch("image_pvc_clone.run", side_effect=values) as execute:
            self.assertEqual(import_bound_image("/verified-kind", pg, rehearsal), imported)
            self.assertEqual(execute.call_args_list[0].kwargs["timeout"], 240)

    def test_policy_is_single_readonly_file_under_existing_trusted_etc(self):
        self.assertEqual(POLICY_PATH, "/etc/clone-policy.json")
        for mode in (None, "missing", "invalid"):
            value = migration_pod("policy", CANDIDATE, "synthetic", "restored-state", policy_failure=mode)
            spec = value["spec"]; container = spec["containers"][0]
            self.assertEqual(next(mount for mount in container["volumeMounts"] if mount["name"] == "policy"),
                {"name": "policy", "mountPath": POLICY_PATH, "subPath": "policy.json", "readOnly": True})
            self.assertNotIn("initContainers", spec)
            self.assertEqual(spec["securityContext"]["runAsUser"], 1000)
            if mode != "missing":
                self.assertEqual(next(item["value"] for item in container["env"] if item["name"] == "PAPERCLIP_ADMISSION_POLICY_FILE"), POLICY_PATH)
        self.assertIn("const canonical=await realpath(configured)", POLICY_PREFLIGHT_JS)
        self.assertIn("value.uid", POLICY_PREFLIGHT_JS)
        self.assertIn("value.mode&0o7777", POLICY_PREFLIGHT_JS)
        self.assertIn("metadata.parents.some", POLICY_PREFLIGHT_JS)
        self.assertIn("PC_POLICY_METADATA", POLICY_PREFLIGHT_JS)
        self.assertIn("await loadProductionAdmissionPolicy(", POLICY_PREFLIGHT_JS)
        self.assertNotIn("applyPendingMigrations", POLICY_PREFLIGHT_JS)
        self.assertLess(POLICY_PREFLIGHT_JS.index("PC_POLICY_METADATA"), POLICY_PREFLIGHT_JS.index("throw Error('fixture_policy_file_unprotected')"))

    def test_both_image_migrations_use_shipped_db_source_with_tsx_and_exact_api(self):
        for image, script in ((OLD_ALIAS, OLD_SOURCE_MIGRATE_JS), (CANDIDATE, MIGRATE_JS)):
            manifest = migration_pod("migration", image, "synthetic", "source-state" if image == OLD_ALIAS else "restored-state")
            command = manifest["spec"]["containers"][0]["command"]
            self.assertEqual(command[:3], ["node", "--import", "/app/server/node_modules/tsx/dist/loader.mjs"])
            self.assertIn("/app/packages/db/src/client.ts", script)
            self.assertNotIn("/app/packages/db/dist/client.js", script)
            self.assertIn("typeof applyPendingMigrations!=='function'", script)
            self.assertIn("typeof inspectMigrations!=='function'", script)
            self.assertIn("fixture_db_module_verified:/app/packages/db/src/client.ts", script)
            self.assertLess(script.index("fixture_db_module_verified:"), script.index("await applyPendingMigrations("))
            self.assertIn("result.status!=='upToDate'", script)
            self.assertNotIn("catch", script)  # no alternate module/SQL fallback

    def test_only_real_controller_boots_receive_accounted_explicit_heap_budget(self):
        from image_pvc_clone import APPLICATION_BUDGET_JS, APPLICATION_MEMORY, APPLICATION_NODE_OPTIONS
        self.assertEqual(APPLICATION_MEMORY, "1536Mi")
        self.assertEqual(APPLICATION_NODE_OPTIONS, "--max-old-space-size=768")
        for image in (OLD_ALIAS, CANDIDATE):
            boot = pod("boot", image, APP_COMMAND, database_url="synthetic", state="restored-state")
            container = boot["spec"]["containers"][0]
            self.assertEqual(container["resources"]["limits"]["memory"], "1536Mi")
            self.assertEqual(next(item["value"] for item in container["env"] if item["name"] == "NODE_OPTIONS"), APPLICATION_NODE_OPTIONS)
            self.assertEqual(boot["spec"]["securityContext"]["runAsUser"], 1000)
            self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
            migrate = migration_pod("migrate", image, "synthetic", "restored-state")["spec"]["containers"][0]
            self.assertEqual(migrate["resources"]["limits"]["memory"], "768Mi")
            self.assertNotIn("NODE_OPTIONS", {item["name"] for item in migrate["env"]})
        self.assertEqual(pod("pg", POSTGRES_IMAGE, [], db=True)["spec"]["containers"][0]["resources"]["limits"]["memory"], "256Mi")
        self.assertIn("getHeapStatistics().heap_size_limit", APPLICATION_BUDGET_JS)
        self.assertIn("process.exit(1)", APPLICATION_BUDGET_JS)
        self.assertEqual(3072 - 1536 - 256, 1280)

    def test_application_predecessor_must_be_removed_before_tools_or_next_boot(self):
        import json
        from unittest.mock import Mock
        from types import SimpleNamespace
        from image_pvc_clone import Rehearsal
        rehearsal = Rehearsal.__new__(Rehearsal)
        rehearsal.install = Mock()
        predecessor = pod("old", OLD_ALIAS, APP_COMMAND, database_url="synthetic", state="source-state")
        predecessor["status"] = {"phase": "Succeeded"}
        rehearsal.kube = Mock(return_value=SimpleNamespace(stdout=json.dumps({"items": [predecessor]}).encode()))
        with self.assertRaisesRegex(RuntimeError, "application_predecessor_not_removed"):
            rehearsal.once(pod("tool", POSTGRES_IMAGE, ["true"]))
        with self.assertRaisesRegex(RuntimeError, "application_predecessor_not_removed"):
            rehearsal.boot("next", CANDIDATE, "synthetic", "restored-state")
        rehearsal.install.assert_not_called()
        other_tool = pod("tool", POSTGRES_IMAGE, ["true"])
        rehearsal.kube = Mock(return_value=SimpleNamespace(stdout=json.dumps({"items": [other_tool]}).encode()))
        with self.assertRaisesRegex(RuntimeError, "database_only_phase"):
            rehearsal.boot("next", CANDIDATE, "synthetic", "restored-state")
        rehearsal.install.assert_not_called()


if __name__ == "__main__": unittest.main()
